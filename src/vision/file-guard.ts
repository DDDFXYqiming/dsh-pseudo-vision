/**
 * 本地图像读取护栏（v0.5.4）：
 * vision_* 工具接受任意 file_path——先做大小上限（防内存耗尽）与
 * magic-number 嗅探（防把任意二进制/文本文件丢进 OCR 管线并回灌对话）。
 */
import { readFile, stat } from "node:fs/promises";

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export function looksLikeImage(bytes: Uint8Array): boolean {
    // PNG: 89 50 4E 47；JPEG: FF D8 FF；WebP: RIFF....WEBP（52 49 46 46 .. 57 45 42 50）；GIF: 47 49 46 38
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
    return false;
}

export async function readImageFileSafe(filePath: string): Promise<Buffer> {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error(`vision: 不是普通文件（目录/设备/符号链接目标异常）: ${filePath}`);
    if (st.size === 0) throw new Error(`vision: 文件为空: ${filePath}`);
    if (st.size > MAX_IMAGE_BYTES) {
        throw new Error(`vision: 文件过大（${st.size} bytes > 64MB 上限）: ${filePath}`);
    }
    const bytes = await readFile(filePath);
    if (!looksLikeImage(bytes)) {
        throw new Error(`vision: 文件不是受支持的图片格式（PNG/JPEG/WebP/GIF magic-number 校验失败）: ${filePath}`);
    }
    return bytes;
}
