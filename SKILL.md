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
- 单图 < 4 MiB（自动降采样到 1568px）
- 仅支持 PNG/JPEG/WebP/GIF