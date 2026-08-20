# dsh-pseudo-vision

> 给 text-only DeepSeek Harness 模型装上"工具层视觉"：把图片在落地到模型前，自动拆解成 OCR 文字 + 颜色统计 + 像素扫描 + 元信息，让纯文本模型也能"看图"。

固定化 [@YinsenW\_](https://x.com/YinsenW_) 2026-08-20 扒出的 DeepSeek Harness rc.8 伪视觉流程。

## 它在做什么

Yinsen 的实验显示，当 `deepseek-v4-flash`（text-only）收到 read_image 失败错误时，会**自己**用 `bash` + Python 拼出 OCR + 像素分析 + 颜色统计 + 元信息这套工具链，把图片"硬拼"成结构化文本再喂回自己。

**dsh-pseudo-vision 把这套涌现流程封装成插件的固定能力**：

1. **Server 端** 在用户提交 prompt 前拦截 image block，自动调用 4 个本地工具合成结构化文本
2. 把 image block **透明替换**为 `[pseudo-vision] OCR:... / Colors:... / Pixels:... / Meta:...` 文本描述
3. text-only 模型收到的是纯文本，不会被 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒发，也不会在网关返回 400

## 提供的能力

| 工具 | 作用 | 实现 |
|---|---|---|
| `vision_ocr` | 提取图中所有文字（带归一化坐标） | tesseract.js（chi_sim + eng） |
| `vision_color_stats` | 像素占比分析（白/黑/灰/其他色比例） | sharp + 直方图统计 |
| `vision_pixel_scan` | 逐行检测目标色像素 | sharp raw pixel access |
| `vision_meta` | 尺寸、格式、色彩模式、四角/中心颜色采样 | sharp metadata |

## 安装

```bash
# 在 dsh 项目根目录
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision
```

或本地开发模式：

```bash
git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
cd dsh-pseudo-vision
pnpn install
pnpn build
dsh plugin --profile plugin-dev add .
dsh --profile plugin-dev web
```

## 使用

默认行为：**装上即生效**。所有 text-only 模型（`inputModalities` 未声明 `image` 的）粘贴图片时，会自动触发伪视觉转换。

**显式触发**（可选）：在 `/goal` 或 `/plan` 指令前加 `[pseudo-vision]`，强制走转换（（即使模型本身支持图片）。

## 效果对比

**之前**（用户截图）：
```
Error: model deepseek-v4-flash does not declare image input
→ switch to an image-capable model
```

**之后**：
```
[dsh-pseudo-vision] 自动转换 1 张图片

OCR 文字提取（3 段）：
  · "Cherry Studio 一体机"  x=0.065 y=0.670
  · "DeepSeek-V4-Flash"     x=0.290 y=0.810
  · "High"                   x=0.820 y=0.920

颜色统计（占比）：
  · 白 95.5%
  · 黑 1.4%
  · 灰 0.9%
  · 红（装饰线）

像素行扫描：
  · y=304 red=72 → 推断水平红线位置

图片元信息：
  · 尺寸 960×540  PNG  sRGB
  · 四角采样 [TL,白] [TR,白] [BL,白] [BR,白]
  · 中心采样 [C,白]
```

模型基于以上结构化证据"脑补"出整张图内容。

## 兼容版本

| dsh 版本 | 状态 |
|---|---|
| 0.1.0-rc.7 | ✅ 已测试 |
| 0.1.0-rc.8 | ✅ 已测试 |
| 0.1.0-rc.9+ | ⚠️ 需重新验证（dsh 处于开发者预览，破坏性变更常见） |

## 权限

- 读取工作区内的图片附件
- 写入临时缓存到 `~/.dsh/profiles/<profile>/.dsh-pseudo-vision/cache/`
- 进程内 tesseract.js OCR（默认无网络依赖）
- sharp 图像处理（默认无网络依赖）

**不**会：
- 上传任何图片到外部 API
- 修改 dsh 核心代码（无需打补丁）
- 修改用户模型配置

## 已知边界

- 复杂空间关系、真实照片：描述精度有限（与 Yinsen 实验一致）
- 大图（>4 MiB）：自动降采样到 1568px（与 Qwen-VL 默认行为一致）
- 速度：单图全流程 ~500ms–2s（tesseract + sharp）

## 关联项目

- `dsh-vision-skill`（同一作者，已弃用）：早期 paste-to-path 方案
- [Yinsen 原帖](https://x.com/YinsenW_/status/...)

## License

MIT