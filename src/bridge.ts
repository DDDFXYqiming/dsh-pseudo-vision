/**
 * Image→text bridge.
 *
 * When a turn carries an `image` block AND the routed model does not declare
 * image input, swap that block for a structured text block built from the
 * four vision tools (ocr / color-stats / pixel-scan / meta). This is the
 * exact pipeline Yinsen observed the text-only DeepSeek model reconstructing
 * by hand with bash + Python; here it is fixed and reproducible.
 *
 * The bridge never modifies image bytes; the model still receives pure text.
 * The only persistence side effect is an on-disk cache keyed by sha256, so
 * re-attaching the same image within a session skips the work.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { computeColorStats, formatColorStatsBlock } from './vision/color-stats.js';
import { readMeta, formatMetaBlock } from './vision/meta.js';
import { runOcr, formatOcrBlock } from './vision/ocr.js';
import { pixelScan, formatPixelScanBlock } from './vision/pixel-scan.js';

export interface ImageBlockInput {
    attachment: {
        attachmentId: string;
        mediaType: string;
        bytes?: number;
    };
}

export interface ResolvedImage {
    attachmentId: string;
    bytes: Buffer;
    mediaType: string;
    sha256: string;
}

export interface BridgeOptions {
    /** Cache root (per profile). */
    cacheDir: string;
    /** Force re-computation even when a cached result exists. */
    bypassCache?: boolean;
}

/**
 * Convert an image buffer into the structured text block the text-only model
 * will actually consume. Returns a single string with all four blocks
 * concatenated; the caller decides how to splice it into the message stream.
 */
export async function imageToText(
    image: ResolvedImage,
    options: BridgeOptions,
): Promise<string> {
    const cacheKey = `${image.sha256}.json`;
    const cachePath = join(options.cacheDir, cacheKey);

    if (!options.bypassCache) {
        try {
            const cached = JSON.parse(await readFile(cachePath, 'utf-8')) as { text: string };
            return cached.text;
        } catch {
            // fall through to recompute
        }
    }

    const [ocr, colors, scan, meta] = await Promise.all([
        runOcr(image.bytes).catch((error) => {
            console.error('[dsh-pseudo-vision] OCR failed:', error);
            return null;
        }),
        computeColorStats(image.bytes).catch((error) => {
            console.error('[dsh-pseudo-vision] color stats failed:', error);
            return null;
        }),
        pixelScan(image.bytes, { target: 'red' }).catch((error) => {
            console.error('[dsh-pseudo-vision] pixel scan failed:', error);
            return null;
        }),
        readMeta(image.bytes).catch((error) => {
            console.error('[dsh-pseudo-vision] meta failed:', error);
            return null;
        }),
    ]);

    const blocks: string[] = [];
    blocks.push(`[dsh-pseudo-vision] sha256=${image.sha256.slice(0, 12)}  ${image.mediaType}  ${image.bytes.length}B`);
    if (ocr) blocks.push(formatOcrBlock(ocr));
    if (colors) blocks.push(formatColorStatsBlock(colors));
    if (scan) blocks.push(formatPixelScanBlock(scan));
    if (meta) blocks.push(formatMetaBlock(meta));
    const text = blocks.join('\n\n');

    await mkdir(options.cacheDir, { recursive: true }).catch(() => undefined);
    await writeFile(cachePath, JSON.stringify({ text }), 'utf-8').catch(() => undefined);

    return text;
}

/**
 * Compute the sha256 of a buffer; reused by callers that want to dedupe
 * images across the bridge before doing any heavy work.
 */
export function sha256Of(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}