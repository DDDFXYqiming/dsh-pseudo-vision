[简体中文](README.md) | English

# dsh-pseudo-vision

> Adds "tool-layer vision" to text-only providers in DeepSeek Harness: before an image reaches the model, it is automatically decomposed into OCR text + color statistics + pixel scan + metadata, so any text-only model can "see" images.

**Verified on a live setup** (tested on dsh 0.1.0-rc.8 / deepseek-v4-flash: after receiving the image, the model correctly read out the OCR text, color shares, image dimensions, and answered).

## What It Does

When `deepseek-v4-flash` (text-only) receives a `read_image` failure, it can use `bash` + Python to assemble OCR, pixel analysis, color statistics, and metadata, converting the image into structured text.

**dsh-pseudo-vision packages this local evidence pipeline into a plugin capability**:

1. Takes over the official `deepseek-official` route via `cordis.patch.yml`, keeping existing DeepSeek behavior intact
2. Generates sibling routes for other registered providers based on the `bridgeProviders` whitelist (or explicit `bridgeOtherProviders`), e.g. `dsh-pseudo-vision/kimi-for-coding`, `dsh-pseudo-vision/openrouter`
3. **Automatically flagged as vision-capable**: the sibling routes' `resolveModel` / `listModels` force-declare `inputModalities: ["text", "image"]`, so requests pass DSH's image admission gate first
4. **Pseudo vision on request**: native vision models are passed through untouched; for text-only models, attachments are read → converted to text by the 4 local tools → the image block is replaced and a `<pseudo-vision-context>` injected → the request is delegated back to the original provider

**Everything runs locally; no external vision API**. The HTTP request to the original provider contains text only, so text-only gateways won't return 400; the original provider route itself is not modified.

## Capabilities

| Tool | Purpose | Implementation |
|---|---|---|
| `vision_ocr` | Extract all text in the image (with normalized coordinates) | tesseract.js (chi_sim + eng, local language packs) |
| `vision_color_stats` | Pixel share analysis (white/black/grey/red/green/blue/yellow/cyan/magenta/other) | sharp + histogram statistics |
| `vision_pixel_scan` | Under automatic bridging, detects multi-bucket pixel density row by row / column by column; manual calls can still specify a target color | sharp raw pixel access |
| `vision_meta` | Dimensions, format, color space, corner/center color sampling | sharp metadata |

## Local Evidence Pipeline (v0.5.0)

Image evidence is still generated entirely on the local machine; OCR runs through a traceable preprocessing pipeline under a budget, and pixel scanning has been generalized:

```yaml
- id: dsh-pseudo-vision
  config:
    ocrBudget: auto       # auto | small | normal | large | mega
```

### Original-Image Evidence vs. OCR Preprocessing Boundary

The four kinds of visual evidence never share modified image bytes; the processing branches are:

```text
Original image bytes
├─ vision_color_stats → color shares of the original image (9-bucket classification)
├─ vision_pixel_scan  → generic row/column scan of the original image (multi-bucket, background-bucket suppression)
├─ vision_meta        → original image dimensions, format, and sampling
└─ vision_ocr         → OCR-only copy (budget, grayscale, inversion, enhancement)
```

The automatic pseudo-vision bridge applies scaling, grayscale, inversion, contrast, sharpening, and white padding only to the OCR copy; color statistics, pixel scanning, and metadata are always based on the original image. Calling the `vision_ocr` tool directly also reads the original bytes. All processing happens locally; the original image is never sent to an external vision API.

`ocrNoResize: true` means skipping the OCR branch's budget scaling and adaptive upscaling while preserving the original geometric dimensions; it does **not** disable preprocessing entirely — the OCR copy is still enhanced and given a white border (the final copy gains border pixels as a result). It also does not affect the other three tools reading the original image.

### Generalized Pixel Scan (v0.5.0)

In older versions, the automatic bridge's pixel scan **only detected red horizontal rows**, so UI screenshots without red elements often produced "no high-density red rows", forcing the model to call `vision_pixel_scan` repeatedly with different target colors.

v0.5.0 switches to **generic row + column scanning**:

- Reuses the 9 buckets from color statistics (white/black/grey/red/green/blue/yellow/cyan/magenta), scanning **both rows and columns**
- Buckets with a share `≥30%` in color statistics are identified as background-candidate buckets; when such a bucket's row/column density is `≥90%`, it is treated as pure background and **not reported**, but partial bands in the `[0.15, 0.90)` range (e.g. alternating table rows, grey separator bands) are still surfaced
- Non-background buckets use a uniform threshold of `0.15`, with at most 5 row hits + 5 column hits reported per bucket
- Color statistics and pixel scanning **share a single 512px downsampled** raw dataset, guaranteeing both see the same image
- Scan results also produce `focusY` (row hits) and `focusX` (column hits); low-confidence OCR re-verification enlarges the crop padding along the corresponding axis accordingly

When calling `vision_pixel_scan` manually, the `target` parameter can still specify any color, keeping the old behavior unchanged.

### Digit Re-verification Channel (v0.5.1)

Tesseract's classic misreading of small terminal text is `0↔6/9/8` glyph confusion — e.g. reading `127.0.0.1:3080` as `127.6.6.1:3080` — and it often "confidently misreads" (whole-line confidence isn't low, so low-confidence re-verification never triggers).

v0.5.1 adds a **digit re-verification channel**, still with zero model calls and zero new dependencies:

- After the first OCR pass, regexes capture **digit-critical tokens** (IPv4 / URL / port / long digit strings, word-level confidence < 92), up to 6 re-verifications per image
- For each token, a 3× Lanczos upscaled crop is cut from the preprocessed copy at the token's word-level bbox and handed to a **dedicated digit worker** (locked ASCII whitelist + PSM 7 single-line mode) for re-recognition — essentially "locking down the Chinese glyph space so the same engine only answers ASCII questions"
- Acceptance rules: **same character count** (only same-shape substitutions like 0↔6/9/8 are accepted; structural rewrites are rejected) + confidence gain ≥5 + an actual change
- **Punctuation-preserving fusion**: among same-length re-reads, punctuation positions such as `.` `-` `:` `/` keep the first-pass result (the first pass's tokenization skeleton is usually right; only the glyphs are wrong) and only the newly read digits/letters are adopted — fusing `127-0.0.1` back with `127.6.6.1` yields the correct `127.0.0.1`
- Corrections are written back into the OCR line text in place, and a `[数字复核 N 处]` (digit re-verification, N fixes) evidence block is emitted (`原 → 新（置信度 34→66）`, i.e. `old → new (confidence 34→66)`), fully transparent and auditable to the model

Field test (PowerShell terminal screenshot, deepseek-v4-flash): `127.6.6.1:3080` (conf 34) and `127.9.6.1:3689` (conf 38) were both corrected to `http://127.0.0.1:3080` (conf 66/85), with the two re-verifications adding only ~0.5s.

| Stage | Behavior |
|---|---|
| Budget and snapping | `small=512²`, `normal=1024²`, `large=1448²`, `mega=4096²`; snapped to a Qwen-style `minPixels/maxPixels + 28` multiple grid |
| `auto` | Regular images use `normal`; over ~2.1 megapixels uses `large`; small images are first upscaled to an OCR-friendly size |
| Small-text upscaling | Small inputs are upscaled with Lanczos before OCR (capped at the budget's longest-edge limit) |
| Dark and low-contrast | Dark backgrounds are detected automatically from the original image's color statistics; after inversion, grayscale, contrast stretching, and light sharpening are applied, and text near edges gets white padding |
| Very long screenshots | When the original height exceeds 3000px, it is first split into 2000px-tall blocks with 100px overlap; each block gets independent budget preprocessing and OCR, with `[第 i/N 块，y=...]` (block i/N) boundaries in the output |
| Low-confidence re-verification | Up to 3 lines with Tesseract confidence below 60 are cropped, padded, upscaled 2×, and re-verified; pixel-scan focus rows/columns expand the re-verification region along the corresponding axis |
| Digit re-verification | IP/URL/port/long-digit tokens are re-recognized with an ASCII whitelist + PSM 7 + 3× crops; accepted only on same length + confidence gain, then written back into the line text after punctuation-preserving fusion |
| Generic pixel scan | 9 color buckets × row/column scanning, background buckets `≥90%` suppressed, `[0.15,0.90)` range retained; results enter the pseudo-vision context |
| Cache isolation | Cache keys include `sha256 + resolved budget + langs/resize switches + OCR pipeline parameter version + scan version`; old cache files are kept and never mix with the new pipeline's results |

`auto` is a good default; dense tables, tiny fonts, or documents may explicitly choose `large`/`mega`, and `small` when you only want to limit local CPU/memory. Set `ocrNoResize: true` to keep the OCR image at its original size (grayscale/contrast/sharpen/white-border enhancement still applies). Color statistics, pixel scanning, and metadata always read the original image, so the color evidence the model sees is never altered by OCR preprocessing. Use `bypassCache: true` to force recomputation.

## Installation

```bash
# Install from GitHub (requires network, recommended)
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision
```

> ⚠️ Windows note: if your machine reports `schannel: CRYPT_E_NO_REVOCATION_CHECK` or pnpm's safe-delete blocks the install, fall back to a local-path install:
>
> ```bash
> git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
> cd dsh-pseudo-vision
> pnpm install && pnpm build
> dsh plugin --profile web add <absolute local path>
> ```

## Usage

**Works out of the box**, no extra configuration needed. The `deepseek-official` route continues to support images automatically.

**No sibling routes are generated for other providers by default** (to avoid flooding the model selector with duplicate entries). Only when you actually need to receive images on a given text-only provider should you explicitly enable the whitelist in your profile patch:

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # generate a sibling route for this provider only
    ocrBudget: auto                        # or small/normal/large/mega
    ocrNoResize: false                     # true: skip budget scaling/upscaling
```

Or bridge all providers at once except those in `excludeProviders` (caution: every model gains an extra `· Pseudo Vision` entry in the model selector):

```yaml
    bridgeOtherProviders: true
```

Once enabled, `dsh-pseudo-vision/<provider>` sibling routes (displayed as `· Pseudo Vision`) appear in the model selector; selecting one makes text-only models automatically go through the local pseudo-vision conversion, while native vision models keep native pass-through.

**Example output** (pseudo-vision evidence actually received by deepseek-v4-flash, excerpt from a PowerShell terminal screenshot):

```
[dsh-pseudo-vision] sha256=b290f3d7e212 budget=normal 原图:image/png 187415B 预处理:灰度+反色 1196×636 238744B
[OCR chi_sim+eng] 12 行
  · "PS C:\Users\39795> dsh web"  x=0.113 y=0.199
  · "dsh web: http://127.0.0.1:3080"  x=0.128 y=0.230
  · …
[OCR 低置信度重试 1 区域]
  · 区域 1 x=0.008-0.992 y=0.958-0.984：CR
[数字复核 2 处]
  · y=0.230 "http://127.6.6.1:3080" → "http://127.0.0.1:3080"（置信度 34→66）
  · y=0.413 "http://127.9.6.1:3689" → "http://127.0.0.1:3080"（置信度 38→85）
[颜色统计] 总像素 760896
  · 平均亮度 57.5/255
  · grey 94.3%
  · white 4.9%
[像素扫描] 476×512 背景豁免:grey 27 条命中（行 14 / 列 13）
  · 行 y=0.0%  white  99.8%
  · 列 x=0.2%  white  71.4%
  · …
[元信息] 尺寸 1184×608  png  sRGB
  · [TL] #282c34 (深灰)
  · [C] #282c34 (深灰)
  · …
```

The model "imagines" the full image content from this structured evidence — note the `[数字复核]` (digit re-verification) block: whole-image OCR misread the loopback address as `127.6.6.1`, and the re-verification channel corrected it in place with an audit trail.

## Compatible Versions

| dsh version | Status |
|---|---|
| 0.1.0-rc.7 | ⚠️ Structurally compatible (not verified live) |
| 0.1.0-rc.8 | ✅ Verified on a live setup |
| 0.1.0-rc.9+ | ⚠️ Needs re-verification (dsh is in developer preview; breaking changes are common) |

## Permissions

- Read image attachments within the workspace
- Write a temporary cache to `~/.dsh/profiles/<profile>/.dsh-pseudo-vision/cache/` (keys include sha256, budget, langs/resize switches, OCR pipeline parameter version, scan version)
- In-process tesseract.js OCR + sharp (language packs are downloaded from the tesseract CDN into the built-in cache on first run, offline afterwards)
- Take over the `deepseek-official` provider (the official llm-deepseek is disabled and re-registered by the plugin)
- Register sibling routes for specified providers per configuration (`bridgeProviders` whitelist / `bridgeOtherProviders` for all); sibling adapters delegate to the original provider via the public `ctx.llm` API. **By default, no sibling routes are registered for any other provider**

It will **not**:
- Upload any image to an external API
- Modify dsh core code (pure cordis patch + adapter wrapping)
- Override or replace the original provider adapter; original routes still run their original logic

## Known Limitations

- Complex spatial relationships and real photographs: description accuracy is limited; pseudo-vision evidence is not equivalent to true multimodal understanding
- OCR can still misrecognize characters (e.g. reading "DeepSeek" as "Deepseck"); digit-critical tokens (IP/URL/port/long digit strings) are backstopped and corrected by the digit re-verification channel, but other text misreadings still deserve attention
- Color statistics only give shares; layout/icon details cannot be reconstructed
- Large images: OCR is processed under the `ocrBudget` budget; very long screenshots are split by original image first, while color/pixel/metadata still use the original image
- OCR low-confidence re-verification covers at most 3 regions; it improves small-text readability but is not true image super-resolution

## ⚠️ Known Limitations / Roadmap

The current version (v0.5.0) already supports bridging other live providers via sibling routes, a configurable OCR budget, long-screenshot chunking, dark/low-contrast enhancement, low-confidence local re-verification, parameter-isolated caching, and — new in v0.5.0 — generic row+column multi-color pixel scanning; cross-provider bridging is still **disabled by default** (enabled via the `bridgeProviders` whitelist), and requires the user to pick a route marked `· Pseudo Vision` in the model selector; original providers are never implicitly rewritten.

| Item | Status | Notes |
|---|---|---|
| **Other text-only model support** (GLM / Qwen / Kimi / OpenRouter etc. under `llm-pi-ai`) | ✅ Implemented (off by default) | Enable via the `bridgeProviders` whitelist or `bridgeOtherProviders`; when enabled, `dsh-pseudo-vision/<provider>` sibling routes are registered while original routes stay untouched |
| **Generic pixel scan** (rows+columns, multi-color buckets, background exemption) | ✅ Implemented | v0.5.0 automatic bridging no longer scans red only; outputs row/column hits for 9 color buckets with pure-background buckets suppressed, results entering the pseudo-vision context |
| **External Vision Backend** (Qwen-VL / Gemini / OpenAI-compatible) | ❌ Not implemented | The current version sticks to local OCR/color/pixel/metadata; an explicit opt-in external vision backend may be added later |
| **Local OCR engine upgrade** (RapidOCR / PaddleOCR ONNX) | ⏸️ Deferred by user decision | Higher accuracy than Tesseract but adds a ~20MB model, violating the "no model" red line; currently mitigated by the v0.5.1 digit re-verification channel (pure parameterized re-recognition), to be revisited if needed |
| **Automatic sibling-route switching** | ⚠️ Not implemented | Currently the `· Pseudo Vision` route must be picked manually in the model selector, to avoid polluting the original session's model selection |
| **npm release** | ❌ Not released | Would be published as the `dsh-pseudo-vision` npm package, enabling one-line `dsh plugin add` installation |
| **Client-side enhancements** | ⚠️ Basic | A settings plugin card exists; automatic composer image hints are not done |
| **Multi-language OCR configuration** | ✅ Supported | `langs` config key (default `chi_sim+eng`) |
| **Image pre-scaling strategy** | ✅ Implemented | `ocrBudget` + smart resize + adaptive small-text upscaling; `auto` picks normal/large by original pixel count |
| **Long screenshot OCR** | ✅ Implemented | When the original height > 3000px: 2000px blocks with 100px overlap, per-block budget preprocessing, and merged boundaries |
| **Preprocessing & local re-verification** | ✅ Implemented | Dark inversion, grayscale/contrast/sharpening, white border, and up to 3 low-confidence regions retried at 2× |
| **Cache invalidation / manual refresh** | ✅ Implemented | Content-addressed cache keyed by sha256 + budget + pipeline parameter version; `bypassCache` forces recomputation |

## Related Projects

- `dsh-vision-skill` (same author, deprecated): an earlier paste-to-path approach
- [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision): architectural reference for this plugin (adapter-replacement idea), but it uses an external vision API instead of local tools

## License

MIT
