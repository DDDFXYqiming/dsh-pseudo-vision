import { useEffect, useState } from "react";

interface CardProps {
  scope?: unknown;
}

const CARD_CSS = `
.dsh-pseudo-vision-card {
  border: 1px solid var(--vp-c-divider, #e2e2e3);
  border-radius: 8px;
  padding: 16px;
  margin: 12px 0;
  font-size: 14px;
  line-height: 1.6;
}
.dsh-pseudo-vision-card h4 {
  margin: 0 0 8px;
  font-size: 15px;
}
.dsh-pseudo-vision-card .tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  margin-left: 8px;
}
.dsh-pseudo-vision-card .tag.on { background: #10b98122; color: #10b981; }
.dsh-pseudo-vision-card .tag.off { background: #ef444422; color: #ef4444; }
.dsh-pseudo-vision-card ul { margin: 8px 0; padding-left: 18px; }
.dsh-pseudo-vision-card code {
  background: var(--vp-c-bg-soft, #f6f6f7);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
}
`;

const STYLE_ID = "dsh-pseudo-vision-card-css";

export function PseudoVisionSettingsCard(_props: CardProps): JSX.Element {
  const [enabled] = useState(true);

  useEffect(() => {
    if (document.querySelector(`style[data-id="${STYLE_ID}"]`) !== null) return;
    const tag = document.createElement("style");
    tag.dataset.id = STYLE_ID;
    tag.textContent = CARD_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, []);

  return (
    <div className="dsh-pseudo-vision-card">
      <h4>
        伪视觉桥接 (dsh-pseudo-vision)
        <span className={`tag ${enabled ? "on" : "off"}`}>
          {enabled ? "已启用" : "未启用"}
        </span>
      </h4>
      <p>
        <code>deepseek-official</code> 路由声明支持图片；
        其他 provider 仅在配置 <code>bridgeProviders</code> 白名单后生成
        <code>dsh-pseudo-vision/&lt;provider&gt;</code> 兄弟路由（默认关闭）。
        当模型本身不支持图片时，图片会在请求前被本地转换为：
      </p>
      <ul>
        <li><code>vision_ocr</code> — OCR 文字（tesseract.js）</li>
        <li><code>vision_color_stats</code> — 颜色占比（sharp）</li>
        <li><code>vision_pixel_scan</code> — 像素行扫描（sharp）</li>
        <li><code>vision_meta</code> — 元信息 + 角/中心采样（sharp）</li>
      </ul>
      <p style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>
        OCR 预算：<code>ocrBudget</code> 默认 <code>auto</code>，可选
        <code>small</code>/<code>normal</code>/<code>large</code>/<code>mega</code>；
        需要原图尺寸时可设 <code>ocrNoResize: true</code>。
      </p>
      <ul>
        <li>小字自适应 Lanczos 放大；暗色模式反色、灰度、对比度拉伸、锐化、白边</li>
        <li>超长截图按 2000px 块、100px 重叠处理，并保留块边界</li>
        <li>低置信度最多 3 个区域自动裁剪并 2× 复核</li>
        <li>缓存键隔离预算和完整 OCR 管线参数；颜色/像素/元信息仍读取原图</li>
      </ul>
      <p>
        转换结果以 <code>&lt;pseudo-vision-context&gt;</code> 注入系统提示词，
        图片字节不会进入纯文本模型的请求。整个过程在本机完成，无外部 API。
        已开启的兄弟路由在模型选择器中显示为 <code>· Pseudo Vision</code>。
      </p>
    </div>
  );
}