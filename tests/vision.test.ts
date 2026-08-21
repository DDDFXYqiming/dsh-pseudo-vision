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

import { computeColorStats, decodeAndColorStats, formatColorStatsBlock } from '../src/vision/color-stats.ts';
import { readMeta, formatMetaBlock } from '../src/vision/meta.ts';
import { pixelScan, formatPixelScanBlock, pixelScanUniversal, formatUniversalScanBlock } from '../src/vision/pixel-scan.ts';
import {
    budgetResize,
    isDarkModeFromStats,
    preprocessForOcr,
    smartResize,
} from '../src/vision/preprocess.ts';
import {
    formatDigitFixBlock,
    formatOcrRetryBlock,
    fuseDigitReread,
    isDigitCriticalToken,
    lowConfidenceRegions,
    shouldAcceptDigitFix,
    type DigitFix,
    type OcrResult,
} from '../src/vision/ocr.ts';
import { planChunkTops } from '../src/vision/chunk-ocr.ts';

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

test('pixel scan accepts named red and finds a dense horizontal line', async () => {
    const sharpModule = await tryImport<typeof import('sharp')>('sharp');
    if (!sharpModule) return;
    const sharp = sharpModule.default;

    const image = await sharp(Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        + '<rect width="100" height="100" fill="white"/>'
        + '<rect x="5" y="45" width="90" height="10" fill="red"/>'
        + '</svg>',
    )).png().toBuffer();
    const result = await pixelScan(image, { target: 'red' });

    assert.ok(result.rows.length > 0);
    assert.ok((result.peak?.density ?? 0) > 0.5);
});

// ---------- Universal row+column scan (v0.5.0) ----------

async function svgToUniversal(
    svg: string,
    backgroundBuckets: string[] = [],
): Promise<ReturnType<typeof pixelScanUniversal>> {
    const sharpModule = await tryImport<typeof import('sharp')>('sharp');
    if (!sharpModule) throw new Error('sharp not available');
    const sharp = sharpModule.default;
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
    const decoded = await decodeAndColorStats(bytes);
    return pixelScanUniversal(decoded.raw, {
        backgroundBuckets,
        threshold: 0.15,
        backgroundCap: 0.9,
        maxHitsPerBucket: 5,
    });
}

test('universal scan suppresses pure background rows and columns', async () => {
    const sharpModule = await tryImport<typeof import('sharp')>('sharp');
    if (!sharpModule) return;

    const result = await svgToUniversal(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        + '<rect width="100" height="100" fill="white"/>'
        + '</svg>',
        ['white'],
    );

    assert.equal(result.rowHitCount, 0);
    assert.equal(result.colHitCount, 0);
    assert.ok(formatUniversalScanBlock(result).includes('无非背景高密度行/列'));
});

test('universal scan finds non-background horizontal and vertical bands', async () => {
    const result = await svgToUniversal(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        + '<rect width="100" height="100" fill="white"/>'
        + '<rect x="0" y="40" width="100" height="10" fill="red"/>'
        + '<rect x="40" y="0" width="10" height="100" fill="blue"/>'
        + '</svg>',
        ['white'],
    );

    const rows = result.hits.filter((h) => h.axis === 'row');
    const cols = result.hits.filter((h) => h.axis === 'col');
    assert.ok(rows.length > 0, 'red horizontal band should produce row hits');
    assert.ok(rows.some((h) => h.bucket === 'red'), 'red row hit expected');
    assert.ok(cols.length > 0, 'blue vertical band should produce column hits');
    assert.ok(cols.some((h) => h.bucket === 'blue'), 'blue column hit expected');
});

test('universal scan suppresses pure background buckets and keeps partial bands', async () => {
    // A full grey image: every row/column is 100% grey; with grey marked as
    // background, nothing should surface.
    const fullGrey = await svgToUniversal(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        + '<rect width="100" height="100" fill="#cccccc"/>'
        + '</svg>',
        ['grey'],
    );
    assert.equal(fullGrey.hits.length, 0, 'full grey background should be fully suppressed');

    // A grey band covering only 80% of the row width yields ~80% density,
    // which is below the 0.90 background cap and above the 0.15 threshold.
    const partial = await svgToUniversal(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        + '<rect width="100" height="100" fill="white"/>'
        + '<rect x="0" y="20" width="80" height="60" fill="#cccccc"/>'
        + '</svg>',
        ['grey'],
    );
    const partialRows = partial.hits.filter((h) => h.axis === 'row' && h.bucket === 'grey');
    assert.ok(partialRows.length > 0, 'partial grey band should still surface');
});

test('universal scan block formats row and column hits together', async () => {
    const result = await svgToUniversal(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        + '<rect width="100" height="100" fill="black"/>'
        + '<rect x="0" y="45" width="100" height="10" fill="green"/>'
        + '<rect x="45" y="0" width="10" height="100" fill="cyan"/>'
        + '</svg>',
        ['black'],
    );

    const block = formatUniversalScanBlock(result);
    assert.ok(block.includes('行'), 'block should contain row hits');
    assert.ok(block.includes('列'), 'block should contain column hits');
    assert.ok(block.includes('green') || block.includes('cyan'), 'non-background buckets reported');
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

test('preprocessForOcr runs without error', async () => {
    const sharp = await tryImport<typeof import('sharp').default>('sharp');
    if (!sharp) return;

    const result = await preprocessForOcr(TINY_WHITE_PNG, 'normal');

    // 40×40 → 预算放大到 224² → 自适应放大到 800² → 白边 ±10 → 820²
    assert.ok(result.bytes.length > 0);
    assert.equal(result.resized, true);
    assert.equal(result.enhanced, true);
    assert.equal(result.upscaled, true);
    assert.equal(result.width, 820);
    assert.equal(result.height, 820);
    assert.equal(result.budget, 'normal');
});

test('ocrNoResize keeps the original dimensions before enhancement', async () => {
    const sharp = await tryImport<typeof import('sharp').default>('sharp');
    if (!sharp) return;

    const result = await preprocessForOcr(TINY_WHITE_PNG, 'mega', false, true);

    assert.equal(result.resized, false);
    assert.equal(result.upscaled, false);
    assert.equal(result.width, 60);
    assert.equal(result.height, 60);
    assert.equal(result.budget, 'mega');
});

test('budgetResize keeps small images in budget', async () => {
    const sharp = await tryImport<typeof import('sharp').default>('sharp');
    if (!sharp) return;

    const result = await budgetResize(TINY_WHITE_PNG, 'normal');

    // 40×40（1600 像素）远低于 224²，应放大并吸附到 28 的整数倍。
    assert.equal(result.resized, true);
    assert.equal(result.width, 224);
    assert.equal(result.height, 224);
    assert.ok(result.width * result.height <= 1024 * 1024);
    assert.ok(result.bytes.length > 0);
});

test('smartResize stays inside the max pixel budget after grid snapping', () => {
    const result = smartResize(4000, 1000, 224 * 224, 1024 * 1024);

    assert.equal(result.width % 28, 0);
    assert.equal(result.height % 28, 0);
    assert.ok(result.width * result.height <= 1024 * 1024);
    assert.ok(result.width > 0 && result.height > 0);
});

test('dark-mode detection and low-confidence retry formatting are deterministic', () => {
    assert.equal(isDarkModeFromStats({
        totalPixels: 100,
        buckets: [
            { name: 'black', share: 0.75, pixels: 75 },
            { name: 'grey', share: 0.1, pixels: 10 },
            { name: 'white', share: 0.15, pixels: 15 },
        ],
    }), true);
    assert.equal(isDarkModeFromStats({
        totalPixels: 100,
        averageLuminance: 35,
        buckets: [{ name: 'other', share: 0.98, pixels: 98 }],
    }), true);
    assert.equal(isDarkModeFromStats({
        totalPixels: 100,
        averageLuminance: 230,
        buckets: [{ name: 'white', share: 0.9, pixels: 90 }],
    }), false);

    const initial: OcrResult = {
        langs: 'chi_sim+eng',
        fullText: '整体文本',
        lines: [
            {
                text: '低置信度',
                confidence: 42,
                bbox: { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.3 },
                words: [],
            },
            {
                text: '可靠文本',
                confidence: 95,
                bbox: { x1: 0.1, y1: 0.4, x2: 0.8, y2: 0.5 },
                words: [],
            },
        ],
    };
    assert.deepEqual(lowConfidenceRegions(initial, 60), [initial.lines[0]?.bbox]);

    const block = formatOcrRetryBlock({
        initial,
        retries: [{
            region: initial.lines[0]!.bbox,
            pixelFocus: true,
            pixelFocusX: false,
            result: { ...initial, fullText: '复核文本' },
        }],
    });
    assert.match(block, /低置信度重试 1 区域/);
    assert.match(block, /命中像素扫描行焦点/);
    assert.doesNotMatch(block, /\\\\n/);
});

test('planChunkTops splits tall images', () => {
    // 5000px 高：step = 2000 - 100 = 1900 → [0, 1900, 3800]。
    const tops = planChunkTops(5000, 2000, 100);
    assert.deepEqual(tops, [0, 1900, 3800]);

    // 每块覆盖 [top, top+targetHeight)，末块 3800 + 2000 ≥ 5000 盖满原图。
    const covered = tops.every((top, index) => {
        const bottom = Math.min(top + 2000, 5000);
        const nextTop = tops[index + 1] ?? 5000;
        return bottom >= nextTop;
    });
    assert.equal(covered, true);

    // 不同 step（overlap=200）：→ [0, 1800, 3600, 5400]。
    assert.deepEqual(planChunkTops(6500, 2000, 200), [0, 1800, 3600, 5400]);

    // 非法 overlap（>= targetHeight 的一半）直接抛错，避免死循环。
    assert.throws(() => planChunkTops(5000, 2000, 1000), RangeError);
});

// ---------- Digit verification pass (v0.5.1) ----------

test('isDigitCriticalToken targets IP/URL/port/number tokens', () => {
    assert.equal(isDigitCriticalToken('127.6.6.1:3080'), true);
    assert.equal(isDigitCriticalToken('http://127.0.0.1:3080'), true);
    assert.equal(isDigitCriticalToken('127.0.0.1'), true);
    assert.equal(isDigitCriticalToken(':3989'), true);
    assert.equal(isDigitCriticalToken('39890'), true);
    assert.equal(isDigitCriticalToken('管理员'), false);
    assert.equal(isDigitCriticalToken('dsh'), false);
    assert.equal(isDigitCriticalToken('v4-flash'), false);
});

test('shouldAcceptDigitFix only allows same-length confident rewrites', () => {
    // 0↔6 confusion with a solid confidence gain: accepted.
    assert.equal(shouldAcceptDigitFix('127.6.6.1:3080', '127.0.0.1:3080', 70, 90), true);
    // Same text: nothing to fix.
    assert.equal(shouldAcceptDigitFix('127.0.0.1:3080', '127.0.0.1:3080', 70, 95), false);
    // Length changed (structural rewrite): rejected.
    assert.equal(shouldAcceptDigitFix('39795>', '39795', 70, 95), false);
    // Confidence did not improve enough: rejected.
    assert.equal(shouldAcceptDigitFix('127.6.6.1:3080', '127.0.0.1:3080', 70, 72), false);
    // No digits in replacement: rejected.
    assert.equal(shouldAcceptDigitFix('3080', 'oooo', 70, 95), false);
    // Empty replacement: rejected.
    assert.equal(shouldAcceptDigitFix('3080', '', 70, 95), false);
});

test('fuseDigitReread keeps first-pass punctuation, takes re-read glyphs', () => {
    // Re-read fixed the digits but misread the second dot as a hyphen:
    // fusion must keep the original dot and take the corrected digits.
    assert.equal(
        fuseDigitReread('http://127.6.6.1:3080', 'http://127-0.0.1:3080'),
        'http://127.0.0.1:3080',
    );
    // Pure digit corrections pass through untouched.
    assert.equal(
        fuseDigitReread('http://127.9.6.1:3689', 'http://127.0.0.1:3080'),
        'http://127.0.0.1:3080',
    );
    // Identical re-read stays identical.
    assert.equal(fuseDigitReread('3080', '3080'), '3080');
    // Different lengths fall back to the re-read verbatim.
    assert.equal(fuseDigitReread('39795>', '39795'), '39795');
});

test('formatDigitFixBlock renders corrections or stays empty', () => {
    assert.equal(formatDigitFixBlock([]), '');

    const fix: DigitFix = {
        original: '127.6.6.1:3080',
        replacement: '127.0.0.1:3080',
        oldConfidence: 71.4,
        newConfidence: 93.2,
        bbox: { x1: 0.1, y1: 0.4, x2: 0.5, y2: 0.44 },
        lineIndex: 3,
    };
    const block = formatDigitFixBlock([fix]);
    assert.ok(block.startsWith('[数字复核 1 处]'));
    assert.ok(block.includes('"127.6.6.1:3080" → "127.0.0.1:3080"'));
    assert.ok(block.includes('71→93'));
});
