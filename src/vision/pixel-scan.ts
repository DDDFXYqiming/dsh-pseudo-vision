/**
 * Row-wise pixel scan via sharp.
 *
 * Two entry points:
 *
 * 1. `pixelScan` — the ORIGINAL single-target scan used by the
 *    `vision_pixel_scan` tool: for a configurable target colour, walk every
 *    row, count matching pixels, and report rows whose density stands out.
 *    Kept byte-for-byte compatible for the manual tool path.
 *
 * 2. `pixelScanUniversal` — the AUTO-BRIDGE scan: one pass over the shared
 *    512px raw buffer, buckets every pixel into the same 9 colour classes as
 *    the colour statistics, and reports BOTH rows and columns whose density
 *    of a non-background bucket exceeds the threshold. Background buckets
 *    (share >= 30% from the colour statistics) are still scanned but only
 *    reported when their density falls inside [threshold, backgroundCap) —
 *    a pure-background band (95%+) is suppressed while an alternating stripe
 *    (80-85%) still surfaces.
 *
 * Pure local work; no model calls.
 */

import sharp from 'sharp';

import {
    classifyPixel,
    COLOR_BUCKET_NAMES,
    type DecodedRaw,
} from './color-stats.ts';

export interface PixelScanOptions {
    /** Target colour in #RRGGBB (default "red"). */
    target?: string;
    /** Minimum row density to surface (default 0.05 = 5%). */
    threshold?: number;
    /** Maximum number of "interesting" rows to report (default 8). */
    maxRows?: number;
    /** Resize longer side before scanning (default 256). */
    sampleSize?: number;
}

export interface PixelScanRow {
    /** 0-based row index in the sampled image. */
    y: number;
    /** Pixels in this row matching the target colour. */
    matched: number;
    /** matched / width. */
    density: number;
}

export interface PixelScanResult {
    target: string;
    width: number;
    height: number;
    rows: PixelScanRow[];
    /** Highest-density row across the scan (handy for "red line at y=…"). */
    peak: PixelScanRow | null;
}

const DEFAULT_OPTIONS: Required<PixelScanOptions> = {
    target: 'red',
    threshold: 0.05,
    maxRows: 8,
    sampleSize: 256,
};

function parseHex(hex: string): [number, number, number] {
    const aliases: Record<string, string> = {
        red: '#ff0000',
        green: '#00ff00',
        blue: '#0000ff',
        white: '#ffffff',
        black: '#000000',
    };
    const value = aliases[hex.trim().toLowerCase()] ?? hex;
    const normalised = value.replace(/^#/, '').padEnd(6, '0');
    const r = Number.parseInt(normalised.slice(0, 2), 16);
    const g = Number.parseInt(normalised.slice(2, 4), 16);
    const b = Number.parseInt(normalised.slice(4, 6), 16);
    return [
        Number.isFinite(r) ? r : 0,
        Number.isFinite(g) ? g : 0,
        Number.isFinite(b) ? b : 0,
    ];
}

/**
 * Returns true if a pixel counts as "matching" the target colour. We use a
 * generous tolerance band (75 RGB units) so anti-aliased edges still match;
 * tightening this would be a follow-up for a stricter classifier.
 */
function matchesTarget(r: number, g: number, b: number, target: [number, number, number]): boolean {
    const dr = Math.abs(r - target[0]);
    const dg = Math.abs(g - target[1]);
    const db = Math.abs(b - target[2]);
    return dr < 75 && dg < 75 && db < 75;
}

/**
 * Scan the image row-by-row, returning rows whose density of the target
 * colour exceeds the configured threshold.
 */
export async function pixelScan(
    imageBytes: Buffer,
    options: PixelScanOptions = {},
): Promise<PixelScanResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const targetRgb = parseHex(opts.target);

    const { data, info } = await sharp(imageBytes)
        .resize({ width: opts.sampleSize, height: opts.sampleSize, fit: 'inside' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const rows: PixelScanRow[] = [];

    for (let y = 0; y < height; y++) {
        let matched = 0;
        const rowStart = y * width * channels;
        for (let x = 0; x < width; x++) {
            const i = rowStart + x * channels;
            const r = data[i] ?? 0;
            const g = data[i + 1] ?? 0;
            const b = data[i + 2] ?? 0;
            if (matchesTarget(r, g, b, targetRgb)) matched++;
        }
        const density = matched / width;
        if (density >= opts.threshold) {
            rows.push({ y, matched, density });
        }
    }

    rows.sort((a, b) => b.density - a.density);
    const top = rows.slice(0, opts.maxRows);
    const peak = top[0] ?? null;

    return {
        target: opts.target,
        width,
        height,
        rows: top,
        peak,
    };
}

/**
 * Format the scan result as the model-facing evidence block.
 * "像素行扫描" rows: "y=… matched=N → 推断...".
 */
export function formatPixelScanBlock(result: PixelScanResult): string {
    if (result.rows.length === 0) {
        return `[像素扫描] target=${result.target} 无高密度行`;
    }
    const lines = result.rows.map((row) => {
        const scaledY = Math.round((row.y / result.height) * 1000) / 10;
        return `  · y=${scaledY.toFixed(1)}%  matched=${row.matched}  density=${(row.density * 100).toFixed(1)}%`;
    });
    const peakNote = result.peak
        ? `peak y=${(result.peak.y / result.height * 100).toFixed(1)}%`
        : 'no peak';
    return `[像素扫描] target=${result.target} ${result.width}×${result.height}\n${lines.join('\n')}\n  (${peakNote})`;
}

/* ------------------------------------------------------------------ *
 * Universal row+column scan (v0.5.0) — auto-bridge evidence path.
 * ------------------------------------------------------------------ */

export interface UniversalScanHit {
    axis: 'row' | 'col';
    /** Normalised position in [0,1]: row y or column x. */
    pos: number;
    /** Bucket name (never 'other'). */
    bucket: string;
    /** Shared pixels of this bucket in the row/column. */
    matched: number;
    /** matched / row-or-column length. */
    density: number;
}

export interface UniversalScanResult {
    width: number;
    height: number;
    /** Buckets treated as background (share >= backgroundShare, decided by colour stats). */
    backgroundBuckets: string[];
    /** Row hits then column hits, each sorted by density desc. */
    hits: UniversalScanHit[];
    rowHitCount: number;
    colHitCount: number;
}

export interface UniversalScanOptions {
    /** Buckets exempt from normal reporting (background candidates). */
    backgroundBuckets?: string[];
    /** Background buckets are reported only below this density cap (default 0.90). */
    backgroundCap?: number;
    /** Minimum density for non-background buckets (default 0.15). */
    threshold?: number;
    /** Maximum hits reported per bucket per axis (default 5). */
    maxHitsPerBucket?: number;
}

const UNIVERSAL_DEFAULTS: Required<Omit<UniversalScanOptions, 'backgroundBuckets'>> = {
    backgroundCap: 0.9,
    threshold: 0.15,
    maxHitsPerBucket: 5,
};

function bucketIndex(name: string): number {
    return COLOR_BUCKET_NAMES.indexOf(name as (typeof COLOR_BUCKET_NAMES)[number]);
}

/**
 * Universal row+column pixel scan over an already-downsampled raw buffer.
 *
 * The raw buffer and colour stats must come from the SAME decode
 * (`decodeAndColorStats`) so both evidence steps observe identical pixels.
 * `backgroundBuckets` is normally derived from the colour statistics
 * (share >= 0.30); those buckets are only reported for densities inside
 * [threshold, backgroundCap).
 */
export async function pixelScanUniversal(
    raw: DecodedRaw,
    options: UniversalScanOptions = {},
): Promise<UniversalScanResult> {
    const opts = { ...UNIVERSAL_DEFAULTS, ...options };
    const background = new Set(options.backgroundBuckets ?? []);
    const { data, width, height, channels } = raw;

    const bucketCount = COLOR_BUCKET_NAMES.length;
    const rowCounts = new Float32Array(height * bucketCount);
    const colCounts = new Float32Array(width * bucketCount);
    const rowTotals = new Float32Array(height);
    const colTotals = new Float32Array(width);

    for (let y = 0; y < height; y++) {
        const rowStart = y * width * channels;
        for (let x = 0; x < width; x++) {
            const i = rowStart + x * channels;
            const bucket = classifyPixel(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
            const index = bucketIndex(bucket);
            if (index < 0) continue; // 'other' never forms a meaningful band
            rowCounts[y * bucketCount + index] += 1;
            colCounts[x * bucketCount + index] += 1;
            rowTotals[y] += 1;
            colTotals[x] += 1;
        }
    }

    const hits: UniversalScanHit[] = [];
    for (let bucketIndexId = 0; bucketIndexId < bucketCount; bucketIndexId++) {
        const name = COLOR_BUCKET_NAMES[bucketIndexId] as string;
        const isBackground = background.has(name);
        const cap = isBackground ? opts.backgroundCap : 1;

        const rowHits: UniversalScanHit[] = [];
        for (let y = 0; y < height; y++) {
            const matched = rowCounts[y * bucketCount + bucketIndexId];
            if (matched <= 0) continue;
            const density = matched / Math.max(1, rowTotals[y]);
            if (density >= opts.threshold && density < cap) {
                rowHits.push({ axis: 'row', pos: y / height, bucket: name, matched, density });
            }
        }
        rowHits.sort((a, b) => b.density - a.density);
        hits.push(...rowHits.slice(0, opts.maxHitsPerBucket));

        const colHits: UniversalScanHit[] = [];
        for (let x = 0; x < width; x++) {
            const matched = colCounts[x * bucketCount + bucketIndexId];
            if (matched <= 0) continue;
            const density = matched / Math.max(1, colTotals[x]);
            if (density >= opts.threshold && density < cap) {
                colHits.push({ axis: 'col', pos: x / width, bucket: name, matched, density });
            }
        }
        colHits.sort((a, b) => b.density - a.density);
        hits.push(...colHits.slice(0, opts.maxHitsPerBucket));
    }

    // Global order: rows first (by density desc), then columns (by density desc).
    hits.sort((a, b) => {
        if (a.axis !== b.axis) return a.axis === 'row' ? -1 : 1;
        return b.density - a.density;
    });

    return {
        width,
        height,
        backgroundBuckets: [...background],
        hits,
        rowHitCount: hits.filter((h) => h.axis === 'row').length,
        colHitCount: hits.filter((h) => h.axis === 'col').length,
    };
}

/** Format the universal scan as the model-facing evidence block. */
export function formatUniversalScanBlock(result: UniversalScanResult): string {
    const bg = result.backgroundBuckets.length > 0
        ? ` 背景豁免:${result.backgroundBuckets.join('/')}`
        : '';
    const total = result.hits.length;
    const header = `[像素扫描] ${result.width}×${result.height}${bg} ${total} 条命中`
        + `（行 ${result.rowHitCount} / 列 ${result.colHitCount}）`;
    if (total === 0) {
        return `${header}\n  无非背景高密度行/列`;
    }
    const lines = result.hits.map((hit) => {
        const pos = (hit.pos * 100).toFixed(1);
        const pct = (hit.density * 100).toFixed(1);
        return `  · ${hit.axis === 'row' ? '行' : '列'} ${hit.axis === 'row' ? 'y' : 'x'}=${pos}%  ${hit.bucket}  ${pct}%`;
    });
    return `${header}\n${lines.join('\n')}`;
}