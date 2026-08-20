/**
 * OCR 预处理管线 via sharp。
 *
 * 从 dsh-vision-skill 的 vision.py 移植：动态分辨率预算
 * （small/normal/large/mega，参照 Qwen 的 visual-token 预算）、factor 网格
 * 吸附（VLM patch grid 惯例）、小图自适应放大、深色模式反色、灰度 + 对比度
 * 拉伸 + 轻锐化，最后补一圈白边。截图类图片经此管线后 OCR 质量显著提升。
 *
 * 注意：颜色统计 / 像素扫描 / 元信息仍然基于【原图】字节（颜色分析需要真实
 * 像素），只有 OCR 走预处理后的字节——见 bridge.ts。
 */

import sharp from 'sharp';
import { computeColorStats, type ColorStats } from './color-stats.ts';

/** 分辨率预算：像素总数上限（与 vision.py BUDGET_PIXELS 一致）。 */
export const BUDGETS: Record<string, { maxPixels: number; label: string }> = {
    small:  { maxPixels: 512 * 512,   label: '512² ≈ 26 万像素' },
    normal: { maxPixels: 1024 * 1024, label: '1024² ≈ 105 万像素' },
    large:  { maxPixels: 1448 * 1448, label: '1448² ≈ 210 万像素' },
    mega:   { maxPixels: 4096 * 4096, label: '4096² ≈ 1678 万像素' },
};

const DEFAULT_MIN_PIXELS = 224 * 224;
const DEFAULT_FACTOR = 28; // 吸附网格（部分 VLM 的 patch grid 惯例）
const UPSCALE_MIN_DIMENSION = 800;
const WHITE_BORDER_PX = 10;

/**
 * 把 (width, height) 缩放进 [minPixels, maxPixels] 区间并吸附到 factor 的
 * 整数倍。与 vision.py 的 smart_resize 行为一致：两个方向各自独立判断，
 * 吸附无条件执行。
 *
 * @param minPixels 低于该像素数则放大（默认 224²）。
 * @param maxPixels 高于该像素数则缩小。
 */
export function smartResize(
    width: number,
    height: number,
    minPixels: number,
    maxPixels: number,
    factor: number = DEFAULT_FACTOR,
): { width: number; height: number } {
    let w = width;
    let h = height;
    const totalPixels = Math.max(1, w * h);

    if (totalPixels < minPixels) {
        const scale = Math.sqrt(minPixels / totalPixels);
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
    }
    if (w * h > maxPixels) {
        const scale = Math.sqrt(maxPixels / (w * h));
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
    }

    const snap = (value: number): number =>
        Math.max(factor, Math.round(value / factor) * factor);
    w = snap(w);
    h = snap(h);

    // Rounding to the patch grid can push the product a little above the
    // budget. Pull both dimensions down on the same grid until the invariant
    // is true; otherwise a nominal `normal`/`large` budget is not real.
    while (w * h > maxPixels && (w > factor || h > factor)) {
        if (w >= h && w > factor) w -= factor;
        else if (h > factor) h -= factor;
        else break;
    }
    return { width: w, height: h };
}

export interface BudgetResizeResult {
    bytes: Buffer;
    width: number;
    height: number;
    /** true 表示实际发生了缩放（非原图直出）。 */
    resized: boolean;
}

/**
 * 按预算缩放图片。keepOriginal=true 时只读元信息、原样返回（原图直发）。
 */
export async function budgetResize(
    imageBytes: Buffer,
    budget: string,
    keepOriginal: boolean = false,
): Promise<BudgetResizeResult> {
    if (keepOriginal) {
        const meta = await sharp(imageBytes).metadata();
        return {
            bytes: imageBytes,
            width: meta.width ?? 1,
            height: meta.height ?? 1,
            resized: false,
        };
    }

    const spec = BUDGETS[budget] ?? BUDGETS.normal;
    const meta = await sharp(imageBytes).metadata();
    const width = meta.width ?? 1;
    const height = meta.height ?? 1;

    const target = smartResize(width, height, DEFAULT_MIN_PIXELS, spec.maxPixels);
    if (target.width === width && target.height === height) {
        return { bytes: imageBytes, width, height, resized: false };
    }

    const bytes = await sharp(imageBytes)
        .resize(target.width, target.height, { fit: 'fill', kernel: 'lanczos3' })
        .toBuffer();
    return { bytes, width: target.width, height: target.height, resized: true };
}

/**
 * OCR 增强：灰度 → （深色模式时）反色 → 对比度拉伸 → 轻锐化。
 */
export async function enhanceForOcr(
    imageBytes: Buffer,
    isDarkMode: boolean,
): Promise<Buffer> {
    const pipeline = sharp(imageBytes).greyscale();
    if (isDarkMode) {
        // 反色只作用于颜色通道；alpha 保持原样，避免透明区域被翻转成不透明。
        pipeline.negate({ alpha: false });
    }
    return pipeline
        .normalize()
        .sharpen({ sigma: 0.8 })
        .toBuffer();
}

/**
 * 四周补一圈白边，给 OCR 引擎留出安全边距。
 */
export async function addWhiteBorder(
    imageBytes: Buffer,
    borderPx: number = WHITE_BORDER_PX,
): Promise<Buffer> {
    return sharp(imageBytes)
        .extend({
            top: borderPx,
            bottom: borderPx,
            left: borderPx,
            right: borderPx,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .toBuffer();
}

export interface AdaptiveUpscaleResult {
    bytes: Buffer;
    scaled: boolean;
}

/**
 * 小图自适应放大：最长边不足 minDimension 时按 lanczos3 等比放大到该长度。
 */
export async function adaptiveUpscale(
    imageBytes: Buffer,
    minDimension: number = UPSCALE_MIN_DIMENSION,
): Promise<AdaptiveUpscaleResult> {
    const meta = await sharp(imageBytes).metadata();
    const width = meta.width ?? 1;
    const height = meta.height ?? 1;

    const longest = Math.max(width, height);
    if (longest >= minDimension) {
        return { bytes: imageBytes, scaled: false };
    }

    const scale = minDimension / longest;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const bytes = await sharp(imageBytes)
        .resize(targetWidth, targetHeight, { kernel: 'lanczos3' })
        .toBuffer();
    return { bytes, scaled: true };
}

/**
 * 由颜色统计判断深色模式：亮色（白/黄/青/品红）占比低且平均亮度较低
 * → 深色背景（白字反色后变黑字，OCR 更易识别）。没有平均亮度的旧统计
 * 仍使用黑/灰占比规则兼容。
 */
export function isDarkModeFromStats(stats: ColorStats): boolean {
    const share = (name: string): number => {
        const found = stats.buckets.find((b) => b.name === name);
        return found?.share ?? 0;
    };
    const bright = share('white') + share('yellow') + share('cyan') + share('magenta');
    const dark = share('black') + share('grey');
    if (typeof stats.averageLuminance === 'number') {
        return bright < 0.4 && stats.averageLuminance < 115;
    }
    return bright < 0.3 && dark > 0.6;
}

/**
 * 对图片做颜色统计后判断是否深色模式（isDarkModeFromStats 的便捷封装）。
 */
export async function detectDarkMode(imageBytes: Buffer): Promise<boolean> {
    const stats = await computeColorStats(imageBytes);
    return isDarkModeFromStats(stats);
}

export interface PreprocessResult {
    bytes: Buffer;
    width: number;
    height: number;
    resized: boolean;
    enhanced: boolean;
    upscaled: boolean;
    budget: string;
}

/**
 * 完整 OCR 预处理：预算缩放 → 自适应放大 → 深色模式检测（可覆盖）→
 * 灰度/反色/对比度/锐化 → 白边。keepOriginal=true 时跳过两种 resize，
 * 仍保留 OCR 增强与边框步骤。
 */
export async function preprocessForOcr(
    imageBytes: Buffer,
    budget: string,
    darkModeOverride?: boolean,
    keepOriginal: boolean = false,
): Promise<PreprocessResult> {
    const resized = await budgetResize(imageBytes, budget, keepOriginal);
    const spec = BUDGETS[budget] ?? BUDGETS.normal;
    const budgetMaxDimension = Math.floor(Math.sqrt(spec.maxPixels));
    const upscaled = keepOriginal
        ? { bytes: resized.bytes, scaled: false }
        : await adaptiveUpscale(
            resized.bytes,
            Math.min(UPSCALE_MIN_DIMENSION, budgetMaxDimension),
        );

    const isDarkMode = darkModeOverride ?? await detectDarkMode(upscaled.bytes);
    const enhancedBytes = await enhanceForOcr(upscaled.bytes, isDarkMode);
    const bytes = await addWhiteBorder(enhancedBytes, WHITE_BORDER_PX);

    const meta = await sharp(bytes).metadata();
    return {
        bytes,
        width: meta.width ?? 1,
        height: meta.height ?? 1,
        resized: resized.resized,
        enhanced: true, // 增强管线总是执行（灰度/对比度/锐化/白边）
        upscaled: upscaled.scaled,
        budget,
    };
}
