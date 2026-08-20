# Changelog

All notable changes to dsh-pseudo-vision are documented here.

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