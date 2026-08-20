/**
 * Pixel-ratio colour statistics via sharp.
 *
 * Implements the "颜色统计" step Yinsen surfaced: bucket every pixel into
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
}

interface BucketSpec {
    name: string;
    classify: (r: number, g: number, b: number) => boolean;
}

const MAX_DIMENSION = 512;

const BUCKETS: BucketSpec[] = [
    { name: 'white', classify: (r, g, b) => r > 230 && g > 230 && b > 230 },
    { name: 'black', classify: (r, g, b) => r < 25 && g < 25 && b < 25 },
    { name: 'grey', classify: (r, g, b) =>
        Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && Math.abs(r - b) < 15 &&
        r > 25 && r < 230 },
    { name: 'red', classify: (r, g, b) => r > g + 30 && r > b + 30 && r > 100 },
    { name: 'green', classify: (r, g, b) => g > r + 30 && g > b + 30 && g > 100 },
    { name: 'blue', classify: (r, g, b) => b > r + 30 && b > g + 30 && b > 100 },
    { name: 'yellow', classify: (r, g, b) => r > 180 && g > 180 && b < 100 },
    { name: 'cyan', classify: (r, g, b) => g > 180 && b > 180 && r < 100 },
    { name: 'magenta', classify: (r, g, b) => r > 180 && b > 180 && g < 100 },
];

/**
 * Compute colour-bucket shares for an image. Downsamples to MAX_DIMENSION on
 * the longer side first so we never iterate > ~512×512 pixels even for
 * very large source images.
 */
export async function computeColorStats(imageBytes: Buffer): Promise<ColorStats> {
    const { data, info } = await sharp(imageBytes)
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const totalPixels = width * height;
    const counts = new Map<string, number>();

    for (let i = 0; i < data.length; i += channels) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;

        let matched = false;
        for (const bucket of BUCKETS) {
            if (bucket.classify(r, g, b)) {
                counts.set(bucket.name, (counts.get(bucket.name) ?? 0) + 1);
                matched = true;
                break;
            }
        }
        if (!matched) {
            counts.set('other', (counts.get('other') ?? 0) + 1);
        }
    }

    const buckets: ColorBucket[] = [];
    for (const spec of BUCKETS) {
        const pixels = counts.get(spec.name) ?? 0;
        buckets.push({ name: spec.name, share: pixels / totalPixels, pixels });
    }
    const otherPixels = counts.get('other') ?? 0;
    if (otherPixels > 0) {
        buckets.push({ name: 'other', share: otherPixels / totalPixels, pixels: otherPixels });
    }

    buckets.sort((a, b) => b.share - a.share);

    return { totalPixels, buckets };
}

/**
 * Format colour stats as the model-facing block. Mirrors the
 * "颜色统计" step Yinsen surfaced.
 */
export function formatColorStatsBlock(stats: ColorStats): string {
    const significant = stats.buckets.filter((b) => b.share >= 0.005);
    const lines = significant.map((b) => {
        const pct = (b.share * 100).toFixed(1);
        return `  · ${b.name} ${pct}%`;
    });
    return `[颜色统计] 总像素 ${stats.totalPixels}\n${lines.join('\n')}`;
}