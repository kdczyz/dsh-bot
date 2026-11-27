/**
 * 状态在身体之外还画什么：工作时环绕身体的彩带，以及思考/阻塞时身体让位给的标记
 * （三个圆点、一个感叹号）。全部是 viewBox 单位下的纯几何，输入是身体包围盒、
 * seed、动画时钟与轮廓的内部判定。
 */
import { noise } from './pose.ts';
import type { Bounds, Point } from './path.ts';

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};
const f = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// 彩带

/**
 * 身体在每个方向上离 (cx, cy) 有多远。彩带的环挂在这之外一点，
 * 于是身体的任何姿态都不会穿过“彩带从背后绕过”的那条线。
 */
export interface Rim {
  cx: number;
  cy: number;
  at: (angle: number) => number;
  max: number;
}

export function rimOf(polys: Point[][], cx: number, cy: number): Rim {
  const at = (angle: number) => {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    let far = 0;
    for (const poly of polys) {
      for (const [x, y] of poly) {
        const d = Math.abs((x - cx) * ux + (y - cy) * uy);
        if (d > far) far = d;
      }
    }
    return far;
  };
  let max = 0;
  for (let k = 0; k < 72; k++) max = Math.max(max, at((k * Math.PI) / 72));
  return { cx, cy, at, max };
}

/** 环的倾角与画面内滚转角。 */
const HOOP_TILT = 0.386;
const HOOP_ROLL = 0.157;
const HOOP_JITTER = 0.24;
/** 每圈挂几条彩带。 */
const LANES = 3;
/** 环上相邻色带的半径差，viewBox 单位。 */
const LADDER = 4.2;
const BAND_ARC = 0.95;
const BAND_WIDTH = 2.4;

export interface RibbonPiece {
  d: string;
  front: boolean;
  box: Box;
  /** 属于哪一条彩带：cage 时为 hoop * LANES + lane。 */
  ribbon: number;
  /** 这条彩带的渐变，坐标与 `d` 相同：从尾 (x1,y1) 到头 (x2,y2)。 */
  gradient: { x1: number; y1: number; x2: number; y2: number; stops: string[] };
}

const rollOf = (seed: number, hoop: number, hoops: number) =>
  HOOP_ROLL + (hoop * Math.PI) / hoops + (noise(seed, 450 + hoop) - 0.5) * HOOP_JITTER;

/** 环上角度 θ 的 3D 点、屏幕点与朝向观察者的符号。 */
function hoopPoint(ring: number, tilt: number, roll: number, theta: number): { x: number; y: number; front: boolean } {
  const x3 = ring * Math.cos(theta);
  const y3 = ring * Math.sin(theta) * Math.cos(tilt);
  const z3 = ring * Math.sin(theta) * Math.sin(tilt);
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  return { x: x3 * cos - y3 * sin, y: y3 * cos + x3 * sin, front: z3 > 0 };
}

/**
 * 这一刻所有可见的彩带片段。
 * `presence` 0..1 让彩带长出来又收回去；`sweep` 是身体转身带它们走过的角度。
 * `inside` 判断一点是否在身体剪影内，用来把“在身体背后”的片段剪掉。
 */
export function ribbonPieces(
  rim: Rim,
  presence: number,
  seed: number,
  time: number,
  sweep: number,
  cage: number,
  inside: (x: number, y: number) => boolean,
  runOf: (ribbon: number) => string[],
): RibbonPiece[] {
  if (presence <= 0.01) return [];
  const hoops = cage >= 0.5 ? 3 : 1;
  const pieces: RibbonPiece[] = [];
  const tilt = HOOP_TILT + (noise(seed, 480) - 0.5) * 0.08;
  for (let h = 0; h < hoops; h++) {
    const roll = rollOf(seed, h, hoops);
    const ring = rim.at(roll) + 2 + (h - (hoops - 1) / 2) * 1.4;
    for (let lane = 0; lane < LANES; lane++) {
      const r = ring + (lane - (LANES - 1) / 2) * LADDER;
      // 每条彩带自己的相位、自己的速度份额，于是一圈上的彩带会散开。
      const share = 0.74 + 0.2 * noise(seed, 500 + lane);
      const drift = (0.5 + 0.6 * noise(seed, 520 + lane * 7 + h)) * time;
      const head = sweep * share + drift + (lane / LANES) * TAU * 0.16 + h * 0.9;
      const samples: { x: number; y: number; front: boolean; s: number }[] = [];
      const N = 14;
      for (let k = 0; k <= N; k++) {
        const s = k / N;
        const theta = head - BAND_ARC * (1 - s);
        const p = hoopPoint(r, tilt, roll, theta);
        samples.push({ x: rim.cx + p.x, y: rim.cy + p.y, front: p.front, s });
      }
      // 屏幕空间法线，用来给色带一点宽度（尾细头宽，圆头）。
      const widths = samples.map((p) => BAND_WIDTH * presence * (0.45 + 0.55 * p.s));
      const left: Point[] = [];
      const right: Point[] = [];
      for (let k = 0; k <= N; k++) {
        const a = samples[Math.max(0, k - 1)];
        const b = samples[Math.min(N, k + 1)];
        const tx = b.x - a.x;
        const ty = b.y - a.y;
        const len = Math.hypot(tx, ty) || 1;
        const nx = -ty / len;
        const ny = tx / len;
        const w = widths[k] / 2;
        left.push([samples[k].x + nx * w, samples[k].y + ny * w]);
        right.push([samples[k].x - nx * w, samples[k].y - ny * w]);
      }
      const visible = (k: number) => samples[k].front || !inside(samples[k].x, samples[k].y);
      const headPoint = samples[N];
      const tailPoint = samples[0];
      const gradient = {
        x1: tailPoint.x,
        y1: tailPoint.y,
        x2: headPoint.x,
        y2: headPoint.y,
        stops: runOf(h * LANES + lane),
      };
      let k = 0;
      while (k <= N) {
        if (!visible(k)) {
          k++;
          continue;
        }
        const from = k;
        while (k <= N && visible(k)) k++;
        const to = k - 1;
        if (to - from < 1) continue;
        const pts: Point[] = [];
        for (let q = from; q <= to; q++) pts.push(left[q]);
        for (let q = to; q >= from; q--) pts.push(right[q]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        pieces.push({
          d: `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`,
          front: samples[from].front,
          box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y },
          ribbon: h * LANES + lane,
          gradient,
        });
      }
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// 完成态的粒子绽放

/** 一粒：圆点路径、画在哪个矩阵、什么颜色、在身体前还是后。 */
export interface BloomPiece {
  d: string;
  box: Box;
  matrix: [number, number, number, number, number, number];
  fill: string;
  front: boolean;
}

/** 粒子半径的几档（同一档共用一条路径，省 Path2D）。 */
const RADII = [1, 1.5, 2.1, 2.9] as const;

/**
 * 完成时的粒子绽放：从一个点向外炸开，然后慢慢飘散、缩没。
 *
 * 纯函数：同一 (seed, age) 永远得到同一组粒子。每个粒子的角度、速度、延迟、
 * 大小、寿命、旋向都由 seed 与序号散列出来，所以每个头像的花形都不同，
 * 但同一头像每次都一样。
 */
export function bloomPieces(
  b: Bounds,
  seed: number,
  age: number,
  energy: number,
  palette: string[],
): BloomPiece[] {
  if (energy <= 0.01 || !Number.isFinite(age)) return [];
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const scale = clamp(Math.min(b.maxX - b.minX, b.maxY - b.minY), 40, 84) / 70;
  const pieces: BloomPiece[] = [];
  const GOLDEN = 2.399963;
  const COUNT = 34;

  for (let i = 0; i < COUNT; i++) {
    const r1 = noise(seed, 7000 + i * 7);
    const r2 = noise(seed, 7001 + i * 7);
    const r3 = noise(seed, 7002 + i * 7);
    const r4 = noise(seed, 7003 + i * 7);
    const r5 = noise(seed, 7004 + i * 7);

    const delay = r1 * 0.42;
    const life = 1.5 + r2 * 2.1;
    const t = (age - delay) / life;
    if (t <= 0 || t >= 1) continue;

    // 开头快、后面慢：位移是“炸开”的曲线，不是匀速飞散。
    const reach = (10 + r3 * 46) * scale * (1 - Math.exp(-age * 2.6));
    const angle = i * GOLDEN + r4 * 0.9 + age * (0.25 + r5 * 0.5) * (r5 > 0.5 ? 1 : -1);
    const x = cx + Math.cos(angle) * reach;
    const y = cy + Math.sin(angle) * reach * 0.92;

    // 大小：先涨后缩，缩到 0 就等于淡出（配色是不透明填充）。
    const envelope = Math.sin(Math.PI * clamp(t, 0, 1));
    const r0 = RADII[i % RADII.length];
    const grow = envelope * (0.55 + r2 * 0.9) * scale;
    if (grow < 0.06) continue;

    const spin = r4 * TAU;
    const cos = Math.cos(spin) * grow;
    const sin2 = Math.sin(spin) * grow;
    const fill = palette[i % palette.length];
    pieces.push({
      d: circlePath(r0),
      box: { x: -r0, y: -r0, w: 2 * r0, h: 2 * r0 },
      matrix: [cos, sin2, -sin2, cos, x, y],
      fill,
      // 往下（朝向观察者这边）的粒子在身体前面，往上的在后面。
      front: Math.sin(angle) > 0.12,
    });
  }
  return pieces;
}

/** 以原点为圆心、半径 r 的圆路径（绝对坐标，供 Path2D 与 SVG 共用）。 */
function circlePath(r: number): string {
  const f = (n: number) => Math.round(n * 100) / 100;
  return `M${f(-r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(-r)} 0Z`;
}

/**
 * 一条“粗线”：沿折线两侧按宽度偏移出轮廓，用于触须、蛇身、飘带这类
 * 需要厚度又不想手写贝塞尔的部件（触须、蛇身、飘带之类）。
 */
export function tube(points: Point[], width: number, closed = false): string {
  const pts = closed ? [...points, points[0]] : points;
  if (pts.length < 2) return '';
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const c = pts[Math.min(pts.length - 1, i + 1)];
    const dx = c[0] - a[0];
    const dy = c[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);
    left.push([p[0] + nx, p[1] + ny]);
    right.push([p[0] - nx, p[1] - ny]);
  }
  const f = (n: number) => Math.round(n * 100) / 100;
  const fmt = (q: Point[]) => q.map(([x, y]) => `${f(x)} ${f(y)}`).join('L');
  return `M${fmt(left)}L${fmt(right.reverse())}Z`;
}

// ---------------------------------------------------------------------------
// 标记

export interface MarkPart {
  shape: string;
  d: string;
  box: Box;
  x: number;
  y: number;
  turn: number;
  scale: number;
}

const circle = (r: number) => `M${f(r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(-r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(r)} 0Z`;
const capsule = (w: number, h: number) => {
  const r = w / 2;
  const y = h / 2 - r;
  return `M${f(-r)} ${f(-y)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-y)}L${f(r)} ${f(y)}A${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(y)}Z`;
};

/** 标记的尺寸单位：身体较窄边的比例，限定在读得清的范围内。 */
function markUnit(b: Bounds): number {
  return clamp(Math.min(b.maxX - b.minX, b.maxY - b.minY), 34, 78);
}

/**
 * 某一刻标记的各个部件。`bang` / `dots` 0..1 表示身体让位给各自的程度：
 * 标记从身体中心长出来。圆点轮流跳；感叹号每隔 2.6 s 跳一下并抖一抖。
 */
export function markParts(b: Bounds, bang: number, dots: number, seed: number, time: number, still: boolean): MarkPart[] {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const u = markUnit(b);
  const t = still ? 0 : time + noise(seed, 9) * 10;
  const parts: MarkPart[] = [];
  const grown = (weight: number) => smooth((clamp(weight, 0, 1) - 0.45) / 0.55);

  const gb = grown(bang);
  if (gb > 0) {
    const barW = 0.21 * u;
    const barH = 0.5 * u;
    const dot = 0.115 * u;
    const gap = 0.1 * u;
    const total = barH + gap + 2 * dot;
    const p = still ? 1 : (((t % 2.6) + 2.6) % 2.6) / 2.6;
    const alarm = p < 0.3 ? p / 0.3 : 1;
    const jump = still ? 0 : Math.sin(Math.PI * alarm);
    const turn = still ? 0 : 0.2 * Math.sin(TAU * 3 * alarm) * (1 - alarm);
    const lift = -0.09 * u * jump;
    const barY = -total / 2 + barH / 2;
    const dotY = total / 2 - dot;
    parts.push(
      { shape: 'bar', d: capsule(barW, barH), box: { x: -barW / 2, y: -barH / 2, w: barW, h: barH }, x: cx, y: cy + (barY + lift) * gb, turn, scale: gb },
      { shape: 'dot', d: circle(dot), box: { x: -dot, y: -dot, w: 2 * dot, h: 2 * dot }, x: cx, y: cy + (dotY + lift * 0.45) * gb, turn, scale: gb },
    );
  }

  const gd = grown(dots);
  if (gd > 0) {
    const r = 0.1 * u;
    const step = 0.31 * u;
    for (let i = 0; i < 3; i++) {
      const p = still ? 0 : (((t - i * 0.17) % 1.25) + 1.25) % 1.25 / 1.25;
      const hop = p < 0.4 ? Math.sin(Math.PI * (p / 0.4)) : 0;
      parts.push({
        shape: 'dot3',
        d: circle(r),
        box: { x: -r, y: -r, w: 2 * r, h: 2 * r },
        x: cx + (i - 1) * step * gd,
        y: cy - 0.16 * u * hop * gd,
        turn: 0,
        scale: gd * (1 + 0.12 * hop),
      });
    }
  }
  return parts;
}

/** 身体让位给标记时保留多少尺寸：过半一点就完全消失。 */
export function bodyScale(bang: number, dots: number): number {
  return 1 - smooth(clamp(bang + dots, 0, 1) / 0.55);
}