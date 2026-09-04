简体中文 | [English](README.en.md)

# dsh-pseudo-vision

给 DeepSeek Harness 的 text-only provider 补一层"工具层视觉"。图片附件在 LLM dispatch 路径上被拆解成 **OCR 文字 + 颜色统计 + 像素扫描 + 元信息**，纯文本模型拿到这些文字，就能"看"懂一张图。所有处理都在本机完成，**无外部视觉 API**。

## 它在做什么

- 插件接管 `deepseek-official` 路由，这条路由原本就能看图。其他 text-only provider 按 `bridgeProviders` 白名单生成兄弟路由 `dsh-pseudo-vision/<provider>`（模型选择器中显示 `· Pseudo Vision`），也可以用 `bridgeOtherProviders` 一并覆盖。
- 兄弟路由强制声明 `inputModalities: ["text", "image"]`，请求才能通过 DSH 的图片 admission 门。
- LLM dispatch 时分两种情况。原生视觉模型直接透传。text-only 模型则读附件，用本地四个工具把图片转成文字，替换掉 image block，注入 `<pseudo-vision-context>`，再委派回原 provider。
- 证据按轮次分层：最近 `fullEvidenceTurns`（默认 2）个用户轮的图片走全量管线；更早轮次的图片自动降级为**紧凑证据**（元信息+颜色+扫描，不跑 OCR），并附 `vision_ocr(file_path=…)` 回读指针，需要旧图文字时模型自己取回。历史图重新出现在新消息里会自动恢复全量。
- 单请求有双护栏：`maxImages`（默认 8）限全量张数，`maxTotalEvidenceChars`（默认 96000 字符，约 24K tokens）限证据文本总量。超限时不再报错中止，未转换的图片留下 `[图片 N 未转换…]` 占位符并在上下文末尾附 `[⚠️ 图片处理摘要]`，模型会明确告知用户哪些图未生效。

## 提供的工具

v0.6.1 适配 DSH `0.1.2-rc.1`：使用独立 `dsh-util-values` 导出，并接入新版 DeepSeek API 扩展准备接口。桥接仍仅作用于非原生多模态模型，Windows / Linux 均使用本地 OCR 生成文本证据。

| 工具 | 作用 | 实现 |
|---|---|---|
| `vision_ocr` | 提取图中所有文字（带归一化坐标） | tesseract.js（chi_sim + eng），管线见下 |
| `vision_color_stats` | 9 桶像素占比 + 平均亮度 | sharp + 直方图 |
| `vision_pixel_scan` | 行 + 列多色桶扫描，输出 focusY/focusX | sharp raw pixel |
| `vision_meta` | 尺寸、格式、色彩空间、四角/中心采样 | sharp metadata |

### OCR 管线（v5）

1. **预处理**先按预算缩放图片（small/normal/large/mega，28 网格吸附），随后检测深色模式（浅色不反色），转灰度，做对比度拉伸。接着检测椒盐噪声，有噪才走 3×3 中值降噪，干净图跳过这一步，避免磨掉 1px 细笔画。最后轻锐化（σ0.3）加白边。
2. **主识别**由 tesseract 整页完成，输出全部文字行和置信度，非文本块（image/separator）会被过滤。
3. **低置信度重试**最多做 8 个区域，文字行优先排队，图标噪声行不占名额。重读时裁剪区域，3× Lanczos 放大，用单文本块模式（PSM 6）。置信度更高的重读结果替换主行，证据块仍留痕。
4. **CJK 后处理**合并字间空格（`通 知`→`通知`），剥离行首图标符号。
5. **数字复核**针对 IP/URL/端口/长数字，用 ASCII 白名单加单行模式重新识别。标点保持首遍骨架，只有同长度且置信提升 ≥5 的结果才被接受，`[数字复核 N 处]` 留痕。

> 一次实机验证里，设置页截图的 OCR 从"只出顶部 3 行、菜单文字全丢"修复为 11 行全检出，"通用设置/模型/通知"完全干净。关键修复在 tesseract.js 的 PSM 参数必须传数字，字符串 `"3"` 会破坏整页检测。

## 安装

推荐直接从 GitHub 安装，需要网络。Windows 上遇到 schannel/pnpm 拦截时，改用本地路径安装。

```bash
# GitHub 安装（需网络，推荐）
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision

# Windows schannel/pnpm 拦截时改用本地路径
git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
cd dsh-pseudo-vision && pnpm install && pnpm build
dsh plugin --profile web add <本机绝对路径>
```

GitHub 安装会触发 `prepare` 脚本从源码构建 `lib/`。pnpm ≥10 首次 `add` 会拒绝运行该构建脚本：把 pnpm 打印的包键复制进 profile 的 `pnpm-workspace.yaml` 后重新 `add` 即可，例如：

```yaml
allowBuilds:
  dsh-pseudo-vision: true
```

请把这项授权视为「允许该包代码在安装时于你的机器上执行」；担心后续推送改变构建内容时，锁定 commit（`github:DDDFXYqiming/dsh-pseudo-vision#<sha>`）。

## 使用

装上即生效，无需额外配置。`deepseek-official` 路由自动支持图片。其他 provider 默认没有兄弟路由，要在配置里显式加白名单。

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # 只给这个 provider 生成兄弟路由
    ocrBudget: auto                        # 也可 small | normal | large | mega
    ocrNoResize: false                     # true：跳过预算缩放/放大
    evidenceMaxChars: 32000                # 单图证据文本字符封顶
    # tessdataDir: "D:/tessdata"           # 离线 traineddata 目录；设置后优先于 PV_TESSDATA 环境变量
    maxImages: 8                           # 单请求全量证据张数上限（1-32）
    maxTotalEvidenceChars: 96000           # 单请求证据文本总字符硬顶（16000-320000）
    fullEvidenceTurns: 2                   # 最近 N 个用户轮保留全量，更早降级紧凑（1-8）
```

也可以把 `bridgeOtherProviders` 设为 true，一次性桥接除 `excludeProviders` 外的所有 provider。代价是每个模型会在选择器里多出一份条目，开之前先想清楚。

```yaml
    bridgeOtherProviders: true
```

配好以后，模型选择器里会出现 `dsh-pseudo-vision/<provider>` 兄弟路由。text-only 模型走本地伪视觉转换，原生视觉模型保持原生透传。
