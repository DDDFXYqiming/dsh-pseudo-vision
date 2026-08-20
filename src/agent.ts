/**
 * `apply(ctx)` — the entry point Cordis calls when the bundle is mounted.
 *
 * Responsibilities:
 *   1. Register the four `vision_*` tools so the agent can call them.
 *   2. Inject a Skill section that teaches text-only models how to invoke
 *      the tools when the user pastes an image.
 *   3. Resolve plugin configuration (`cacheDir`, `bypassCache`,
 *      `autoBridge`) from `ctx.config` so the user can tune behaviour
 *      without editing source.
 *
 * Note on "auto-bridge":
 *   The plugin does NOT modify dsh core source. Automatic image→text
 *   substitution at the API gateway level requires either a host-side
 *   patch (out of scope for this plugin) or a client-side composer hook.
 *   The auto-bridge path is wired here so a future client companion can
 *   pick it up without re-plumbing.
 */

import { computeColorStats, formatColorStatsBlock } from './vision/color-stats.js';
import { readMeta, formatMetaBlock } from './vision/meta.js';
import { runOcr, formatOcrBlock } from './vision/ocr.js';
import { pixelScan, formatPixelScanBlock } from './vision/pixel-scan.js';

export interface PseudoVisionConfig {
    cacheDir?: string;
    bypassCache?: boolean;
    autoBridge?: boolean;
    langs?: string;
}

export interface ToolContextLike {
    register(definition: unknown): () => void;
}

export interface SystemPromptLike {
    add?(section: { name: string; content: string }): void;
}

export interface AgentContext {
    config?: PseudoVisionConfig;
    tools?: ToolContextLike;
    systemPrompt?: SystemPromptLike;
    logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

const SKILL_SECTION = `
### dsh-pseudo-vision (image→text bridge)

You have four local vision tools that can analyse images without a multimodal
model. When the user pastes an image AND your current route does NOT declare
\`inputModalities: image\`, do not try to read the image directly — call these
tools instead and reason from their structured output.

- \`vision_ocr\` → recognised text + normalised bbox coords per line
- \`vision_color_stats\` → share of white/black/grey/red/green/blue/...
- \`vision_pixel_scan\` → rows where a target colour density stands out
- \`vision_meta\` → dimensions + four-corner + centre colour samples

Always run all four when the user asks you to look at a screenshot,
diagram, UI mock, or other image. Treat the concatenated output the same
way you would treat a long pasted description: it is the only evidence
you have of the picture.
`.trim();

export function apply(ctx: AgentContext): void {
    const config = ctx.config ?? {};
    const logger = ctx.logger ?? {
        info: console.log,
        warn: console.warn,
        error: console.error,
    };

    logger.info('[dsh-pseudo-vision] mounting');

    if (ctx.systemPrompt?.add) {
        ctx.systemPrompt.add({ name: 'dsh-pseudo-vision', content: SKILL_SECTION });
    }

    const ocrLangs = config.langs ?? 'chi_sim+eng';

    if (!ctx.tools?.register) {
        logger.warn('[dsh-pseudo-vision] ctx.tools.register unavailable; tools will not be exposed');
        return;
    }

    const ocrDef = defineTool({
        name: 'vision_ocr',
        description: 'Extract every text line in an image, returning the recognised text and its normalised bounding box. Powered by tesseract.js. Reads the file path passed by the agent harness; resolves it through the standard filesystem contract.',
        parameters: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'PNG/JPEG/WebP/GIF path on disk.' },
                langs: { type: 'string', description: `tessdata languages, default ${ocrLangs}.` },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                required: ['text'],
                properties: {
                    text: { type: 'string' },
                    lines: { type: 'integer' },
                },
                additionalProperties: false,
            },
            render: (_args, value: { text: string; lines: number }) => value.text,
        },
        execute: async (args: { file_path: string; langs?: string }) => {
            const { readFile } = await import('node:fs/promises');
            const bytes = await readFile(args.file_path);
            const result = await runOcr(bytes, args.langs ?? ocrLangs);
            return { text: formatOcrBlock(result), lines: result.lines.length };
        },
    });
    ctx.tools.register(ocrDef);

    const colorDef = defineTool({
        name: 'vision_color_stats',
        description: 'Bucket every pixel into coarse colour categories (white/black/grey/red/green/blue/...) and report each bucket\'s share of the total.',
        parameters: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'PNG/JPEG/WebP/GIF path on disk.' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                required: ['text'],
                properties: { text: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_args, value: { text: string }) => value.text,
        },
        execute: async (args: { file_path: string }) => {
            const { readFile } = await import('node:fs/promises');
            const bytes = await readFile(args.file_path);
            const stats = await computeColorStats(bytes);
            return { text: formatColorStatsBlock(stats) };
        },
    });
    ctx.tools.register(colorDef);

    const scanDef = defineTool({
        name: 'vision_pixel_scan',
        description: 'Walk every row of the image and report rows where the target colour\'s pixel density exceeds a threshold. Use to spot horizontal lines or coloured bands.',
        parameters: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'PNG/JPEG/WebP/GIF path on disk.' },
                target: { type: 'string', description: 'Hex colour (default red #ff0000).' },
                threshold: { type: 'number', description: 'Minimum row density 0..1, default 0.05.' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                required: ['text'],
                properties: { text: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_args, value: { text: string }) => value.text,
        },
        execute: async (args: { file_path: string; target?: string; threshold?: number }) => {
            const { readFile } = await import('node:fs/promises');
            const bytes = await readFile(args.file_path);
            const result = await pixelScan(bytes, {
                target: args.target ?? 'red',
                threshold: args.threshold ?? 0.05,
            });
            return { text: formatPixelScanBlock(result) };
        },
    });
    ctx.tools.register(scanDef);

    const metaDef = defineTool({
        name: 'vision_meta',
        description: 'Read image metadata (dimensions, format, colour space) and sample colours at the four corners plus the centre. Cheap call, useful for layout inferences.',
        parameters: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'PNG/JPEG/WebP/GIF path on disk.' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                required: ['text'],
                properties: { text: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_args, value: { text: string }) => value.text,
        },
        execute: async (args: { file_path: string }) => {
            const { readFile } = await import('node:fs/promises');
            const bytes = await readFile(args.file_path);
            const result = await readMeta(bytes);
            return { text: formatMetaBlock(result) };
        },
    });
    ctx.tools.register(metaDef);

    logger.info('[dsh-pseudo-vision] tools registered: vision_ocr, vision_color_stats, vision_pixel_scan, vision_meta');
}

/**
 * Local stand-in for `@deepseek-ai/dsh-tool-cordis`'s `defineTool` — we keep
 * the signature minimal here so the plugin does not depend on a specific
 * dsh-tools version. DSH itself will pass its own `defineTool` if the
 * plugin opts in via `inject: ['tools']`; this function exists so the
 * plugin compiles and runs against the local test harness.
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