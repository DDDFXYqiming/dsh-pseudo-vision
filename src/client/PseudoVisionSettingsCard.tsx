import { useEffect } from "react";

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
  margin: 0 0 6px;
  font-size: 15px;
}
.dsh-pseudo-vision-card p {
  margin: 0;
  color: var(--vp-c-text-2, #67676c);
}
.dsh-pseudo-vision-card .tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  margin-left: 8px;
  background: #10b98122;
  color: #10b981;
}
`;

const STYLE_ID = "dsh-pseudo-vision-card-css";

export function PseudoVisionSettingsCard(_props: CardProps): JSX.Element {
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
        <span className="tag">已启用</span>
      </h4>
      <p>为不支持图片的模型提供本地 OCR 与图像分析；原生视觉模型保持不变。</p>
    </div>
  );
}
