/**
 * OCR via tesseract.js.
 *
 * Why tesseract.js: pure JS, no native binary, runs in-process inside the
 * DSH Node worker. The same local engine powers the OCR evidence block.
 *
 * Output: an array of lines, each with a normalised bounding box
 * (x1, y1, x2, y2 in [0,1]) and the recognised text. Normalised coordinates
 * mirror what the DSH Web UI shows so the model can correlate the line back
 * to a position in the original image.
 */

import { createWorker, PSM, type Worker } from 'tesseract.js';
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

// Dedicated digit-verification worker. It is created lazily only when a
// digit-critical token needs a second read and lives with its own locked
// parameters (digit whitelist + single-line PSM), so the general-purpose
// worker never sees its state mutated. Same engine, zero new models.
let cachedDigitWorker: Worker | null = null;
let cachedDigitLangs: string | null = null;

// ASCII-only whitelist for digit-critical tokens (IP / URL / port). The point
// is not to forbid letters — URL tokens need them — but to lock out the CJK
// glyph space, which is the dominant noise source for chi_sim+eng on
// terminal-style ASCII text.
const DIGIT_WHITELIST =
    '0123456789.:/-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function getDigitWorker(langs: string): Promise<Worker> {
    if (cachedDigitWorker && cachedDigitLangs === langs) return cachedDigitWorker;
    if (cachedDigitWorker) {
        await cachedDigitWorker.terminate();
        cachedDigitWorker = null;
        cachedDigitLangs = null;
    }
    const worker = await createWorker(langs);
    await worker.setParameters({
        tessedit_char_whitelist: DIGIT_WHITELIST,
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
    });
    cachedDigitWorker = worker;
    cachedDigitLangs = langs;
    return worker;
}

export interface OcrWord {
    text: string;
    /** Normalized word bounding box in [0,1], image-relative. */
    bbox: { x1: number; y1: number; x2: number; y2: number };
    /** Tesseract-reported confidence in [0, 100]. */
    confidence: number;
}

export interface OcrLine {
    text: string;
    /** Normalised bounding box in [0,1], image-relative. */
    bbox: { x1: number; y1: number; x2: number; y2: number };
    /** Tesseract-reported confidence in [0, 100]. */
    confidence: number;
    /** Word-level tokens (used by the digit verification pass). */
    words: OcrWord[];
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
    /** Optional normalized y positions from the row pixel scan. */
    focusY?: readonly number[];
    /** Optional normalized x positions from the column pixel scan. */
    focusX?: readonly number[];
    /** Digit verification pass (default true). */
    digitVerify?: boolean;
    /** Maximum digit-critical tokens to re-verify per image/chunk. */
    maxDigitFixes?: number;
}

export interface OcrRetry {
    region: NormalizedRegion;
    /** Whether a focus row from pixel scanning fell near this region. */
    pixelFocus: boolean;
    /** Whether a focus column from pixel scanning fell near this region. */
    pixelFocusX: boolean;
    result: OcrResult;
}

/** One accepted digit-token correction produced by the verification pass. */
export interface DigitFix {
    original: string;
    replacement: string;
    oldConfidence: number;
    newConfidence: number;
    bbox: OcrLine['bbox'];
    lineIndex: number;
}

export interface OcrRetryResult {
    initial: OcrResult;
    retries: OcrRetry[];
    digitFixes: DigitFix[];
}

/** IP v4 / URL / port / long-number tokens where digit errors hurt the most. */
const DIGIT_CRITICAL_RE = /(\d{1,3}\.){3}\d{1,3}|https?:\/\/|:\d{2,5}(?!\d)|\d{4,}/i;

/** True when the token carries digit-critical payload (IP, URL, port, number). */
export function isDigitCriticalToken(text: string): boolean {
    return DIGIT_CRITICAL_RE.test(text);
}

/**
 * Acceptance rule for a digit re-read: same glyph count (targets 0↔6/9/8
 * style confusions, rejects structural rewrites), strictly better confidence,
 * and the text actually changed while still containing digits.
 */
export function shouldAcceptDigitFix(
    oldText: string,
    newText: string,
    oldConfidence: number,
    newConfidence: number,
): boolean {
    if (newText.length === 0) return false;
    if (newText === oldText) return false;
    if (newText.length !== oldText.length) return false;
    if (!/\d/.test(newText)) return false;
    return newConfidence >= oldConfidence + 5;
}

const TOKEN_PUNCTUATION = new Set(['.', '-', ':', '/', ';', ',']);

/**
 * Fuse a same-length re-read with the original token: punctuation positions
 * keep the first-pass character (segmentation is usually right; glyph
 * identity is what the first pass got wrong), everything else takes the
 * higher-confidence re-read. `127-0.0.1` fused over `127.6.6.1` therefore
 * yields `127.0.0.1`.
 */
export function fuseDigitReread(oldText: string, newText: string): string {
    if (oldText.length !== newText.length) return newText;
    let fused = '';
    for (let i = 0; i < oldText.length; i += 1) {
        const prev = oldText[i];
        const next = newText[i];
        if (prev === next) {
            fused += prev;
        } else if (TOKEN_PUNCTUATION.has(prev) && TOKEN_PUNCTUATION.has(next)) {
            fused += prev;
        } else {
            fused += next;
        }
    }
    return fused;
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
            const words: OcrWord[] = (line.words ?? [])
                .filter((word) => (word.text ?? '').trim().length > 0)
                .map((word) => ({
                    text: (word.text ?? '').trim(),
                    bbox: {
                        x1: word.bbox.x0 / width,
                        y1: word.bbox.y0 / height,
                        x2: word.bbox.x1 / width,
                        y2: word.bbox.y1 / height,
                    },
                    confidence: word.confidence ?? 0,
                }));
            return {
                text: (line.text ?? '').trim(),
                bbox: {
                    x1: bbox.x0 / width,
                    y1: bbox.y0 / height,
                    x2: bbox.x1 / width,
                    y2: bbox.y1 / height,
                },
                confidence: line.confidence ?? 0,
                words,
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
 * screenshot OCR evidence so users can compare the result visually.
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
 * Re-read digit-critical tokens (IP/URL/port/number) from tight 3× crops
 * with a locked digit whitelist on a dedicated worker. Same Tesseract
 * engine, zero new models: we only ask the existing classifier a narrower
 * question. Accepted corrections are applied in-place to the line text.
 */
async function verifyDigitTokens(
    imageBytes: Buffer,
    initial: OcrResult,
    langs: string,
    maxFixes: number,
): Promise<DigitFix[]> {
    const candidates: Array<{ word: OcrWord; lineIndex: number }> = [];
    initial.lines.forEach((line, lineIndex) => {
        for (const word of line.words) {
            if (!isDigitCriticalToken(word.text)) continue;
            if (word.confidence >= 92) continue;
            candidates.push({ word, lineIndex });
        }
    });
    if (candidates.length === 0) return [];
    candidates.sort((a, b) => a.word.confidence - b.word.confidence);
    const picked = candidates.slice(0, Math.max(0, maxFixes));
    if (picked.length === 0) return [];

    const meta = await sharp(imageBytes).metadata();
    const width = meta.width ?? 1;
    const height = meta.height ?? 1;
    const digitWorker = await getDigitWorker(langs);

    const fixes: DigitFix[] = [];
    for (const { word, lineIndex } of picked) {
        const left = Math.max(0, Math.floor(word.bbox.x1 * width) - 4);
        const top = Math.max(0, Math.floor(word.bbox.y1 * height) - 4);
        const right = Math.min(width, Math.ceil(word.bbox.x2 * width) + 4);
        const bottom = Math.min(height, Math.ceil(word.bbox.y2 * height) + 4);
        const cropWidth = Math.max(1, right - left);
        const cropHeight = Math.max(1, bottom - top);
        const crop = await sharp(imageBytes)
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .resize({
                width: Math.max(1, Math.round(cropWidth * 3)),
                height: Math.max(1, Math.round(cropHeight * 3)),
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

        const { data } = await digitWorker.recognize(crop);
        const reread = (data.text ?? '').replace(/\s+/g, '').trim();
        const newText = fuseDigitReread(word.text, reread);
        const newConfidence = (data.blocks ?? [])
            .flatMap((block) => block.paragraphs ?? [])
            .flatMap((para) => para.lines ?? [])
            .map((line) => line.confidence ?? 0)
            .reduce((best, c) => Math.max(best, c), 0);
        if (!shouldAcceptDigitFix(word.text, newText, word.confidence, newConfidence)) {
            continue;
        }
        const line = initial.lines[lineIndex];
        initial.lines[lineIndex] = {
            ...line,
            text: line.text.replace(word.text, newText),
        };
        // Keep fullText consistent with the corrected lines: apply the same
        // first-occurrence replacement to the raw tesseract text.
        initial.fullText = initial.fullText.replace(word.text, newText);
        fixes.push({
            original: word.text,
            replacement: newText,
            oldConfidence: word.confidence,
            newConfidence,
            bbox: word.bbox,
            lineIndex,
        });
    }
    return fixes;
}

/** Format the digit verification corrections as an evidence block. */
export function formatDigitFixBlock(fixes: readonly DigitFix[]): string {
    if (fixes.length === 0) return '';
    const lines = fixes.map((fix) => {
        const y = (fix.bbox.y1 + fix.bbox.y2) / 2;
        const oldConf = Math.round(fix.oldConfidence);
        const newConf = Math.round(fix.newConfidence);
        return `  · y=${y.toFixed(3)} "${fix.original}" → "${fix.replacement}"（置信度 ${oldConf}→${newConf}）`;
    });
    return `[数字复核 ${fixes.length} 处]\n${lines.join('\n')}`;
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
    const focusX = options.focusX ?? [];
    const digitVerify = options.digitVerify ?? true;
    const maxDigitFixes = Math.max(0, Math.floor(options.maxDigitFixes ?? 6));
    const initial = await runOcr(imageBytes, langs);

    const digitFixes = digitVerify
        ? await verifyDigitTokens(imageBytes, initial, langs, maxDigitFixes).catch(() => [])
        : [];

    const regions = lowConfidenceRegions(initial, threshold).slice(0, maxRegions);
    if (regions.length === 0) return { initial, retries: [], digitFixes };

    const meta = await sharp(imageBytes).metadata();
    const width = meta.width ?? 1;
    const height = meta.height ?? 1;
    const retries: OcrRetry[] = [];

    for (const region of regions) {
        const pixelFocus = focusY.some((y) =>
            y >= region.y1 - 0.04 && y <= region.y2 + 0.04,
        );
        const pixelFocusX = focusX.some((x) =>
            x >= region.x1 - 0.04 && x <= region.x2 + 0.04,
        );
        // Focus hits enlarge the crop on the matching axis so separators or
        // vertical band boundaries are not clipped during the retry read.
        const padY = pixelFocus ? Math.max(padding, 24) : padding;
        const padX = pixelFocusX ? Math.max(padding, 24) : padding;
        const left = Math.max(0, Math.floor(region.x1 * width) - padX);
        const top = Math.max(0, Math.floor(region.y1 * height) - padY);
        const right = Math.min(width, Math.ceil(region.x2 * width) + padX);
        const bottom = Math.min(height, Math.ceil(region.y2 * height) + padY);
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
        retries.push({ region, pixelFocus, pixelFocusX, result });
    }

    return { initial, retries, digitFixes };
}

/** Format only the extra readings produced by low-confidence retries. */
export function formatOcrRetryBlock(result: OcrRetryResult): string {
    if (result.retries.length === 0) return '';
    const lines = result.retries.map((retry, index) => {
        const { x1, y1, x2, y2 } = retry.region;
        const focus = [
            retry.pixelFocus ? '行' : null,
            retry.pixelFocusX ? '列' : null,
        ].filter(Boolean).join('·');
        const focusNote = focus.length > 0 ? `，命中像素扫描${focus}焦点` : '';
        const text = retry.result.fullText.trim() || '未识别到文字';
        return `  · 区域 ${index + 1} x=${x1.toFixed(3)}-${x2.toFixed(3)} `
            + `y=${y1.toFixed(3)}-${y2.toFixed(3)}${focusNote}：${text}`;
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
    if (cachedDigitWorker) {
        await cachedDigitWorker.terminate();
        cachedDigitWorker = null;
        cachedDigitLangs = null;
    }
}