简体中文 | [English](README.en.md)

# dsh-pseudo-vision

> 给 DeepSeek Harness 的 text-only provider 装上"工具层视觉"：把图片在 LLM dispatch 路径上自动拆解成 OCR 文字 + 颜色统计 + 像素扫描 + 元信息，让任意纯文本模型也能"看图"。全程本机执行，**无外部视觉 API**。

**实机验证通过**（opencode-go/go1 + read_image → 纯文本模型完整描述 PowerShell 截图，数字复核通道把 OCR 误读 `127.6.6.1:3080` 纠正为 `http://127.0.0.1:3080`）。

## 它在做什么

- 通过 `cordis.patch.yml` 接管 `deepseek-official` 路由，原始 provider 路由不变
- 按 `bridgeProviders` 白名单（或 `bridgeOtherProviders`）为其他 text-only provider 生成兄弟路由 `dsh-pseudo-vision/<provider>`，在模型选择器中显示为 `· Pseudo Vision`
- 兄弟路由的 `resolveModel` / `listModels` 强制声明 `inputModalities: ["text", "image"]`，通过 DSH 图片 admission 门
- LLM dispatch 时：原生视觉模型透传；text-only 模型读附件 → 本地 4 工具转文本 → 替换 image block + 注入 `<pseudo-vision-context>` → 委派回原 provider

## 提供的工具

| 工具 | 作用 | 实现 |
|---|---|---|
| `vision_ocr` | 提取图中所有文字（带归一化坐标），含数字复核通道（IP/URL/端口/长数字的 `0↔6/9/8` 字形重识别 + 标点保持融合） | tesseract.js（chi_sim + eng） |
| `vision_color_stats` | 9 桶（白/黑/灰/红/绿/蓝/黄/青/品红/其他）像素占比 + 平均亮度 | sharp + 直方图 |
| `vision_pixel_scan` | 行+列多色桶扫描；背景桶 `≥90%` 抑制，`[0.15, 0.90)` 区间部分带 surfaced；每桶最多 5 行 + 5 列 | sharp raw pixel |
| `vision_meta` | 尺寸、格式、色彩空间、四角/中心采样 | sharp metadata |

> 数字复核通道（v0.5.1）：首遍 OCR 后用 ASCII 白名单 + PSM 7 单行模式对 IP/URL/端口/长数字重识别，标点位置保留首遍骨架（避免 `127-0.0.1` 这类破坏），同长度 + 置信提升 ≥5 才接受，证据块 `[数字复核 N 处]` 全程留痕。
>
> 通用像素扫描（v0.5.0）：与颜色统计共享 512px 降采样，行/列双向输出 `focusY`/`focusX` 供低置信度 OCR 复核扩大 padding。

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

**装上即生效**，无需额外配置。`deepseek-official` 路由继续自动支持图片。其他 provider 默认不生成兄弟路由（避免模型选择器重复条目），需要在某 text-only provider 上收图时显式白名单：

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

模型选择器出现 `dsh-pseudo-vision/<provider>`（`· Pseudo Vision`）兄弟路由；text-only 模型走本地伪视觉转换，原生视觉模型保持原生透传。

## 配置

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: []              # 白名单 provider 列表（空 = 仅 deepseek-official）
    bridgeOtherProviders: false      # true = 桥接除 excludeProviders 外所有
    excludeProviders: []             # bridgeOtherProviders 时的排除列表
    ocrBudget: auto                  # auto | small | normal | large | mega
    ocrNoResize: false               # true：跳过 OCR 预算缩放
    langs: chi_sim+eng              # tesseract 语言包
    maxImages: 5                    # 单请求最多转换张数
    bypassCache: false              # true：强制重算
    cacheDir: ''                    # 缓存目录（默认 <home>/.dsh/cache/pseudo-vision/）
```

`auto` 适合默认使用；密集表格/细小字体选 `large`/`mega`；想限制本地 CPU/内存选 `small`。`ocrNoResize: true` 跳过预算缩放但仍执行灰度/对比度/锐化/白边增强；颜色统计/像素扫描/元信息始终基于原图。

## 效果示例

`opencode-go/go1`（纯文本） + `read_image` + PowerShell 截图，模型收到的伪视觉证据：

```
[dsh-pseudo-vision] sha256=b290f3d7e212 budget=normal 原图:image/png 187415B 预处理:灰度+反色 1196×636 238744B
[OCR chi_sim+eng] 12 行
  · "dsh web: http://127.0.0.1:3080"  x=0.128 y=0.230
  · "dsh web: opening the default browser; pass —-no-open to disable"  x=0.251 y=0.262
  · …
[数字复核 2 处]
  · y=0.230 "http://127.6.6.1:3080" → "http://127.0.0.1:3080"（置信度 34→66）
  · y=0.413 "http://127.9.6.1:3689" → "http://127.0.0.1:3080"（置信度 38→85）
[颜色统计] 总像素 760896  · 平均亮度 57.5/255  · grey 94.3%  · white 4.9%
[像素扫描] 476×512 背景豁免:grey 27 条命中（行 14 / 列 13）
  · 行 y=0.0%  white  99.8%  · 列 x=0.2%  white  71.4%  · …
[元信息] 尺寸 1184×608  png  sRGB
  · [TL] #282c34 (深灰)  · [C] #282c34 (深灰)  · …
```

模型基于以上结构化证据"脑补"出整图内容——`[数字复核]` 块记录了原 OCR 误读与纠正前后，证据完全可审计。

## 兼容版本

| dsh 版本 | 状态 |
|---|---|
| 0.1.0-rc.7 / 0.1.0-rc.8 | ✅ 实机验证通过 |
| **0.1.1-rc.2** | **✅ 实机验证通过（v0.5.2+：override prepareCall 适配新版宿主接口）** |
| 0.1.0-rc.9 / 0.1.1-rc.1 等中间版本 | ⚠️ 结构兼容（未实机验证） |

**dsh 0.1.1-rc.2 升级注意**：宿主对 `LlmAdapter` 增加了强制 `prepareCall` 调用，v0.5.1 及更早版本运行会抛 `this[#deepseek].prepareCall is not a function`。请升级到 **v0.5.2+**。

## 权限

- 读取工作区图片附件
- 写入临时缓存到 `~/.dsh/profiles/<profile>/.dsh-pseudo-vision/cache/`（键含 sha256、budget、langs/resize 开关、OCR 管线参数版本、扫描版本）
- 进程内 tesseract.js OCR + sharp（首次运行从 tesseract CDN 下载语言包，之后离线）
- 接管 `deepseek-official` provider（禁用官方 llm-deepseek，由插件重新注册）
- 按 `bridgeProviders` 白名单 / `bridgeOtherProviders` 为指定 provider 注册兄弟路由，通过 `ctx.llm.registerAdapter` 委托原 provider。**默认不注册任何其他 provider 的兄弟路由**

**不**会：上传图片到外部 API / 修改 dsh 核心代码 / 覆盖原始 provider adapter（原路由按原逻辑运行）。

## 已知边界

- 复杂空间关系、真实照片：描述精度有限，伪视觉证据不等同于真实多模态理解
- OCR 仍可能认错字（除数字关键 token 已由复核通道兜底）；剩余文字误读仍需留意
- 颜色统计只给占比，无法还原布局/图标细节
- 大图：OCR 按 `ocrBudget` 预算处理；超长截图（高 > 3000px）会先切块
- 低置信度复核最多 3 个区域，提升小字可读性但不等同于图像超分辨率
- **明确不做**：embedding/外部 Vision API（违背"无模型"红线）/ 主动切换兄弟路由（需手动选避免污染原始会话模型选择）/ npm 发布（仍走 `dsh plugin add`）

详细更新历史见 [CHANGELOG.md](./CHANGELOG.md)。关联项目：`dsh-vision-skill`（同一作者，已弃用）；架构参考 [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision)（外部 API 路线）。

## License

MIT
