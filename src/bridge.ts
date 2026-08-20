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
 * OCR now runs on a preprocessed copy (budget resize + dark-mode inversion +
 * greyscale/contrast/sharpen + white border, see vision/preprocess.ts), while
 * colour analysis keeps using the ORIGINAL bytes. The only persistence side
 * effect is an on-disk cache keyed by the image hash, resolved budget, and
 * complete OCR pipeline version/parameters, so different preprocessing choices
 * never share a stale result.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { computeColorStats, formatColorStatsBlock } from './vision/color-stats.js';
import { readMeta, formatMetaBlock } from './vision/meta.js';
import {
    formatOcrBlock,
    formatOcrRetryBlock,
    ocrWithLowConfidenceRetry,
} from './vision/ocr.js';
import { pixelScan, formatPixelScanBlock } from './vision/pixel-scan.js';
import { chunkedOcr, type ChunkOcrResult } from './vision/chunk-ocr.js';
import {
    BUDGETS,
    isDarkModeFromStats,
    preprocessForOcr,
} from './vision/preprocess.js';

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
    /** OCR 分辨率预算：'auto' | 'small' | 'normal' | 'large' | 'mega'（缺省 auto）。 */
    ocrBudget?: string;
    /** Tesseract language pack, defaulting to chi_sim+eng. */
    langs?: string;
    /** Skip budget resize/upscale while retaining OCR enhancement. */
    ocrNoResize?: boolean;
}

/** 缓存里存的元数据；budget/尺寸/块数供调用方追溯实际用了什么。 */
interface CacheEntry {
    text: string;
    budget: string;
    width: number;
    height: number;
    chunkCount: number;
    retryCount: number;
    ocrBytes?: number;
}

/** 原图高度超过该值走分块 OCR。 */
const CHUNK_HEIGHT_THRESHOLD = 3000;
const CHUNK_TARGET_HEIGHT = 2000;
const CHUNK_OVERLAP = 100;
const OCR_CONFIDENCE_THRESHOLD = 60;
const OCR_MAX_RETRY_REGIONS = 3;
const OCR_RETRY_UPSCALE = 2;

/** 'auto' 预算下超过该像素数切到 large（>210 万像素）。 */
const AUTO_LARGE_THRESHOLD = 2_100_000;

/**
 * Cache namespace for every OCR-affecting knob. Keep old cache files on disk,
 * but never let a result made by the old fixed pipeline satisfy a new request.
 */
export const OCR_CACHE_PIPELINE =
    'ocr-v2-min224-factor28-up800-border10-dark-enhance-chunk3000-2000-100-retry60-3x2';

export function buildVisionCacheKey(
    sha256: string,
    budget: string,
    params: { langs?: string; noResize?: boolean } = {},
): string {
    const langs = (params.langs ?? 'chi_sim+eng').replace(/[^a-zA-Z0-9+_-]/g, '_');
    const resize = params.noResize === true ? 'original' : 'budget';
    return `${sha256}-${budget}-${resize}-${langs}-${OCR_CACHE_PIPELINE}.json`;
}

function resolveOcrBudget(
    budget: string | undefined,
    width: number,
    height: number,
): string {
    if (budget !== undefined && budget !== 'auto' && Object.hasOwn(BUDGETS, budget)) {
        return budget;
    }
    // auto：小图/常规图用 normal（小图会被放大），超大图用 large。
    return width * height > AUTO_LARGE_THRESHOLD ? 'large' : 'normal';
}

function formatChunkedOcrBlock(result: ChunkOcrResult): string {
    if (result.chunks.length === 0) {
        return `[OCR 整图]\n${result.fullText}`;
    }
    return `[OCR 分块 ${result.chunkCount}]\n${result.fullText}`;
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
    const origMeta = await sharp(image.bytes).metadata();
    const origWidth = origMeta.width ?? 1;
    const origHeight = origMeta.height ?? 1;
    const budget = resolveOcrBudget(options.ocrBudget, origWidth, origHeight);
    const langs = options.langs ?? 'chi_sim+eng';

    const cacheKey = buildVisionCacheKey(image.sha256, budget, {
        langs,
        noResize: options.ocrNoResize,
    });
    const cachePath = join(options.cacheDir, cacheKey);

    if (!options.bypassCache) {
        try {
            const cached = JSON.parse(await readFile(cachePath, 'utf-8')) as CacheEntry;
            return cached.text;
        } catch {
            // fall through to recompute
        }
    }

    // 颜色统计 / 像素扫描 / 元信息用【原图】字节（颜色分析需要真实像素）。
    // 深色模式判定复用同一份颜色统计，preprocessForOcr 因此拿到 override，
    // 内部不再重复检测。
    const [colors, scan, meta] = await Promise.all([
        computeColorStats(image.bytes).catch((error) => {
            console.error('[dsh-pseudo-vision] color stats failed:', error);
            return null;
        }),
        pixelScan(image.bytes, { target: '#ff0000' }).catch((error) => {
            console.error('[dsh-pseudo-vision] pixel scan failed:', error);
            return null;
        }),
        readMeta(image.bytes).catch((error) => {
            console.error('[dsh-pseudo-vision] meta failed:', error);
            return null;
        }),
    ]);

    const darkMode = colors !== null && isDarkModeFromStats(colors);
    const focusY = scan?.rows.map((row) => row.y / Math.max(1, scan.height)) ?? [];

    let ocrBlock: string | null = null;
    let chunkCount = 0;
    let retryCount = 0;
    let ocrWidth = origWidth;
    let ocrHeight = origHeight;
    let ocrBytes = 0;
    let preprocessSummary = `${origWidth}×${origHeight}（原图分块）`;

    if (origHeight > CHUNK_HEIGHT_THRESHOLD) {
        // Important: crop the ORIGINAL tall image first. Resizing the whole
        // screenshot to a visual-token budget would erase the small text that
        // chunking is meant to preserve.
        const chunked = await chunkedOcr(image.bytes, {
            targetHeight: CHUNK_TARGET_HEIGHT,
            overlap: CHUNK_OVERLAP,
            langs,
            focusY,
            confidenceThreshold: OCR_CONFIDENCE_THRESHOLD,
            maxRetryRegions: OCR_MAX_RETRY_REGIONS,
            preprocessChunk: async (bytes) => (
                await preprocessForOcr(bytes, budget, darkMode, options.ocrNoResize)
            ).bytes,
        }).catch((error) => {
            console.error('[dsh-pseudo-vision] chunked OCR failed:', error);
            return null;
        });
        if (chunked !== null) {
            chunkCount = chunked.chunkCount;
            retryCount = chunked.retryCount;
            ocrBlock = formatChunkedOcrBlock(chunked);
            preprocessSummary = `${origWidth}×${origHeight}（每块预算预处理）`;
        }
    } else {
        // Normal images use the complete budget pipeline once, then crop and
        // retry only low-confidence OCR lines at 2× resolution.
        const pre = await preprocessForOcr(
            image.bytes,
            budget,
            darkMode,
            options.ocrNoResize,
        );
        ocrWidth = pre.width;
        ocrHeight = pre.height;
        ocrBytes = pre.bytes.length;
        preprocessSummary = `${pre.width}×${pre.height} ${pre.bytes.length}B`;
        const ocr = await ocrWithLowConfidenceRetry(
            pre.bytes,
            langs,
            {
                threshold: OCR_CONFIDENCE_THRESHOLD,
                maxRegions: OCR_MAX_RETRY_REGIONS,
                upscale: OCR_RETRY_UPSCALE,
                focusY,
            },
        ).catch((error) => {
            console.error('[dsh-pseudo-vision] OCR failed:', error);
            return null;
        });
        if (ocr !== null) {
            retryCount = ocr.retries.length;
            const retryBlock = formatOcrRetryBlock(ocr);
            ocrBlock = [formatOcrBlock(ocr.initial), retryBlock]
                .filter((block) => block.length > 0)
                .join('\n');
        }
    }

    const enhancement = darkMode ? '灰度+反色' : '灰度';
    const blocks: string[] = [];
    blocks.push(
        `[dsh-pseudo-vision] sha256=${image.sha256.slice(0, 12)} budget=${budget} `
        + `原图:${image.mediaType} ${image.bytes.length}B 预处理:${enhancement} ${preprocessSummary}`,
    );
    if (ocrBlock !== null) blocks.push(ocrBlock);
    if (colors !== null) blocks.push(formatColorStatsBlock(colors));
    if (scan !== null) blocks.push(formatPixelScanBlock(scan));
    if (meta !== null) blocks.push(formatMetaBlock(meta));
    const text = blocks.join('\n\n');

    await mkdir(options.cacheDir, { recursive: true }).catch(() => undefined);
    await writeFile(
        cachePath,
        JSON.stringify({
            text,
            budget,
            width: ocrWidth,
            height: ocrHeight,
            chunkCount,
            retryCount,
            ocrBytes,
        }),
        'utf-8',
    ).catch(() => undefined);

    return text;
}

/**
 * Compute the sha256 of a buffer; reused by callers that want to dedupe
 * images across the bridge before doing any heavy work.
 */
export function sha256Of(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}
