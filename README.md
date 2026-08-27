简体中文 | [English](README.en.md)

# dsh-pseudo-vision

> 给 DeepSeek Harness 的 text-only provider 装上"工具层视觉"：图片在 LLM dispatch 路径上自动拆解成 **OCR 文字 + 颜色统计 + 像素扫描 + 元信息**，让任意纯文本模型也能"看图"。全程本机执行，**无外部视觉 API**。

## 它在做什么

- 接管 `deepseek-official` 路由；按 `bridgeProviders` 白名单（或 `bridgeOtherProviders`）为其他 text-only provider 生成兄弟路由 `dsh-pseudo-vision/<provider>`（模型选择器中显示 `· Pseudo Vision`）
- 兄弟路由强制声明 `inputModalities: ["text", "image"]`，通过 DSH 图片 admission 门
- LLM dispatch 时：原生视觉模型透传；text-only 模型读附件 → 本地 4 工具转文本 → 替换 image block + 注入 `<pseudo-vision-context>` → 委派回原 provider

## 提供的工具

| 工具 | 作用 | 实现 |
|---|---|---|
| `vision_ocr` | 提取图中所有文字（带归一化坐标） | tesseract.js（chi_sim + eng），管线见下 |
| `vision_color_stats` | 9 桶像素占比 + 平均亮度 | sharp + 直方图 |
| `vision_pixel_scan` | 行 + 列多色桶扫描，输出 focusY/focusX | sharp raw pixel |
| `vision_meta` | 尺寸、格式、色彩空间、四角/中心采样 | sharp metadata |

### OCR 管线（v5）

1. **预处理**：预算缩放（small/normal/large/mega，28 网格吸附）→ 深色模式检测（浅色不反色）→ 灰度 → 对比度拉伸 → 椒盐噪声检测（有噪才 3×3 中值降噪，干净图跳过，避免磨掉 1px 细笔画）→ 轻锐化（σ0.3）→ 白边
2. **主识别**：tesseract 整页，输出全部文字行 + 置信度；非文本块（image/separator）过滤
3. **低置信度重试**：最多 8 个区域，**文字行优先**（图标噪声行不抢占名额）；裁剪 + 3× Lanczos 放大 + 单文本块模式（PSM 6）重读；**置信度更高时替换主行**（证据块仍留痕）
4. **CJK 后处理**：字间空格合并（`通 知`→`通知`）、行首图标符号剥离
5. **数字复核**：IP/URL/端口/长数字用 ASCII 白名单 + 单行模式重识别，标点保持首遍骨架，同长度 + 置信提升 ≥5 才接受，`[数字复核 N 处]` 留痕

> 实机验证：设置页截图 OCR 从"只出顶部 3 行、菜单文字全丢"修复为 11 行全检出、"通用设置/模型/通知"完全干净。关键修复：tesseract.js 的 PSM 参数必须传数字（字符串 `"3"` 会破坏整页检测）。

## 安装

```bash
# GitHub 安装（需网络，推荐）
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision

# Windows schannel/pnpm 拦截时改用本地路径
git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
cd dsh-pseudo-vision && pnpm install && pnpm build
dsh plugin --profile web add <本机绝对路径>
```

## 使用

装上即生效，无需额外配置。`deepseek-official` 路由自动支持图片；其他 provider 需显式白名单：

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # 只给这个 provider 生成兄弟路由
    ocrBudget: auto                        # 也可 small | normal | large | mega
    ocrNoResize: false                     # true：跳过预算缩放/放大
```

一次性桥接除 `excludeProviders` 外的所有 provider（谨慎：每个模型在选择器多一份条目）：

```yaml
    bridgeOtherProviders: true
```

模型选择器出现 `dsh-pseudo-vision/<provider>` 兄弟路由；text-only 模型走本地伪视觉转换，原生视觉模型保持原生透传。
