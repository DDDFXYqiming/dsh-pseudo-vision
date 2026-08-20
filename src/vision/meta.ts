/**
 * Image metadata + four-corner / centre sampling via sharp.
 *
 * Implements the "图片元信息" step of the local evidence pipeline: report width × height,
 * media type, colour space, and the dominant colour at the four corners and
 * the centre. The model uses corners to infer layout (e.g. white TL/TR/BL/BR
 * ⇒ "白底") and the centre to anchor "where the main subject is".
 */

import sharp from 'sharp';

export interface ImageMeta {
    width: number;
    height: number;
    format: string;
    space: string;
    channels: number;
    hasAlpha: boolean;
    size: number;
}

export interface ColorSample {
    label: string;
    rgb: [number, number, number];
    hex: string;
}

export interface MetaResult {
    meta: ImageMeta;
    samples: ColorSample[];
}

function rgbToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function rgbToLabel(r: number, g: number, b: number): string {
    if (r > 230 && g > 230 && b > 230) return 'white';
    if (r < 25 && g < 25 && b < 25) return 'black';
    if (Math.abs(r - g) < 15 && Math.abs(g - b) < 15) return 'grey';
    if (r > g + 30 && r > b + 30) return 'red';
    if (g > r + 30 && g > b + 30) return 'green';
    if (b > r + 30 && b > g + 30) return 'blue';
    return 'mixed';
}

/**
 * Read metadata + sample colours. The image is decoded once; sample reads
 * use the raw buffer after a fixed resize so colour reads are deterministic.
 */
export async function readMeta(imageBytes: Buffer): Promise<MetaResult> {
    const image = sharp(imageBytes);
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    const sampleTargets: Array<{ label: string; x: number; y: number }> = [
        { label: 'TL', x: Math.floor(width * 0.05), y: Math.floor(height * 0.05) },
        { label: 'TR', x: Math.floor(width * 0.95), y: Math.floor(height * 0.05) },
        { label: 'BL', x: Math.floor(width * 0.05), y: Math.floor(height * 0.95) },
        { label: 'BR', x: Math.floor(width * 0.95), y: Math.floor(height * 0.95) },
        { label: 'C',  x: Math.floor(width * 0.5),  y: Math.floor(height * 0.5) },
    ];

    const samples: ColorSample[] = [];
    for (const target of sampleTargets) {
        if (target.x <= 0 || target.y <= 0 || target.x >= width || target.y >= height) {
            continue;
        }
        const region = await sharp(imageBytes)
            .extract({
                left: target.x,
                top: target.y,
                width: 1,
                height: 1,
            })
            .removeAlpha()
            .raw()
            .toBuffer();
        const r = region[0] ?? 0;
        const g = region[1] ?? 0;
        const b = region[2] ?? 0;
        const rgb: [number, number, number] = [r, g, b];
        samples.push({
            label: target.label,
            rgb,
            hex: rgbToHex(r, g, b),
        });
    }

    const imageMeta: ImageMeta = {
        width,
        height,
        format: meta.format ?? 'unknown',
        space: meta.space ?? 'unknown',
        channels: meta.channels ?? 0,
        hasAlpha: Boolean(meta.hasAlpha),
        size: imageBytes.length,
    };

    return { meta: imageMeta, samples };
}

/**
 * Format meta + samples as the model-facing evidence block.
 * "图片元信息" rows.
 */
export function formatMetaBlock(result: MetaResult): string {
    const { meta, samples } = result;
    const sizeLine = `尺寸 ${meta.width}×${meta.height}  ${meta.format}  ${meta.space}`;
    const sampleLines = samples.map((s) => {
        const label = rgbToLabel(s.rgb[0], s.rgb[1], s.rgb[2]);
        return `  · [${s.label}] ${s.hex} (${label})`;
    });
    return `[元信息] ${sizeLine}\n${sampleLines.join('\n')}`;
}