/**
 * 48 点闭合眼环：表情变形的拓扑基础。
 *
 * 每只眼睛永远是 48 个顶点的闭合数组，索引 0 固定在 3 点钟方向，按屏幕顺时针
 * （y 向下，角度递增）均匀排列。于是任意两种表情都能逐点插值，不会“拧麻花”。
 *
 * 坐标单位：viewBox 单位、以眼睛中心为原点、对应 `eyes.scale = 1`
 * （中性眼约宽 4、高 11，与定义契约一致）。渲染器再乘以实际眼睛倍率。
 */
import type { AvatarMood } from '../core/types.ts';

export interface Pt {
  x: number;
  y: number;
}
export type EyeRing = Pt[];
export type EyePair = [EyeRing, EyeRing];

export const POINT_COUNT = 48;
const TAU = Math.PI * 2;

export interface RingParams {
  /** 半宽、半高。 */
  rx: number;
  ry: number;
  /** 超椭圆指数：2 = 椭圆，越大越方；默认 2.6（圆润的胶囊）。 */
  n?: number;
  /** 上半区压扁（0..1）。 */
  squintTop?: number;
  /** 下半区压扁（0..1）。 */
  squintBottom?: number;
  /** 抛物线弯曲：y += bend·(x/rx)²；正值两端下垂，读作“^”形笑眼。 */
  bend?: number;
  /** 上眼睑切线：y = lid.y + lid.slope·x，线以上的点压到线上。 */
  lid?: { y: number; slope?: number };
  /** 下眼睑切线：线以下的点压到线上。 */
  floor?: { y: number; slope?: number };
  /** 斜切：x += shear·y。 */
  shear?: number;
  /** 旋转（弧度，正 = 顺时针）。 */
  tilt?: number;
  /** 整体平移。 */
  dx?: number;
  dy?: number;
}

/** 按角度 θᵢ = 2πi/48 采样超椭圆，再依次施加表情修饰。 */
export function createEyeRing(p: RingParams): EyeRing {
  const n = p.n ?? 2.6;
  const ring: EyeRing = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    const theta = (i / POINT_COUNT) * TAU;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let x = Math.sign(c) * Math.abs(c) ** (2 / n) * p.rx;
    let y = Math.sign(s) * Math.abs(s) ** (2 / n) * p.ry;
    if (y < 0 && p.squintTop) y *= 1 - p.squintTop;
    if (y > 0 && p.squintBottom) y *= 1 - p.squintBottom;
    if (p.bend) y += (p.bend * x * x) / (p.rx * p.rx);
    if (p.lid) {
      const line = p.lid.y + (p.lid.slope ?? 0) * x;
      if (y < line) y = line;
    }
    if (p.floor) {
      const line = p.floor.y + (p.floor.slope ?? 0) * x;
      if (y > line) y = line;
    }
    if (p.shear) x += p.shear * y;
    ring.push({ x, y });
  }
  return transform(ring, p.tilt ?? 0, p.dx ?? 0, p.dy ?? 0);
}

function transform(ring: EyeRing, tilt: number, dx: number, dy: number): EyeRing {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return ring.map(({ x, y }) => ({ x: x * c - y * s + dx, y: x * s + y * c + dy }));
}

/**
 * 任意“关于原点星形”的闭合折线 → 48 点眼环：沿 θᵢ 方向发射线，取最远交点。
 * 保证与参数化眼环同样的索引约定（0 = 3 点钟、顺时针）。
 */
export function ringFromPolygon(poly: Pt[], origin: Pt = { x: 0, y: 0 }): EyeRing {
  const ring: EyeRing = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    const theta = (i / POINT_COUNT) * TAU;
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    let best = 0;
    for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
      const ax = poly[j].x - origin.x;
      const ay = poly[j].y - origin.y;
      const ex = poly[k].x - poly[j].x;
      const ey = poly[k].y - poly[j].y;
      const den = ux * ey - uy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;
      const u = (ax * uy - ay * ux) / den;
      if (t > best && u >= 0 && u <= 1) best = t;
    }
    ring.push({ x: origin.x + ux * best, y: origin.y + uy * best });
  }
  return ring;
}

/** 心形眼（参数方程采样后按角度重排），宽约 2·halfWidth。 */
export function heartRing(halfWidth: number, dy = 0): EyeRing {
  const poly: Pt[] = [];
  for (let k = 0; k < 160; k++) {
    const t = (k / 160) * TAU;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    poly.push({ x: (x / 16) * halfWidth, y: (y / 16) * halfWidth + 0.1 * halfWidth });
  }
  return ringFromPolygon(poly).map((p) => ({ x: p.x, y: p.y + dy }));
}

/**
 * 左右镜像，同时保持索引约定：镜像后第 i 点来自原环第 (N/2 − i) 点，
 * 于是 0 号点仍在 3 点钟、方向仍是顺时针。
 */
export function mirrorRing(ring: EyeRing): EyeRing {
  const out: EyeRing = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    const p = ring[(((POINT_COUNT / 2 - i) % POINT_COUNT) + POINT_COUNT) % POINT_COUNT];
    out.push({ x: -p.x, y: p.y });
  }
  return out;
}

/** 左眼参数 → 一对（右眼镜像，于是“内角”语义左右一致）。 */
const pair = (left: RingParams, right?: RingParams): EyePair => [
  createEyeRing(left),
  right ? mirrorRing(createEyeRing(right)) : mirrorRing(createEyeRing(left)),
];

/** 15 种表情。所有参数写的是“左眼”，x 正方向 = 朝鼻梁的内角。 */
const LIBRARY: Record<AvatarMood, EyePair> = {
  neutral: pair({ rx: 2.1, ry: 5.4 }),
  happy: pair({ rx: 2.9, ry: 1.5, bend: 2.6, dy: -0.6 }),
  joy: pair({ rx: 3.2, ry: 1.9, bend: 3.4, n: 2.2, dy: -0.9 }),
  love: [heartRing(3.2, -0.2), mirrorRing(heartRing(3.2, -0.2))],
  surprised: pair({ rx: 2.9, ry: 5.8, n: 2.15 }),
  curious: pair({ rx: 2.4, ry: 5.8, n: 2.3 }, { rx: 2.0, ry: 4.6, squintTop: 0.25, dy: 0.5 }),
  skeptical: pair({ rx: 2.2, ry: 5.2 }, { rx: 2.4, ry: 5.2, lid: { y: -0.9, slope: 0.15 } }),
  sleepy: pair({ rx: 2.6, ry: 5.2, lid: { y: 1.6 } }),
  bored: pair({ rx: 2.5, ry: 5.2, lid: { y: -0.5 }, squintBottom: 0.15 }),
  sad: pair({ rx: 2.3, ry: 5.0, lid: { y: -1.6, slope: -0.75 }, dy: 0.6 }),
  angry: pair({ rx: 2.5, ry: 5.2, lid: { y: -1.2, slope: 0.95 } }),
  focused: pair({ rx: 2.8, ry: 5.4, squintTop: 0.5, squintBottom: 0.38 }),
  confused: pair({ rx: 2.2, ry: 5.6, tilt: 0.18 }, { rx: 1.8, ry: 4.0, tilt: 0.28, dy: -0.8 }),
  shy: pair({ rx: 2.0, ry: 3.5, squintTop: 0.2, dy: 1.8 }),
  smug: pair({ rx: 2.6, ry: 4.6, lid: { y: -0.6, slope: -0.25 }, bend: -0.7, squintBottom: 0.25 }),
};

export const EXPRESSIONS: readonly AvatarMood[] = Object.keys(LIBRARY) as AvatarMood[];

/** 表情的目标眼环（深拷贝，可随意修改）。未知表情回落到 neutral（兼容历史 grumpy -> angry）。 */
export function expressionRings(mood: AvatarMood | string | undefined): EyePair {
  const key = mood === 'grumpy' ? 'angry' : mood;
  const src = LIBRARY[(key as AvatarMood) ?? 'neutral'] ?? LIBRARY.neutral;
  return [src[0].map((p) => ({ ...p })), src[1].map((p) => ({ ...p }))];
}

export function lerpPair(a: EyePair, b: EyePair, t: number, out?: EyePair): EyePair {
  const res: EyePair = out ?? [a[0].map((p) => ({ ...p })), a[1].map((p) => ({ ...p }))];
  for (let e = 0; e < 2; e++) {
    for (let i = 0; i < POINT_COUNT; i++) {
      res[e][i].x = a[e][i].x + (b[e][i].x - a[e][i].x) * t;
      res[e][i].y = a[e][i].y + (b[e][i].y - a[e][i].y) * t;
    }
  }
  return res;
}

export function clonePair(p: EyePair): EyePair {
  return [p[0].map((q) => ({ ...q })), p[1].map((q) => ({ ...q }))];
}

/**
 * 所有表情的外包络（超椭圆，指数 ENVELOPE_N）：校验器用它判断“眼睛无论换成哪种表情都不出界”，
 * 渲染器用它估算眼睛的深度半宽。
 */
export const ENVELOPE_N = 2.6;
export const RING_ENVELOPE = (() => {
  let hw = 0;
  let hh = 0;
  for (const p of Object.values(LIBRARY)) {
    for (const ring of p) {
      for (const q of ring) {
        hw = Math.max(hw, Math.abs(q.x));
        hh = Math.max(hh, Math.abs(q.y));
      }
    }
  }
  // 超椭圆包络要比轴对齐的最大值略大才能装下斜向的点。
  return { hw: hw * 1.06, hh: hh * 1.04 };
})();

const fmt = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/**
 * 眼环 → 光滑闭合路径（每个顶点一条二次曲线，在边中点相接）。
 * `scale` 是眼睛倍率，`blink` 是纵向缩放（1 = 睁开，0.08 ≈ 闭上），`dx/dy` 是视线位移。
 */
export function ringPath(ring: EyeRing, cx: number, cy: number, scale: number, blink = 1, dx = 0, dy = 0): string {
  const n = ring.length;
  const X = (i: number) => cx + dx + ring[i % n].x * scale;
  const Y = (i: number) => cy + dy + ring[i % n].y * scale * blink;
  const mx = (i: number) => (X(i) + X(i + 1)) / 2;
  const my = (i: number) => (Y(i) + Y(i + 1)) / 2;
  let d = `M${fmt(mx(n - 1))} ${fmt(my(n - 1))}`;
  for (let i = 0; i < n; i++) d += `Q${fmt(X(i))} ${fmt(Y(i))} ${fmt(mx(i))} ${fmt(my(i))}`;
  return `${d}Z`;
}
