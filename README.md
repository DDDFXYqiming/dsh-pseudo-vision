# dsh-pseudo-vision

> 给 text-only DeepSeek Harness 模型装上"工具层视觉"：把图片在落地到模型前，自动拆解成 OCR 文字 + 颜色统计 + 像素扫描 + 元信息，让纯文本模型也能"看图"。

固定化 [@YinsenW\_](https://x.com/YinsenW_) 2026-08-20 扒出的 DeepSeek Harness rc.8 伪视觉流程。**实机验证通过**（2026-08-20，dsh 0.1.0-rc.8 / deepseek-v4-flash 实测：模型收到图片后正确读出 OCR 文字、颜色占比、图片尺寸并回答）。

## 它在做什么

Yinsen 的实验显示，当 `deepseek-v4-flash`（text-only）收到 read_image 失败错误时，会**自己**用 `bash` + Python 拼出 OCR + 像素分析 + 颜色统计 + 元信息这套工具链，把图片"硬拼"成结构化文本再喂回自己。

**dsh-pseudo-vision 把这套涌现流程封装成插件的固定能力**：

1. 通过 `cordis.patch.yml` 禁用官方 `llm-deepseek` 适配器
2. 插件重新注册 `deepseek-official` provider，用 `PseudoVisionBridgeAdapter` 包装官方 DeepSeekAdapter
3. **自动标识为识图**：`resolveModel` / `listModels` 强制声明 `inputModalities: ["text", "image"]` —— 模型选择器和 api-proxy 门禁都放行，**无需手动配置**
4. **请求时伪视觉**：`stream()` 检测 image block → 若底层模型真实支持图片则原生透传；否则读附件 → 本地 4 工具转文本 → 替换 image block + 注入 `<pseudo-vision-context>` 到系统提示词

**全程本机执行，无外部视觉 API**。底层 HTTP 请求只含文本，text-only 网关不会 400。

## 提供的能力

| 工具 | 作用 | 实现 |
|---|---|---|
| `vision_ocr` | 提取图中所有文字（带归一化坐标） | tesseract.js（chi_sim + eng，本地语言包） |
| `vision_color_stats` | 像素占比分析（白/黑/灰/红/绿/蓝等） | sharp + 直方图统计 |
| `vision_pixel_scan` | 逐行检测目标色像素密度 | sharp raw pixel access |
| `vision_meta` | 尺寸、格式、色彩空间、四角/中心颜色采样 | sharp metadata |

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

**装上即生效**，无需任何配置。`deepseek-official` 路由下所有模型自动声明为支持图片；text-only 模型收到图片时自动走伪视觉转换。

**效果示例**（deepseek-v4-flash 实测收到的伪视觉证据）：

```
元信息：sha256=46997842de08, image/png, 217068B, 尺寸 1919×1019
OCR 文本：23 行（"了解 deepseek harness 的 dsh 安装"等）
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
- 写入临时缓存到 `~/.dsh/profiles/<profile>/.dsh-pseudo-vision/cache/`
- 进程内 tesseract.js OCR + sharp（首次运行从 tesseract CDN 下载语言包到内置缓存，之后离线）
- **接管 `deepseek-official` provider**（这是插件工作的方式：禁用官方 llm-deepseek，由插件重新注册）

**不**会：
- 上传任何图片到外部 API
- 修改 dsh 核心代码（纯 cordis patch + adapter 包装）
- 影响 `llm-pi-ai` 下的其他 provider（kimi-for-coding、MiniMax M3、GLM、Qwen 等原样运行）

## 已知边界

- 复杂空间关系、真实照片：描述精度有限（与 Yinsen 实验一致）
- OCR 可能认错字（例如把 "DeepSeek" 识别成 "Deepseck"），影响理解
- 颜色统计只给占比，无法还原布局/图标细节
- 大图：自动降采样后再分析

## ⚠️ 未完成 / 路线图

当前版本（v0.2.0）**只接管 `deepseek-official` 这一个 provider**。以下为已知未完成项：

| 项 | 状态 | 计划 |
|---|---|---|
| **其他 text-only 模型支持**（`llm-pi-ai` 下的 GLM / Qwen / Kimi 纯文本变体等） | ❌ 未实现 | v0.3.0：用 `agent/pre-step` waterfall 做通用图片→文本拦截（已验证该钩子支持替换消息批次），不碰任何 adapter；需与 deepseek adapter 方案协调避免重复转换 |
| **npm 发布** | ❌ 未发布 | 发布为 `dsh-pseudo-vision` npm 包，支持 `dsh plugin add` 一行安装 |
| **client 端增强** | ⚠️ 基础版 | 已有 settings 插件卡片；自动 composer 图片提示未做 |
| **多语言 OCR 配置** | ✅ 已支持 | `langs` 配置项（默认 `chi_sim+eng`） |
| **图像预缩放策略** | ⚠️ 固定 | 目前固定降采样 512px 分析；可配置化未做 |
| **缓存失效/手动刷新** | ⚠️ 部分 | sha256 内容寻址缓存；`bypassCache` 配置项可强制重算 |

## 关联项目

- `dsh-vision-skill`（同一作者，已弃用）：早期 paste-to-path 方案
- [Yinsen 原帖](https://x.com/YinsenW_/status/...)
- [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision)：本插件架构参考（adapter 替换思路），但使用外部视觉 API 而非本地工具

## License

MIT
