/**
 * 采样标量场的等值线（marching squares），拼成闭合环并简化；
 * 以及一群多边形最近边距离的查询结构。
 *
 * 每个定义只算一次：把“体积高度场”变成一堆扁平截面路径，
 * 于是切片本身不需要任何 SVG 遮罩。
 */
import { bounds, insideRow, isInside, type Bounds, type Point } from './path.ts';

/** 规则采样网格。 */
export interface Grid {
  x0: number;
  y0: number;
  step: number;
  nx: number;
  ny: number;
}

export interface Field extends Grid {
  /** 行优先样本，nx * ny。最外圈应低于所有等值面。 */
  values: Float64Array;
}

/** segDist2：点到线段的平方距离。 */
export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

export function edgeDistance(polys: Point[][], x: number, y: number): number {
  let best = Infinity;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const d = segDist2(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** 朝内的到轮廓距离；填充之外为 0。 */
export function insideDistance(polys: Point[][], x: number, y: number): number {
  return isInside(polys, x, y) ? edgeDistance(polys, x, y) : 0;
}

/**
 * 轮廓的边表：ax, ay, dx, dy, len 每边五个数，直接把 segDist2 的常量项算好。
 * 一个定义只建一次，之后网格、厚度、眼窝都复用。
 */
export class Shape {
  readonly polys: Point[][];
  readonly bounds: Bounds;
  readonly count: number;
  private readonly e: Float64Array;

  constructor(polys: Point[][], b: Bounds = bounds(polys)) {
    this.polys = polys;
    this.bounds = b;
    let count = 0;
    for (const poly of polys) count += poly.length;
    this.count = count;
    const e = (this.e = new Float64Array(5 * Math.max(1, count)));
    let k = 0;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++, k += 5) {
        const ax = poly[j][0];
        const ay = poly[j][1];
        const dx = poly[i][0] - ax;
        const dy = poly[i][1] - ay;
        e[k] = ax;
        e[k + 1] = ay;
        e[k + 2] = dx;
        e[k + 3] = dy;
        e[k + 4] = dx * dx + dy * dy;
      }
    }
  }

  distance(x: number, y: number): number {
    const e = this.e;
    let best = Infinity;
    for (let k = 0; k < e.length; k += 5) {
      const ax = e[k];
      const ay = e[k + 1];
      const dx = e[k + 2];
      const dy = e[k + 3];
      const len = e[k + 4];
      let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  inside(x: number, y: number): boolean {
    return isInside(this.polys, x, y);
  }

  /** 网格上带符号的距离（内部为正），行优先。 */
  signedGrid(g: Grid): Float64Array {
    const out = new Float64Array(g.nx * g.ny);
    const inside = new Uint8Array(g.nx);
    const xs = new Float64Array(g.nx);
    for (let i = 0; i < g.nx; i++) xs[i] = g.x0 + i * g.step;
    for (let j = 0; j < g.ny; j++) {
      const y = g.y0 + j * g.step;
      insideRow(this.polys, y, xs, inside);
      for (let i = 0; i < g.nx; i++) {
        const d = this.distance(xs[i], y);
        out[j * g.nx + i] = inside[i] ? d : -d;
      }
    }
    return out;
  }

  /** 内切圆半径的最大值（内部采样点的最大向内距离）。 */
  widest(step = 0.6): number {
    const b = this.bounds;
    const pad = 1;
    const nx = Math.ceil((b.maxX - b.minX + 2 * pad) / step) + 1;
    const ny = Math.ceil((b.maxY - b.minY + 2 * pad) / step) + 1;
    const g = { x0: b.minX - pad, y0: b.minY - pad, step, nx, ny };
    const sd = this.signedGrid(g);
    let best = 0;
    for (let k = 0; k < sd.length; k++) if (sd[k] > best) best = sd[k];
    return best;
  }
}

// ---------------------------------------------------------------------------
// Marching squares

/** 每条边最多两个链接（每侧格子一个），以及是否已被某个环走过。 */
interface Trace {
  a: Int32Array;
  b: Int32Array;
  passed: Uint8Array;
  used: Int32Array;
  count: number;
  xs: Float64Array;
  ends: Int32Array;
  loops: number;
}

let traceState: Trace | null = null;

function traceBuffer(size: number): Trace {
  const t = traceState;
  if (t && t.a.length >= size) {
    t.a.fill(-1, 0, size);
    t.b.fill(-1, 0, size);
    t.passed.fill(0, 0, size);
    t.count = 0;
    t.loops = 0;
    return t;
  }
  const fresh: Trace = {
    a: new Int32Array(size).fill(-1),
    b: new Int32Array(size).fill(-1),
    passed: new Uint8Array(size),
    used: new Int32Array(size),
    count: 0,
    xs: new Float64Array(2 * size),
    ends: new Int32Array(64),
    loops: 0,
  };
  traceState = fresh;
  return fresh;
}

/**
 * 追踪场穿过 `level`（内部 = 值 ≥ level）的闭合环。
 * `flat` 标记已知不穿越的“行段”（每行 RUN 个格子，行优先），其样本不读。
 */
export function contourLoops(field: Field, level: number, flat?: Uint8Array): Point[][] {
  const { values, nx, ny, x0, y0, step } = field;
  const t = traceBuffer(2 * nx * ny);
  const a = t.a;
  const b = t.b;
  const used = t.used;
  const link = (p: number, q: number) => {
    if (a[p] < 0) {
      if (t.count === used.length) throw new Error('contour: too many edges');
      used[t.count++] = p;
      a[p] = q;
    } else b[p] = q;
  };
  const connect = (p: number, q: number) => {
    link(p, q);
    link(q, p);
  };

  const runs = Math.max(1, Math.ceil((nx - 1) / RUN));
  for (let j = 0; j < ny - 1; j++) {
    const row = j * nx;
    for (let r = 0; r < runs; r++) {
      if (flat && flat[j * runs + r]) continue;
      let i = r * RUN;
      const end = Math.min(nx - 1, i + RUN);
      let tl = values[row + i] - level >= 0;
      let bl = values[row + nx + i] - level >= 0;
      for (; i < end; i++) {
        const tr = values[row + i + 1] - level >= 0;
        const br = values[row + nx + i + 1] - level >= 0;
        if (tl !== tr || tr !== br || br !== bl) {
          const top = 2 * (row + i);
          const bottom = 2 * (row + nx + i);
          const left = top + 1;
          const right = top + 3;
          if (tl === br && tr === bl) {
            const center =
              (values[row + i] - level +
                values[row + i + 1] - level +
                values[row + nx + i + 1] - level +
                values[row + nx + i] - level) /
                4 >=
              0;
            if (tl === center) {
              connect(top, right);
              connect(bottom, left);
            } else {
              connect(left, top);
              connect(right, bottom);
            }
          } else if (tl !== tr) connect(top, tr !== br ? right : br !== bl ? bottom : left);
          else if (tr !== br) connect(right, br !== bl ? bottom : left);
          else connect(bottom, left);
        }
        tl = tr;
        bl = br;
      }
    }
  }

  const xy = t.xs;
  let n = 0;
  let loops = 0;
  const ends = t.ends;
  for (let k = 0; k < t.count; k++) {
    if (t.passed[used[k]]) continue;
    let prev = -1;
    let cur = used[k];
    while (!t.passed[cur]) {
      t.passed[cur] = 1;
      const idx = cur >> 1;
      const i = idx % nx;
      const j = (idx - i) / nx;
      const v = values[idx] - level;
      if (cur & 1) {
        const tv = v / (v - (values[idx + nx] - level));
        xy[n++] = x0 + i * step;
        xy[n++] = y0 + (j + tv) * step;
      } else {
        const tt = v / (v - (values[idx + 1] - level));
        xy[n++] = x0 + (i + tt) * step;
        xy[n++] = y0 + j * step;
      }
      let next = a[cur];
      if (next === prev || t.passed[next]) {
        next = b[cur];
        if (next < 0 || next === prev || t.passed[next]) break;
      }
      prev = cur;
      cur = next;
    }
    if (loops === ends.length) {
      const grown = new Int32Array(2 * loops);
      grown.set(ends);
      t.ends = grown;
    }
    t.ends[loops++] = n;
  }
  t.loops = loops;

  const out: Point[][] = [];
  const marks = t.ends;
  for (let k = 0, start = 0; k < loops; start = marks[k++]) {
    const count = (marks[k] - start) >> 1;
    if (count < 3) continue;
    const loop: Point[] = [];
    for (let q = 0; q < count; q++) loop.push([xy[start + 2 * q], xy[start + 2 * q + 1]]);
    out.push(loop);
  }
  return out;
}

/** 每行格子被切成几个“行段”，供 flat 预筛使用。 */
export const RUN = 8;

/** 每行段（RUN 个格子）覆盖样本的最小/最大值，用于一次性排除整段。 */
export function runRange(values: Float64Array, nx: number, ny: number): { min: Float64Array; max: Float64Array } {
  const runs = Math.max(1, Math.ceil((nx - 1) / RUN));
  const lo = new Float64Array(runs * ny);
  const hi = new Float64Array(runs * ny);
  for (let j = 0; j < ny; j++) {
    for (let r = 0; r < runs; r++) {
      let a = Infinity;
      let b = -Infinity;
      for (let k = j * nx + r * RUN, end = j * nx + Math.min(nx - 1, (r + 1) * RUN); k <= end; k++) {
        const v = values[k];
        if (v < a) a = v;
        if (v > b) b = v;
      }
      lo[j * runs + r] = a;
      hi[j * runs + r] = b;
    }
  }
  const min = new Float64Array(runs * Math.max(0, ny - 1));
  const max = new Float64Array(min.length);
  for (let k = 0; k < min.length; k++) {
    min[k] = Math.min(lo[k], lo[k + runs]);
    max[k] = Math.max(hi[k], hi[k + runs]);
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// 简化与序列化

/** Ramer–Douglas–Peucker：返回哪些点保留。 */
function simplifyPoints(pts: Point[], tolerance: number): Point[] {
  const n = pts.length;
  if (n <= 4) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop() as [number, number];
    const ax = pts[s][0];
    const ay = pts[s][1];
    const dx = pts[e][0] - ax;
    const dy = pts[e][1] - ay;
    const len = Math.hypot(dx, dy);
    let best = tolerance;
    let idx = -1;
    for (let k = s + 1; k < e; k++) {
      const px = pts[k][0];
      const py = pts[k][1];
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (ay - py) - dy * (ax - px)) / len;
      if (d > best) {
        best = d;
        idx = k;
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Point[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[k]);
  return out;
}

/** 闭合环上的 RDP 简化。 */
export function simplifyLoop(loop: Point[], tolerance: number): Point[] {
  if (loop.length <= 8) return loop;
  // 以离首点最远的点切开，闭合环变成两条开链。
  let far = 0;
  let best = -1;
  for (let k = 1; k < loop.length; k++) {
    const d = (loop[k][0] - loop[0][0]) ** 2 + (loop[k][1] - loop[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = k;
    }
  }
  const first = simplifyPoints(loop.slice(0, far + 1), tolerance);
  const second = simplifyPoints(loop.slice(far).concat([loop[0]]), tolerance);
  return first.slice(0, -1).concat(second.slice(0, -1));
}

const UNIT = 100;
const write = (k: number): string => {
  const a = Math.abs(k);
  const whole = Math.floor(a / UNIT);
  const frac = a % UNIT;
  const f = frac === 0 ? '' : frac % 10 === 0 ? `.${frac / 10}` : frac < 10 ? `.0${frac}` : `.${frac}`;
  return (k < 0 ? '-' : '') + (whole || !f ? whole : '') + f;
};

const NEAR = 4096;
const written: (string | undefined)[] = new Array(2 * NEAR + 1);
const numText = (k: number): string => (Number.isInteger(k) && k >= -NEAR && k <= NEAR ? (written[k + NEAR] ??= write(k)) : write(k));

/** 转角超过这个角度（弧度）保持尖角，其余画成曲线。 */
const CORNER = 0.6;

/**
 * 把追踪出的折线环写成紧凑闭合路径（用 evenodd 填充）。
 * 平缓的转折用边中点之间的二次曲线画，于是大尺寸下也看不到折面；真正的角保持尖。
 */
export function loopsToPath(loops: Point[][]): string {
  let d = '';
  let cmd = '';
  let last = '';
  const emit = (c: string, x: number, y: number) => {
    if (c !== cmd) {
      d += c;
      cmd = c;
      last = '';
    }
    for (let k = 0; k < 2; k++) {
      const text = numText(k ? y : x);
      if (last && text[0] !== '-' && !(text[0] === '.' && last.includes('.'))) d += ' ';
      d += text;
      last = text;
    }
  };
  for (const loop of loops) {
    const n = loop.length;
    if (n < 3) continue;
    const v = new Float64Array(2 * n);
    const corner = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const p = loop[k];
      const a = loop[(k + n - 1) % n];
      const b = loop[(k + 1) % n];
      v[2 * k] = 2 * Math.round((p[0] * UNIT) / 2);
      v[2 * k + 1] = 2 * Math.round((p[1] * UNIT) / 2);
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      const dot = (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]);
      corner[k] = Math.abs(Math.atan2(cross, dot)) > CORNER ? 1 : 0;
      if (!corner[k]) {
        const turn = Math.abs(cross);
        const chord = 0.16 * Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (turn > chord) corner[k] = 1;
      }
    }
    let cx = (v[0] + v[2 * (1 % n)]) / 2;
    let cy = (v[1] + v[2 * (1 % n) + 1]) / 2;
    emit('M', cx, cy);
    let smooth = false;
    for (let k = 1; k <= n; k++) {
      const at = 2 * (k % n);
      const after = 2 * ((k + 1) % n);
      const px = v[at];
      const py = v[at + 1];
      const mx = (px + v[after]) / 2;
      const my = (py + v[after + 1]) / 2;
      if (corner[k % n]) {
        emit('l', px - cx, py - cy);
        cx = px;
        cy = py;
        if (k < n && !corner[(k + 1) % n]) {
          emit('l', mx - cx, my - cy);
          cx = mx;
          cy = my;
        }
        smooth = false;
      } else {
        if (smooth) emit('t', mx - cx, my - cy);
        else {
          emit('q', px - cx, py - cy);
          emit('q', mx - cx, my - cy);
        }
        cx = mx;
        cy = my;
        smooth = true;
      }
    }
    d += 'Z';
    cmd = 'Z';
    last = '';
  }
  return d;
}

/** 环的包围盒。 */
export function loopBox(loops: Point[][]): { x: number; y: number; w: number; h: number } {
  const b = bounds(loops);
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}