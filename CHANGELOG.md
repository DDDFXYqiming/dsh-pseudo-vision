# Changelog

All notable changes to dsh-pseudo-vision are documented here.

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