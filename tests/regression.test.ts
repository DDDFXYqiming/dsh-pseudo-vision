/**
 * v0.5.4 回归测试：vision_* 文件读取护栏（大小/magic-number）、
 * OCR 位置感知替换（replaceNth）与 fullText 一致性重建。
 * Run with `node --experimental-strip-types --test tests/regression.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { looksLikeImage, readImageFileSafe, MAX_IMAGE_BYTES } from '../src/vision/file-guard.ts';
import { replaceNth, rebuildFullText, type OcrLine } from '../src/vision/ocr.ts';
import { capEvidence, MAX_EVIDENCE_CHARS, DEFAULT_IMAGE_PIXEL_BUDGET } from '../lib/index.js';

// 1×1 透明 PNG（最小合法 PNG 文件）
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

test('looksLikeImage accepts PNG/JPEG/WebP/GIF magic numbers', () => {
    assert.equal(looksLikeImage(TINY_PNG), true);
    assert.equal(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), true);
    assert.equal(looksLikeImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), true);
    assert.equal(looksLikeImage(Buffer.from('GIF89a....')), true);
    assert.equal(looksLikeImage(Buffer.from('GIF87a....')), true);
});

test('looksLikeImage rejects text and arbitrary binaries', () => {
    assert.equal(looksLikeImage(Buffer.from('hello world, this is a text file')), false);
    assert.equal(looksLikeImage(Buffer.from([0x00, 0x01, 0x02, 0x03])), false);
    assert.equal(looksLikeImage(Buffer.alloc(0)), false);
});

test('readImageFileSafe rejects directories, empty files, text files and oversized files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pv-guard-'));
    try {
        // 目录
        await assert.rejects(() => readImageFileSafe(dir), /不是普通文件/);
        // 空文件
        const empty = join(dir, 'empty.png');
        writeFileSync(empty, '');
        await assert.rejects(() => readImageFileSafe(empty), /文件为空/);
        // 文本伪装成图片
        const fake = join(dir, 'fake.png');
        writeFileSync(fake, 'this is not an image at all');
        await assert.rejects(() => readImageFileSafe(fake), /magic-number 校验失败/);
        // 超 64MB
        const huge = join(dir, 'huge.png');
        writeFileSync(huge, Buffer.alloc(MAX_IMAGE_BYTES + 1));
        await assert.rejects(() => readImageFileSafe(huge), /文件过大/);
        // 合法 PNG 放行
        const ok = join(dir, 'ok.png');
        writeFileSync(ok, TINY_PNG);
        const bytes = await readImageFileSafe(ok);
        assert.deepEqual(bytes, TINY_PNG);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('replaceNth only rewrites the target occurrence (duplicate-token safety)', () => {
    const row = '127.0.0.1 22 127.0.0.1 443';
    // 第 1 次出现（0-based 0）
    assert.equal(replaceNth(row, '127.0.0.1', '127.6.6.1', 0), '127.6.6.1 22 127.0.0.1 443');
    // 第 2 次出现（0-based 1）
    assert.equal(replaceNth(row, '127.0.0.1', '127.6.6.1', 1), '127.0.0.1 22 127.6.6.1 443');
    // 超过出现次数 → null（调用方回退首次替换）
    assert.equal(replaceNth(row, '127.0.0.1', 'x', 5), null);
    // 不存在的 needle → null
    assert.equal(replaceNth(row, 'nope', 'x', 0), null);
    // 空 needle → null
    assert.equal(replaceNth(row, '', 'x', 0), null);
});

test('rebuildFullText joins corrected lines as the single source of truth', () => {
    const line = (text: string, n: number): OcrLine => ({
        text,
        bbox: { x1: 0, y1: 0, x2: 1, y2: 1 },
        confidence: 90,
        words: [],
        lineNumber: n,
    });
    const lines = [line('导航', 1), line('127.0.0.1', 2)];
    assert.equal(rebuildFullText(lines), '导航\n127.0.0.1');
});

test('evidence budget: admission default is 16M and text is capped at 32K chars', () => {
    assert.equal(DEFAULT_IMAGE_PIXEL_BUDGET, 16_000_000);
    // 未超限原样返回
    assert.equal(capEvidence('短证据'), '短证据');
    // 超限截断 + 标注
    const big = '字'.repeat(MAX_EVIDENCE_CHARS + 10);
    const capped = capEvidence(big);
    assert.equal(capped.slice(0, MAX_EVIDENCE_CHARS), big.slice(0, MAX_EVIDENCE_CHARS));
    assert.ok(capped.length > MAX_EVIDENCE_CHARS);
    assert.match(capped, /证据已截断/);
});
