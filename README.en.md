[简体中文](README.md) | English

# dsh-pseudo-vision

**Local tool-layer vision extension for text-only providers in DeepSeek Harness (DSH).**

Provides a non-intrusive "tool-layer vision" bridge for text-only providers in DeepSeek Harness (such as pure-text channels and code-specialized models). Intercepting requests on the LLM dispatch path, it automatically deconstructs image attachments into **OCR text (with normalized coordinates and numeric verification) + 9-bucket color distributions + pixel matrix scans + spatial metadata**—running completely locally without external vision APIs.

---

## Key Features

* **Bypassing Modality Gates**: Synthesizes sibling routes named `dsh-pseudo-vision/<provider>` with explicit `inputModalities: ["text", "image"]` declarations, allowing text-only providers to admit image attachments cleanly.
* **Transparent Pass-Through for Native Vision**: Models with native vision capabilities pass through untouched; only targeted text-only channels undergo local multimodal decomposition.
* **High-Fidelity On-Device Pipeline**:
  * **v5 OCR Pipeline**: Powered by `tesseract.js`, featuring grid-snapped resizing, dark-mode awareness, salt-and-pepper noise filtering, 3× Lanczos regional retries for low-confidence blocks, and punctuation-preserving re-verification for IPs, ports, and numeric strings.
  * **9-Bucket Color Distribution**: Calculates global luminance and pixel proportions across black, white, gray, and primary hues.
  * **Row & Column Pixel Scans**: Scans cross-sectional pixel lines to detect layout boundaries and visual UI focal points.
  * **Physical Geometry & Spatial Samples**: Captures dimensions, color space, and perimeter/center color samples.
* **Tiered Context & Token Safeguards**:
  * **Turn-Based Degradation**: Retains full evidence for the most recent user turns (default 2), while older turns degrade to compact metadata with an on-demand `vision_ocr(file_path=...)` refetch pointer.
  * **Hard Character Limits**: Caps full-tier conversions to 8 images per request and combined evidence to 96,000 characters (~24K tokens), emitting explicit summary placeholders when limits are reached.

---

## Exposed Vision Tools

In addition to injected prompt evidence, the agent can invoke four standalone tools:

| Tool Name | Core Role | Implementation |
| :--- | :--- | :--- |
| `vision_ocr` | Extracts text with normalized bounding coordinates and numeric checks | `tesseract.js` (chi_sim + eng) |
| `vision_color_stats` | Emits 9-bucket color proportions and average scene luminance | `sharp` pixel histograms |
| `vision_pixel_scan` | Traverses rows and columns for target or foreground colors | `sharp` raw pixel buffers |
| `vision_meta` | Inspects image dimensions, format, and edge color samples | `sharp.metadata()` |

---

## Installation & Quick Start

### Install via DSH Plugin Manager (Recommended)

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision
```

### Local Development

```bash
git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
cd dsh-pseudo-vision && pnpm install && pnpm build
dsh plugin --profile web add .
```

*Note: For pnpm 10+ workspaces, set `@dsh-external/dsh-pseudo-vision` to `allowBuilds: true` inside your profile's `pnpm-workspace.yaml`.*

---

## Configuration

Configure target routes in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # Whitelisted providers to create sibling routes for
    # bridgeOtherProviders: true           # Bridge all providers except excluded ones
    ocrBudget: auto                        # Preprocessing resolution budget: auto | small | normal | large | mega
    ocrNoResize: false                     # Skip budget resizing and upscaling
    maxImages: 8                           # Maximum full-tier images per request (1-32)
    maxTotalEvidenceChars: 96000           # Combined evidence character ceiling (~24k tokens)
    fullEvidenceTurns: 2                   # Depth of user turns retaining full evidence (1-8)
    evidenceMaxChars: 32000                # Per-image character ceiling
```

Active bridged channels will appear in the model selector marked with `· Pseudo Vision`.

---

## License

This project is open-sourced under the [MIT License](LICENSE).
