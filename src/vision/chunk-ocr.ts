/**
 * 超长截图分块 OCR。
 *
 * 长截图（聊天记录 / 网页）直接整图 OCR 时小字会被压没；这里按固定高度切块、
 * 相邻块留 overlap 重叠区，逐块识别后合并全文。逻辑与 dsh-vision-skill 的
 * vision.py long_screenshot_ocr / plan_chunk_tops 一致。
 */

import sharp from 'sharp';
import {
    formatOcrBlock,
    formatOcrRetryBlock,
    ocrWithLowConfidenceRetry,
} from './ocr.ts';

export type ChunkPreprocessor = (bytes: Buffer) => Promise<Buffer>;

export interface ChunkOcrOptions {
    /** 每块目标高度（像素），默认 2000。 */
    targetHeight?: number;
    /** 相邻块重叠高度（像素），默认 100。 */
    overlap?: number;
    /** tessdata 语言（默认取 OCR 的 chi_sim+eng）。 */
    langs?: string;
    /** 对每块单独做预算/增强/放大，避免整张长图先被压扁。 */
    preprocessChunk?: ChunkPreprocessor;
    /** 来自原图像素扫描的归一化 y 焦点。 */
    focusY?: readonly number[];
    /** 来自原图像素扫描的归一化 x 焦点（列）。切块只切 y 方向，x 原样透传。 */
    focusX?: readonly number[];
    /** 低置信度行阈值，默认 60。 */
    confidenceThreshold?: number;
    /** 每块最多重试区域数，默认 3。 */
    maxRetryRegions?: number;
}

export interface ChunkOcrResult {
    chunks: Array<{
        index: number;
        top: number;
        bottom: number;
        /** 该块已格式化的文本（含 `[第 i/N 块，y=top-bottom]` 头）。 */
        text: string;
    }>;
    /** 全部块合并后的完整文本。 */
    fullText: string;
    /** 实际块数（未分块时为 1）。 */
    chunkCount: number;
    /** 所有块触发的低置信度局部重试次数。 */
    retryCount: number;
}

/**
 * 切块计划：从 0 开始每隔 step 取一个 top；若最后一块盖不满原图则补一刀
 * （origH - targetHeight），去重排序后返回。纯函数，可独立测试。
 */
export function planChunkTops(
    origH: number,
    targetHeight: number,
    overlap: number,
): number[] {
    if (overlap < 0 || overlap * 2 >= targetHeight) {
        throw new RangeError('overlap 必须 >= 0 且小于 targetHeight 的一半');
    }
    const step = targetHeight - overlap;
    const tops: number[] = [];
    for (let top = 0; top < origH; top += step) tops.push(top);
    if (tops.length > 0 && tops[tops.length - 1] + targetHeight < origH) {
        tops.push(origH - targetHeight);
    }
    return [...new Set(tops)].sort((a, b) => a - b);
}

/**
 * 分块 OCR：高度 <= targetHeight×1.5 的图片直接整图识别；更高的图片按
 * planChunkTops 切块逐块识别，每块文本带 `[第 i/N 块，y=top-bottom]` 头。
 */
export async function chunkedOcr(
    imageBytes: Buffer,
    options: ChunkOcrOptions = {},
): Promise<ChunkOcrResult> {
    const {
        targetHeight = 2000,
        overlap = 100,
        langs,
        preprocessChunk,
        focusY = [],
        focusX = [],
        confidenceThreshold = 60,
        maxRetryRegions = 3,
    } = options;
    const resolvedLangs = langs ?? 'chi_sim+eng';
    const meta = await sharp(imageBytes).metadata();
    const width = meta.width ?? 1;
    const height = meta.height ?? 1;

    const recognize = async (bytes: Buffer, localFocusY: readonly number[]) => {
        const prepared = preprocessChunk === undefined
            ? bytes
            : await preprocessChunk(bytes);
        return ocrWithLowConfidenceRetry(prepared, resolvedLangs, {
            threshold: confidenceThreshold,
            maxRegions: maxRetryRegions,
            focusY: localFocusY,
            focusX,
        });
    };

    // 短图不分块：整图一次识别，但仍走局部低置信度重试。
    if (height <= targetHeight * 1.5) {
        const result = await recognize(imageBytes, focusY);
        const retryBlock = formatOcrRetryBlock(result);
        return {
            chunks: [],
            fullText: [formatOcrBlock(result.initial), retryBlock]
                .filter((text) => text.length > 0)
                .join('\n'),
            chunkCount: 1,
            retryCount: result.retries.length,
        };
    }

    const tops = planChunkTops(height, targetHeight, overlap);
    const chunks: ChunkOcrResult['chunks'] = [];
    const texts: string[] = [];
    let retryCount = 0;
    for (let index = 0; index < tops.length; index += 1) {
        const top = tops[index] ?? 0;
        const bottom = Math.min(top + targetHeight, height);
        const chunkHeight = bottom - top;
        const chunkBytes = await sharp(imageBytes)
            .extract({ left: 0, top, width, height: chunkHeight })
            .toBuffer();
        const localFocusY = focusY
            .map((y) => (y * height - top) / chunkHeight)
            .filter((y) => y >= 0 && y <= 1);
        const result = await recognize(chunkBytes, localFocusY);
        retryCount += result.retries.length;
        const retryBlock = formatOcrRetryBlock(result);
        const text = `[第 ${index + 1}/${tops.length} 块，y=${top}-${bottom}]\n`
            + formatOcrBlock(result.initial)
            + (retryBlock.length > 0 ? `\n${retryBlock}` : '');
        texts.push(text);
        chunks.push({ index: index + 1, top, bottom, text });
    }

    return {
        chunks,
        fullText: texts.join('\n\n'),
        chunkCount: chunks.length,
        retryCount,
    };
}
