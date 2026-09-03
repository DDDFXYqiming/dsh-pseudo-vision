/**
 * PseudoVisionBridgeAdapter — wraps the official DeepSeek adapter so that:
 *
 *   1. EVERY model is advertised with `inputModalities: ["text", "image"]`
 *      (`resolveModel` / `listModels`), which makes the Web UI and the
 *      host's image-admission gate treat the route as image-capable.
 *   2. At request time, `stream()` inspects the messages. If the underlying
 *      model is actually image-capable, the request passes through
 *      untouched. Otherwise every image block is resolved through the
 *      attachment store and converted, by the four LOCAL tools (OCR, colour
 *      statistics, pixel scan, metadata), into a structured text block that
 *      is spliced into the system prompt as untrusted evidence — the
 *      local pseudo-vision flow, made deterministic.
 *
 * No external vision API is called. Everything runs locally via sharp and
 * tesseract.js. The underlying DeepSeek HTTP request therefore carries only
 * text, so a text-only gateway never returns 400 mid-turn.
 */

import { createHash } from "node:crypto";
import type { AttachmentStore, ImageAttachmentRef, StoredImageAttachment } from "@deepseek-ai/dsh-attachment";
import {
    LlmAdapter,
    type GenerateOptions,
    type LlmModelInfo,
    type LlmProviderInfo,
    type LlmResolvedModelInfo,
    type PreparedAdapterCall,
    type ResolvedRetryPolicy,
    type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { DeepSeekAdapter } from "@deepseek-ai/dsh-llm-deepseek";

import {
    appendVisionContext,
    collectImageRefs,
    collectImageRefsWithOrigin,
    latestUserTask,
    parsedImagePlaceholder,
    withoutImages,
} from "./content.js";
import { imageToCompactText, imageToText } from "./bridge.js";

export interface PseudoVisionBridgeOptions {
    readonly cacheDir: string;
    readonly bypassCache: boolean;
    /** 单请求【全量层】图片张数上限（OCR 耗时护栏）。 */
    readonly maxImages: number;
    /**
     * 单请求证据文本（全量 + 紧凑）总字符硬顶。张数上限管不住
     * “多张满屏文字图”的组合，总量护栏才是上下文护栏。默认 96000。
     */
    readonly maxTotalEvidenceChars?: number;
    /**
     * 最近多少个用户轮次的图片保留全量证据；更早轮次自动降级为
     * 紧凑证据（元信息+颜色+扫描，OCR 折叠可回读）。默认 2。
     */
    readonly fullEvidenceTurns?: number;
    /**
     * OCR 分辨率预算：'auto' | 'small' | 'normal' | 'large' | 'mega'。
     * 可选：buildPseudoVisionRequest 对缺省值回退 'auto'（按图片大小自选）。
     */
    readonly ocrBudget?: string;
    /** Tesseract language pack, defaulting to chi_sim+eng. */
    readonly langs?: string;
    /** Skip budget resize/upscale while retaining OCR enhancement. */
    readonly ocrNoResize?: boolean;
}

const IMAGE_INPUT = ["text", "image"] as const;

/** Model-selector hint shown for every model served by the bridge. */
export const PSEUDO_VISION_DESCRIPTION = "图片会在发送前由 dsh-pseudo-vision 转换为本地视觉文字";

/**
 * 宿主准入用的图片像素预算默认值（v0.5.4）。
 * 64M（≈8000²）会让宿主原样放行超大图，本地 OCR 产出的证据文本可爆上下文；
 * 1M 又会先被宿主降采样、毁掉长截图分块 OCR 的小字。取 16M（4096²）——
 * 与本地 `mega` OCR 档对齐，仍允许 3000px+ 长图走分块管线。
 * 证据文本另有 MAX_EVIDENCE_CHARS 封顶（见 bridge.ts）。
 */
export const DEFAULT_IMAGE_PIXEL_BUDGET = 16_000_000;

function withImageInput(model: LlmModelInfo): LlmModelInfo {
    return {
        ...model,
        inputModalities: IMAGE_INPUT,
        imagePixelBudget: model.imagePixelBudget ?? DEFAULT_IMAGE_PIXEL_BUDGET,
        description: PSEUDO_VISION_DESCRIPTION,
    };
}

/**
 * Replace image blocks with local pseudo-vision evidence while preserving the
 * caller's provider/model fields. Both the official DeepSeek bridge and the
 * generic provider aliases use this exact request transformation.
 */
const DEFAULT_TOTAL_EVIDENCE_CHARS = 96_000;
const DEFAULT_FULL_EVIDENCE_TURNS = 2;

type EvidenceTier = "full" | "compact" | "skipped";

/**
 * Budgeted, tiered request transformation. Images of the recent user turns
 * (`fullEvidenceTurns`, default 2) get the full local evidence pipeline, each
 * image capped at MAX_EVIDENCE_CHARS and the whole request additionally
 * capped at `maxTotalEvidenceChars`. Older-turn images are never dropped:
 * they degrade to compact evidence (metadata + colour + scan, OCR folded to a
 * re-fetch pointer). Only images beyond the count/budget caps are skipped,
 * and every skipped image keeps an explicit placeholder plus a summary line,
 * so nothing disappears silently. The request never fails because too many
 * images were attached.
 */
export async function buildPseudoVisionRequest(
    options: GenerateOptions,
    attachments: AttachmentStore,
    bridgeOptions: PseudoVisionBridgeOptions,
): Promise<GenerateOptions | undefined> {
    const entries = collectImageRefsWithOrigin(options.messages);
    if (entries.length === 0) return undefined;

    const total = entries.length;
    const maxImages = bridgeOptions.maxImages;
    const totalBudget = bridgeOptions.maxTotalEvidenceChars ?? DEFAULT_TOTAL_EVIDENCE_CHARS;
    const fullTurns = bridgeOptions.fullEvidenceTurns ?? DEFAULT_FULL_EVIDENCE_TURNS;

    // Turn boundary: the message index of the fullTurns-th user message from
    // the end. An image whose LATEST appearance is before it is history-tier.
    const userIdx: number[] = [];
    options.messages.forEach((message, index) => {
        if (message.source.kind === "user") userIdx.push(index);
    });
    const boundary = userIdx.length >= fullTurns
        ? (userIdx[userIdx.length - fullTurns] ?? 0)
        : 0;

    const task = latestUserTask(options.messages, total);
    const resolved = await Promise.all(
        entries.map((entry) => attachments.readImage(entry.ref, options.signal)),
    );

    const tiers = new Map<number, EvidenceTier>();
    const texts = new Map<number, string>();
    let usedChars = 0;
    let fullCount = 0;

    // Pass 1: current-turn images → full evidence (count + budget capped).
    for (let index = 0; index < entries.length; index += 1) {
        const label = index + 1;
        const entry = entries[index];
        if (entry === undefined) continue;
        if (entry.lastIndex < boundary) continue;
        if (fullCount >= maxImages || usedChars >= totalBudget) {
            tiers.set(label, "skipped");
            continue;
        }
        const text = await imageToText(toResolvedImage(resolved[index]), {
            cacheDir: bridgeOptions.cacheDir,
            bypassCache: bridgeOptions.bypassCache,
            ocrBudget: bridgeOptions.ocrBudget ?? "auto",
            langs: bridgeOptions.langs ?? "chi_sim+eng",
            ocrNoResize: bridgeOptions.ocrNoResize ?? false,
        });
        // The first included image is never dropped for being over budget on
        // its own: some evidence beats none, and per-image capEvidence already
        // bounds it. Subsequent images must fit the remaining budget.
        if (usedChars > 0 && usedChars + text.length > totalBudget) {
            tiers.set(label, "skipped");
            continue;
        }
        usedChars += text.length;
        fullCount += 1;
        tiers.set(label, "full");
        texts.set(label, `===== 图片 ${label}（${entry.ref.mediaType}）=====\n${text}`);
    }

    // Pass 2: history images → compact evidence, newest first, filling the
    // remaining budget. Cheap enough that old images effectively never vanish.
    let compactCount = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const label = index + 1;
        const entry = entries[index];
        if (entry === undefined) continue;
        if (entry.lastIndex >= boundary) continue;
        if (usedChars >= totalBudget) {
            tiers.set(label, "skipped");
            continue;
        }
        const text = await imageToCompactText(toResolvedImage(resolved[index]), {
            hostPath: attachments.imageHostPath?.(entry.ref),
        });
        if (usedChars > 0 && usedChars + text.length > totalBudget) {
            tiers.set(label, "skipped");
            continue;
        }
        usedChars += text.length;
        compactCount += 1;
        tiers.set(label, "compact");
        texts.set(label, `===== 图片 ${label}（${entry.ref.mediaType}·历史·紧凑）=====\n${text}`);
    }

    const skipped: number[] = [];
    for (let label = 1; label <= total; label += 1) {
        if (tiers.get(label) === "skipped") skipped.push(label);
    }

    const observations: string[] = [];
    for (let label = 1; label <= total; label += 1) {
        const text = texts.get(label);
        if (text !== undefined) observations.push(text);
    }
    if (compactCount > 0 || skipped.length > 0) {
        const parts = [
            `本次请求共 ${total} 张图片：全量证据 ${fullCount} 张`,
            `紧凑证据（历史轮次，OCR 已折叠可按指针回读）${compactCount} 张`,
        ];
        if (skipped.length > 0) {
            parts.push(`未转换 ${skipped.length} 张（图片编号 ${skipped.join("、")}，超出张数上限 ${maxImages} 或证据预算）`);
        }
        const advice = skipped.length > 0
            ? "。请在回答中明确告知用户哪些图片未生效，并建议其把未生效的图片单独发送"
            : "";
        observations.push(`[⚠️ 图片处理摘要] ${parts.join("；")}${advice}。`);
    }

    return {
        ...options,
        messages: withoutImages(
            options.messages,
            entries.map((entry) => entry.ref),
            (label) => {
                const tier = tiers.get(label);
                if (tier === "compact") {
                    return `[图片 ${label} 为历史轮次图片，本次仅注入紧凑视觉证据（颜色/扫描/元信息，OCR 已折叠可回读），见本次请求的伪视觉上下文]`;
                }
                if (tier === "skipped") {
                    return `[图片 ${label} 未转换（本次请求共 ${total} 张，超出张数上限 ${maxImages} 或证据预算），请提示用户重新单独发送该图片]`;
                }
                return parsedImagePlaceholder(label);
            },
        ),
        system: appendVisionContext(
            options.system,
            observations.join("\n\n"),
            task,
            total,
        ),
    };
}

export class PseudoVisionBridgeAdapter extends LlmAdapter {
    readonly #deepseek: DeepSeekAdapter;
    readonly #attachments: AttachmentStore;
    readonly #cacheDir: string;
    readonly #bypassCache: boolean;
    readonly #maxImages: number;
    readonly #maxTotalEvidenceChars: number;
    readonly #fullEvidenceTurns: number;
    readonly #ocrBudget: string;
    readonly #langs: string;
    readonly #ocrNoResize: boolean;

    constructor(
        deepseek: DeepSeekAdapter,
        attachments: AttachmentStore,
        options: PseudoVisionBridgeOptions,
    ) {
        super();
        this.#deepseek = deepseek;
        this.#attachments = attachments;
        this.#cacheDir = options.cacheDir;
        this.#bypassCache = options.bypassCache;
        this.#maxImages = options.maxImages;
        this.#maxTotalEvidenceChars = options.maxTotalEvidenceChars ?? DEFAULT_TOTAL_EVIDENCE_CHARS;
        this.#fullEvidenceTurns = options.fullEvidenceTurns ?? DEFAULT_FULL_EVIDENCE_TURNS;
        this.#ocrBudget = options.ocrBudget ?? "auto";
        this.#langs = options.langs ?? "chi_sim+eng";
        this.#ocrNoResize = options.ocrNoResize ?? false;
    }

    providerInfo(provider: string): LlmProviderInfo {
        return this.#deepseek.providerInfo(provider);
    }

    providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
        return this.#deepseek.providerRetryPolicy(provider);
    }

    async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        return (await this.#deepseek.listModels(provider)).map(withImageInput);
    }

    async resolveModel(
        provider: string,
        model: string,
        signal?: AbortSignal,
    ): Promise<LlmResolvedModelInfo> {
        const resolved = await this.#deepseek.resolveModel(provider, model, signal);
        return {
            ...resolved,
            inputModalities: IMAGE_INPUT,
            imagePixelBudget: resolved.imagePixelBudget ?? DEFAULT_IMAGE_PIXEL_BUDGET,
            description: PSEUDO_VISION_DESCRIPTION,
        };
    }

    /**
     * [v0.5.2] dsh 0.1.1-rc.2 宿主在 adapterStream 中无条件调用 `adapter.prepareCall`；
     * 抽象基类 `LlmAdapter` 不提供默认实现，未重写即抛 "is not a function"。
     * 这里**不委托**被包装的 DeepSeek adapter（其 `prepareCall` 在 dsh 的
     * 嵌套模块解析下可能取到旧版的实例而缺失该方法），而是自取 `this.resolveModel`
     * 拿到带 image modalities 的元数据，dispatch 用 bridge 自己的 `this.stream()`
     * （已含伪视觉变换）——这是把 prepareCall 退化为"解析 + dispatch 闭包"的最小
     * 契约实现，对宿主完全透明。
     */
    async prepareCall(
        provider: string,
        model: string,
        signal?: AbortSignal,
    ): Promise<PreparedAdapterCall> {
        const resolved = await this.resolveModel(provider, model, signal);
        return {
            model: resolved,
            stream: (options: GenerateOptions) => this.stream(options),
        };
    }

    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const refs = collectImageRefs(options.messages);
        if (refs.length === 0) {
            yield* this.#deepseek.stream(options);
            return;
        }

        // If the underlying model genuinely accepts images, pass through.
        const native = await this.#deepseek.resolveModel(
            options.provider,
            options.model,
            options.signal,
        );
        if (native.inputModalities?.includes("image") === true) {
            yield* this.#deepseek.stream(options);
            return;
        }

        const delegated = await buildPseudoVisionRequest(
            options,
            this.#attachments,
            {
                cacheDir: this.#cacheDir,
                bypassCache: this.#bypassCache,
                maxImages: this.#maxImages,
                maxTotalEvidenceChars: this.#maxTotalEvidenceChars,
                fullEvidenceTurns: this.#fullEvidenceTurns,
                ocrBudget: this.#ocrBudget,
                langs: this.#langs,
                ocrNoResize: this.#ocrNoResize,
            },
        );
        if (delegated === undefined) {
            yield* this.#deepseek.stream(options);
            return;
        }
        yield* this.#deepseek.stream(delegated);
    }
}

export interface ResolvedImage {
    attachmentId: string;
    bytes: Buffer;
    mediaType: string;
    sha256: string;
}

/** Adapt a StoredImageAttachment (Uint8Array) to the bridge's Buffer shape. */
export function toResolvedImage(stored: StoredImageAttachment): ResolvedImage {
    const bytes = Buffer.from(stored.data);
    const attachmentId = String(stored.ref.attachmentId);
    return {
        attachmentId,
        bytes,
        mediaType: stored.ref.mediaType,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}