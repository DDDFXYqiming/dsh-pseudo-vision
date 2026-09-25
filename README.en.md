[简体中文](README.md) | English

# dsh-pseudo-vision

Gives text-only providers in DeepSeek Harness a layer of "tool vision". Image attachments are broken down into **OCR text + color statistics + pixel scan + metadata** on the LLM dispatch path, so any text-only model can read an image through those words. Everything runs locally, with only local OCR and pixel statistics.

## What it does

- The plugin takes over the `deepseek-official` route, which already handles images natively. Other text-only providers get sibling routes named `dsh-pseudo-vision/<provider>` through the `bridgeProviders` whitelist (shown as `· Pseudo Vision` in the model selector), or all at once via `bridgeOtherProviders`.
- Sibling routes declare `inputModalities: ["text", "image"]`, which is what lets the request pass the host image-admission gate.
- On LLM dispatch there are two paths. Native vision models pass through untouched. For text-only models, the plugin reads the attachment, runs the 4 local tools to turn the image into text, replaces the image block, injects `<pseudo-vision-context>`, then delegates to the original provider.
- Evidence is tiered by turn. Images from the last `fullEvidenceTurns` (default 2) user turns get the full pipeline; older-turn images degrade automatically to **compact evidence** (metadata + colour + scan, no OCR) with a `vision_ocr(file_path=…)` re-fetch pointer, so the model can pull the text back on demand. Re-attaching an old image in a new message restores its full tier.
- Two per-request guards: `maxImages` (default 8) bounds full-tier conversions, `maxTotalEvidenceChars` (default 96 000 characters, ≈24K tokens) bounds the combined evidence text. Over the limit the plugin degrades instead: unconverted images keep an explicit `[图片 N 未转换…]` placeholder and a `[⚠️ 图片处理摘要]` summary line tells the model exactly which images did not take effect.

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

> The key point in the OCR pipeline is that the tesseract.js PSM argument must be a Number; the string `"3"` breaks full-page detection.

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

The GitHub route triggers the `prepare` script, which builds `lib/` from source. On the first `add`, pnpm >= 10 refuses to run build scripts of git dependencies: copy the exact package key pnpm prints into the profile's `pnpm-workspace.yaml`, then re-run `add`:

```yaml
allowBuilds:
  '@dsh-external/dsh-pseudo-vision': true
```

Treat this approval as "let this package run code on your machine at install time". Pin a commit (`github:DDDFXYqiming/dsh-pseudo-vision#<sha>`) if you want later pushes to stop changing what gets built.

## Usage

It works out of the box with the default configuration. The `deepseek-official` route keeps handling images natively. Other providers get no sibling route by default, so opt in explicitly.

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # only this provider gets a sibling route
    ocrBudget: auto                        # also small | normal | large | mega
    ocrNoResize: false                     # true: skip budget resize/upscale
    evidenceMaxChars: 32000                # per-image character cap on model-visible evidence text
    # tessdataDir: "D:/tessdata"           # offline traineddata dir; wins over the PV_TESSDATA env fallback
    maxImages: 8                           # full-tier image count cap per request (1-32)
    maxTotalEvidenceChars: 96000           # combined evidence character cap (16000-320000)
    fullEvidenceTurns: 2                   # recent user turns kept full; older degrade (1-8)
```

You can also set `bridgeOtherProviders` to bridge every provider except the excluded list in one go. The tradeoff is one extra entry per model in the selector, so think before turning it on.

```yaml
    bridgeOtherProviders: true
```

Once configured, sibling routes show up as `dsh-pseudo-vision/<provider>` (`· Pseudo Vision`). Text-only models go through the local pseudo-vision conversion, while native vision models stay untouched.
