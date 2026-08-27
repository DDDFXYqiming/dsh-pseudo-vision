/**
 * Generic provider sibling routes for dsh-pseudo-vision.
 *
 * The host rejects a text-only provider before the agent loop starts, so a
 * bridge must own a separate route whose model metadata advertises image
 * input. The route delegates image-free requests to the original provider
 * through the LLM runtime and removes images before the original adapter sees
 * a text-only request.
 */

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import {
    LlmAdapter,
    LlmError,
    type GenerateOptions,
    type LlmModelInfo,
    type LlmProviderInfo,
    type LlmResolvedModelInfo,
    type LlmRuntime,
    type PreparedAdapterCall,
    type ResolvedRetryPolicy,
    type StreamChunk,
} from "@deepseek-ai/dsh-llm";

import {
    buildPseudoVisionRequest,
    DEFAULT_IMAGE_PIXEL_BUDGET,
    type PseudoVisionBridgeOptions,
} from "./adapter.js";
import { collectImageRefs } from "./content.js";

export const GENERIC_PROVIDER_PREFIX = "dsh-pseudo-vision/";
const IMAGE_INPUT = ["text", "image"] as const;

export function genericProviderId(provider: string): string {
    return `${GENERIC_PROVIDER_PREFIX}${provider}`;
}

export function isGenericProviderId(provider: string): boolean {
    return provider.startsWith(GENERIC_PROVIDER_PREFIX);
}

/**
 * One adapter instance serves a dynamic set of sibling routes. The map is
 * refreshed by the host plugin when LLM adapter topology changes.
 */
export class ProviderVisionBridgeAdapter extends LlmAdapter {
    readonly #llm: LlmRuntime;
    readonly #attachments: AttachmentStore;
    readonly #targets: Map<string, string>;
    readonly #options: PseudoVisionBridgeOptions;

    constructor(
        llm: LlmRuntime,
        attachments: AttachmentStore,
        targets: Map<string, string>,
        options: PseudoVisionBridgeOptions,
    ) {
        super();
        this.#llm = llm;
        this.#attachments = attachments;
        this.#targets = targets;
        this.#options = options;
    }

    #target(provider: string): string {
        const target = this.#targets.get(provider);
        if (target === undefined) {
            throw new LlmError(
                `伪视觉路由「${provider}」的原始 provider 已不可用`,
                "PSEUDO_VISION_ROUTE_UNAVAILABLE",
            );
        }
        return target;
    }

    #displayName(target: string): string {
        const found = this.#llm.listProviders().find((item) => item.id === target);
        return `${found?.name ?? target} · Pseudo Vision`;
    }

    providerInfo(provider: string): LlmProviderInfo {
        return {
            id: provider,
            name: this.#displayName(this.#target(provider)),
        };
    }

    providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
        return this.#llm.providerRetryPolicy(this.#target(provider));
    }

    async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        const target = this.#target(provider);
        const models = await this.#llm.listModels(target);
        // Only text-only models need the sibling route. Native multimodal
        // models already accept images on the original route and would only
        // duplicate entries in the model selector.
        return models
            .filter((model) => model.inputModalities?.includes("image") !== true)
            .map((model) => ({
                ...model,
                provider,
                inputModalities: IMAGE_INPUT,
                description: model.description === undefined
                    ? "图片会在发送前由 dsh-pseudo-vision 转换为本地视觉文字"
                    : `${model.description} · Pseudo Vision`,
            }));
    }

    async resolveModel(
        provider: string,
        model: string,
        signal?: AbortSignal,
    ): Promise<LlmResolvedModelInfo> {
        const target = this.#target(provider);
        const resolved = await this.#llm.resolveModelInfo(target, model, signal);
        // Native multimodal models are not served by the sibling route; the
        // original route already handles their image input.
        if (resolved.inputModalities?.includes("image") === true) {
            throw new LlmError(
                `模型「${model}」原生支持图片输入，请选择原始 provider 路由`,
                "PSEUDO_VISION_NATIVE_MODEL",
            );
        }
        return {
            ...resolved,
            provider,
            inputModalities: IMAGE_INPUT,
            imagePixelBudget: resolved.imagePixelBudget ?? DEFAULT_IMAGE_PIXEL_BUDGET,
        };
    }

    /**
     * [v0.5.3] dsh 0.1.1-rc.2 宿主在 adapterStream 中无条件调用 `adapter.prepareCall`；
     * 抽象基类 `LlmAdapter` 不提供默认实现，未重写即抛 "is not a function"。
     * 这里**不委托**被包装的运行时（其 `prepareCall` 在 dsh 的嵌套模块解析下可能取到旧版
     * 实例而缺失该方法），而是自取 `this.resolveModel` 拿到带 image modalities 的元数据，
     * dispatch 用 bridge 自己的 `this.stream()`（已含伪视觉变换）——这是把 prepareCall
     * 退化为"解析 + dispatch 闭包"的最小契约实现，对宿主完全透明。与 `PseudoVisionBridgeAdapter`
     * 中 prepareCall 的语义保持一致：sibling route 仅作为文本 only provider 的图像入口。
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
        const target = this.#target(options.provider);
        const refs = collectImageRefs(options.messages);

        // No image: use the original provider without adding any prompt text.
        if (refs.length === 0) {
            yield* this.#llm.stream({ ...options, provider: target });
            return;
        }

        // Native multimodal models keep their original wire format. The
        // sibling route is still useful because it can host both native and
        // text-only models without changing the user's selected route.
        const native = await this.#llm.resolveModelInfo(target, options.model, options.signal);
        if (native.inputModalities?.includes("image") === true) {
            yield* this.#llm.stream({ ...options, provider: target });
            return;
        }

        const delegated = await buildPseudoVisionRequest(
            options,
            this.#attachments,
            this.#options,
        );
        if (delegated === undefined) {
            yield* this.#llm.stream({ ...options, provider: target });
            return;
        }

        // The original provider receives a text-only request. Do not mutate
        // provider/model inside an existing prepared call; this is a fresh
        // runtime dispatch to the target route, while the outer session route
        // remains the selected sibling provider.
        yield* this.#llm.stream({
            ...delegated,
            provider: target,
        });
    }
}
