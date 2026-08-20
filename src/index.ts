/**
 * `apply(ctx)` — Cordis entry point for dsh-pseudo-vision.
 *
 * The bundle DISABLES the official `llm-deepseek` plugin (see
 * cordis.patch.yml) and re-registers the `deepseek-official` provider with a
 * PseudoVisionBridgeAdapter that:
 *
 *   - advertises every model as image-capable (`inputModalities: ["text",
 *     "image"]`) so the host admission gate and the model selector treat the
 *     route as multimodal, and
 *   - converts image blocks into local OCR + colour-statistics + pixel-scan
 *     + metadata text at request time for models that are not natively
 *     multimodal.
 *
 * It also keeps the four `vision_*` tools registered so the agent can call
 * them directly when it already has a file path.
 */

import type { Context } from "@deepseek-ai/cordis";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import type {} from "@deepseek-ai/dsh-attachment";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import {
    assertUsableApiKey,
    LlmError,
    type AdapterRegistrationHandle,
} from "@deepseek-ai/dsh-llm";
import {
    Config as DeepSeekConfigSchema,
    DeepSeekAdapter,
    resolveAdapterOptions,
    type Config as DeepSeekConfig,
    type DeepSeekConnectionOptions,
} from "@deepseek-ai/dsh-llm-deepseek";
import { deepEqualJson, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { readFile } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";

// Tool registry surface used by this plugin; declared loosely so the bundle
// does not pin a specific dsh-tools version.
export interface ToolRegistryLike {
    register(definition: unknown): () => void;
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        tools?: ToolRegistryLike;
    }
}

import { PseudoVisionBridgeAdapter } from "./adapter.js";
import {
    ProviderVisionBridgeAdapter,
    genericProviderId,
    isGenericProviderId,
} from "./provider-bridge.js";
import { computeColorStats, formatColorStatsBlock } from "./vision/color-stats.js";
import { readMeta, formatMetaBlock } from "./vision/meta.js";
import { disposeOcr, formatOcrBlock, runOcr } from "./vision/ocr.js";
import { pixelScan, formatPixelScanBlock } from "./vision/pixel-scan.js";

export const name = "dsh-pseudo-vision";
export const inject = ["llm", "attachments", "tools"];

export {
    GENERIC_PROVIDER_PREFIX,
    ProviderVisionBridgeAdapter,
    genericProviderId,
    isGenericProviderId,
} from "./provider-bridge.js";
export {
    buildVisionCacheKey,
    imageToText,
    OCR_CACHE_PIPELINE,
    sha256Of,
} from "./bridge.js";
export { disposeOcr } from "./vision/ocr.js";

const PROVIDER = "deepseek-official";
const DEEPSEEK_NS = settingsNamespace("llm-deepseek");

export interface PseudoVisionConfig {
    /** Local cache directory for converted image text. */
    cacheDir?: string;
    /** Re-run the vision tools even when a cached conversion exists. */
    bypassCache?: boolean;
    /** Maximum images converted per request. */
    maxImages?: number;
    /** tesseract language pack (default "chi_sim+eng"). */
    langs?: string;
    /** OCR 分辨率预算：'auto' | 'small' | 'normal' | 'large' | 'mega'（缺省 auto，按图片大小自选）。 */
    ocrBudget?: string;
    /** 跳过预算缩放/自适应放大，保留原图尺寸进行本地 OCR 增强。 */
    ocrNoResize?: boolean;
    /** Explicitly override the provider route this bridge serves. */
    provider?: string;
    /**
     * Register image-capable sibling routes for OTHER live providers. Off by
     * default — each sibling route duplicates every model in the selector,
     * so only enable it when you actually need cross-provider bridging.
     */
    bridgeOtherProviders?: boolean;
    /**
     * Explicit allowlist of provider ids to bridge (e.g. ["kimi-for-coding"]).
     * Empty by default: no sibling routes are created for other providers.
     */
    bridgeProviders?: string[];
    /** Provider ids that should not receive a pseudo-vision sibling route. */
    excludeProviders?: string[];
}

export const PseudoVisionConfigSchema: z<PseudoVisionConfig> = z.object({
    cacheDir: z.string(),
    bypassCache: z.boolean().default(false),
    maxImages: z.number().step(1).min(1).max(32).default(8),
    langs: z.string().default("chi_sim+eng"),
    ocrBudget: z.string().default("auto"),
    ocrNoResize: z.boolean().default(false),
    provider: z.string().default(PROVIDER),
    bridgeOtherProviders: z.boolean().default(false),
    bridgeProviders: z.array(z.string()).default([]),
    excludeProviders: z.array(z.string()).default([]),
});

export const Config = z.intersect([
    DeepSeekConfigSchema,
    PseudoVisionConfigSchema,
]) as unknown as z<PseudoVisionConfig & DeepSeekConfig>;

const DEFAULT_CACHE_DIR = ".dsh-pseudo-vision/cache";

function deepseekPart(config: PseudoVisionConfig): DeepSeekConfig {
    const {
        cacheDir: _cacheDir,
        bypassCache: _bypassCache,
        maxImages: _maxImages,
        langs: _langs,
        ocrBudget: _ocrBudget,
        ocrNoResize: _ocrNoResize,
        provider: _provider,
        bridgeOtherProviders: _bridgeOtherProviders,
        bridgeProviders: _bridgeProviders,
        excludeProviders: _excludeProviders,
        ...deepseek
    } = config;
    return deepseek as DeepSeekConfig;
}

export function apply(ctx: Context, config: PseudoVisionConfig): void {
    const provider = config.provider ?? PROVIDER;
    const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR;
    const bypassCache = config.bypassCache ?? false;
    const maxImages = config.maxImages ?? 8;
    const langs = config.langs ?? "chi_sim+eng";
    const ocrBudget = config.ocrBudget ?? "auto";
    const ocrNoResize = config.ocrNoResize ?? false;

    let currentConfig: () => PseudoVisionConfig = () => config;
    let currentDeepSeek: () => DeepSeekConfig = () => deepseekPart(currentConfig());
    let lastRaw: DeepSeekConfig | undefined;
    let lastGood: DeepSeekConnectionOptions | undefined;
    const options = (): DeepSeekConnectionOptions => {
        const raw = currentDeepSeek();
        if (raw === lastRaw && lastGood !== undefined) return lastGood;
        try {
            const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
            lastRaw = raw;
            lastGood = next;
            return next;
        } catch (error) {
            if (lastGood === undefined) throw error;
            lastRaw = raw;
            ctx.logger.error("dsh-pseudo-vision: keeping the last good DeepSeek configuration");
            ctx.logger.error(error);
            return lastGood;
        }
    };
    options();

    const resolveApiKey = async (connection: DeepSeekConnectionOptions): Promise<string> => {
        const ref = connection.apiKeyEnv;
        const credentials = ctx.get("credentials");
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined) return assertUsableApiKey(hit.value, name, ref);
        } else {
            const ambient = launchEnvironmentOf(ctx).get(ref);
            if (ambient !== undefined && ambient.value !== "") {
                return assertUsableApiKey(ambient.value, name, ref);
            }
        }
        throw new LlmError(
            `dsh-pseudo-vision: 没有找到 ${ref}，请在设置 → 模型中保存 DeepSeek API Key`,
            "MISSING_CREDENTIAL",
        );
    };

    const deepseek = new DeepSeekAdapter({
        options,
        resolveApiKey,
        resolveUserId: () => getOrCreateAnonymousUserId(),
        resolveAttachments: () => ctx.get("attachments"),
    });

    const bridge = new PseudoVisionBridgeAdapter(deepseek, ctx.attachments, {
        cacheDir,
        bypassCache,
        maxImages,
        ocrBudget,
        langs,
        ocrNoResize,
    });

    ctx.llm.registerConfigurableProviders([{
        provider,
        displayName: "DeepSeek",
        settingsNs: DEEPSEEK_NS,
        settingsPath: [],
    }]);
    const registration = ctx.llm.registerAdapter([provider], bridge);

    // DSH rejects images before the agent loop when a selected model is
    // explicitly text-only. Give every other live provider a sibling route
    // whose model metadata advertises image input, while leaving the original
    // route and its adapter untouched.
    const genericTargets = new Map<string, string>();
    const genericBridge = new ProviderVisionBridgeAdapter(
        ctx.llm,
        ctx.attachments,
        genericTargets,
        { cacheDir, bypassCache, maxImages, ocrBudget, langs, ocrNoResize },
    );
    let genericRegistration: AdapterRegistrationHandle | undefined;
    let genericRoutes: string[] = [];
    let refreshingGenericRoutes = false;

    const refreshGenericRoutes = (): void => {
        if (refreshingGenericRoutes) return;
        refreshingGenericRoutes = true;
        const previousTargets = new Map(genericTargets);
        try {
            const current = currentConfig();
            const excluded = new Set(current.excludeProviders ?? []);
            const allow = new Set(current.bridgeProviders ?? []);
            const all = current.bridgeOtherProviders === true;
            if (!all && allow.size === 0) {
                if (genericRoutes.length > 0 && genericRegistration !== undefined) {
                    genericTargets.clear();
                    genericRegistration.replace([]);
                    genericRoutes = [];
                }
                return;
            }
            const live = ctx.llm.listProviders().filter((item) =>
                item.id !== provider
                && !isGenericProviderId(item.id)
                && !excluded.has(item.id)
                && (all || allow.has(item.id)),
            );
            const nextRoutes = live.map((item) => genericProviderId(item.id));
            const unchanged = nextRoutes.length === genericRoutes.length
                && nextRoutes.every((route, index) => route === genericRoutes[index]);
            if (unchanged) return;

            genericTargets.clear();
            for (const item of live) genericTargets.set(genericProviderId(item.id), item.id);

            if (genericRegistration === undefined) {
                if (nextRoutes.length > 0) {
                    genericRegistration = ctx.llm.registerAdapter(nextRoutes, genericBridge);
                }
            } else {
                genericRegistration.replace(nextRoutes);
            }
            genericRoutes = nextRoutes;
            if (nextRoutes.length > 0) {
                ctx.logger.info(
                    `[dsh-pseudo-vision] generic sibling routes: ${nextRoutes.join(", ")}`,
                );
            }
        } catch (error) {
            genericTargets.clear();
            for (const [route, target] of previousTargets) genericTargets.set(route, target);
            ctx.logger.warn("[dsh-pseudo-vision] unable to refresh generic sibling routes");
            ctx.logger.warn(error);
        } finally {
            refreshingGenericRoutes = false;
        }
    };

    ctx.on("llm/adapters-updated", refreshGenericRoutes, { global: true });
    refreshGenericRoutes();

    let registeredPolicy = options().retryPolicy;
    const ensureRegistrationFacts = (): void => {
        const policy = options().retryPolicy;
        if (deepEqualJson(policy, registeredPolicy)) return;
        registration.replace([provider]);
        registeredPolicy = policy;
    };

    ctx.inject(["settings"], (settingsCtx) => {
        const scope = settingsCtx.settings.register(
            DEEPSEEK_NS,
            Config,
            { base: config },
        );
        currentConfig = () => scope.get() as PseudoVisionConfig;
        currentDeepSeek = () => deepseekPart(currentConfig());
        ensureRegistrationFacts();
        refreshGenericRoutes();
        scope.watch(() => {
            ensureRegistrationFacts();
            refreshGenericRoutes();
        });
        settingsCtx.effect(() => () => {
            if (ctx.fiber.state >= 5) return;
            currentConfig = () => config;
            currentDeepSeek = () => deepseekPart(currentConfig());
            ensureRegistrationFacts();
            refreshGenericRoutes();
        });
    });

    registerVisionTools(ctx, { langs });
    ctx.effect(
        () => async () => {
            await disposeOcr();
        },
        "dsh-pseudo-vision: dispose OCR worker",
    );
    ctx.logger.info(`[dsh-pseudo-vision] bridge active on provider "${provider}"; cache=${cacheDir}`);
}

function registerVisionTools(ctx: Context, config: { langs: string }): void {
    const tools = ctx.tools;
    if (tools === undefined) {
        ctx.logger.warn("[dsh-pseudo-vision] ctx.tools unavailable; vision_* tools not exposed");
        return;
    }

    const langs = config.langs;

    tools.register(defineTool({
        name: "vision_ocr",
        description: "Extract every text line in an image, returning recognised text with a normalised bounding box. Uses local tesseract.js; no network.",
        parameters: {
            type: "object",
            required: ["file_path"],
            properties: {
                file_path: { type: "string", description: "PNG/JPEG/WebP/GIF path on disk." },
                langs: { type: "string", description: `tessdata languages, default ${langs}.` },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: "object",
                required: ["text"],
                properties: {
                    text: { type: "string" },
                    lines: { type: "integer" },
                },
                additionalProperties: false,
            },
            render: (_args, value: { text: string; lines: number }) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args: { file_path: string; langs?: string }) => {
            const bytes = await readFile(args.file_path);
            const result = await runOcr(bytes, args.langs ?? langs);
            return { text: formatOcrBlock(result), lines: result.lines.length };
        },
    }));

    tools.register(defineTool({
        name: "vision_color_stats",
        description: "Bucket every pixel into coarse colour categories (white/black/grey/red/green/blue/...) and report each bucket's share of the total.",
        parameters: {
            type: "object",
            required: ["file_path"],
            properties: {
                file_path: { type: "string", description: "PNG/JPEG/WebP/GIF path on disk." },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
                additionalProperties: false,
            },
            render: (_args, value: { text: string }) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args: { file_path: string }) => {
            const bytes = await readFile(args.file_path);
            const stats = await computeColorStats(bytes);
            return { text: formatColorStatsBlock(stats) };
        },
    }));

    tools.register(defineTool({
        name: "vision_pixel_scan",
        description: "Walk every row of the image and report rows where the target colour's pixel density exceeds a threshold. Use to spot horizontal lines or coloured bands.",
        parameters: {
            type: "object",
            required: ["file_path"],
            properties: {
                file_path: { type: "string", description: "PNG/JPEG/WebP/GIF path on disk." },
                target: { type: "string", description: "Hex colour (default red #ff0000)." },
                threshold: { type: "number", description: "Minimum row density 0..1, default 0.05." },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
                additionalProperties: false,
            },
            render: (_args, value: { text: string }) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args: { file_path: string; target?: string; threshold?: number }) => {
            const bytes = await readFile(args.file_path);
            const result = await pixelScan(bytes, {
                target: args.target ?? "#ff0000",
                threshold: args.threshold ?? 0.05,
            });
            return { text: formatPixelScanBlock(result) };
        },
    }));

    tools.register(defineTool({
        name: "vision_meta",
        description: "Read image metadata (dimensions, format, colour space) and sample colours at the four corners plus the centre. Cheap call, useful for layout inferences.",
        parameters: {
            type: "object",
            required: ["file_path"],
            properties: {
                file_path: { type: "string", description: "PNG/JPEG/WebP/GIF path on disk." },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
                additionalProperties: false,
            },
            render: (_args, value: { text: string }) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args: { file_path: string }) => {
            const bytes = await readFile(args.file_path);
            const result = await readMeta(bytes);
            return { text: formatMetaBlock(result) };
        },
    }));

    ctx.logger.info("[dsh-pseudo-vision] tools registered: vision_ocr, vision_color_stats, vision_pixel_scan, vision_meta");
}

/**
 * Local stand-in for `@deepseek-ai/dsh-tool-cordis`'s `defineTool` — keeps
 * the plugin free of a hard dependency on a specific dsh-tools version.
 * DSH injects its own typed `defineTool` when the bundle opts in via
 * `inject: ['tools']`; this function exists so the plugin still compiles
 * and runs against the local test harness.
 */
function defineTool<TArgs, TValue>(spec: {
    name: string;
    description: string;
    parameters: unknown;
    output: unknown;
    execute: (args: TArgs) => Promise<TValue>;
}): unknown {
    return spec;
}