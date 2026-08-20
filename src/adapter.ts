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
    LlmError,
    type GenerateOptions,
    type LlmModelInfo,
    type LlmProviderInfo,
    type LlmResolvedModelInfo,
    type ResolvedRetryPolicy,
    type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { DeepSeekAdapter } from "@deepseek-ai/dsh-llm-deepseek";

import {
    appendVisionContext,
    collectImageRefs,
    latestUserTask,
    withoutImages,
} from "./content.js";
import { imageToText } from "./bridge.js";

export interface PseudoVisionBridgeOptions {
    readonly cacheDir: string;
    readonly bypassCache: boolean;
    readonly maxImages: number;
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

function withImageInput(model: LlmModelInfo): LlmModelInfo {
    return {
        ...model,
        inputModalities: IMAGE_INPUT,
        description: PSEUDO_VISION_DESCRIPTION,
    };
}

/**
 * Replace image blocks with local pseudo-vision evidence while preserving the
 * caller's provider/model fields. Both the official DeepSeek bridge and the
 * generic provider aliases use this exact request transformation.
 */
export async function buildPseudoVisionRequest(
    options: GenerateOptions,
    attachments: AttachmentStore,
    bridgeOptions: PseudoVisionBridgeOptions,
): Promise<GenerateOptions | undefined> {
    const refs = collectImageRefs(options.messages);
    if (refs.length === 0) return undefined;

    if (refs.length > bridgeOptions.maxImages) {
        throw new LlmError(
            `本次请求包含 ${refs.length} 张图片，伪视觉桥接上限为 ${bridgeOptions.maxImages} 张`,
            "PSEUDO_VISION_IMAGE_LIMIT",
        );
    }

    const task = latestUserTask(options.messages, refs.length);
    const resolved = await Promise.all(
        refs.map((ref) => attachments.readImage(ref, options.signal)),
    );

    const observations: string[] = [];
    for (let index = 0; index < resolved.length; index += 1) {
        const image = toResolvedImage(resolved[index]);
        const text = await imageToText(image, {
            cacheDir: bridgeOptions.cacheDir,
            bypassCache: bridgeOptions.bypassCache,
            ocrBudget: bridgeOptions.ocrBudget ?? "auto",
            langs: bridgeOptions.langs ?? "chi_sim+eng",
            ocrNoResize: bridgeOptions.ocrNoResize ?? false,
        });
        observations.push(
            `===== 图片 ${index + 1}（${refs[index]?.mediaType}）=====\n${text}`,
        );
    }

    return {
        ...options,
        messages: withoutImages(options.messages, refs),
        system: appendVisionContext(
            options.system,
            observations.join("\n\n"),
            task,
            refs.length,
        ),
    };
}

export class PseudoVisionBridgeAdapter extends LlmAdapter {
    readonly #deepseek: DeepSeekAdapter;
    readonly #attachments: AttachmentStore;
    readonly #cacheDir: string;
    readonly #bypassCache: boolean;
    readonly #maxImages: number;
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
            description: PSEUDO_VISION_DESCRIPTION,
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