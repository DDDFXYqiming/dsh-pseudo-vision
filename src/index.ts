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
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { readImageFileSafe } from "./vision/file-guard.js";

import { PseudoVisionBridgeAdapter } from "./adapter.js";
import {
    ProviderVisionBridgeAdapter,
    genericProviderId,
    isGenericProviderId,
} from "./provider-bridge.js";
import { computeColorStats, formatColorStatsBlock } from "./vision/color-stats.js";
import { readMeta, formatMetaBlock } from "./vision/meta.js";
import {
    disposeOcr,
    formatDigitFixBlock,
    formatOcrBlock,
    formatOcrRetryBlock,
    ocrWithLowConfidenceRetry,
    setTessdataDir,
} from "./vision/ocr.js";
import { pixelScan, formatPixelScanBlock } from "./vision/pixel-scan.js";
import { preprocessForOcr } from "./vision/preprocess.js";

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
    capEvidence,
    imageToText,
    MAX_EVIDENCE_CHARS,
    OCR_CACHE_PIPELINE,
    sha256Of,
} from "./bridge.js";
import { MAX_EVIDENCE_CHARS, setEvidenceCharCap } from "./bridge.js";
export { disposeOcr } from "./vision/ocr.js";
export { DEFAULT_IMAGE_PIXEL_BUDGET } from "./adapter.js";

const PROVIDER = "deepseek-official";
const DEEPSEEK_NS = settingsNamespace("llm-deepseek");

export interface PseudoVisionConfig {
    /** Local cache directory for converted image text. */
    cacheDir: string;
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
    /**
     * Local tessdata directory for offline / slow-CDN scenarios. When set,
     * it takes precedence over the PV_TESSDATA environment variable.
     */
    tessdataDir: string;
    /** Character cap on evidence text handed to the model. */
    evidenceMaxChars: number;
}

const DEFAULT_CACHE_DIR = ".dsh-pseudo-vision/cache";

export const PseudoVisionConfigSchema: z<PseudoVisionConfig> = z.object({
    cacheDir: z.string().default(DEFAULT_CACHE_DIR),
    bypassCache: z.boolean().default(false),
    maxImages: z.number().step(1).min(1).max(32).default(8),
    langs: z.string().default("chi_sim+eng"),
    ocrBudget: z.string().default("auto"),
    ocrNoResize: z.boolean().default(false),
    provider: z.string().default(PROVIDER),
    bridgeOtherProviders: z.boolean().default(false),
    bridgeProviders: z.array(z.string()).default([]),
    excludeProviders: z.array(z.string()).default([]),
    tessdataDir: z.string().default(""),
    evidenceMaxChars: z.number().min(1000).default(MAX_EVIDENCE_CHARS),
});

export const Config = z.intersect([
    DeepSeekConfigSchema,
    PseudoVisionConfigSchema,
]) as unknown as z<PseudoVisionConfig & DeepSeekConfig>;

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
        tessdataDir: _tessdataDir,
        evidenceMaxChars: _evidenceMaxChars,
        ...deepseek
    } = config;
    return deepseek as DeepSeekConfig;
}

export function apply(ctx: Context, config: PseudoVisionConfig): void {
    const provider = config.provider ?? PROVIDER;
    const cacheDir = config.cacheDir;
    setTessdataDir(config.tessdataDir || undefined);
    setEvidenceCharCap(config.evidenceMaxChars);
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

    registerVisionTools(ctx, { langs, ocrBudget, ocrNoResize });
    ctx.effect(
        () => async () => {
            await disposeOcr();
        },
        "dsh-pseudo-vision: dispose OCR worker",
    );
    ctx.logger.info(`[dsh-pseudo-vision] bridge active on provider "${provider}"; cache=${cacheDir}`);
}

function registerVisionTools(ctx: Context, config: { langs: string; ocrBudget: string; ocrNoResize: boolean }): void {
    const tools = ctx.tools;
    const langs = config.langs;

    tools.register(defineTool({
        name: "vision_ocr",
        description: "Extract every text line in an image, returning recognised text with a normalised bounding box. Runs the full local pipeline: low-confidence lines are re-read from enlarged crops, and digit-critical tokens (IP/URL/port) get a whitelist verification pass. Local tesseract.js; no network.",
        parameters: {
            file_path: { type: "string", required: true, description: "PNG/JPEG/WebP/GIF path on disk." },
            langs: { type: "string", description: `tessdata languages, default ${langs}.` },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    text: { type: "string", required: true },
                    lines: { type: "integer" },
                },
            },
            render: (_args, value) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args) => {
            const bytes = await readImageFileSafe(args.file_path);
            // 与 pi-pseudo-vision 对齐：工具路径也走预算预处理管线，
            // 保证小字/低质量截图在手动调用时与 auto-bridge 同一识别质量。
            const pre = await preprocessForOcr(
                bytes,
                config.ocrBudget,
                undefined,
                config.ocrNoResize,
            );
            const result = await ocrWithLowConfidenceRetry(
                pre.bytes,
                args.langs ?? langs,
                {
                    threshold: 60,
                    maxRegions: 3,
                    upscale: 2,
                },
            );
            const text = [
                formatOcrBlock(result.initial),
                formatOcrRetryBlock(result),
                formatDigitFixBlock(result.digitFixes),
            ]
                .filter((block) => block.length > 0)
                .join("\n");
            return { text, lines: result.initial.lines.length };
        },
    }));

    tools.register(defineTool({
        name: "vision_color_stats",
        description: "Bucket every pixel into coarse colour categories (white/black/grey/red/green/blue/...) and report each bucket's share of the total.",
        parameters: {
            file_path: { type: "string", required: true, description: "PNG/JPEG/WebP/GIF path on disk." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: { text: { type: "string", required: true } },
            },
            render: (_args, value) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args) => {
            const bytes = await readImageFileSafe(args.file_path);
            const stats = await computeColorStats(bytes);
            return { text: formatColorStatsBlock(stats) };
        },
    }));

    tools.register(defineTool({
        name: "vision_pixel_scan",
        description: "Walk every row of the image and report rows where the target colour's pixel density exceeds a threshold. Use to spot horizontal lines or coloured bands.",
        parameters: {
            file_path: { type: "string", required: true, description: "PNG/JPEG/WebP/GIF path on disk." },
            target: { type: "string", description: "Hex colour (default red #ff0000)." },
            threshold: { type: "number", description: "Minimum row density 0..1, default 0.05." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: { text: { type: "string", required: true } },
            },
            render: (_args, value) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args) => {
            const bytes = await readImageFileSafe(args.file_path);
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
            file_path: { type: "string", required: true, description: "PNG/JPEG/WebP/GIF path on disk." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: { text: { type: "string", required: true } },
            },
            render: (_args, value) => [
                { type: "text", text: value.text },
            ],
        },
        execute: async (args) => {
            const bytes = await readImageFileSafe(args.file_path);
            const result = await readMeta(bytes);
            return { text: formatMetaBlock(result) };
        },
    }));

    ctx.logger.info("[dsh-pseudo-vision] tools registered: vision_ocr, vision_color_stats, vision_pixel_scan, vision_meta");
}

