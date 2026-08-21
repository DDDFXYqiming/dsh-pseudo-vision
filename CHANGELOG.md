# Changelog

All notable changes to dsh-pseudo-vision are documented here.

## [0.5.0] - 2026-08-21

### Added
- **Universal row+column pixel scan**: instead of scanning only red horizontal rows, the auto-bridge now scans every colour bucket from the colour-statistics classifier in both row and column directions. Layout cues such as horizontal separators, vertical sidebars, and coloured bands can now be surfaced regardless of hue.
- **Background-bucket suppression**: buckets that dominate the image (share >= 30% from colour stats) are treated as background candidates. Rows/columns where a background bucket reaches >= 90% density are suppressed as pure background, while partial bands (e.g., 80%) still surface as structured layout cues.
- **Shared 512px decode**: colour statistics and the universal scan now share a single downsampled raw buffer so both evidence steps observe identical pixels.
- **Column focus for OCR retry (`focusX`)**: column hits from the universal scan are forwarded to the low-confidence OCR retry crop, enlarging horizontal padding around vertical separators or band boundaries.

### Changed
- `pixelScan` (single-target, red-by-default) is kept unchanged for the manual `vision_pixel_scan` tool; only the auto-bridge uses the new universal scan.
- Cache pipeline version bumped so red-only scan results are not reused after upgrade.

### Verification
- `pnpm typecheck` and `pnpm test` pass (19/19).
- Headless CLI comparison against `C:\Users\39795\Pictures\Screenshots` on `deepseek-official` / `deepseek-v4-flash` showed improved layout inference (colour bands and separators detected without requiring the model to run a second manual scan).

## [0.4.0] - 2026-08-21

### Added
- **Configurable OCR budgets**: `ocrBudget: auto | small | normal | large | mega`; `auto` selects a budget from the original pixel count and Qwen-style smart resize snaps dimensions to a 28px grid. `ocrNoResize: true` preserves the original OCR dimensions.
- **Adaptive small-text upscale**: low-resolution inputs are Lanczos-upscaled before OCR without exceeding the selected budget's longest-side cap.
- **Long-screenshot OCR**: original images taller than 3000px are cropped into 2000px blocks with 100px overlap before per-block preprocessing/OCR; merged output carries block boundaries.
- **Local OCR enhancement**: dark-mode detection/inversion, greyscale, contrast normalization, light sharpening, and a white border for edge-touching text.
- **Low-confidence local retry**: up to three Tesseract lines below confidence 60 are padded, enlarged 2×, and recognized again; pixel-scan focus rows guide the crop.
- **Pipeline-aware cache keys**: sha256, resolved budget, langs/resize flags, and the full OCR pipeline version are included in cache names, so old fixed-pipeline results cannot cross-contaminate new settings.

### Changed
- Colour statistics, pixel scanning, and metadata continue to use original bytes; only OCR uses the preprocessed copy.
- DeepSeek and allowlisted provider bridge routes now pass the OCR budget consistently.
- Settings card, README, and SKILL document the new local-only pipeline and its CPU/memory trade-offs.
- OCR workers are disposed with the plugin fiber, and tool renderers return standard text content blocks for DSH CLI/tool-call compatibility.

### Verification
- Windows Node `tsdown` build and `tsc --noEmit` pass.
- Windows Node test suite: 15/15 pass; tessdata-dependent OCR smoke remains conditionally skipped when language data is not cached.
- CLI smoke checks passed through the built bridge: English OCR, 900×700 metadata, red-row pixel density, dark-mode inversion, and 4-block long-screenshot OCR.
- DSH headless CLI self-test passed all four registered tools on the local fixture; no external vision API was used.

## [0.3.1] - 2026-08-20

### Changed (fixes UX regression from 0.3.0)
- **Cross-provider sibling routes are now OFF by default.** 0.3.0 registered a `· Pseudo Vision` sibling route for every model of every live provider, flooding the model selector with duplicates. Now nothing is registered unless `bridgeProviders: ["<provider-id>"]` (allowlist) or `bridgeOtherProviders: true` (all, minus `excludeProviders`) is configured.
- `deepseek-official` behaviour is unchanged.

## [0.3.0] - 2026-08-20

### Added
- **Cross-provider sibling routes**: every live provider except the managed DeepSeek route receives a `dsh-pseudo-vision/<provider>` route whose models advertise `inputModalities: ["text", "image"]`.
- **Provider-neutral wrapper**: image-free requests and native vision models are delegated to the original provider; text-only models have image blocks converted locally before delegation.
- **Topology/config refresh**: sibling routes follow `llm/adapters-updated`; `bridgeOtherProviders` and `excludeProviders` control route generation.
- **Adapter tests**: route metadata, text-only image removal, cache-backed conversion, and original-provider delegation are covered.

### Notes
- The original provider routes are not replaced. Users select the `· Pseudo Vision` sibling route when they want automatic image conversion.
- The transformation remains local-only; no external vision backend is included yet.
- Compatible target remains dsh `0.1.0-rc.8`; sibling nested dispatch deliberately preserves call config fields and only changes messages/system/provider for the fresh target dispatch.

## [0.2.0] - 2026-08-20

### Changed (breaking)
- **Automatic image-capable advertisement**: the official `llm-deepseek`
  bundle is disabled via `cordis.patch.yml` and the `deepseek-official`
  provider is re-registered with `PseudoVisionBridgeAdapter`, which reports
  `inputModalities: ["text", "image"]` for every model. The model selector
  and the host's image-admission gate now treat every DeepSeek model as
  image-capable — **no manual `input: [text, image]` needed**.
- **Request-time local pseudo vision**: at `stream()` time, if the
  underlying model is not natively multimodal, every image block is resolved
  through the attachment store and converted by the four LOCAL tools (OCR,
  colour statistics, pixel scan, metadata) into a structured text block that
  is spliced into the system prompt inside `<pseudo-vision-context>`.
  Image bytes never reach a text-only gateway.
- **Client bundle added**: `dsh.client` manifest + settings plugin card
  ("伪视觉桥接") that surfaces bridge status in Settings → Plugins.
- Build: tsdown dual entry (ESM `lib/index.js` + CJS browser
  `lib/client.js`); pnpm `onlyBuiltDependencies` for sharp/tesseract.js.

### Notes
- Compatible with dsh `0.1.0-rc.7` and `0.1.0-rc.8`.
- OCR needs tesseract language data; the install downloads `chi_sim`/`eng`
  on first run (or ship them alongside the plugin).
- Tests: 4/4 green (`node --experimental-strip-types --test tests/*.test.ts`);
  OCR smoke test is skipped when tessdata is not cached locally.
- OCR downloads `chi_sim`+`eng` (.traineddata.gz) from the tesseract CDN on
  first use into tesseract.js's built-in cache directory; subsequent runs
  are fully offline.
- Still no external vision API: everything runs in-process.

## [0.1.0] - 2026-08-20

### Added
- Initial release.
- Server-side image→text bridge for text-only DeepSeek Harness models.
- 4 tools: `vision_ocr` (tesseract.js), `vision_color_stats` (sharp histogram), `vision_pixel_scan` (sharp raw pixels), `vision_meta` (sharp metadata + corner sampling).
- Auto-trigger on `image` block in messages for routes whose `inputModalities` excludes `image`.
- Manual trigger with `[pseudo-vision]` prefix; bypass with `[no-pseudo-vision]`.
- Local-only execution (no external API calls).

### Notes
- This plugin does NOT modify dsh core code; it relies on cordis hooks and the dsh llm service surface.
- Compatible with dsh `0.1.0-rc.7` and `0.1.0-rc.8`.
