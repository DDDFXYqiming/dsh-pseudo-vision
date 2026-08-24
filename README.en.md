[简体中文](README.md) | English

# dsh-pseudo-vision

> Adds "tool-layer vision" to text-only providers in DeepSeek Harness: image attachments are converted to OCR text + color statistics + pixel scan + metadata on the LLM dispatch path, so any text-only model can "see" the image. Everything runs locally, **no external vision API**.

**Verified end-to-end** (opencode-go/go1 + read_image → a pure text model fully described a PowerShell screenshot; the digit verification pass corrected the OCR misread `127.6.6.1:3080` to `http://127.0.0.1:3080`).

## What it does

- Takes over the `deepseek-official` route via `cordis.patch.yml`; the original provider route is untouched
- Generates sibling routes `dsh-pseudo-vision/<provider>` for other text-only providers via a `bridgeProviders` whitelist (or `bridgeOtherProviders`); they appear in the model selector with the `· Pseudo Vision` marker
- Sibling routes declare `inputModalities: ["text", "image"]` in `resolveModel` / `listModels`, so the host image-admission gate accepts the request
- On LLM dispatch: native vision models pass through; for text-only models the plugin reads the attachment, runs the 4 local tools, replaces the image block, injects `<pseudo-vision-context>`, then delegates to the original provider

## Tools exposed

| Tool | Purpose | Implementation |
|---|---|---|
| `vision_ocr` | Extract every text line (with normalized coordinates); includes a digit verification pass for IP / URL / port / long numbers (`0↔6/9/8` glyph re-recognition + punctuation-preserving fusion) | tesseract.js (chi_sim + eng) |
| `vision_color_stats` | 9-bucket pixel share (white / black / grey / red / green / blue / yellow / cyan / magenta / other) + average luminance | sharp + histogram |
| `vision_pixel_scan` | Row + column multi-bucket scan; background buckets suppressed at `≥90%`, partial bands in `[0.15, 0.90)` still surfaced; up to 5 rows + 5 cols per bucket | sharp raw pixel access |
| `vision_meta` | Dimensions, format, color space, 4-corner + center samples | sharp metadata |

> Digit verification (v0.5.1): after the first OCR pass, IP/URL/port/long-number tokens are re-read using an ASCII whitelist + PSM 7 single-line mode; punctuation positions keep the first-pass skeleton (so `127-0.0.1` won't survive — it becomes `127.0.0.1`). Only same-length re-reads with confidence gain ≥5 are accepted; the `[数字复核 N 处]` block keeps a full audit trail.
>
> Universal pixel scan (v0.5.0): shares a 512px downsample with color stats, emits both row and column hits as `focusY` / `focusX` for low-confidence OCR retry padding.

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

Works out of the box. The `deepseek-official` route keeps handling images natively. Other providers don't get sibling routes by default (to keep the model selector clean) — opt in explicitly when you actually need images on a text-only provider:

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

The selector then shows `dsh-pseudo-vision/<provider>` (tagged `· Pseudo Vision`); pick it and text-only models auto-route through local pseudo-vision, native vision models keep their native passthrough.

## Configuration

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: []              # provider whitelist (empty = deepseek-official only)
    bridgeOtherProviders: false      # true = bridge all except excludeProviders
    excludeProviders: []             # exclusion list when bridgeOtherProviders is true
    ocrBudget: auto                  # auto | small | normal | large | mega
    ocrNoResize: false               # true: skip OCR budget resize
    langs: chi_sim+eng              # tesseract language pack
    maxImages: 5                    # max images converted per request
    bypassCache: false              # true: force re-compute
    cacheDir: ''                    # cache dir (default <home>/.dsh/cache/pseudo-vision/)
```

`auto` is the safe default; switch to `large`/`mega` for dense tables / small fonts, `small` to bound local CPU/memory. `ocrNoResize: true` skips budget resize but still runs grayscale / contrast / sharpen / white-border; color stats / pixel scan / meta always read the original image.

## Effect example

A pure text `opencode-go/go1` model, with `read_image` of a PowerShell screenshot, receives this evidence:

```
[dsh-pseudo-vision] sha256=b290f3d7e212 budget=normal 原图:image/png 187415B 预处理:灰度+反色 1196×636 238744B
[OCR chi_sim+eng] 12 行
  · "dsh web: http://127.0.0.1:3080"  x=0.128 y=0.230
  · "dsh web: opening the default browser; pass —-no-open to disable"  x=0.251 y=0.262
  · …
[数字复核 2 处]
  · y=0.230 "http://127.6.6.1:3080" → "http://127.0.0.1:3080"（置信度 34→66）
  · y=0.413 "http://127.9.6.1:3689" → "http://127.0.0.1:3080"（置信度 38→85）
[颜色统计] 总像素 760896  · 平均亮度 57.5/255  · grey 94.3%  · white 4.9%
[像素扫描] 476×512 背景豁免:grey 27 条命中（行 14 / 列 13）
  · 行 y=0.0%  white  99.8%  · 列 x=0.2%  white  71.4%  · …
[元信息] 尺寸 1184×608  png  sRGB
  · [TL] #282c34 (深灰)  · [C] #282c34 (深灰)  · …
```

The model synthesizes a full description purely from this structured evidence — the `[数字复核]` block records the OCR misread and its correction, every step fully auditable.

## Compatibility

| dsh version | Status |
|---|---|
| 0.1.0-rc.7 / 0.1.0-rc.8 | ✅ verified end-to-end |
| **0.1.1-rc.2** | **✅ verified end-to-end (v0.5.2+ overrides `prepareCall` to match the new host interface)** |
| 0.1.0-rc.9 / 0.1.1-rc.1 | ⚠️ structurally compatible, not field-verified |

**Upgrade note for dsh 0.1.1-rc.2**: the host now requires `LlmAdapter.prepareCall` unconditionally; v0.5.1 and earlier throw `this[#deepseek].prepareCall is not a function`. Upgrade to **v0.5.2+**.

## Permissions

- Reads image attachments from the workspace
- Writes temp cache to `~/.dsh/profiles/<profile>/.dsh-pseudo-vision/cache/` (key: sha256 + budget + langs/resize flags + OCR pipeline version + scan version)
- In-process tesseract.js OCR + sharp (first run downloads language pack from tesseract CDN, then offline)
- Takes over the `deepseek-official` provider (disables official `llm-deepseek`, re-registers via plugin)
- Registers sibling routes per config (`bridgeProviders` whitelist or `bridgeOtherProviders`); siblings delegate to the original provider via `ctx.llm.registerAdapter`. **By default no other provider gets a sibling route.**

**Does NOT**: upload images to any external API / modify dsh core / override the original provider adapter (the original route still runs as before).

## Known limits

- Complex spatial relations / real photos: description precision is limited; pseudo-vision evidence ≠ real multimodal understanding
- OCR may still misread other text (digit-critical tokens are now covered by the verification pass; everything else still needs the user to spot-check)
- Color stats give shares only — no layout / icon reconstruction
- Large images: OCR is processed within `ocrBudget`; tall screenshots (height > 3000px) are first chunked, color/pixel/meta still read from the original
- Low-confidence retry covers at most 3 regions; it improves small-text readability but isn't image super-resolution
- **Explicitly NOT planned**: embeddings / external Vision API (violates the "no model" red line) / auto-route to sibling route (must be picked manually to avoid polluting the model's own selector) / npm publish (still installed via `dsh plugin add`)

Full version history in [CHANGELOG.md](./CHANGELOG.md). Related: `dsh-vision-skill` (same author, deprecated); architectural inspiration [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision) (uses external vision API).

## License

MIT
