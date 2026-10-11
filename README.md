简体中文 | [English](README.en.md)

# dsh-pseudo-vision

**面向 DeepSeek Harness (DSH) 纯文本模型的本地工具层视觉扩展**。

本插件为 DeepSeek Harness 平台中缺乏原生视觉能力的纯文本服务商（如 DeepSeek 纯文本通道、Kimi 代码模型等）提供无缝的“工具层视觉”。在 LLM 分发（Dispatch）前，它将图片附件自动解构为 **OCR 文本（含归一化坐标与数字二次复核） + 9 桶颜色统计 + 矩阵像素扫描 + 空间几何元信息**，全程纯本地计算，零外部视觉 API 依赖。

---

## 核心特性

* **突破模态准入限制**：通过为纯文本服务商动态派生 `dsh-pseudo-vision/<provider>` 兄弟路由，显式声明 `inputModalities: ["text", "image"]`，让纯文本模型顺利接收图片输入。
* **原生多模态自动放行**：对原生支持视觉的模型（如原生多模态版本）完全透明穿透，仅对纯文本通道执行本地伪视觉解构，杜绝负优化。
* **高可靠本地多维解构管线**：
  * **v5 OCR 增强管线**：基于 `tesseract.js`，包含网格吸附预缩放、深色模式自适应、椒盐噪声定向过滤、低置信度局部 3× Lanczos 放大重测，以及 IP/端口/长数字的标点保持二次校验。
  * **9 桶色彩空间分布**：统计黑白灰及六大主色调的像素占比与平均明度。
  * **行列多色扫描（Pixel Scan）**：支持指定目标色彩探测与全局行列切片，感知界面区块与视觉重点。
  * **物理元信息与采样**：提取图片尺寸、色彩空间及四角与中心点颜色采样。
* **分层证据与字符预算保护**：
  * **轮次动态降级**：最近 2 个用户轮次的图片保留全量证据，较早轮次自动降级为紧凑证据（保留元数据与色彩，省去 OCR 文本），并提供 `vision_ocr(file_path=...)` 按需拉取指针。
  * **全局安全上限**：单次请求默认最多处理 8 张全量图片，总证据文本硬顶 96,000 字符（约 24K tokens），超限图片自动保留显式占位符并在末尾输出处理摘要，杜绝撑爆上下文。

---

## 暴露的原子工具

模型除了接收自动注入的证据外，还可按需自主调用以下 4 个原子工具：

| 工具名称 | 功能描述 | 底层实现 |
| :--- | :--- | :--- |
| `vision_ocr` | 提取文字与归一化坐标，支持数字及关键凭证二次复核 | `tesseract.js` (chi_sim + eng) |
| `vision_color_stats` | 统计 9 类颜色桶像素占比与平均亮度 | `sharp` 像素直方图 |
| `vision_pixel_scan` | 对指定颜色或非背景像素执行行列穿透扫描 | `sharp` Raw Pixel Buffer |
| `vision_meta` | 读取分辨率、格式、色彩空间及中心/四角采样色 | `sharp.metadata()` |

---

## 安装与快速上手

### 通过 DSH 插件系统安装（推荐）

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision
```

### 本地源码安装

```bash
git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
cd dsh-pseudo-vision && pnpm install && pnpm build
dsh plugin --profile web add .
```

*若使用 pnpm 10+ 遇到构建拦截，请在 Profile 对应的 `pnpm-workspace.yaml` 中为 `@dsh-external/dsh-pseudo-vision` 配置 `allowBuilds: true`。*

---

## 配置指南

在对应 Profile 的 `cordis.patch.yml` 中配置桥接策略：

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # 针对指定纯文本服务商派生兄弟路由
    # bridgeOtherProviders: true           # 可选：一键桥接除排除列表外的所有服务商
    ocrBudget: auto                        # 预处理分辨率预算: auto | small | normal | large | mega
    ocrNoResize: false                     # 是否跳过预算缩放
    maxImages: 8                           # 单次请求全量转换的图片数量上限 (1-32)
    maxTotalEvidenceChars: 96000           # 证据文本总字符上限 (约 24K tokens)
    fullEvidenceTurns: 2                   # 保留全量证据的用户轮次深度 (1-8)
    evidenceMaxChars: 32000                # 单张图片可见证据的字符上限
```

配置完成后，模型选择器中将呈现带 `· Pseudo Vision` 标记的可用模型通道。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
