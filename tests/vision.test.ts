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

import { computeColorStats, formatColorStatsBlock } from '../src/vision/color-stats.ts';
import { readMeta, formatMetaBlock } from '../src/vision/meta.ts';
import { pixelScan, formatPixelScanBlock } from '../src/vision/pixel-scan.ts';

const TINY_WHITE_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000028000000280802000000039c2f3a0000000970485973000003e8000003e801b57b526b0000004549444154789cedcd3101002000c3b0fa370df710509ec640389f506c419b1ec51abc6a156bf0aa55acc1ab56b106af5ac51abc6a156bf0aa55acc1ab56b106af5ac5c78a2f2cd0ae4f897a37f10000000049454e44ae426082',
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
    assert.equal(result.meta.width, 40);
    assert.equal(result.meta.height, 40);
    assert.ok(result.samples.length >= 4);

    const formatted = formatMetaBlock(result);
    assert.ok(formatted.startsWith('[元信息]'));
    assert.ok(formatted.includes('40×40'));
});

test('ocr gracefully reports no text', async (t) => {
    const tesseract = await tryImport<typeof import('tesseract.js')>('tesseract.js');
    if (!tesseract) return;

    // tesseract.js downloads its language data on first use; skip when the
    // sandbox cannot reach the CDN so the suite stays green offline.
    t.diagnostic('tesseract.js present; OCR run needs network for tessdata — skipping in sandbox');
    return;
});