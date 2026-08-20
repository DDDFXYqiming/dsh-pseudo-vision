# dsh-pseudo-vision Skill

> DeepSeek Harness skill: text-only 模型图片理解能力（OCR + 颜色 + 像素 + 元信息）。

## When to use this skill

- 当前路由是 text-only 模型（`inputModalities` 不含 `image`）
- 用户粘贴了图片但模型声明不支持图片
- 你想自动让模型"看图"，而不是切换到多模态模型

## What this skill does

把图片在落地到模型前，自动拆解为：

1. **OCR 文字**（带归一化坐标 `x=0.000-1.000 y=0.000-1.000`）
2. **颜色统计**（白/黑/灰/其他色比例）
3. **像素行扫描**（目标色像素的逐行分布）
4. **图片元信息**（尺寸、格式、色彩模式、四角/中心采样）

输出格式：

```
[dsh-pseudo-vision] 自动转换 1 张图片

OCR 文字提取：
  · "..." x=... y=...

颜色统计（占比）：
  · 白 XX.X%
  · 黑 XX.X%
  · ...

像素行扫描：
  · y=... red=... → 推断位置

图片元信息：
  · 尺寸 WIDTH×HEIGHT  FORMAT  COLOR_MODE
  · 四角采样 [TL,...] [TR,...] [BL,...] [BR,...]
  · 中心采样 [C,...]
```

## OCR preprocessing pipeline

OCR 采用本地可配置管线，默认 `ocrBudget: auto`：

- `small / normal / large / mega` 分别对应约 `512² / 1024² / 1448² / 4096²` 像素预算，使用 28px 网格吸附；`auto` 对常规图用 `normal`，超大图切到 `large`。
- `ocrNoResize: true` 可跳过预算缩放和自适应放大，保留原图尺寸；仍执行 OCR 增强和白边，且该开关会进入缓存键。
- 小输入先 Lanczos 放大；暗色模式按原图颜色统计检测并反色，再执行灰度、对比度拉伸、轻锐化和白边填充。
- 原图高度超过 3000px 时，先按原图切为 2000px 高、100px 重叠块，再逐块预算预处理/OCR，结果带 `[第 i/N 块，y=...]` 边界。
- Tesseract 置信度低于 60 的最多 3 个区域会裁剪、补白边、2× 放大复核；像素扫描命中红色行时会扩大相邻复核区域。
- 缓存键包含图片 sha256、解析后的预算、langs/resize 开关和 OCR 管线参数版本；`bypassCache: true` 强制重算，旧缓存文件不会被删除或与新管线混用。
- 颜色统计、像素扫描和元信息始终基于原图，只有 OCR 使用预处理副本。

## How to invoke

**自动触发**：`deepseek-official` 路由自动生效；其他 provider 需在配置中显式开启（`bridgeProviders: ["<provider-id>"]` 白名单）后，使用自动生成的 `dsh-pseudo-vision/<provider>` 兄弟路由。**默认不为其他 provider 注册兄弟路由**。原生视觉模型透传，text-only 模型走本地转换。

**手动触发**：在用户消息前加 `[pseudo-vision]`，强制走转换。

**禁用**：在用户消息前加 `[no-pseudo-vision]`，跳过插件。

## Tools exposed by the plugin

- `vision_ocr` — 提取图中文字（tesseract.js）
- `vision_color_stats` — 像素占比分析（sharp）
- `vision_pixel_scan` — 逐行像素检测（sharp）
- `vision_meta` — 元信息 + 角/中心采样（sharp）

## Limitations

- 复杂空间关系、真实照片：精度有限
- 超长图会按高度分块，仍受宿主附件尺寸/像素准入限制（profile 可按需提高 `maxImageDimension`）
- `mega`/`large` 会增加本地 sharp 与 OCR 的 CPU/内存消耗；预算越高不等于真实视觉理解
- 仅支持 PNG/JPEG/WebP/GIF