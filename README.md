# dsh-pseudo-vision

> 给 DeepSeek Harness 的 text-only provider 装上"工具层视觉"：把图片在落地到模型前，自动拆解成 OCR 文字 + 颜色统计 + 像素扫描 + 元信息，让任意纯文本模型也能"看图"。

**实机验证通过**（dsh 0.1.0-rc.8 / deepseek-v4-flash 实测：模型收到图片后正确读出 OCR 文字、颜色占比、图片尺寸并回答）。

## 它在做什么

当 `deepseek-v4-flash`（text-only）收到 `read_image` 失败错误时，可以用 `bash` + Python 拼出 OCR、像素分析、颜色统计和元信息，再把图片转换为结构化文本。

**dsh-pseudo-vision 将这套本地证据链封装为插件能力**：

1. 通过 `cordis.patch.yml` 接管官方 `deepseek-official` 路由，保持现有 DeepSeek 行为
2. 按 `bridgeProviders` 白名单（或显式 `bridgeOtherProviders`）为其他已注册 provider 生成兄弟路由，例如 `dsh-pseudo-vision/kimi-for-coding`、`dsh-pseudo-vision/openrouter`
3. **自动标识为识图**：兄弟路由的 `resolveModel` / `listModels` 强制声明 `inputModalities: ["text", "image"]`，先通过 DSH 的图片 admission 门
4. **请求时伪视觉**：原生视觉模型原样透传；text-only 模型读附件 → 本地 4 工具转文本 → 替换 image block + 注入 `<pseudo-vision-context>`，再委托回原 provider

**全程本机执行，无外部视觉 API**。原始 provider 的 HTTP 请求只含文本，text-only 网关不会 400；原始 provider 路由本身不被修改。

## 提供的能力

| 工具 | 作用 | 实现 |
|---|---|---|
| `vision_ocr` | 提取图中所有文字（带归一化坐标） | tesseract.js（chi_sim + eng，本地语言包） |
| `vision_color_stats` | 像素占比分析（白/黑/灰/红/绿/蓝等） | sharp + 直方图统计 |
| `vision_pixel_scan` | 逐行检测目标色像素密度 | sharp raw pixel access |
| `vision_meta` | 尺寸、格式、色彩空间、四角/中心颜色采样 | sharp metadata |

## OCR 优化管线（v0.4.0）

图片证据仍然全部在本机生成；OCR 现在不再固定压到 512px，而是按预算走一条可追溯的预处理管线：

```yaml
- id: dsh-pseudo-vision
  config:
    ocrBudget: auto       # auto | small | normal | large | mega
```

### 原图证据与 OCR 预处理边界

四项视觉证据不会共用被修改过的图片字节，处理分支如下：

```text
原图 bytes
├─ vision_color_stats → 原图颜色占比
├─ vision_pixel_scan  → 原图目标色/红色行
├─ vision_meta        → 原图尺寸、格式与采样
└─ vision_ocr         → OCR 专用副本（预算、灰度、反色、增强）
```

自动伪视觉桥接只对 OCR 副本执行缩放、灰度、反色、对比度、锐化和白边；颜色统计、像素扫描、元信息始终基于原图。直接调用 `vision_ocr` 工具时也读取原图字节。所有处理都在本机完成，不会把原图发送给外部视觉 API。

`ocrNoResize: true` 的含义是跳过 OCR 分支的预算缩放和自适应放大，保留原图的几何尺寸；它**不是**完全关闭预处理，OCR 副本仍会增强并添加白边（最终副本会因此增加边框像素）。它也不影响另外三个工具读取原图。

| 阶段 | 行为 |
|---|---|
| 预算与吸附 | `small=512²`、`normal=1024²`、`large=1448²`、`mega=4096²`；按 Qwen 风格 `minPixels/maxPixels + 28` 倍数网格吸附 |
| `auto` | 常规图使用 `normal`；超过约 210 万像素使用 `large`；小图会先放大到 OCR 友好的尺寸 |
| 小字放大 | OCR 前对小输入用 Lanczos 放大（不超过该预算的最长边上限） |
| 深色与低对比度 | 自动依据原图颜色统计判断暗底，反色后执行灰度、对比度拉伸、轻锐化，并给贴边文字补白边 |
| 超长截图 | 原图高度超过 3000px 时先按原图切成 2000px 高、100px 重叠的块，再对每块独立预算预处理和 OCR，输出 `[第 i/N 块，y=...]` 边界 |
| 低置信度复核 | Tesseract 置信度低于 60 的最多 3 行会裁剪、补边、2× 放大后复核；红色行像素扫描命中时扩大该复核区域 |
| 缓存隔离 | 缓存键包含 `sha256 + 解析后的 budget + langs/resize 开关 + OCR 管线参数版本`；旧缓存文件保留，不会与新管线串结果 |

`auto` 适合默认使用；密集表格、细小字体或文档可显式选择 `large`/`mega`，只想限制本地 CPU/内存时选择 `small`。需要保留 OCR 原图尺寸时设 `ocrNoResize: true`（仍会执行灰度/对比度/锐化/白边增强）。颜色统计、像素扫描、元信息始终读取原图，不会因为 OCR 预处理而改变模型看到的颜色证据。`bypassCache: true` 可强制重算。

## 安装

```bash
# GitHub 安装（需网络，推荐）
dsh plugin --profile web add github:DDDFXYqiming/dsh-pseudo-vision
```

> ⚠️ Windows 注意：本机若报 `schannel: CRYPT_E_NO_REVOCATION_CHECK` 或 pnpm 安全删除拦截，改用本地路径安装：
>
> ```bash
> git clone https://github.com/DDDFXYqiming/dsh-pseudo-vision.git
> cd dsh-pseudo-vision
> pnpm install && pnpm build
> dsh plugin --profile web add <本机绝对路径>
> ```

## 使用

**装上即生效**，无需额外配置。`deepseek-official` 路由继续自动支持图片。

**其他 provider 默认不生成兄弟路由**（避免模型选择器出现大量重复条目）。只有当你确实需要在某个 text-only provider 上收图时，才在 profile patch 中显式开启白名单：

```yaml
- id: dsh-pseudo-vision
  config:
    bridgeProviders: ["kimi-for-coding"]   # 只给这个 provider 生成兄弟路由
    ocrBudget: auto                        # 也可 small/normal/large/mega
    ocrNoResize: false                     # true：跳过预算缩放/放大
```

或一次性桥接除 `excludeProviders` 外的所有 provider（谨慎：每个模型都会在模型选择器里多出一份 `· Pseudo Vision` 条目）：

```yaml
    bridgeOtherProviders: true
```

开启后，模型选择器会出现 `dsh-pseudo-vision/<provider>`（显示为 `· Pseudo Vision`）兄弟路由；选择它，text-only 模型会自动走本地伪视觉转换，原生视觉模型保持原生透传。

**效果示例**（deepseek-v4-flash 实测收到的伪视觉证据）：

```
[dsh-pseudo-vision] sha256=46997842de08 budget=normal 原图:image/png 217068B 预处理:灰度 1392×776
OCR 文本：23 行（"了解 deepseek harness 的 dsh 安装"等）
OCR 低置信度重试：1 个区域（2× 局部复核）
元信息：image/png, 217068B, 原图尺寸 1919×1019
颜色统计：白色 94.1%、灰色 5.1%、其他 0.6%  → 推断浅色 UI
像素扫描：无红色高密度行
```

模型基于以上结构化证据"脑补"出整张图内容。

## 兼容版本

| dsh 版本 | 状态 |
|---|---|
| 0.1.0-rc.7 | ⚠️ 结构兼容（未实机验证） |
| 0.1.0-rc.8 | ✅ 实机验证通过 |
| 0.1.0-rc.9+ | ⚠️ 需重新验证（dsh 处于开发者预览，破坏性变更常见） |

## 权限

- 读取工作区内的图片附件
- 写入临时缓存到 `~/.dsh/profiles/<profile>/.dsh-pseudo-vision/cache/`（键含 sha256、budget、langs/resize 开关、OCR 管线参数版本）
- 进程内 tesseract.js OCR + sharp（首次运行从 tesseract CDN 下载语言包到内置缓存，之后离线）
- 接管 `deepseek-official` provider（禁用官方 llm-deepseek，由插件重新注册）
- 按配置（`bridgeProviders` 白名单 / `bridgeOtherProviders` 全开）为指定 provider 注册兄弟路由；兄弟 adapter 通过公开的 `ctx.llm` API 委托原始 provider。**默认不注册任何其他 provider 的兄弟路由**

**不**会：
- 上传任何图片到外部 API
- 修改 dsh 核心代码（纯 cordis patch + adapter 包装）
- 覆盖或替换原始 provider adapter；原路由仍按原逻辑运行

## 已知边界

- 复杂空间关系、真实照片：描述精度有限（与 Yinsen 实验一致）
- OCR 可能认错字（例如把 "DeepSeek" 识别成 "Deepseck"），影响理解
- 颜色统计只给占比，无法还原布局/图标细节
- 大图：OCR 按 `ocrBudget` 预算处理；超长截图会先按原图切块，颜色/像素/元信息仍基于原图
- OCR 低置信度复核最多 3 个区域；它提升小字可读性，但不等同于真正的图像超分辨率

## ⚠️ 已知边界 / 路线图

当前版本（v0.4.0）已支持通过兄弟路由桥接其他 live provider，并新增可配置 OCR 预算、长截图分块、暗色/低对比度增强、低置信度局部复核与参数隔离缓存；跨 provider 仍**默认关闭**（`bridgeProviders` 白名单开启），且需要用户在模型选择器中选择带 `· Pseudo Vision` 标记的路由；原始 provider 不会被隐式改写。

| 项 | 状态 | 说明 |
|---|---|---|
| **其他 text-only 模型支持**（`llm-pi-ai` 下的 GLM / Qwen / Kimi / OpenRouter 等） | ✅ 已实现（默认关闭） | 通过 `bridgeProviders` 白名单或 `bridgeOtherProviders` 开启；开启后注册 `dsh-pseudo-vision/<provider>` 兄弟路由，原始路由保持不变 |
| **外部 Vision Backend**（Qwen-VL / Gemini / OpenAI-compatible） | ❌ 未实现 | 当前版本坚持本地 OCR/颜色/像素/元信息；后续可增加显式 opt-in 的外部视觉后端 |
| **自动切换兄弟路由** | ⚠️ 未实现 | 当前需在模型选择器手动选择 `· Pseudo Vision` 路由，避免污染原始会话模型选择 |
| **npm 发布** | ❌ 未发布 | 发布为 `dsh-pseudo-vision` npm 包，支持 `dsh plugin add` 一行安装 |
| **client 端增强** | ⚠️ 基础版 | 已有 settings 插件卡片；自动 composer 图片提示未做 |
| **多语言 OCR 配置** | ✅ 已支持 | `langs` 配置项（默认 `chi_sim+eng`） |
| **图像预缩放策略** | ✅ 已实现 | `ocrBudget` + smart resize + 小字自适应放大；`auto` 按原图像素数选择 normal/large |
| **长截图 OCR** | ✅ 已实现 | 原图高度 > 3000px 时 2000px 分块、100px 重叠，块级预算预处理并合并边界 |
| **预处理与局部复核** | ✅ 已实现 | 暗色反色、灰度/对比度/锐化、白边、低置信度最多 3 区域 2× 重试 |
| **缓存失效/手动刷新** | ✅ 已实现 | sha256 + budget + 管线参数版本内容寻址缓存；`bypassCache` 强制重算 |

## 关联项目

- `dsh-vision-skill`（同一作者，已弃用）：早期 paste-to-path 方案
- [Yinsen 原帖](https://x.com/YinsenW_/status/...)
- [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision)：本插件架构参考（adapter 替换思路），但使用外部视觉 API 而非本地工具

## License

MIT
