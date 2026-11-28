/**
 * 任意 look 下单只眼睛的轮廓。
 *
 * 药丸、开心弧、扁平细缝、四角闪光星、闭眼线，全部从顶部中心顺时针等距采样 40 点；
 * 逐点混合就得到中间的所有形状，于是状态或表情切换时眼睛是“变形”，而不是“换图”。
 * 倾斜（tilt）在最后统一旋转整条轮廓，所以它和任何形状都能叠加。
 */
import type { EyeLook } from './pose.ts';
import type { Point } from './path.ts';
import { HAPPY_ARC } from './validate.ts';

/** 这一帧一只眼睛画在哪（脸的平面坐标，viewBox 单位）。 */
export interface EyeSpot {
  /** 中心，已含凝视偏移。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 眨眼/眯眼之后的药丸高度，以及它向下移动的距离。 */
  open: number;
  shift: number;
  /** 这只眼睛完全闭着（眨眼到顶）。 */
  closed?: boolean;
}

/** 每条轮廓的点数。 */
const STEPS = 40;
/** 细缝：与开心弧等宽，厚度与翘角按眼睛宽度比例。 */
const SLIT = { length: 1.9, thick: 0.5, tip: 0.2 } as const;
/** 闪光星：外径/内径按眼睛宽高的比例。 */
const STAR = { outerMin: 0.42, inner: 0.34, points: 4 } as const;
/** 闭眼线：比眼睛略长，向下弯。 */
const CLOSED = { length: 1.3, thick: 0.3, sag: 0.3 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 沿闭合折线等距取 `count` 个点，从第一个点开始。 */
function resample(pts: Point[], count: number): Point[] {
  const n = pts.length;
  const at: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    at.push(at[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = at[n];
  const out: Point[] = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * total;
    while (i < n - 1 && at[i + 1] < s) i++;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const u = at[i + 1] > at[i] ? (s - at[i]) / (at[i + 1] - at[i]) : 0;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

/** 一段圆弧上的点，从 `from` 到 `to`（弧度，y 向下），含两端。 */
function sweep(cx: number, cy: number, r: number, from: number, to: number, steps: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/** 药丸：以 (cx, cy) 为中心、宽 w 高 h 的跑道形，从顶部中心顺时针。 */
function pill(cx: number, cy: number, w: number, h: number): Point[] {
  const r = Math.min(w, h) / 2;
  const fx = w / 2 - r;
  const fy = h / 2 - r;
  const q = Math.PI / 2;
  return [
    [cx, cy - h / 2] as Point,
    ...sweep(cx + fx, cy - fy, r, -q, 0, 6),
    ...sweep(cx + fx, cy + fy, r, 0, q, 6),
    ...sweep(cx - fx, cy + fy, r, q, 2 * q, 6),
    ...sweep(cx - fx, cy - fy, r, 2 * q, 3 * q, 6),
  ];
}

/** 开心弧的轮廓：描边的上下两条边，加上两个圆头。 */
function arc(e: EyeSpot): Point[] {
  const hw = e.w * HAPPY_ARC.halfWidth;
  const base = e.y + e.h * HAPPY_ARC.base;
  const peak = e.y - e.h * HAPPY_ARC.peak;
  const r = (e.w * HAPPY_ARC.stroke) / 2;
  const at = (s: number): { p: Point; n: Point } => {
    const m = 1 - s;
    const x = e.x + hw * (2 * s - 1);
    const y = (m * m + s * s) * base + 2 * m * s * peak;
    const tx = 2 * hw;
    const ty = 2 * (2 * s - 1) * (base - peak);
    const len = Math.hypot(tx, ty);
    return { p: [x, y], n: [ty / len, -tx / len] };
  };
  const edge = (from: number, to: number, side: 1 | -1): Point[] => {
    const pts: Point[] = [];
    for (let i = 0; i <= 8; i++) {
      const { p, n } = at(from + ((to - from) * i) / 8);
      pts.push([p[0] + n[0] * r * side, p[1] + n[1] * r * side]);
    }
    return pts;
  };
  const end = (s: 0 | 1): Point[] => {
    const { p, n } = at(s);
    const up = Math.atan2(n[1], n[0]);
    return s === 1 ? sweep(p[0], p[1], r, up, up + Math.PI, 8) : sweep(p[0], p[1], r, up + Math.PI, up + 2 * Math.PI, 8);
  };
  return [...edge(0.5, 1, 1), ...end(1), ...edge(1, 0, -1), ...end(0), ...edge(0, 0.5, 1)];
}

/** 细缝：几乎躺平的薄胶囊，两只眼向同一侧倾；眨眼会把它变薄。 */
function slit(e: EyeSpot): Point[] {
  const length = e.w * SLIT.length;
  const thick = e.w * SLIT.thick * clamp(e.open / e.h, 0.3, 1);
  const cos = Math.cos(SLIT.tip);
  const sin = Math.sin(SLIT.tip);
  return pill(0, 0, length, thick).map(([x, y]) => [e.x + x * cos - y * sin, e.y + x * sin + y * cos] as Point);
}

/** 半闭的眼（困）：上缘平、下缘圆，像上眼皮压下来一样。 */
function lidded(e: EyeSpot, drop: number): Point[] {
  const w = e.w;
  const half = w / 2;
  const ty = e.y + e.shift - e.h / 2 + clamp(drop, 0, 1) * e.h * 0.62;
  const by = e.y + e.shift + e.h / 2;
  const h = Math.max(by - ty, w * 0.4);
  const r = Math.min(half, h / 2);
  const q = Math.PI / 2;
  return [
    [e.x - half, ty] as Point,
    [e.x + half, ty] as Point,
    ...sweep(e.x + half - r, by - r, r, 0, q, 5),
    ...sweep(e.x - half + r, by - r, r, q, 2 * q, 5),
  ];
}

/** 四角闪光星：近方形的四角星，内角圆润（软化后再重采样）。 */
function star(e: EyeSpot): Point[] {
  // 星要看起来“方”，所以横竖两个半径都按眼睛的长边取，再各自不小于一个下界。
  const rx = Math.max(e.w * 1.05, e.h * STAR.outerMin);
  const ry = Math.max(e.h * 0.6, e.w * 1.0);
  const irx = rx * STAR.inner;
  const iry = ry * STAR.inner;
  const pts: Point[] = [];
  const n = STAR.points * 2;
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / STAR.points;
    const ox = k % 2 ? irx : rx;
    const oy = k % 2 ? iry : ry;
    pts.push([e.x + Math.cos(a) * ox, e.y + Math.sin(a) * oy]);
  }
  // 每个顶点后插一个靠内的点，重采样时星角不会整块丢掉。
  const softened: Point[] = [];
  for (let k = 0; k < n; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % n];
    softened.push(p, [p[0] * 0.8 + q[0] * 0.2, p[1] * 0.8 + q[1] * 0.2]);
  }
  return softened;
}

/** 闭眼线：一条向下弯的细胶囊，像垂下的眼皮。 */
function closedEyelid(e: EyeSpot): Point[] {
  const half = (e.w * CLOSED.length) / 2;
  const thick = Math.max(e.w * CLOSED.thick, 0.8);
  const sag = Math.max(e.h * CLOSED.sag, thick);
  const y0 = e.y - e.h * 0.02;
  const N = 14;
  const upper: Point[] = [];
  const lower: Point[] = [];
  // 曲线很浅，直接按竖直方向取厚度，避免法线在两端翻转导致自交。
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const x = e.x - half + 2 * half * s;
    const y = y0 + sag * (1 - (2 * s - 1) ** 2);
    upper.push([x, y - thick / 2]);
    lower.push([x, y + thick / 2]);
  }
  const cap = (cx: number, cy: number, from: number, to: number): Point[] => sweep(cx, cy, thick / 2, from, to, 4);
  const right = upper[upper.length - 1];
  const left = upper[0];
  return [
    ...upper,
    ...cap(right[0], right[1] + thick / 2, -Math.PI / 2, Math.PI / 2),
    ...lower.reverse(),
    ...cap(left[0], left[1] + thick / 2, Math.PI / 2, Math.PI * 1.5),
  ];
}

/** 是否恰好是普通药丸或恰好是开心弧：这两种直接用简单图元画，省一条路径。 */
export function plainLook(look: EyeLook): 'pill' | 'arc' | null {
  if (look.arc >= 1) return 'arc';
  const rest = look.arc <= 0 && look.slit <= 0 && look.wide <= 0 && look.star <= 0 && Math.abs(look.tilt) < 0.02;
  return rest ? 'pill' : null;
}

/** 把一条轮廓绕眼睛中心旋转 `angle` 弧度。 */
function tilt(pts: Point[], e: EyeSpot, angle: number): Point[] {
  if (Math.abs(angle) < 1e-4) return pts;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return pts.map(([x, y]) => {
    const dx = x - e.x;
    const dy = y - e.y;
    return [e.x + dx * cos - dy * sin, e.y + dx * sin + dy * cos] as Point;
  });
}

/** 混合权重：闭眼 > 星 > 弧 > 细缝 > 药丸。 */
function weightsOf(look: EyeLook): { name: string; w: number }[] {
  const star = clamp(look.star, 0, 1);
  const arc = clamp(look.arc, 0, 1 - star);
  const lid = clamp(look.lid, 0, 1 - arc - star);
  const slit = clamp(look.slit, 0, 1 - arc - star - lid);
  const pillw = Math.max(0, 1 - arc - slit - lid - star);
  return [
    { name: 'pill', w: pillw },
    { name: 'arc', w: arc },
    { name: 'slit', w: slit },
    { name: 'star', w: star },
    { name: 'lidded', w: lid },
  ];
}

/** 一只眼的闭合轮廓，从顶部顺时针：各形状按 look 混合后再统一倾斜。 */
export function eyeOutline(look: EyeLook, e: EyeSpot): Point[] {
  if (e.closed) return tilt(resample(closedEyelid(e), STEPS), e, look.tilt * 0.25);

  const wide = clamp(look.wide, 0, 1);
  const shapes: Record<string, Point[]> = {
    // 惊讶时眼睛更高、更圆（宽不变，圆角半径随之变大）。
    pill: pill(e.x, e.y + e.shift, e.w, e.open * (1 + 0.2 * wide)),
    arc: arc(e),
    slit: slit(e),
    star: star(e),
    lidded: lidded(e, clamp(look.lid, 0, 1)),
  };
  const out: Point[] = Array.from({ length: STEPS }, () => [0, 0] as Point);
  let total = 0;
  for (const { name, w } of weightsOf(look)) {
    if (w <= 0) continue;
    total += w;
    resample(shapes[name], STEPS).forEach(([x, y], i) => {
      out[i][0] += x * w;
      out[i][1] += y * w;
    });
  }
  if (total <= 0) return tilt(resample(shapes.pill, STEPS), e, look.tilt * 0.25);
  for (const p of out) {
    p[0] /= total;
    p[1] /= total;
  }
  return tilt(out, e, look.tilt * 0.25);
}

const f = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/** 过一组点的光滑闭合路径：每点一条二次曲线，在边中点相接。只用绝对的 M / Q / Z。 */
export function outlinePath(pts: Point[]): string {
  const n = pts.length;
  const mid = (i: number): Point => {
    const a = pts[i % n];
    const b = pts[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const start = mid(n - 1);
  let d = `M${f(start[0])} ${f(start[1])}`;
  for (let i = 0; i < n; i++) {
    const m = mid(i);
    d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f(m[0])} ${f(m[1])}`;
  }
  return `${d}Z`;
}

/** 既不是普通药丸也不是普通弧时，单只眼睛的路径。 */
export function eyePath(look: EyeLook, e: EyeSpot): string {
  return outlinePath(eyeOutline(look, e));
}

/** 高光：眼睛左上角的一小块圆，用身体颜色画在眼球上层。 */
export function glintPath(e: EyeSpot, strength: number): { d: string; r: number; x: number; y: number } | null {
  const open = clamp(e.open / e.h, 0, 1);
  const k = clamp(strength, 0, 1) * clamp((open - 0.25) / 0.5, 0, 1);
  if (k <= 0.04) return null;
  const r = Math.max(0.35, Math.min(e.w * 0.24, e.h * 0.17) * k);
  const x = e.x - e.w * 0.24;
  const y = e.y + e.shift - e.h * 0.24;
  return { d: `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 1 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 1 ${f(-2 * r)} 0Z`, r, x, y };
}