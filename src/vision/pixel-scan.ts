/**
 * Row-wise pixel scan via sharp.
 *
 * Implements the "像素行扫描" step of the local evidence pipeline: for a configurable target
 * colour, walk every row of the image, count matching pixels, and report
 * rows whose density stands out. The model uses this to infer the position
 * of horizontal lines, dominant edges, etc.
 *
 * Pure local work; no model calls.
 */

import sharp from 'sharp';

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