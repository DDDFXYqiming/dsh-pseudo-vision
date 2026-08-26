[简体中文](README.md) | English

# dsh-pseudo-vision

> Adds "tool-layer vision" to text-only providers in DeepSeek Harness: image attachments are converted to OCR text + color statistics + pixel scan + metadata on the LLM dispatch path, so any text-only model can "see" the image. Everything runs locally, **no external vision API**.

## What it does

- Takes over the `deepseek-official` route; generates sibling routes `dsh-pseudo-vision/<provider>` for other text-only providers via a `bridgeProviders` whitelist (or `bridgeOtherProviders`), shown as `· Pseudo Vision` in the model selector
- Sibling routes declare `inputModalities: ["text", "image"]`, so the host image-admission gate accepts the request
- On LLM dispatch: native vision models pass through; for text-only models the plugin reads the attachment, runs the 4 local tools, replaces the image block, injects `<pseudo-vision-context>`, then delegates to the original provider

## Tools exposed

| Tool | Purpose | Implementation |
|---|---|---|
| `vision_ocr` | Extract every text line (with normalized coordinates) | tesseract.js (chi_sim + eng), pipeline below |
| `vision_color_stats` | 9-bucket pixel share + average luminance | sharp + histogram |
| `vision_pixel_scan` | Row + column multi-bucket scan emitting focusY/focusX | sharp raw pixel access |
| `vision_meta` | Dimensions, format, color space, 4-corner + center samples | sharp metadata |

### OCR pipeline (v5)

1. **Preprocessing**: budget resize (small/normal/large/mega, 28-grid snap) → dark-mode detection (no inversion on light themes) → greyscale → contrast stretch → 3×3 median denoise → light sharpen (σ0.3) → white border
2. **First pass**: full-page tesseract recognition with per-line confidence; non-text blocks (image/separator) filtered
3. **Low-confidence retry**: up to 8 regions, **text-like lines ranked first** (icon noise lines no longer exhaust the budget); crop + 3× Lanczos upscale + single-block mode (PSM 6) re-read; **higher-confidence re-reads replace the main line** (evidence block still emitted)
4. **CJK post-process**: inter-character space merge (`通 知` → `通知`), leading icon symbol strip
5. **Digit verification**: IP/URL/port/long-number tokens re-read with an ASCII whitelist + single-line mode; punctuation keeps the first-pass skeleton, only same-length re-reads with confidence gain ≥5 are accepted; `[数字复核 N 处]` audit block

> Verified on a real settings-page screenshot: OCR went from "3 top lines only, all menu text lost" to 11 lines with "通用设置/模型/通知" fully clean. Key fix: tesseract.js PSM must be passed as a Number (the string `"3"` breaks full-page detection).

## Install

```bash
# GitHub (recommended)
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision

# Local path when schannel / pnpm blockers hit on Windows
git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
cd dsh-pseudo-vision && pnpm install && pnpm build
dsh plugin --profile web add <local absolute path>
```

## Usage

Works out of the box. The `deepseek-official` route keeps handling images natively. Other providers don't get sibling routes by default — opt in explicitly:

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # only this provider gets a sibling route
    ocrBudget: auto                        # also small | normal | large | mega
    ocrNoResize: false                     # true: skip budget resize/upscale
```

Bridge every provider except the excluded list (caution: one extra entry per model in the selector):

```yaml
    bridgeOtherProviders: true
```

Sibling routes appear as `dsh-pseudo-vision/<provider>` (`· Pseudo Vision`); text-only models go through the local pseudo-vision conversion, native vision models stay untouched.
