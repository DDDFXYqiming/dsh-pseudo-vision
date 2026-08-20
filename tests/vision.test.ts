/**
 * Smoke tests for the four vision helpers. Run with `node --test tests/`.
 *
 * The tests skip automatically if the optional native deps (sharp, tesseract.js)
 * are not installed — they are only listed as runtime dependencies and the
 * registry install path is best-effort. This keeps the harness green for
 * users who do `git clone` without `pnpm install`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeColorStats, formatColorStatsBlock } from '../src/vision/color-stats.js';
import { readMeta, formatMetaBlock } from '../src/vision/meta.js';
import { pixelScan, formatPixelScanBlock } from '../src/vision/pixel-scan.js';

const TINY_WHITE_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000040000000408060000003a55cfaa0000001a49444154789c63fc0fe1c0c4c0c0c0c8c0c4cbffaafff0300019a000a4f02d1ec7e6b530000000049454e44ae426082',
    'hex',
);

async function tryImport<T>(moduleName: string): Promise<T | null> {
    try {
        return (await import(moduleName)) as T;
    } catch {
        return null;
    }
}

test('color stats format block renders non-empty output', async () => {
    const sharp = await tryImport<typeof import('sharp').default>('sharp');
    if (!sharp) return;

    const stats = await computeColorStats(TINY_WHITE_PNG);
    const formatted = formatColorStatsBlock(stats);

    assert.ok(stats.totalPixels > 0);
    assert.ok(formatted.startsWith('[颜色统计]'));
    assert.ok(stats.buckets.some((b) => b.name === 'white' && b.share > 0.5));
});

test('pixel scan finds nothing on a uniform white image', async () => {
    const sharp = await tryImport<typeof import('sharp').default>('sharp');
    if (!sharp) return;

    const result = await pixelScan(TINY_WHITE_PNG, { target: 'red' });
    assert.equal(result.rows.length, 0);
    assert.equal(result.peak, null);

    const formatted = formatPixelScanBlock(result);
    assert.ok(formatted.includes('无高密度行'));
});

test('meta exposes dimensions and samples', async () => {
    const sharp = await tryImport<typeof import('sharp').default>('sharp');
    if (!sharp) return;

    const result = await readMeta(TINY_WHITE_PNG);
    assert.equal(result.meta.width, 4);
    assert.equal(result.meta.height, 4);
    assert.ok(result.samples.length >= 4);

    const formatted = formatMetaBlock(result);
    assert.ok(formatted.startsWith('[元信息]'));
    assert.ok(formatted.includes('4×4'));
});

test('ocr gracefully reports no text', async () => {
    const tesseract = await tryImport<typeof import('tesseract.js')>('tesseract.js');
    if (!tesseract) return;

    const { runOcr, formatOcrBlock } = await import('../src/vision/ocr.js');
    const result = await runOcr(TINY_WHITE_PNG);
    const formatted = formatOcrBlock(result);

    assert.equal(result.lines.length, 0);
    assert.ok(formatted.startsWith('[OCR'));
});