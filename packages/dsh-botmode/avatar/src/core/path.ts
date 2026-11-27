/**
 * 受限 SVG 路径几何：解析、归一化、展平。
 *
 * 只接受 M L H V C S Q T A Z（绝对与相对）。解析结果由数字重新序列化，
 * 因此模型写的文本永远不会被原样回显进标记。
 */

export type Segment =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'A'; rx: number; ry: number; rot: number; large: 0 | 1; sweep: 0 | 1; x: number; y: number }
  | { c: 'Z' };

export type Point = [number, number];

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const PATH_LIMITS = {
  maxChars: 6000,
  maxSegments: 400,
  maxSubpaths: 16,
  coordMin: -20,
  coordMax: 120,
} as const;

/** 曲线与其折线代理之间允许的最大偏差（viewBox 单位）。 */
export const FLATNESS = 0.03;

const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export class PathError extends Error {}

function tokenize(d: string): (string | number)[] {
  if (/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/.test(d)) {
    const bad = /[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/.exec(d)![0];
    throw new PathError(`unsupported character ${JSON.stringify(bad)} (allowed commands: M L H V C S Q T A Z)`);
  }
  const tokens: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)/y;
  let i = 0;
  while (i < d.length) {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m) throw new PathError(`cannot parse path near ${JSON.stringify(d.slice(i, i + 12))}`);
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
    i = re.lastIndex;
  }
  return tokens;
}

/** 解析并转成绝对的 M/L/C/Q/A/Z 段。失败抛 PathError。 */
export function parsePath(d: string): Segment[] {
  if (typeof d !== 'string' || d.trim() === '') throw new PathError('path is empty');
  if (d.length > PATH_LIMITS.maxChars) throw new PathError(`path longer than ${PATH_LIMITS.maxChars} characters`);
  const tokens = tokenize(d);
  const out: Segment[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let prevC: Point | null = null;
  let prevQ: Point | null = null;
  let cmd = '';
  let subpaths = 0;
  let open = false;

  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (!open) throw new PathError('Z without an open subpath');
        out.push({ c: 'Z' });
        cx = sx;
        cy = sy;
        prevC = prevQ = null;
        open = false;
        continue;
      }
    } else if (!cmd) {
      throw new PathError('path must start with M');
    } else if (cmd === 'Z' || cmd === 'z') {
      throw new PathError('numbers after Z');
    }

    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (out.length === 0 && up !== 'M') throw new PathError('path must start with M');
    const n = ARG_COUNT[up];
    const args: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = tokens[i + k];
      if (typeof v !== 'number') throw new PathError(`command ${cmd} expects ${n} numbers`);
      if (!Number.isFinite(v)) throw new PathError('non-finite number');
      args.push(v);
    }
    i += n;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let nextC: Point | null = null;
    let nextQ: Point | null = null;

    switch (up) {
      case 'M': {
        if (open) out.push({ c: 'Z' });
        cx = args[0] + ox;
        cy = args[1] + oy;
        sx = cx;
        sy = cy;
        out.push({ c: 'M', x: cx, y: cy });
        subpaths++;
        open = true;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L':
        cx = args[0] + ox;
        cy = args[1] + oy;
        out.push({ c: 'L', x: cx, y: cy });
        break;
      case 'H':
        cx = args[0] + ox;
        out.push({ c: 'L', x: cx, y: cy });
        break;
      case 'V':
        cy = args[0] + oy;
        out.push({ c: 'L', x: cx, y: cy });
        break;
      case 'C': {
        const s: Segment = { c: 'C', x1: args[0] + ox, y1: args[1] + oy, x2: args[2] + ox, y2: args[3] + oy, x: args[4] + ox, y: args[5] + oy };
        out.push(s);
        nextC = [s.x2, s.y2];
        cx = s.x;
        cy = s.y;
        break;
      }
      case 'S': {
        const x1: number = prevC ? 2 * cx - prevC[0] : cx;
        const y1: number = prevC ? 2 * cy - prevC[1] : cy;
        const s: Segment = { c: 'C', x1, y1, x2: args[0] + ox, y2: args[1] + oy, x: args[2] + ox, y: args[3] + oy };
        out.push(s);
        nextC = [s.x2, s.y2];
        cx = s.x;
        cy = s.y;
        break;
      }
      case 'Q': {
        const s: Segment = { c: 'Q', x1: args[0] + ox, y1: args[1] + oy, x: args[2] + ox, y: args[3] + oy };
        out.push(s);
        nextQ = [s.x1, s.y1];
        cx = s.x;
        cy = s.y;
        break;
      }
      case 'T': {
        const x1: number = prevQ ? 2 * cx - prevQ[0] : cx;
        const y1: number = prevQ ? 2 * cy - prevQ[1] : cy;
        const s: Segment = { c: 'Q', x1, y1, x: args[0] + ox, y: args[1] + oy };
        out.push(s);
        nextQ = [x1, y1];
        cx = s.x;
        cy = s.y;
        break;
      }
      case 'A': {
        const [rx, ry, rot, la, sw] = args;
        if (rx < 0 || ry < 0) throw new PathError('arc radii must be non-negative');
        if ((la !== 0 && la !== 1) || (sw !== 0 && sw !== 1)) throw new PathError('arc flags must be 0 or 1, written as separate numbers');
        cx = args[5] + ox;
        cy = args[6] + oy;
        out.push({ c: 'A', rx, ry, rot, large: la as 0 | 1, sweep: sw as 0 | 1, x: cx, y: cy });
        break;
      }
      default:
        throw new PathError(`unsupported command ${cmd}`);
    }
    prevC = nextC;
    prevQ = nextQ;
    if (out.length > PATH_LIMITS.maxSegments) throw new PathError(`more than ${PATH_LIMITS.maxSegments} segments`);
  }
  if (open) out.push({ c: 'Z' });
  if (subpaths > PATH_LIMITS.maxSubpaths) throw new PathError(`more than ${PATH_LIMITS.maxSubpaths} subpaths`);
  for (const s of out) {
    for (const [k, v] of Object.entries(s)) {
      if (k === 'c' || typeof v !== 'number') continue;
      if (k === 'rot' || k === 'large' || k === 'sweep') continue;
      if (v < PATH_LIMITS.coordMin || v > PATH_LIMITS.coordMax) throw new PathError(`coordinate ${v} far outside the 0..100 viewBox`);
    }
  }
  return out;
}

const num = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/** 只由解析出的数字构成的紧凑绝对序列化。 */
export function serializePath(segs: Segment[]): string {
  const parts: string[] = [];
  for (const s of segs) {
    switch (s.c) {
      case 'M':
        parts.push(`M${num(s.x)} ${num(s.y)}`);
        break;
      case 'L':
        parts.push(`L${num(s.x)} ${num(s.y)}`);
        break;
      case 'C':
        parts.push(`C${num(s.x1)} ${num(s.y1)} ${num(s.x2)} ${num(s.y2)} ${num(s.x)} ${num(s.y)}`);
        break;
      case 'Q':
        parts.push(`Q${num(s.x1)} ${num(s.y1)} ${num(s.x)} ${num(s.y)}`);
        break;
      case 'A':
        parts.push(`A${num(s.rx)} ${num(s.ry)} ${num(s.rot)} ${s.large} ${s.sweep} ${num(s.x)} ${num(s.y)}`);
        break;
      case 'Z':
        parts.push('Z');
        break;
    }
  }
  return parts.join('');
}

/** 端点式圆弧 → 采样点（SVG 规范 F.6.5）。 */
function sampleArc(x0: number, y0: number, s: Extract<Segment, { c: 'A' }>, out: Point[]): void {
  let { rx, ry } = s;
  const { x, y } = s;
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
    out.push([x, y]);
    return;
  }
  const phi = (s.rot * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, numerator / denominator));
  if (s.large === s.sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!s.sweep && delta > 0) delta -= 2 * Math.PI;
  if (s.sweep && delta < 0) delta += 2 * Math.PI;
  // 弦与弧的偏差不超过 FLATNESS：弦在圆心角 θ 处下陷 r(1 - cos(θ/2))。
  const stepAngle = 2 * Math.acos(Math.max(-1, 1 - FLATNESS / Math.max(rx, ry)));
  const steps = Math.min(256, Math.max(4, Math.ceil(Math.abs(delta) / stepAngle)));
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (delta * k) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

/** 展平为闭合多边形，每个子路径一个。 */
export function flattenPath(segs: Segment[]): Point[][] {
  const polys: Point[][] = [];
  let cur: Point[] = [];
  let px = 0;
  let py = 0;
  for (const s of segs) {
    switch (s.c) {
      case 'M':
        if (cur.length) polys.push(cur);
        cur = [[s.x, s.y]];
        px = s.x;
        py = s.y;
        break;
      case 'L':
        cur.push([s.x, s.y]);
        px = s.x;
        py = s.y;
        break;
      case 'C': {
        // Wang 上界：这么多弦就能把误差控制在 FLATNESS 内。
        const m = Math.max(
          Math.hypot(px - 2 * s.x1 + s.x2, py - 2 * s.y1 + s.y2),
          Math.hypot(s.x1 - 2 * s.x2 + s.x, s.y1 - 2 * s.y2 + s.y),
        );
        const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt((0.75 * m) / FLATNESS))));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          cur.push([
            u * u * u * px + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
            u * u * u * py + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
          ]);
        }
        px = s.x;
        py = s.y;
        break;
      }
      case 'Q': {
        const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt((0.25 * Math.hypot(px - 2 * s.x1 + s.x, py - 2 * s.y1 + s.y)) / FLATNESS))));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          cur.push([u * u * px + 2 * u * t * s.x1 + t * t * s.x, u * u * py + 2 * u * t * s.y1 + t * t * s.y]);
        }
        px = s.x;
        py = s.y;
        break;
      }
      case 'A':
        sampleArc(px, py, s, cur);
        px = s.x;
        py = s.y;
        break;
      case 'Z':
        if (cur.length) {
          polys.push(cur);
          px = cur[0][0];
          py = cur[0][1];
        }
        cur = [];
        break;
    }
  }
  if (cur.length) polys.push(cur);
  return polys.filter((p) => p.length >= 3);
}

/** 点对所有子路径的 nonzero 环绕数（SVG 默认填充规则）。 */
export function winding(polys: Point[][], x: number, y: number): number {
  let w = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
    }
  }
  return w;
}

export function isInside(polys: Point[][], x: number, y: number): boolean {
  return winding(polys, x, y) !== 0;
}

/** 一行上多点（xs 升序）的 nonzero 内部标记，一次扫描所有边。 */
export function insideRow(polys: Point[][], y: number, xs: ArrayLike<number>, out: Uint8Array): void {
  const hits: [number, number][] = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xj, yj] = poly[j];
      const [xi, yi] = poly[i];
      if (yj <= y && yi > y) hits.push([xj + ((y - yj) * (xi - xj)) / (yi - yj), 1]);
      else if (yi <= y && yj > y) hits.push([xj + ((y - yj) * (xi - xj)) / (yi - yj), -1]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  let w = 0;
  let h = 0;
  for (let k = 0; k < xs.length; k++) {
    while (h < hits.length && hits[h][0] < xs[k]) w += hits[h++][1];
    out[k] = w !== 0 ? 1 : 0;
  }
}

/**
 * 一组多边形的边表，供同一个轮廓上的大量点/行测试使用。
 * 查询只做一遍算术，不建格子索引：一个定义里这类查询最多几十万次，够用且好懂。
 */
export class EdgeBands {
  constructor(private readonly polys: Point[][]) {}

  private crossings(y: number): { xs: Float64Array; dirs: Int8Array; n: number } {
    const xs = new Float64Array(64);
    const dirs = new Int8Array(64);
    let n = 0;
    for (const poly of this.polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xj, yj] = poly[j];
        const [xi, yi] = poly[i];
        let dir = 0;
        if (yj <= y && yi > y) dir = 1;
        else if (yi <= y && yj > y) dir = -1;
        else continue;
        const x = xj + ((y - yj) * (xi - xj)) / (yi - yj);
        let m = n++;
        for (; m > 0 && xs[m - 1] > x; m--) {
          xs[m] = xs[m - 1];
          dirs[m] = dirs[m - 1];
        }
        xs[m] = x;
        dirs[m] = dir;
      }
    }
    return { xs, dirs, n };
  }

  /** 同 `winding`。 */
  winding(x: number, y: number): number {
    const { xs, dirs, n } = this.crossings(y);
    let w = 0;
    for (let k = 0; k < n && xs[k] < x; k++) w += dirs[k];
    return w;
  }

  /** 同 `insideRow`。 */
  insideRow(y: number, points: ArrayLike<number>, out: Uint8Array): void {
    const { xs, dirs, n } = this.crossings(y);
    let w = 0;
    let h = 0;
    for (let k = 0; k < points.length; k++) {
      while (h < n && xs[h] < points[k]) w += dirs[h++];
      out[k] = w !== 0 ? 1 : 0;
    }
  }

  /** 单点版本。 */
  insideRowAt(x: number, y: number): boolean {
    return this.winding(x, y) !== 0;
  }
}

const bandCache = new WeakMap<Point[][], EdgeBands>();

/** 这些多边形的边表，每个数组只建一次；建好后数组不可再改。 */
export function edgeBands(polys: Point[][]): EdgeBands {
  let index = bandCache.get(polys);
  if (!index) {
    index = new EdgeBands(polys);
    bandCache.set(polys, index);
  }
  return index;
}

export function bounds(polys: Point[][]): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of polys) {
    for (let k = 0; k < p.length; k++) {
      const x = p[k][0];
      const y = p[k][1];
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  }
  return b;
}

/** 在 1 单位采样网格上估算填充面积（nonzero 规则）。 */
export function filledArea(polys: Point[][], b: Bounds = bounds(polys)): number {
  let n = 0;
  const xs: number[] = [];
  for (let x = Math.floor(b.minX) + 0.5; x < b.maxX; x += 1) xs.push(x);
  const row = new Uint8Array(xs.length);
  for (let y = Math.floor(b.minY) + 0.5; y < b.maxY; y += 1) {
    insideRow(polys, y, xs, row);
    for (let k = 0; k < row.length; k++) n += row[k];
  }
  return n;
}

/** 把归一化段按子路径切开。 */
export function splitSubpaths(segs: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  for (const s of segs) {
    if (s.c === 'M') out.push([]);
    out[out.length - 1]?.push(s);
  }
  return out;
}