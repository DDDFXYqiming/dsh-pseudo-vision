/**
 * Pixel-ratio colour statistics via sharp.
 *
 * Implements the "颜色统计" step of the local evidence pipeline: bucket every pixel into
 * coarse colour categories (white / black / grey / red / green / blue /
 * yellow / cyan / magenta / other) and emit the share each bucket owns.
 *
 * Pure local work; no model calls.
 */

import sharp from 'sharp';

export interface ColorBucket {
    name: string;
    /** [0, 1] share of pixels in this bucket. */
    share: number;
    /** Number of pixels that fell into this bucket. */
    pixels: number;
}

export interface ColorStats {
    totalPixels: number;
    buckets: ColorBucket[];
    /** Mean perceived brightness (0..255), used for dark-mode detection. */
    averageLuminance?: number;
}

export const COLOR_BUCKET_NAMES = [
    'white',
    'black',
    'grey',
    'red',
    'green',
    'blue',
    'yellow',
    'cyan',
    'magenta',
] as const;

export type ColorBucketName = (typeof COLOR_BUCKET_NAMES)[number];

const MAX_DIMENSION = 512;

/** Classify one RGB pixel into a coarse bucket name, or 'other'. */
export function classifyPixel(r: number, g: number, b: number): string {
    if (r > 230 && g > 230 && b > 230) return 'white';
    if (r < 25 && g < 25 && b < 25) return 'black';
    if (Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && Math.abs(r - b) < 15
        && r > 25 && r < 230) return 'grey';
    if (r > g + 30 && r > b + 30 && r > 100) return 'red';
    if (g > r + 30 && g > b + 30 && g > 100) return 'green';
    if (b > r + 30 && b > g + 30 && b > 100) return 'blue';
    if (r > 180 && g > 180 && b < 100) return 'yellow';
    if (g > 180 && b > 180 && r < 100) return 'cyan';
    if (r > 180 && b > 180 && g < 100) return 'magenta';
    return 'other';
}

export interface DecodedRaw {
    data: Buffer;
    width: number;
    height: number;
    channels: number;
}

/**
 * Compute colour-bucket shares from an ALREADY downsampled raw buffer.
 * Used by the bridge so colour statistics and the universal pixel scan
 * observe the exact same pixels (one resize, consistent bucketing).
 */
export async function colorStatsFromRaw(raw: DecodedRaw): Promise<ColorStats> {
    const { data, width, height, channels } = raw;
    const totalPixels = width * height;
    const counts = new Map<string, number>();
    let luminanceSum = 0;

    for (let i = 0; i < data.length; i += channels) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        luminanceSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;

        const bucket = classifyPixel(r, g, b);
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }

    const buckets: ColorBucket[] = [];
    for (const name of COLOR_BUCKET_NAMES) {
        const pixels = counts.get(name) ?? 0;
        buckets.push({ name, share: pixels / totalPixels, pixels });
    }
    const otherPixels = counts.get('other') ?? 0;
    if (otherPixels > 0) {
        buckets.push({ name: 'other', share: otherPixels / totalPixels, pixels: otherPixels });
    }

    buckets.sort((a, b) => b.share - a.share);

    return {
        totalPixels,
        buckets,
        averageLuminance: luminanceSum / Math.max(1, totalPixels),
    };
}

/**
 * Downsample the image to MAX_DIMENSION and return raw + colour stats.
 * The raw buffer is shared with the pixel scanner so both see the same pixels.
 */
export async function decodeAndColorStats(imageBytes: Buffer): Promise<{
    raw: DecodedRaw;
    stats: ColorStats;
}> {
    const { data, info } = await sharp(imageBytes)
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const raw = { data: data as Buffer, width: info.width, height: info.height, channels: info.channels };
    const stats = await colorStatsFromRaw(raw);
    return { raw, stats };
}

/**
 * Compute colour-bucket shares for an image. Downsamples to MAX_DIMENSION on
 * the longer side first so we never iterate > ~512×512 pixels even for
 * very large source images.
 */
export async function computeColorStats(imageBytes: Buffer): Promise<ColorStats> {
    const data = await decodeAndColorStats(imageBytes);
    return data.stats;
}

/**
 * Format colour stats as the model-facing block. Mirrors the
 * "颜色统计" evidence step.
 */
export function formatColorStatsBlock(stats: ColorStats): string {
    const significant = stats.buckets.filter((b) => b.share >= 0.005);
    const lines = significant.map((b) => {
        const pct = (b.share * 100).toFixed(1);
        return `  · ${b.name} ${pct}%`;
    });
    const luminance = stats.averageLuminance;
    const brightness = typeof luminance === 'number' && Number.isFinite(luminance)
        ? `\n  · 平均亮度 ${luminance.toFixed(1)}/255`
        : '';
    return `[颜色统计] 总像素 ${stats.totalPixels}${brightness}\n${lines.join('\n')}`;
}