/**
 * 扁平轮廓的隐含体积。
 *
 * 定义本身始终是 2D 路径。这里把每条填充子路径变成一个“部件”，并给它一个
 * 前表面高度场 h(x, y)（背面关于 z = 0 镜像）：
 *
 * - inflate：圆角板。高度由到轮廓的距离决定（椭圆边圆角），于是侧面是弧的，正面是平的。
 * - revolve-y：绕部件自身竖直中心线的旋转体（杯子、灯泡），从精确扫描线宽度得来。
 * - revolve-x：绕整个身体共享的水平轴旋转（哑铃：杆成圆柱，配重成圆片）。
 *
 * 由高度场把部件一次性切成两叠普通截面路径：z 切片（朝向观察者的平面，h 的等值面）
 * 与 x 切片（朝向侧面的平面，h 的列剖面）。单色渲染时，一叠的并集就是这个实体的剪影，
 * 渲染器选择更朝向观察者的那一叠，因此永远不会看到平面的“侧面”。
 * 这里全部是纯函数，并由渲染器缓存。
 */
import { contourLoops, loopBox, loopsToPath, runRange, simplifyLoop, RUN, type Field, type Grid } from './field.ts';
import { bounds, edgeBands, isInside, type Bounds, type Point } from './path.ts';
import { EYE_H, EYE_W, GAZE_X, GAZE_Y, analyzeBody, drawnEyesFit, eyeCenters, eyeClearance, gazeRange, type BodyAnalysis, type GazeRange } from './validate.ts';
import type { AvatarDefinition, AvatarEyes } from './types.ts';

export type PartKind = 'inflate' | 'revolve-x' | 'revolve-y';

export interface VolumeSlice {
  /** 'z'：平面 z = at，路径坐标 (x, y)；'x'：平面 x = at，路径坐标 (u = -z, y)。 */
  axis: 'z' | 'x';
  at: number;
  d: string;
  loops: Point[][];
  evenOdd: boolean;
  box: { x: number; y: number; w: number; h: number };
  /** z 切片：该截面到轮廓的最小距离（核心与厚壁为 0）。 */
  inset: number;
}

export interface VolumePart {
  kind: PartKind;
  d: string;
  polys: Point[][];
  bounds: Bounds;
  center: Point;
  thickness: number;
  depth: number;
  rxy: number;
  rz: number;
  axis?: number;
  zSlices: VolumeSlice[];
  xSlices: VolumeSlice[];
  height: (x: number, y: number) => number;
}

export interface EyePlane {
  x: number;
  y: number;
  z: number;
  dzdx: number;
  dzdy: number;
}

export interface Volume {
  parts: VolumePart[];
  bounds: Bounds;
  eyePart: number;
  /** 每只眼睛下方最高的表面，以及凝视行程，用于贴图映射。 */
  eyeZ: [number, number];
  eyeScale: number;
  eyePlanes: [EyePlane, EyePlane];
}

export type Vec3 = [number, number, number];

/** 单个膨胀部件允许的最大厚度。 */
export const MAX_PART_DEPTH = 30;
/** 身体有余量时，绘制眼睛最多比契约的 4×11 药丸大这么多。 */
export const EYE_BOOST = 1.45;
/** 放大前每只绘制眼睛与轮廓保持的间隙。 */
export const EYE_BOOST_PAD = 3;
/** 生成式头像的设计目标：放大后的眼睛静止时保持这么多净空。 */
export const FACE_ROOM_TARGET = 4.5;
const MAX_X_SLICES = 40;
const THIN = 4;
const THIN_REACH = 5;
const THIN_MARGIN = 2;
const FINE_Z = 0.6;

/** 点到多边形的最近边距离。 */
export function polygonEdgeDistance(polys: Point[][], x: number, y: number): number {
  let best = Infinity;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = poly[j][0];
      const ay = poly[j][1];
      const bx = poly[i][0];
      const by = poly[i][1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** 到轮廓的向内距离，填充之外为 0。 */
export function insideDistance(polys: Point[][], x: number, y: number): number {
  return isInside(polys, x, y) ? polygonEdgeDistance(polys, x, y) : 0;
}

/** 深度 z 处的轮廓收缩量（椭圆圆角）。 */
export function erosionAt(part: Pick<VolumePart, 'depth' | 'rxy' | 'rz'>, z: number): number {
  const half = part.depth / 2;
  if (part.rz <= 0) return 0;
  const u = (Math.abs(z) - (half - part.rz)) / part.rz;
  if (u <= 0) return 0;
  return part.rxy * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, u) ** 2)));
}

/** 膨胀部件表面达到 `level` 深度时向内缩进多少（surfaceZ 的反函数）。 */
export function insetAt(part: Pick<VolumePart, 'depth' | 'rxy' | 'rz'>, level: number): number {
  const half = part.depth / 2;
  if (part.rxy <= 0 || part.rz <= 0 || level <= half - part.rz) return 0;
  if (level >= half) return part.rxy;
  const s = (level - (half - part.rz)) / part.rz;
  return part.rxy * (1 - Math.sqrt(Math.max(0, 1 - s * s)));
}

/** 膨胀部件在“向内 `dist` 处”的前表面深度。 */
export function surfaceZ(part: Pick<VolumePart, 'depth' | 'rxy' | 'rz'>, dist: number): number {
  const half = part.depth / 2;
  if (part.rxy <= 0 || dist >= part.rxy) return half;
  const k = 1 - Math.max(0, dist) / part.rxy;
  return half - part.rz + Math.sqrt(Math.max(0, 1 - k * k)) * part.rz;
}

/** 膨胀部件的深度启发式：和它一样厚，但细长部件最多给到厚度的 2.4 倍，读作圆盘。 */
export function partDepth(thickness: number, b: Bounds, volume: number): number {
  const long = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const raw = 0.8 * Math.max(thickness, Math.min(0.4 * long, 2.4 * thickness));
  return Math.min(MAX_PART_DEPTH, Math.max(3, raw)) * volume;
}

/** 直线（y = s 或 x = s）与多边形的交点，升序。 */
function crossings(polys: Point[][], rows: boolean, s: number): number[] {
  const out: number[] = [];
  const a = rows ? 1 : 0;
  const b = rows ? 0 : 1;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p = poly[j];
      const q = poly[i];
      if ((p[a] <= s && q[a] > s) || (q[a] <= s && p[a] > s)) out.push(p[b] + ((s - p[a]) * (q[b] - p[b])) / (q[a] - p[a]));
    }
  }
  return out.sort((m, n) => m - n);
}

interface Profile {
  start: number;
  step: number;
  r: Float64Array;
}

/**
 * 如果每一行（或列）都以 `center` 为中心只交一段，返回该段的一半宽度剖面；
 * 否则返回 null（不是旋转体）。
 */
function revolveProfile(polys: Point[][], rows: boolean, lo: number, hi: number, center: number): Profile | null {
  const step = 0.2;
  const n = Math.max(2, Math.ceil((hi - lo) / step) + 1);
  const r = new Float64Array(n);
  let span = 0;
  const mids: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = Math.min(hi - 0.01, Math.max(lo + 0.01, lo + k * step));
    const xs = crossings(polys, rows, s);
    if (xs.length === 0) continue;
    if (xs.length !== 2) return null;
    r[k] = (xs[1] - xs[0]) / 2;
    span = Math.max(span, xs[1] - xs[0]);
    mids.push((xs[0] + xs[1]) / 2);
  }
  const tol = Math.max(0.8, 0.04 * span);
  if (!mids.length || mids.some((m) => Math.abs(m - center) > tol)) return null;
  return { start: lo, step, r };
}

function radiusAt(p: Profile, s: number): number {
  const t = (s - p.start) / p.step;
  if (t < 0 || t > p.r.length - 1) return 0;
  const k = Math.min(p.r.length - 2, Math.floor(t));
  return p.r[k] + (p.r[k + 1] - p.r[k]) * (t - k);
}

interface Surface {
  kind: PartKind;
  fillet: { depth: number; rxy: number; rz: number };
  profile: Profile | null;
  axis: number;
  v: number;
}

/** 部件内部一点的前表面高度；`sd` 是它到轮廓的距离（仅 inflate 使用）。 */
function surfaceHeight(s: Surface, x: number, y: number, sd: number): number {
  if (s.kind === 'inflate') return surfaceZ(s.fillet, sd);
  const p = s.profile as Profile;
  return s.kind === 'revolve-x'
    ? s.v * Math.sqrt(Math.max(0, radiusAt(p, x) ** 2 - (y - s.axis) ** 2))
    : s.v * Math.sqrt(Math.max(0, radiusAt(p, y) ** 2 - (x - s.axis) ** 2));
}

/**
 * 身体是否像“侧看的车床件”：至少两个部件、宽大于高、关于 y = axis 镜像对称且每个部件都居中于它。
 */
export function revolveAxis(body: BodyAnalysis): number | null {
  const b = body.bounds;
  const outlines = body.subpaths.filter((s) => !s.hole);
  if (outlines.length < 2 || b.maxX - b.minX < 1.1 * (b.maxY - b.minY)) return null;
  const axis = (b.minY + b.maxY) / 2;
  for (const o of outlines) {
    const ob = bounds(o.polys);
    if (Math.abs((ob.minY + ob.maxY) / 2 - axis) > 1.5) return null;
  }
  let filled = 0;
  let off = 0;
  const xs: number[] = [];
  for (let x = b.minX + 0.5; x < b.maxX; x += 1) xs.push(x);
  const top = new Uint8Array(xs.length);
  const bottom = new Uint8Array(xs.length);
  const index = edgeBands(body.polys);
  for (let y = b.minY + 0.5; y < axis; y += 1) {
    index.insideRow(y, xs, top);
    index.insideRow(2 * axis - y, xs, bottom);
    for (let k = 0; k < xs.length; k++) {
      if (top[k] || bottom[k]) filled++;
      if (top[k] !== bottom[k]) off++;
    }
  }
  return filled > 0 && off / filled < 0.02 ? axis : null;
}

interface CellBox {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

type LevelCut = (level: number, box?: CellBox) => Point[][];

/** 膨胀部件的截面：高度随到轮廓的距离增长，所以等值面就是“向内缩进量”的等距线。 */
function insetCuts(g: Grid, sd: Float64Array, fillet: Surface['fillet']): LevelCut {
  const whole: Field = { ...g, values: sd };
  const range = runRange(sd, g.nx, g.ny);
  const flat = new Uint8Array(range.min.length);
  return (level, box) => {
    const drop = insetAt(fillet, level);
    if (!box) {
      for (let k = 0; k < flat.length; k++) flat[k] = range.min[k] - drop >= 0 || range.max[k] - drop < 0 ? 1 : 0;
      return contourLoops(whole, drop, flat);
    }
    // 带框的截面在自身样本加一圈外环上求，外环的值被压到负（裁切线）。
    const i0 = Math.max(0, box.i0 - 1);
    const i1 = Math.min(g.nx - 1, box.i1 + 1);
    const j0 = Math.max(0, box.j0 - 1);
    const j1 = Math.min(g.ny - 1, box.j1 + 1);
    const nx = i1 - i0 + 1;
    const ny = j1 - j0 + 1;
    const values = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const s = sd[(j + j0) * g.nx + i + i0];
        const v = Math.min(s - drop, s);
        const clip = g.step * Math.min(i + i0 - box.i0, box.i1 - i - i0, j + j0 - box.j0, box.j1 - j - j0);
        values[j * nx + i] = Math.min(v, clip);
      }
    }
    return contourLoops({ values, nx, ny, x0: g.x0 + i0 * g.step, y0: g.y0 + j0 * g.step, step: g.step }, 0);
  };
}

/** 旋转体部件的截面：高度 ≥ level 处满足 t² ≤ r² − (level / v)²，该差值除以 2r 近似距离。 */
function revolveCuts(g: Grid, sd: Float64Array, surface: Surface): LevelCut {
  const { nx, ny } = g;
  const { v, axis } = surface;
  const p = surface.profile as Profile;
  const alongX = surface.kind === 'revolve-x';
  const base = new Float64Array(nx * ny);
  const over = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = g.y0 + j * g.step;
    for (let i = 0; i < nx; i++) {
      const x = g.x0 + i * g.step;
      const r = radiusAt(p, alongX ? x : y);
      const tt = alongX ? y - axis : x - axis;
      base[j * nx + i] = r * r - tt * tt;
      over[j * nx + i] = 2 * Math.max(r, 0.5);
    }
  }
  const values = new Float64Array(nx * ny);
  const rise = runRange(base, nx, ny);
  const edge = runRange(sd, nx, ny);
  const runs = Math.ceil((nx - 1) / RUN);
  const flat = new Uint8Array(rise.min.length);
  return (level) => {
    const drop = (level / Math.max(v, 1e-6)) ** 2;
    for (let k = 0; k < flat.length; k++) {
      const out = rise.max[k] - drop < 0 || edge.max[k] < 0;
      const within = rise.min[k] - drop >= 0 && edge.min[k] >= 0;
      flat[k] = out || within ? 1 : 0;
    }
    for (let k = 0; k < flat.length; k++) {
      if (flat[k]) continue;
      const r = k % runs;
      const j = (k - r) / runs;
      for (let q = j * nx + r * RUN, end = j * nx + Math.min(nx - 1, (r + 1) * RUN); q <= end; q++) {
        values[q] = Math.min((base[q] - drop) / over[q], sd[q]);
        values[q + nx] = Math.min((base[q + nx] - drop) / over[q + nx], sd[q + nx]);
      }
    }
    return contourLoops({ values, nx, ny, x0: g.x0, y0: g.y0, step: g.step }, 0, flat);
  };
}

interface ThinBox extends CellBox {
  top: number;
}

/**
 * 细部周围的框（ deepened by THIN_MARGIN，重叠则合并），单位是网格样本。
 * 细部指“在 THIN_REACH 内没有半径 ≥ THIN 的内切圆”的地方：气泡尾巴、叶片、提环。
 */
function thinBoxes(g: Grid, sd: Float64Array, h: Float64Array): ThinBox[] {
  const { nx, ny, step } = g;
  const reach = Math.ceil(THIN_REACH / step);
  const wide = new Uint8Array(nx * ny);
  const near = new Uint8Array(nx * ny);
  const count = new Int32Array(Math.max(nx, ny) + 1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) count[i + 1] = count[i] + (sd[j * nx + i] >= THIN ? 1 : 0);
    for (let i = 0; i < nx; i++) wide[j * nx + i] = count[Math.min(nx, i + reach + 1)] > count[Math.max(0, i - reach)] ? 1 : 0;
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) count[j + 1] = count[j] + wide[j * nx + i];
    for (let j = 0; j < ny; j++) near[j * nx + i] = count[Math.min(ny, j + reach + 1)] > count[Math.max(0, j - reach)] ? 1 : 0;
  }
  const thin = (k: number) => sd[k] > 0 && !near[k];
  const seen = new Uint8Array(nx * ny);
  const grow = Math.ceil(THIN_MARGIN / step);
  const boxes: ThinBox[] = [];
  for (let start = 0; start < nx * ny; start++) {
    if (seen[start] || !thin(start)) continue;
    const box = { i0: nx, i1: -1, j0: ny, j1: -1, top: 0 };
    let cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop() as number;
      const i = k % nx;
      const j = (k - i) / nx;
      cells++;
      box.top = Math.max(box.top, h[k]);
      box.i0 = Math.min(box.i0, i);
      box.i1 = Math.max(box.i1, i);
      box.j0 = Math.min(box.j0, j);
      box.j1 = Math.max(box.j1, j);
      for (const n of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1]) {
        if (n >= 0 && !seen[n] && thin(n)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (cells * step * step < 2) continue;
    boxes.push({
      i0: Math.max(0, box.i0 - grow),
      i1: Math.min(nx - 1, box.i1 + grow),
      j0: Math.max(0, box.j0 - grow),
      j1: Math.min(ny - 1, box.j1 + grow),
      top: box.top,
    });
  }
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a];
      const q = boxes[b];
      if (p.i0 > q.i1 || q.i0 > p.i1 || p.j0 > q.j1 || q.j0 > p.j1) continue;
      boxes[a] = {
        i0: Math.min(p.i0, q.i0),
        i1: Math.max(p.i1, q.i1),
        j0: Math.min(p.j0, q.j0),
        j1: Math.max(p.j1, q.j1),
        top: Math.max(p.top, q.top),
      };
      boxes.splice(b, 1);
      b = a;
    }
  }
  return boxes;
}

/**
 * 网格列 c0..c1 的侧剖面，画在该 slab 的列 `at` 上：坐标 (u = −z, y)，对 u 对称。
 * 每一行取 slab 内的最大高度，于是侧着看时这些平面叠起来正好是实体的侧影，
 * 而不是每个斜率处一根齿。行段与轮廓相接处取该处真实表面高度收尾。
 */
function columnLoops(g: Grid, c0: number, c1: number, sdIn: Float64Array, hIn: Float64Array, surface: Surface): Point[][] {
  const loops: Point[][] = [];
  const sd = new Float64Array(g.ny).fill(-Infinity);
  const h = new Float64Array(g.ny);
  for (let j = 0; j < g.ny; j++) {
    for (let c = c0; c <= c1; c++) {
      const k = j * g.nx + c;
      if (sdIn[k] > sd[j]) sd[j] = sdIn[k];
      if (sdIn[k] > 0 && hIn[k] > h[j]) h[j] = hIn[k];
    }
  }
  const rim = (inside: number, outside: number): Point => {
    const yIn = g.y0 + inside * g.step;
    const y = yIn + ((g.y0 + outside * g.step - yIn) * sd[inside]) / (sd[inside] - sd[outside]);
    let top = 0;
    for (let c = c0; c <= c1; c++) top = Math.max(top, surfaceHeight(surface, g.x0 + c * g.step, y, 0));
    return [Math.min(h[inside], top), y];
  };
  let j = 0;
  while (j < g.ny) {
    if (sd[j] <= 0) {
      j++;
      continue;
    }
    const j0 = j;
    while (j < g.ny && sd[j] > 0) j++;
    const j1 = j - 1;
    const right: Point[] = [];
    if (j0 > 0) right.push(rim(j0, j0 - 1));
    else right.push([h[j0], g.y0 + j0 * g.step]);
    for (let k = j0; k <= j1; k++) right.push([h[k], g.y0 + k * g.step]);
    if (j1 < g.ny - 1) right.push(rim(j1, j1 + 1));
    else right.push([h[j1], g.y0 + j1 * g.step]);
    let top = 0;
    for (const p of right) top = Math.max(top, p[0]);
    if (top < 0.05) continue;
    const loop: Point[] = right.slice();
    for (let k = right.length - 1; k >= 0; k--) loop.push([-right[k][0], right[k][1]]);
    loops.push(simplifyLoop(loop, 0.05));
  }
  return loops;
}

/** 深度层级：在圆角段上按角度均分。 */
function levels(flat: number, round: number, steps: number): number[] {
  const out: number[] = [];
  for (let k = 1; k < steps; k++) out.push(flat + round * Math.sin((k / steps) * (Math.PI / 2)));
  return out;
}

/** 构建隐含体积。`volume` 缩放所有深度（0 = 扁平）。 */
export function buildVolume(def: AvatarDefinition, volume = 1, body: BodyAnalysis = analyzeBody(def.body.path)): Volume {
  const outlines = body.subpaths.filter((s) => !s.hole);
  const holes = body.subpaths.filter((s) => s.hole);
  const v = Number.isFinite(volume) ? Math.max(0, volume) : 1;
  const xAxis = revolveAxis(body);

  const parts: VolumePart[] = outlines.map((o) => {
    const cuts = holes.filter((h) => h.probe && isInside(o.polys, h.probe[0], h.probe[1]));
    const polys = [...o.polys, ...cuts.flatMap((h) => h.polys)];
    const b = bounds(o.polys);
    const center: Point = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    const minDim = Math.min(b.maxX - b.minX, b.maxY - b.minY);
    const step = Math.max(0.25, Math.min(0.45, minDim / 24));

    let kind: PartKind = 'inflate';
    let profile: Profile | null = null;
    if (xAxis !== null) {
      profile = revolveProfile(polys, false, b.minX, b.maxX, xAxis);
      if (profile) kind = 'revolve-x';
    } else if (def.id === 'shape-sphere' || def.id === 'sphere' || (outlines.length > 1 && cuts.length === 0)) {
      profile = revolveProfile(polys, true, b.minY, b.maxY, center[0]);
      if (profile) kind = 'revolve-y';
    }

    const index = edgeBands(polys);
    let thickness: number;
    let depth: number;
    let rxy = 0;
    let rz = 0;
    let axis = 0;
    if (kind === 'inflate' || !profile) {
      // 内切半径：网格采样上最大的向内距离。
      const pad = 1;
      const tStep = Math.max(step, 0.6);
      const nx = Math.ceil((b.maxX - b.minX + 2 * pad) / tStep) + 1;
      const ny = Math.ceil((b.maxY - b.minY + 2 * pad) / tStep) + 1;
      const xs: number[] = [];
      for (let i = 0; i < nx; i++) xs.push(b.minX - pad + i * tStep);
      const row = new Uint8Array(nx);
      let widest = 0;
      for (let j = 0; j < ny; j++) {
        const y = b.minY - pad + j * tStep;
        index.insideRow(y, xs, row);
        for (let i = 0; i < nx; i++) {
          if (!row[i]) continue;
          const d = polygonEdgeDistance(polys, xs[i], y);
          if (d > widest) widest = d;
        }
      }
      thickness = 2 * widest;
      depth = partDepth(thickness, b, v);
      rxy = Math.min(thickness / 2, depth / 2) * 0.9;
      rz = (depth / 2) * 0.85;
    } else {
      axis = kind === 'revolve-x' ? (xAxis as number) : center[0];
      const radius = Math.max(...profile.r);
      thickness = 2 * radius;
      depth = 2 * radius * v;
    }

    const surface: Surface = { kind, fillet: { depth, rxy, rz }, profile, axis, v };
    const filled = edgeBands(polys);
    const height = (x: number, y: number) =>
      filled.winding(x, y) !== 0 ? surfaceHeight(surface, x, y, kind === 'inflate' ? polygonEdgeDistance(polys, x, y) : 0) : 0;

    const core: VolumeSlice = {
      axis: 'z',
      at: 0,
      d: o.d + cuts.map((h) => h.d).join(''),
      loops: polys,
      evenOdd: false,
      box: { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY },
      inset: 0,
    };
    const zSlices: VolumeSlice[] = [core];
    const xSlices: VolumeSlice[] = [];
    const half = depth / 2;

    if (half > 0.05) {
      // 采样网格：带符号距离与高度。
      const pad = 1;
      const nx = Math.ceil((b.maxX - b.minX + 2 * pad) / step) + 1;
      const ny = Math.ceil((b.maxY - b.minY + 2 * pad) / step) + 1;
      const g: Grid = { x0: b.minX - pad, y0: b.minY - pad, step, nx, ny };
      const xs: number[] = [];
      for (let i = 0; i < nx; i++) xs.push(g.x0 + i * step);
      const sd = new Float64Array(nx * ny);
      const h = new Float64Array(nx * ny);
      const inside = new Uint8Array(nx);
      for (let j = 0; j < ny; j++) {
        const y = g.y0 + j * step;
        index.insideRow(y, xs, inside);
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          const d = polygonEdgeDistance(polys, xs[i], y);
          if (inside[i]) {
            sd[k] = d;
            h[k] = surfaceHeight(surface, xs[i], y, kind === 'inflate' ? d : 0);
          } else {
            sd[k] = -d;
          }
        }
      }

      const steps =
        kind === 'inflate' ? Math.max(4, Math.min(14, Math.round(rz / 0.8))) : Math.max(5, Math.min(18, Math.round(half / 1.1)));
      const ls = kind === 'inflate' ? [half - rz, ...levels(half - rz, rz, steps)] : levels(0, half, steps);
      const cut: LevelCut = kind === 'inflate' ? insetCuts(g, sd, surface.fillet) : revolveCuts(g, sd, surface);
      const addLevel = (level: number, box?: CellBox) => {
        const loops = cut(level, box);
        if (!loops.length) return false;
        let inset = Infinity;
        let k = 0;
        for (const loop of loops) for (const p of loop) if (k++ % 3 === 0) inset = Math.min(inset, polygonEdgeDistance(polys, p[0], p[1]));
        const slice = { axis: 'z' as const, d: loopsToPath(loops), loops, evenOdd: true, box: loopBox(loops), inset };
        zSlices.push({ ...slice, at: level }, { ...slice, at: -level });
        return true;
      };
      const used = [0];
      for (const level of ls) if (level >= 0.02 && addLevel(level)) used.push(level);
      // 细长而深的鳍：在层级之间补截面（含直壁），每个裁到自己的框内。
      const thin = kind === 'inflate' ? thinBoxes(g, sd, h) : [];
      for (const box of thin) {
        for (let k = 1; k < used.length && used[k - 1] < box.top; k++) {
          const a = used[k - 1];
          const gap = used[k] - a;
          const m = Math.ceil(gap / FINE_Z - 1e-9);
          for (let q = 1; q < m && a + (gap * q) / m < box.top; q++) addLevel(a + (gap * q) / m, box);
        }
      }
      zSlices.sort((m, n) => m.at - n.at);

      // 每 every 个网格列一个平面，代表它周围的整个 slab。
      const width = b.maxX - b.minX;
      const every = Math.max(1, Math.round(Math.max(1.1, width / MAX_X_SLICES) / step));
      const before = Math.floor((every - 1) / 2);
      for (let i = 1; i < nx - 1; i += every) {
        const loops = columnLoops(g, Math.max(0, i - before), Math.min(nx - 1, i - before + every - 1), sd, h, surface);
        if (loops.length) {
          xSlices.push({ axis: 'x', at: g.x0 + i * step, d: loopsToPath(loops), loops, evenOdd: true, box: loopBox(loops), inset: 0 });
        }
      }
    }

    return {
      kind,
      d: core.d,
      polys,
      bounds: b,
      center,
      thickness,
      depth,
      rxy,
      rz,
      axis: kind === 'revolve-x' ? (xAxis as number) : kind === 'revolve-y' ? center[0] : undefined,
      zSlices,
      xSlices,
      height,
    };
  });

  const eyeScale = boostedEyeScale(body, def.eyes);
  const centers = eyeCenters(def.eyes);
  let eyePart = 0;
  let bestZ = -Infinity;
  parts.forEach((part, i) => {
    const zs = centers.map(([x, y]) => part.height(x, y));
    if (zs.some((z) => z <= 0)) return;
    const z = Math.min(...zs);
    if (z > bestZ) {
      bestZ = z;
      eyePart = i;
    }
  });
  const host = parts[eyePart];
  const w = (EYE_W * eyeScale) / 2 + GAZE_X * eyeScale;
  const hh = (EYE_H * eyeScale) / 2 + GAZE_Y * eyeScale;
  const eyeZ = centers.map(([x, y]) => {
    let top = 0;
    for (const fx of [-1, -0.5, 0, 0.5, 1]) {
      for (const fy of [-1, -0.5, 0, 0.5, 1]) top = Math.max(top, host ? host.height(x + fx * w, y + fy * hh) : 0);
    }
    return top;
  }) as [number, number];

  const eyePlanes = centers.map(([x, y]) => {
    if (!host) return { x, y, z: 0, dzdx: 0, dzdy: 0 };
    const e = 0.75;
    const dzdx = (host.height(x + e, y) - host.height(x - e, y)) / (2 * e);
    const dzdy = (host.height(x, y + e) - host.height(x, y - e)) / (2 * e);
    return { x, y, z: host.height(x, y), dzdx, dzdy };
  }) as [EyePlane, EyePlane];

  return { parts, bounds: body.bounds, eyePart, eyeZ, eyeScale, eyePlanes };
}

/** 不超过 EYE_BOOST × 定义值、且绘制眼睛仍与轮廓保持 EYE_BOOST_PAD 的最大眼睛倍率。 */
export function boostedEyeScale(body: BodyAnalysis, eyes: AvatarEyes): number {
  for (const k of [EYE_BOOST, 1.38, 1.3, 1.22, 1.15, 1.08]) {
    if (!drawnEyesFit(body.polys, { ...eyes, scale: eyes.scale * k }, 0, 0, EYE_BOOST_PAD)) return eyes.scale * k;
  }
  return eyes.scale;
}

export interface FaceRoom {
  boost: number;
  clearance: number;
  gaze: GazeRange;
  ok: boolean;
}

/** 渲染器实际绘制时的脸部余量。 */
export function faceRoom(def: AvatarDefinition, body: BodyAnalysis = analyzeBody(def.body.path)): FaceRoom {
  const scale = boostedEyeScale(body, def.eyes);
  const eyes = { ...def.eyes, scale };
  const clearance = eyeClearance(body.polys, eyes);
  const gaze = gazeRange(body.polys, eyes);
  const boost = Math.round((scale / def.eyes.scale) * 100) / 100;
  const ok = boost >= EYE_BOOST - 1e-9 && clearance >= FACE_ROOM_TARGET && Math.min(gaze.left, gaze.right, gaze.up, gaze.down) === 1;
  return { boost, clearance, gaze, ok };
}