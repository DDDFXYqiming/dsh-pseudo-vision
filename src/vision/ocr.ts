/**
 * OCR via tesseract.js.
 *
 * Why tesseract.js: pure JS, no native binary, runs in-process inside the
 * DSH Node worker. Same engine Yinsen's "OCR 文字提取" step leans on.
 *
 * Output: an array of lines, each with a normalised bounding box
 * (x1, y1, x2, y2 in [0,1]) and the recognised text. Normalised coordinates
 * mirror what the DSH Web UI shows so the model can correlate the line back
 * to a position in the original image.
 */

import { createWorker, type Worker } from 'tesseract.js';
import sharp from 'sharp';

const DEFAULT_LANGS = ['chi_sim+eng'] as const;

// tesseract.js v5 expects the gzipped training data (`<lang>.traineddata.gz`).
// Omit `langPath` so the worker uses its built-in cache directory under
// `node_modules/tesseract.js/...` and downloads the `.gz` once on first
// use. The cache survives process restarts, so subsequent runs are
// fully offline.

let cachedWorker: Worker | null = null;
let cachedLangs: string | null = null;

async function getWorker(langs: string): Promise<Worker> {
    if (cachedWorker && cachedLangs === langs) return cachedWorker;
    if (cachedWorker) {
        await cachedWorker.terminate();
        cachedWorker = null;
        cachedLangs = null;
    }
    const worker = await createWorker(langs);
    cachedWorker = worker;
    cachedLangs = langs;
    return worker;
}

export interface OcrLine {
    text: string;
    /** Normalised bounding box in [0,1], image-relative. */
    bbox: { x1: number; y1: number; x2: number; y2: number };
    /** Tesseract-reported confidence in [0, 100]. */
    confidence: number;
}

export interface OcrResult {
    langs: string;
    lines: OcrLine[];
    fullText: string;
}

export type NormalizedRegion = OcrLine['bbox'];

export interface OcrRetryOptions {
    /** Retry lines whose Tesseract confidence is below this value. */
    threshold?: number;
    /** Maximum number of low-confidence regions to retry per image/chunk. */
    maxRegions?: number;
    /** Lanczos upscale factor for the retry crop. */
    upscale?: number;
    /** Pixel padding around the OCR bounding box before cropping. */
    padding?: number;
    /** Optional normalized y positions from the red-row pixel scan. */
    focusY?: readonly number[];
}

export interface OcrRetry {
    region: NormalizedRegion;
    /** Whether a focus row from pixel scanning fell near this region. */
    pixelFocus: boolean;
    result: OcrResult;
}

export interface OcrRetryResult {
    initial: OcrResult;
    retries: OcrRetry[];
}

/**
 * Run OCR against an image buffer.
 *
 * @param imageBytes raw image bytes (PNG/JPEG/WebP/GIF).
 * @param langs tessdata langs to load (default `chi_sim+eng`).
 */
export async function runOcr(
    imageBytes: Buffer,
    langs: string = DEFAULT_LANGS.join('+'),
): Promise<OcrResult> {
    const worker = await getWorker(langs);
    const { data } = await worker.recognize(imageBytes);

    const meta = await sharp(imageBytes).metadata();
    const width = meta.width || 1;
    const height = meta.height || 1;

    const lines: OcrLine[] = (data.blocks ?? [])
        .flatMap((block) => block.paragraphs ?? [])
        .flatMap((para) => para.lines ?? [])
        .filter((line) => (line.text ?? '').trim().length > 0)
        .map((line) => {
            const bbox = line.bbox;
            return {
                text: (line.text ?? '').trim(),
                bbox: {
                    x1: bbox.x0 / width,
                    y1: bbox.y0 / height,
                    x2: bbox.x1 / width,
                    y2: bbox.y1 / height,
                },
                confidence: line.confidence ?? 0,
            };
        });

    return {
        langs,
        lines,
        fullText: (data.text ?? '').trim(),
    };
}

/**
 * Format OCR result as the block we inject into the prompt. Mirrors the
 * Yinsen screenshot's "OCR 文字提取" step so users can compare visually.
 */
export function formatOcrBlock(result: OcrResult): string {
    if (result.lines.length === 0) {
        return `[OCR] no text detected`;
    }
    const lines = result.lines
        .map((line, index) => {
            const { x1, y1, x2, y2 } = line.bbox;
            const cx = (x1 + x2) / 2;
            const cy = (y1 + y2) / 2;
            const truncated = line.text.length > 80
                ? line.text.slice(0, 77) + '…'
                : line.text;
            return `  · "${truncated}"  x=${cx.toFixed(3)} y=${cy.toFixed(3)}`;
        })
        .join('\n');
    return `[OCR ${result.langs}] ${result.lines.length} 行\n${lines}`;
}

/**
 * 计算 OCR 结果的平均置信度（0-100）。
 */
export function averageConfidence(result: OcrResult): number {
    if (result.lines.length === 0) return 0;
    return result.lines.reduce((sum, l) => sum + l.confidence, 0) / result.lines.length;
}

/**
 * 过滤低置信度行，返回这些行在原图中的归一化区域。
 */
export function lowConfidenceRegions(
    result: OcrResult,
    threshold = 60,
): NormalizedRegion[] {
    return result.lines
        .filter((l) => l.confidence < threshold)
        .sort((a, b) => a.confidence - b.confidence)
        .map((l) => l.bbox);
}

/**
 * OCR once, then retry the worst lines from tight crops. The crop is padded,
 * enlarged with Lanczos, and sent through the same worker again. This keeps
 * the first pass as complete evidence while adding a higher-resolution local
 * reading for small or blurry text instead of silently replacing it.
 *
 * `focusY` is an optional hint from pixel_scan (normally red horizontal rows):
 * a matching row makes the crop slightly taller so anti-aliased separators or
 * underlined text are not clipped at the edge.
 */
export async function ocrWithLowConfidenceRetry(
    imageBytes: Buffer,
    langs: string = DEFAULT_LANGS.join('+'),
    options: OcrRetryOptions = {},
): Promise<OcrRetryResult> {
    const threshold = options.threshold ?? 60;
    const maxRegions = Math.max(0, Math.floor(options.maxRegions ?? 3));
    const upscale = Math.max(1, options.upscale ?? 2);
    const padding = Math.max(0, Math.floor(options.padding ?? 16));
    const focusY = options.focusY ?? [];
    const initial = await runOcr(imageBytes, langs);
    const regions = lowConfidenceRegions(initial, threshold).slice(0, maxRegions);
    if (regions.length === 0) return { initial, retries: [] };

    const meta = await sharp(imageBytes).metadata();
    const width = meta.width ?? 1;
    const height = meta.height ?? 1;
    const retries: OcrRetry[] = [];

    for (const region of regions) {
        const pixelFocus = focusY.some((y) =>
            y >= region.y1 - 0.04 && y <= region.y2 + 0.04,
        );
        const effectivePadding = pixelFocus ? Math.max(padding, 24) : padding;
        const left = Math.max(0, Math.floor(region.x1 * width) - effectivePadding);
        const top = Math.max(0, Math.floor(region.y1 * height) - effectivePadding);
        const right = Math.min(width, Math.ceil(region.x2 * width) + effectivePadding);
        const bottom = Math.min(height, Math.ceil(region.y2 * height) + effectivePadding);
        const cropWidth = Math.max(1, right - left);
        const cropHeight = Math.max(1, bottom - top);

        const crop = await sharp(imageBytes)
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .resize({
                width: Math.max(1, Math.round(cropWidth * upscale)),
                height: Math.max(1, Math.round(cropHeight * upscale)),
                fit: 'fill',
                kernel: 'lanczos3',
            })
            .extend({
                top: 10,
                bottom: 10,
                left: 10,
                right: 10,
                background: { r: 255, g: 255, b: 255, alpha: 1 },
            })
            .toBuffer();
        const result = await runOcr(crop, langs);
        retries.push({ region, pixelFocus, result });
    }

    return { initial, retries };
}

/** Format only the extra readings produced by low-confidence retries. */
export function formatOcrRetryBlock(result: OcrRetryResult): string {
    if (result.retries.length === 0) return '';
    const lines = result.retries.map((retry, index) => {
        const { x1, y1, x2, y2 } = retry.region;
        const focus = retry.pixelFocus ? '，命中像素扫描焦点' : '';
        const text = retry.result.fullText.trim() || '未识别到文字';
        return `  · 区域 ${index + 1} x=${x1.toFixed(3)}-${x2.toFixed(3)} `
            + `y=${y1.toFixed(3)}-${y2.toFixed(3)}${focus}：${text}`;
    });
    return `[OCR 低置信度重试 ${result.retries.length} 区域]\n${lines.join('\n')}`;
}

/**
 * Tear down the worker; call on plugin unload so reverse effects clean up.
 */
export async function disposeOcr(): Promise<void> {
    if (cachedWorker) {
        await cachedWorker.terminate();
        cachedWorker = null;
        cachedLangs = null;
    }
}