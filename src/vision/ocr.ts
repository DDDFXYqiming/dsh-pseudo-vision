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
import { fileURLToPath } from 'node:url';

const DEFAULT_LANGS = ['chi_sim+eng'] as const;

/**
 * Local tessdata directory shipped inside this plugin package. Keeping the
 * language packs beside the plugin makes OCR fully offline — no CDN fetch
 * at first use. tsdown bundles the server into `lib/index.js`, so the
 * package root is one level up from the bundle.
 */
const LANG_PATH = fileURLToPath(new URL('../', import.meta.url));

let cachedWorker: Worker | null = null;
let cachedLangs: string | null = null;

async function getWorker(langs: string): Promise<Worker> {
    if (cachedWorker && cachedLangs === langs) return cachedWorker;
    const worker = await createWorker(langs, 1, { langPath: LANG_PATH });
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
 * Tear down the worker; call on plugin unload so reverse effects clean up.
 */
export async function disposeOcr(): Promise<void> {
    if (cachedWorker) {
        await cachedWorker.terminate();
        cachedWorker = null;
        cachedLangs = null;
    }
}