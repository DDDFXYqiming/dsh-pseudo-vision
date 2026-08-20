# Changelog

All notable changes to dsh-pseudo-vision are documented here.

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
- Inspired by the pseudo-vision flow exposed by [@YinsenW\_](https://x.com/YinsenW_) on 2026-08-20.