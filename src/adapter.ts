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
 *      "pseudo vision" flow Yinsen observed, made deterministic.
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
}

const IMAGE_INPUT = ["text", "image"] as const;

function withImageInput(model: LlmModelInfo): LlmModelInfo {
    return { ...model, inputModalities: IMAGE_INPUT };
}

export class PseudoVisionBridgeAdapter extends LlmAdapter {
    readonly #deepseek: DeepSeekAdapter;
    readonly #attachments: AttachmentStore;
    readonly #cacheDir: string;
    readonly #bypassCache: boolean;
    readonly #maxImages: number;

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
        return { ...resolved, inputModalities: IMAGE_INPUT };
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

        if (refs.length > this.#maxImages) {
            throw new LlmError(
                `本次请求包含 ${refs.length} 张图片，伪视觉桥接上限为 ${this.#maxImages} 张`,
                "PSEUDO_VISION_IMAGE_LIMIT",
            );
        }

        const task = latestUserTask(options.messages, refs.length);
        const resolved = await Promise.all(
            refs.map((ref) => this.#attachments.readImage(ref, options.signal)),
        );

        const observations: string[] = [];
        for (let index = 0; index < resolved.length; index += 1) {
            const image = toResolvedImage(resolved[index]);
            const text = await imageToText(image, {
                cacheDir: this.#cacheDir,
                bypassCache: this.#bypassCache,
            });
            observations.push(
                `===== 图片 ${index + 1}（${refs[index]?.mediaType}）=====\n${text}`,
            );
        }

        const delegated: GenerateOptions = {
            ...options,
            messages: withoutImages(options.messages, refs),
            system: appendVisionContext(
                options.system,
                observations.join("\n\n"),
                task,
                refs.length,
            ),
        };
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