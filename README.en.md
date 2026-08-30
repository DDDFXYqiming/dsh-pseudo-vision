[简体中文](README.md) | English

# dsh-pseudo-vision

Gives text-only providers in DeepSeek Harness a layer of "tool vision". Image attachments are broken down into **OCR text + color statistics + pixel scan + metadata** on the LLM dispatch path, so any text-only model can read an image through those words. Everything runs locally, **no external vision API**.

## What it does

- The plugin takes over the `deepseek-official` route, which already handles images natively. Other text-only providers get sibling routes named `dsh-pseudo-vision/<provider>` through the `bridgeProviders` whitelist (shown as `· Pseudo Vision` in the model selector), or all at once via `bridgeOtherProviders`.
- Sibling routes declare `inputModalities: ["text", "image"]`, which is what lets the request pass the host image-admission gate.
- On LLM dispatch there are two paths. Native vision models pass through untouched. For text-only models, the plugin reads the attachment, runs the 4 local tools to turn the image into text, replaces the image block, injects `<pseudo-vision-context>`, then delegates to the original provider.

## Tools exposed

| Tool | Purpose | Implementation |
|---|---|---|
| `vision_ocr` | Extract every text line (with normalized coordinates) | tesseract.js (chi_sim + eng), pipeline below |
| `vision_color_stats` | 9-bucket pixel share + average luminance | sharp + histogram |
| `vision_pixel_scan` | Row + column multi-bucket scan emitting focusY/focusX | sharp raw pixel access |
| `vision_meta` | Dimensions, format, color space, 4-corner + center samples | sharp metadata |

### OCR pipeline (v5)

1. **Preprocessing** resizes the image on a budget (small/normal/large/mega, snapped to a 28 grid), then detects dark mode (light themes are not inverted), converts to greyscale, and stretches contrast. Salt-pepper noise is detected next, and the 3×3 median denoise runs only when noise is present; clean images skip it so 1px thin strokes are not erased. A light sharpen (σ0.3) and a white border finish the step.
2. **First pass** runs full-page tesseract recognition and emits every text line with per-line confidence; non-text blocks (image/separator) are filtered out.
3. **Low-confidence retry** covers up to 8 regions, with text-like lines ranked first so icon noise lines no longer exhaust the budget. Each region is cropped, upscaled 3× with Lanczos, and re-read in single-block mode (PSM 6). A re-read replaces the main line only when its confidence is higher (the evidence block is still emitted).
4. **CJK post-process** merges inter-character spaces (`通 知` → `通知`) and strips leading icon symbols.
5. **Digit verification** re-reads IP/URL/port/long-number tokens with an ASCII whitelist in single-line mode. Punctuation keeps the first-pass skeleton, and only same-length re-reads with a confidence gain ≥5 are accepted; the `[数字复核 N 处]` audit block records each fix.

> Verified on a real settings-page screenshot. OCR used to return only 3 top lines with all menu text lost; after the fix it returns 11 lines, with "通用设置/模型/通知" fully clean. The key fix was passing the tesseract.js PSM argument as a Number (the string `"3"` breaks full-page detection).

## Install

The GitHub route is the recommended one, assuming network access. When schannel or pnpm blockers hit on Windows, fall back to a local path.

```bash
# GitHub (recommended)
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision

# Local path when schannel / pnpm blockers hit on Windows
git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
cd dsh-pseudo-vision && pnpm install && pnpm build
dsh plugin --profile web add <local absolute path>
```

## Usage

It works out of the box, with no extra configuration. The `deepseek-official` route keeps handling images natively. Other providers get no sibling route by default, so opt in explicitly.

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # only this provider gets a sibling route
    ocrBudget: auto                        # also small | normal | large | mega
    ocrNoResize: false                     # true: skip budget resize/upscale
```

You can also set `bridgeOtherProviders` to bridge every provider except the excluded list in one go. The tradeoff is one extra entry per model in the selector, so think before turning it on.

```yaml
    bridgeOtherProviders: true
```

Once configured, sibling routes show up as `dsh-pseudo-vision/<provider>` (`· Pseudo Vision`). Text-only models go through the local pseudo-vision conversion, while native vision models stay untouched.
