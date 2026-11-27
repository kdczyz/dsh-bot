/**
 * 伪 3D 黏土质感渲染层（Canvas 2D 与 SVG 通用）：
 * 1. 左上角高光（Highlight）：在 (-0.25R, -0.25R) 处叠加柔和径向渐变；
 * 2. 右下角内阴影（Inner Shadow）：使用离屏偏移纯阴影（不回绘黑色遮罩像素），
 *    避免抗锯齿边缘发黑，并随当前视角投影宽高自适应模糊与偏移量。
 */

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface ClayScratch {
  body: HTMLCanvasElement;
  bodyCtx: CanvasRenderingContext2D;
  mask: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D;
  front: HTMLCanvasElement;
  frontCtx: CanvasRenderingContext2D;
}

export function createClayScratch(): ClayScratch | null {
  if (typeof document === 'undefined') return null;
  const body = document.createElement('canvas');
  const mask = document.createElement('canvas');
  const front = document.createElement('canvas');
  const bodyCtx = body.getContext('2d');
  const maskCtx = mask.getContext('2d');
  const frontCtx = front.getContext('2d');
  if (!bodyCtx || !maskCtx || !frontCtx) return null;
  return { body, bodyCtx, mask, maskCtx, front, frontCtx };
}

const SHADOW_SHIFT = 10000;

/**
 * 对已经画在 `scratch.body` 上的完整单色身体切片施加黏土高光与内阴影。
 * `(cx, cy)` 与 `(rx, ry)` 为当前视角下实际投影在画布上的身体中心与半宽高（设备像素）。
 */
export function applyClayToCanvas(
  scratch: ClayScratch,
  width: number,
  height: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  highlightHex: string,
  shadowHex: string,
): void {
  const { body, bodyCtx, mask, maskCtx } = scratch;
  const rLight = Math.max(rx, ry);
  const rRim = Math.max(2, Math.min(rx, ry));
  if (width <= 0 || height <= 0 || rLight <= 1) return;

  // 1. 左上角高光（Highlight）：偏移 (-0.25R, -0.25R)
  bodyCtx.save();
  bodyCtx.setTransform(1, 0, 0, 1, 0, 0);
  bodyCtx.globalCompositeOperation = 'source-atop';
  const hx = cx - rx * 0.25;
  const hy = cy - ry * 0.25;
  const hiGrad = bodyCtx.createRadialGradient(hx, hy, rRim * 0.04, cx - rx * 0.08, cy - ry * 0.08, rLight * 1.15);
  hiGrad.addColorStop(0, hexToRgba(highlightHex, 0.46));
  hiGrad.addColorStop(0.45, hexToRgba(highlightHex, 0.16));
  hiGrad.addColorStop(1, hexToRgba(highlightHex, 0));
  bodyCtx.fillStyle = hiGrad;
  bodyCtx.fillRect(0, 0, width, height);

  // 2. 右下角内阴影（Inner Shadow）：外扩安全边并用远距偏移只投射纯粹阴影，不污染抗锯齿边
  const blur = Math.max(2, rRim * 0.22);
  const off = rRim * 0.14;
  const pad = Math.ceil(blur + off + 4);
  const mw = width + pad * 2;
  const mh = height + pad * 2;
  const shift = Math.max(SHADOW_SHIFT, mw + mh + 1000);
  if (mask.width !== mw || mask.height !== mh) {
    mask.width = mw;
    mask.height = mh;
  }

  maskCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskCtx.globalCompositeOperation = 'source-over';
  maskCtx.clearRect(0, 0, mw, mh);
  maskCtx.fillStyle = '#000';
  maskCtx.fillRect(0, 0, mw, mh);
  maskCtx.globalCompositeOperation = 'destination-out';
  maskCtx.drawImage(body, pad, pad);

  bodyCtx.shadowColor = hexToRgba(shadowHex, 0.52);
  bodyCtx.shadowBlur = blur;
  bodyCtx.shadowOffsetX = shift - off;
  bodyCtx.shadowOffsetY = shift - off;
  bodyCtx.drawImage(mask, -shift - pad, -shift - pad);

  // 柔和左上角高光边缘，让轮廓更 Q 弹
  const hiOff = rRim * 0.06;
  bodyCtx.shadowColor = hexToRgba(highlightHex, 0.28);
  bodyCtx.shadowBlur = Math.max(1.5, rRim * 0.12);
  bodyCtx.shadowOffsetX = shift + hiOff;
  bodyCtx.shadowOffsetY = shift + hiOff;
  bodyCtx.drawImage(mask, -shift - pad, -shift - pad);

  bodyCtx.restore();
}

/**
 * 为 SVG 渲染器生成黏土质感滤镜（高光 + 右下角内阴影）。
 * 完全纯矢量滤镜，支持无损缩放与 PNG 离屏导出。
 */
export function svgClayFilter(id: string, highlightHex: string, shadowHex: string): string {
  return (
    `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="shBlur"/>` +
    `<feOffset in="shBlur" dx="-3.2" dy="-3.2" result="shOff"/>` +
    `<feComposite in="SourceAlpha" in2="shOff" operator="out" result="shMask"/>` +
    `<feFlood flood-color="${shadowHex}" flood-opacity="0.48" result="shColor"/>` +
    `<feComposite in="shColor" in2="shMask" operator="in" result="innerShadow"/>` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="2.6" result="hiBlur"/>` +
    `<feOffset in="hiBlur" dx="3.4" dy="3.4" result="hiOff"/>` +
    `<feComposite in="SourceAlpha" in2="hiOff" operator="out" result="hiMask"/>` +
    `<feFlood flood-color="${highlightHex}" flood-opacity="0.42" result="hiColor"/>` +
    `<feComposite in="hiColor" in2="hiMask" operator="in" result="innerHighlight"/>` +
    `<feMerge>` +
    `<feMergeNode in="SourceGraphic"/>` +
    `<feMergeNode in="innerShadow"/>` +
    `<feMergeNode in="innerHighlight"/>` +
    `</feMerge>` +
    `</filter>`
  );
}
