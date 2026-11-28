/**
 * 把“定义 + 体积 + 姿态”压成一帧扁平数据：每个截面及其投影矩阵、两只眼睛、
 * 身前的彩带与标记。任何矢量渲染器（canvas、SVG、Skia）都能照着画。
 *
 * 投影是正交投影：先绕竖直轴 yaw，再绕水平轴 pitch。截面按到观察者的深度
 * 从后往前排序，于是叠起来就是实体的剪影，看不到平面的“侧面”。
 */
import { oklch, parseHex, toHex, toOklch, type Rgb } from './color.ts';
import { bloomPieces, bodyScale, markParts, ribbonPieces, rimOf, type Box, type Rim } from './fx.ts';
import { eyePath, plainLook, type EyeSpot } from './eyes.ts';
import { blendPoses, hashString, computePose, type Pose } from './pose.ts';
import type { PoseLike } from './types.ts';
import type { Bounds, Point } from './path.ts';
import { EYE_H, EYE_W, GAZE_X, GAZE_Y, HAPPY_ARC, analyzeBody, eyeCenters, gazeRange, validateAvatar, type BodyAnalysis, type GazeRange } from './validate.ts';
import { buildVolume, type EyePlane, type Volume, type VolumeSlice } from './volume.ts';
import type { AvatarDefinition, RenderOptions } from './types.ts';
import { derivePalette } from '../bot/palettes.ts';
import { RING_ENVELOPE, ringPath } from '../bot/ring.ts';
import { badgePiece, orbitPieces } from '../bot/effects.ts';

export const DEFAULT_COLOR = '#ff6a1a';
export const DEFAULT_EYE_COLOR = '#151515';
/** `depth` 选项里对应“自然体积”的值。 */
export const DEFAULT_DEPTH = 6;
const MAX_DEPTH = 14;

export type Matrix = [number, number, number, number, number, number];

export type EyeMark =
  | { shape: 'pill'; x: number; y: number; width: number; height: number; radius: number }
  | { shape: 'arc'; d: string; strokeWidth: number }
  | { shape: 'path'; d: string };

export interface FramePath {
  id: string;
  d: string;
  evenOdd: boolean;
  box: Box;
}

export type FrameShape =
  | { kind: 'slice'; key: string; path: string; matrix: Matrix }
  | { kind: 'eye'; key: 'eye-0' | 'eye-1'; matrix: Matrix; mark: EyeMark }
  | {
      kind: 'ribbon';
      key: string;
      d: string;
      box: Box;
      matrix: Matrix;
      front: boolean;
      gradient: { x1: number; y1: number; x2: number; y2: number; stops: string[] };
    }
  | { kind: 'mark'; key: string; id: string; d: string; box: Box; matrix: Matrix }
  | { kind: 'particle'; key: string; d: string; box: Box; matrix: Matrix; fill: string; front: boolean };

export interface Frame {
  name: string;
  color: string;
  highlight: string;
  shadow: string;
  clay: boolean;
  bodyBox: Bounds;
  ink: string;
  paths: FramePath[];
  /** 身体整体的 2D 动作（跳、摇、压扁），作用在所有形状上。 */
  root: Matrix;
  /** 从后往前。 */
  shapes: FrameShape[];
  /** 这一帧的姿态（已含缓动），可以直接作为下一帧的 `poseBlend.from`。 */
  pose: PoseLike;
}

// ---------------------------------------------------------------------------
// 视图数学

export interface ViewBasis {
  cY: number;
  sY: number;
  cP: number;
  sP: number;
  /** cos(yaw)·cos(pitch)：> 0 表示正面朝向观察者。 */
  facing: number;
}

export function viewBasis(yaw: number, pitch: number): ViewBasis {
  const cY = Math.cos(yaw);
  const cP = Math.cos(pitch);
  return { cY, sY: Math.sin(yaw), cP, sP: Math.sin(pitch), facing: cY * cP };
}

/** 该视角下，模型空间方向朝向观察者的分量（1 = 正对）。 */
export function facingOf(v: ViewBasis, [x, y, z]: [number, number, number]): number {
  return v.sP * y + v.cP * (-v.sY * x + v.cY * z);
}

export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const about = (x: number, y: number, m: Matrix): Matrix => mul(translate(x, y), mul(m, translate(-x, -y)));
const invert = ([a, b, c, d, e, g]: Matrix): Matrix => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * g - d * e) / det, (b * e - a * g) / det];
};

export const pivotOf = (b: Bounds): Point => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/** 深度 z 的平面在 `pivot` 处的正交投影矩阵（yaw 后 pitch）。 */
export function planeMatrix(v: ViewBasis, z: number, pivot: Point): Matrix {
  const [cx, cy] = pivot;
  return [
    v.cY,
    v.sY * v.sP,
    0,
    v.cP,
    cx - v.cY * cx + v.sY * z,
    cy - v.cP * cy - v.sY * v.sP * cx - v.cY * v.sP * z,
  ];
}

/** 侧平面 x = x0 的投影，其局部坐标是 (u = −z, y)。 */
export function sidePlaneMatrix(v: ViewBasis, x0: number, pivot: Point): Matrix {
  const [cx, cy] = pivot;
  return [-v.sY, v.cY * v.sP, 0, v.cP, cx + v.cY * (x0 - cx), cy - v.cP * cy + v.sY * v.sP * (x0 - cx)];
}

export function projectPoint(v: ViewBasis, [x, y, z]: [number, number, number], pivot: Point): [number, number, number] {
  const m = planeMatrix(v, z, pivot);
  const X = x - pivot[0];
  const Y = y - pivot[1];
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], v.sP * Y + v.cP * (-v.sY * X + v.cY * z)];
}

/** 哪一叠截面更朝向观察者：朝前的 z 平面，还是朝侧的 x 平面。 */
export function activeStack(v: ViewBasis): 'z' | 'x' {
  return Math.abs(v.cY) >= Math.abs(v.sY) ? 'z' : 'x';
}

/** 眼睛的切平面矩阵：先在平面上放一个矩形，再按表面斜率倾斜。 */
function eyeMatrix(v: ViewBasis, { x, y, z, dzdx, dzdy }: EyePlane, pivot: Point): Matrix {
  const m = planeMatrix(v, z - x * dzdx - y * dzdy, pivot);
  m[0] += v.sY * dzdx;
  m[1] -= v.cY * v.sP * dzdx;
  m[2] += v.sY * dzdy;
  m[3] -= v.cY * v.sP * dzdy;
  return m;
}

/** 单位平面法线在该视角下是否朝向观察者（侧到极限时面积趋于 0）。 */
function eyeVisible(v: ViewBasis, plane: EyePlane): boolean {
  return facingOf(v, [-plane.dzdx, -plane.dzdy, 1]) > 1e-6;
}

/** 跳、摇、压扁都以身体底部为支点。 */
function rootMatrix(pose: Pose, b: Bounds): Matrix {
  const bx = (b.minX + b.maxX) / 2;
  const by = b.maxY;
  const r = (pose.roll * Math.PI) / 180;
  const rot: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  return mul(translate(0, pose.lift), about(bx, by, mul(rot, [pose.sx, 0, 0, pose.sy, 0, 0])));
}

/** 圆润的身体弹得更狠：越接近圆，压扁/拉伸与弹跳的幅度越大（弹性球体的手感）。 */
export function elasticityOf(b: Bounds): number {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const ratio = Math.min(w, h) / Math.max(w, h || 1);
  return Math.min(1.5, Math.max(0.55, 0.55 + 0.9 * ratio));
}

/** 按弹性系数放大姿态里的形变（压扁、拉伸、弹跳、摇摆），让圆身子的头像更有橡皮感。 */
export function applyElasticity(pose: Pose, k: number): Pose {
  if (!Number.isFinite(k) || k <= 0) return pose;
  return {
    ...pose,
    sy: 1 + (pose.sy - 1) * k,
    sx: 1 + (pose.sx - 1) * k,
    lift: pose.lift * k,
    roll: pose.roll * Math.min(1.2, k),
  };
}

/** 缓动：两端平缓、中间快（smoothstep）。 */
const smoothstep = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

const clampedDepth = (depth: number | undefined): number => {
  const d = Math.min(MAX_DEPTH, Math.max(0, Number.isFinite(depth) ? (depth as number) : DEFAULT_DEPTH));
  return Math.round(d * 2) / 2;
};

// ---------------------------------------------------------------------------
// 预计算与缓存

export interface Prepared {
  def: AvatarDefinition;
  body: BodyAnalysis;
  vol: Volume;
  range: GazeRange;
  seed: number;
  id: string;
  ids: Map<string, string>;
  rim: () => Rim;
}

const cache = new Map<string, Prepared>();

/** 校验后的定义与其缓存体积，与渲染器实际使用的完全一致。 */
export function prepare(definition: AvatarDefinition, depth?: number): Prepared {
  const key = JSON.stringify([definition?.id, definition?.name, definition?.body?.path, definition?.eyes, clampedDepth(depth)]);
  const hit = cache.get(key);
  if (hit) return hit;
  const res = validateAvatar(definition);
  if (!res.ok) throw new Error(`Invalid avatar definition: ${res.errors.join('; ')}`);
  const def = res.value;
  const body = analyzeBody(def.body.path);
  const vol = buildVolume(def, clampedDepth(depth) / DEFAULT_DEPTH, body);
  const id = `obr-${hashString(`${def.id}|${def.body.path}|${clampedDepth(depth)}`).toString(36)}`;
  const ids = new Map<string, string>();
  for (const part of vol.parts) {
    for (const s of [...part.zSlices, ...part.xSlices]) if (!ids.has(s.d)) ids.set(s.d, `${id}-${ids.size}`);
  }
  let rim: Rim | undefined;
  const prepared: Prepared = {
    def,
    body,
    vol,
    range: gazeRange(body.polys, { ...def.eyes, scale: vol.eyeScale }),
    seed: hashString(def.id),
    id,
    ids,
    rim: () => (rim ??= rimOf(body.polys, (vol.bounds.minX + vol.bounds.maxX) / 2, (vol.bounds.minY + vol.bounds.maxY) / 2)),
  };
  if (cache.size >= 48) cache.delete(cache.keys().next().value as string);
  cache.set(key, prepared);
  return prepared;
}

// ---------------------------------------------------------------------------
// 眼睛

interface EyeState {
  x: number;
  y: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  open: number;
  shift: number;
  /** 这只眼睛完全闭着（眨眼到顶）。 */
  closed: boolean;
  plain: 'pill' | 'arc' | null;
  look: Pose['eyes'];
  /** 高光强度（0 = 不画）。 */
  glint: number;
}

function eyeStates(p: Prepared, pose: Pose): [EyeState, EyeState] {
  const s = p.vol.eyeScale;
  const w = EYE_W * s;
  const h = EYE_H * s;
  const r = p.range;
  const dx = pose.gazeX * (pose.gazeX >= 0 ? r.right : r.left) * GAZE_X * s;
  const dy = pose.gazeY * (pose.gazeY >= 0 ? r.down : r.up) * GAZE_Y * s;
  const centers = eyeCenters(p.def.eyes);
  return ([0, 1] as const).map((i) => {
    const squint = i === 0 ? pose.squintL : pose.squintR;
    // 上眼皮下垂（困）与眯眼一起压高度；闭眼另走闭眼线，不靠“压成一条”硬凑。
    const lid = Math.max(0, Math.min(1, pose.eyes.lid * 0.82 + squint * 0.4));
    const openness = (1 - pose.blink) * (1 - lid);
    const closed = pose.blink > 0.92;
    const open = Math.max(h * Math.max(0.09, openness), w * 0.55);
    return {
      x: centers[i][0],
      y: centers[i][1],
      w,
      h,
      dx,
      dy,
      open,
      shift: (h - open) * 0.18,
      closed,
      plain: plainLook(pose.eyes),
      look: pose.eyes,
      glint: pose.eyes.glint,
    };
  }) as [EyeState, EyeState];
}

function spotOf(e: EyeState, withGaze: boolean): EyeSpot {
  return {
    x: e.x + (withGaze ? e.dx : 0),
    y: e.y + (withGaze ? e.dy : 0),
    w: e.w,
    h: e.h,
    open: e.open,
    shift: e.shift,
    closed: e.closed,
  };
}

function happyArc(e: EyeState): string {
  const ex = e.x + e.dx;
  const ey = e.y + e.dy;
  const hw = e.w * HAPPY_ARC.halfWidth;
  const base = ey + e.h * HAPPY_ARC.base;
  return `M${ex - hw} ${base}Q${ex} ${ey - e.h * HAPPY_ARC.peak} ${ex + hw} ${base}`;
}

function eyeMark(e: EyeState): EyeMark {
  if (e.closed) return { shape: 'path', d: eyePath(e.look, spotOf(e, true)) };
  if (e.plain === 'arc') return { shape: 'arc', d: happyArc(e), strokeWidth: e.w * HAPPY_ARC.stroke };
  if (e.plain === null) return { shape: 'path', d: eyePath(e.look, spotOf(e, true)) };
  const cx = e.x + e.dx;
  const cy = e.y + e.dy + e.shift;
  return { shape: 'pill', x: cx - e.w / 2, y: cy - e.open / 2, width: e.w, height: e.open, radius: Math.min(e.w, e.open) / 2 };
}

function colors(options: RenderOptions): { color: string; highlight: string; shadow: string; accent: string; ink: string } {
  const palette = derivePalette(options.color ?? DEFAULT_COLOR);
  const highlight = options.highlightColor ? toHex(parseHex(options.highlightColor) ?? (parseHex(palette.highlight) as Rgb)) : palette.highlight;
  const shadow = options.shadowColor ? toHex(parseHex(options.shadowColor) ?? (parseHex(palette.shadow) as Rgb)) : palette.shadow;
  return {
    color: palette.base,
    highlight,
    shadow,
    accent: palette.accent,
    ink: toHex(parseHex(options.eyeColor) ?? (parseHex(DEFAULT_EYE_COLOR) as Rgb)),
  };
}

// ---------------------------------------------------------------------------
// 彩带配色

const RAMP_LIGHT = 0.09;
const RAMP_HUE = 14;
const RAMP_RANGE: [number, number] = [0.36, 0.9];
const WARM = 100;
const GRADIENT_LIGHT = 0.13;
const GRADIENT_HUE = 25;
const GRADIENT_STOPS = 5;
const NEUTRAL = 0.04;
const NEUTRAL_TINT = 0.025;
const BAND_SHADES = [
  [0, 1, 2],
  [2, 0, 3],
  [1, 2, 0],
] as const;

function turnToward(h: number, to: number, by: number): number {
  const d = ((to - h + 540) % 360) - 180;
  return (h + Math.sign(d) * Math.min(Math.abs(d), by) + 360) % 360;
}

const palettes = new Map<string, string[][]>();

/** 每条彩带的渐变（尾 → 头），取自身体颜色的那条色阶：越亮越暖，越暗越冷。 */
function ribbonPalette(color: string, seed: number): string[][] {
  const key = `${color}|${seed}`;
  const hit = palettes.get(key);
  if (hit) return hit;
  const [light, chroma, hue] = toOklch(parseHex(color) ?? (parseHex(DEFAULT_COLOR) as Rgb));
  const neutral = chroma < NEUTRAL;
  const base = neutral ? (130 + ((seed % 997) / 997) * 310) % 360 : hue;
  const c = neutral ? NEUTRAL_TINT : Math.max(chroma, 0.17);
  const from = Math.min(RAMP_RANGE[1], Math.max(RAMP_RANGE[0], light));
  const steps: number[] = [];
  for (let k = 1; steps.length < 5 && k < 10; k++) {
    for (const step of [k, -k]) {
      const l = from + step * RAMP_LIGHT;
      if (steps.length < 5 && l >= RAMP_RANGE[0] - 1e-9 && l <= RAMP_RANGE[1] + 1e-9) steps.push(step);
    }
  }
  while (steps.length < 5) steps.push(steps[steps.length - 1] ?? 1);
  const shades = steps.map((step) => {
    const l = from + step * RAMP_LIGHT;
    const h = turnToward(base, step > 0 ? WARM : WARM + 180, RAMP_HUE * Math.abs(step));
    const away = step > 0 ? 1 : -1;
    return Array.from({ length: GRADIENT_STOPS }, (_, n) => {
      const t = n / (GRADIENT_STOPS - 1);
      const hh = turnToward(h, away > 0 ? WARM : WARM + 180, GRADIENT_HUE * t);
      return toHex(oklch(Math.min(0.9, Math.max(0.26, l + away * GRADIENT_LIGHT * t)), c, hh));
    });
  });
  const palette = BAND_SHADES.flatMap((pick) => pick.map((n) => shades[n]));
  if (palettes.size >= 64) palettes.clear();
  palettes.set(key, palette);
  return palette;
}

// ---------------------------------------------------------------------------
// 一帧

function sliceCull(v: ViewBasis): (s: VolumeSlice) => boolean {
  const sweep = Math.hypot(v.sY, v.cY * v.sP);
  const inset = Math.min(Math.abs(v.cY), Math.abs(v.cP));
  return (s) => s.axis !== 'z' || s.inset <= 0 || Math.abs(s.at) * sweep > s.inset * inset;
}

/** 按渲染尺寸丢掉挤在一起的截面（小于约 0.75 px 的间隔看不出差别）。 */
function keptSlices(p: Prepared, stack: 'z' | 'x', size: number | undefined): boolean[] {
  const px = Number.isFinite(size) && (size as number) > 0 ? Math.round(size as number) : 0;
  const gap = px ? (0.75 * 100) / px : 0;
  const out: boolean[] = [];
  for (const part of p.vol.parts) {
    const slices = stack === 'z' ? part.zSlices : part.xSlices;
    let last = -Infinity;
    slices.forEach((s, j) => {
      const core = s.axis === 'z' && s.at === 0 && s.inset === 0;
      const keep = core || j === 0 || j === slices.length - 1 || s.at - last >= gap;
      if (keep) last = s.at;
      out.push(keep);
    });
  }
  return out;
}

/** 计算一帧。定义非法时抛错。 */
export function computeFrame(definition: AvatarDefinition, options: RenderOptions = {}, size?: number): Frame {
  const p = prepare(definition, options.depth);
  const { vol, body } = p;
  const b = vol.bounds;
  const pivot = pivotOf(b);
  const { color, highlight, shadow, accent, ink } = colors(options);
  const clay = options.clay !== false;
  const time = Number.isFinite(options.time) ? (options.time as number) : 0;
  const pose = applyElasticity(computePose({
    seed: p.seed,
    time,
    state: options.state,
    mood: options.mood,
    expression: options.expression,
    stateAge: options.stateAge,
    gaze: options.gaze,
    reducedMotion: options.reducedMotion === true,
    view: options.view,
  }), elasticityOf(b));
  // 从“屏幕上正在显示的样子”缓动过来：状态与表情的切换都经过这里。
  const blended: Pose = options.poseBlend && Number.isFinite(options.poseBlend.t) && options.poseBlend.t < 1
    ? blendPoses(options.poseBlend.from as Pose, pose, smoothstep(options.poseBlend.t))
    : pose;
  const v = viewBasis(blended.yaw, blended.pitch);
  const stack = activeStack(v);
  const shrink = bodyScale(blended.bang, blended.dots);
  const root = rootMatrix(blended, b);
  const scaleAbout = (m: Matrix): Matrix => (shrink < 1 ? mul(about(pivot[0], pivot[1], [shrink, 0, 0, shrink, 0, 0]), m) : m);

  const paths = new Map<string, FramePath>();
  const items: { depth: number; shape: FrameShape }[] = [];
  const pathFor = (d: string, evenOdd: boolean, box: Box, id?: string): FramePath => {
    let path = paths.get(d);
    if (!path) {
      path = { id: id ?? (p.ids.get(d) as string), d, evenOdd, box };
      paths.set(d, path);
    }
    return path;
  };

  if (shrink > 0) {
    const drawn = sliceCull(v);
    const kept = keptSlices(p, stack, size);
    let k = 0;
    vol.parts.forEach((part, i) => {
      (stack === 'z' ? part.zSlices : part.xSlices).forEach((s, j) => {
        if (!kept[k++] || !drawn(s)) return;
        const path = pathFor(s.d, s.evenOdd, s.box);
        // 平行的截面在每条视射线上顺序相同。
        const depth = stack === 'z' ? v.facing * s.at : -v.sY * v.cP * s.at;
        items.push({ depth, shape: { kind: 'slice', key: `${i}${stack}${j}`, path: path.id, matrix: scaleAbout(stack === 'z' ? planeMatrix(v, s.at, pivot) : sidePlaneMatrix(v, s.at, pivot)) } });
      });
    });

    if (options.eyeRings && options.eyeRings.length === 2) {
      const s = p.vol.eyeScale;
      const r = p.range;
      const dx = blended.gazeX * (blended.gazeX >= 0 ? r.right : r.left) * GAZE_X * s;
      const dy = blended.gazeY * (blended.gazeY >= 0 ? r.down : r.up) * GAZE_Y * s;
      const blinkScale = Number.isFinite(options.blinkScale) ? Math.max(0.06, Math.min(1, options.blinkScale as number)) : 1;
      const centers = eyeCenters(p.def.eyes);
      const halfW = RING_ENVELOPE.hw * s;
      const halfH = RING_ENVELOPE.hh * s;
      const xDepth = -v.sY * v.cP;

      centers.forEach(([cx, cy], idx) => {
        const plane = vol.eyePlanes[idx];
        if (!eyeVisible(v, plane)) return;
        const z = plane.z + dx * plane.dzdx + dy * plane.dzdy;
        const depth =
          stack === 'z'
            ? v.facing * z + Math.abs(v.facing) * (Math.abs(plane.dzdx) * halfW + Math.abs(plane.dzdy) * halfH)
            : xDepth * (cx + dx) + Math.abs(xDepth) * halfW;
        const eyeMatrixNow = scaleAbout(eyeMatrix(v, plane, pivot));
        const d = ringPath(options.eyeRings![idx], cx, cy, s, blinkScale, dx, dy);
        items.push({
          depth: depth + 1e-6,
          shape: { kind: 'eye', key: idx === 0 ? 'eye-0' : 'eye-1', matrix: eyeMatrixNow, mark: { shape: 'path', d } },
        });
      });
    } else {
      eyeStates(p, blended).forEach((e, idx) => {
        const plane = vol.eyePlanes[idx];
        if (!eyeVisible(v, plane)) return;
        const halfW = e.w * (e.plain === 'pill' ? 0.5 : HAPPY_ARC.halfWidth + 0.5 * HAPPY_ARC.stroke);
        const xDepth = -v.sY * v.cP;
        const z = plane.z + e.dx * plane.dzdx + e.dy * plane.dzdy;
        const depth =
          stack === 'z'
            ? v.facing * z + Math.abs(v.facing) * (Math.abs(plane.dzdx) * halfW + (Math.abs(plane.dzdy) * e.h) / 2)
            : xDepth * (e.x + e.dx) + Math.abs(xDepth) * halfW;
        const eyeMatrixNow = scaleAbout(eyeMatrix(v, plane, pivot));
        const mark = eyeMark(e);
        items.push({
          depth: depth + 1e-6,
          shape: { kind: 'eye', key: idx === 0 ? 'eye-0' : 'eye-1', matrix: eyeMatrixNow, mark },
        });
      });
    }
    items.sort((m, n) => m.depth - n.depth);
  }

  // 彩带与标记停在原地，不随身体的 2D 动作移动：用 root 的逆矩阵抵消。
  const fixed = shrink < 1 || blended.ribbons > 0.01 || options.orbit ? invert(root) : null;
  const ribbons: FrameShape[] = [];
  if (blended.ribbons > 0.01 && !options.reducedMotion) {
    const inside = (x: number, y: number) => {
      let w = 0;
      for (const poly of body.polys) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i];
          const [xj, yj] = poly[j];
          if (yj <= y) {
            if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
          } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
        }
      }
      return w !== 0;
    };
    const palette = ribbonPalette(color, p.seed);
    for (const piece of ribbonPieces(p.rim(), blended.ribbons, p.seed, time, blended.sweep, blended.cage, inside, (i) => palette[i % palette.length])) {
      ribbons.push({
        kind: 'ribbon',
        key: '',
        d: piece.d,
        box: piece.box,
        matrix: fixed ?? [1, 0, 0, 1, 0, 0],
        front: piece.front,
        gradient: piece.gradient,
      });
    }
  }
  const particles: FrameShape[] = [];
  if (blended.bloom > 0.01) {
    const palette = ribbonPalette(color, p.seed).map((run) => run[Math.floor(run.length / 2)]);
    for (const [i, piece] of bloomPieces(b, p.seed, blended.bloomAge, blended.bloom, palette).entries()) {
      particles.push({
        kind: 'particle',
        key: `particle-${i}`,
        d: piece.d,
        box: piece.box,
        matrix: mul(fixed ?? [1, 0, 0, 1, 0, 0], piece.matrix),
        fill: piece.fill,
        front: piece.front,
      });
    }
  }
  if (options.orbit) {
    const orbitColors = [accent, highlight, color];
    for (const [i, piece] of orbitPieces(p.rim(), p.seed, time, options.state ?? 'idle', orbitColors, options.reducedMotion === true).entries()) {
      particles.push({
        kind: 'particle',
        key: `orbit-${i}`,
        d: piece.d,
        box: piece.box,
        matrix: mul(fixed ?? [1, 0, 0, 1, 0, 0], piece.matrix),
        fill: piece.fill,
        front: piece.front,
      });
    }
  }
  const badge = badgePiece(b, options.badge, time, options.reducedMotion === true);
  if (badge) {
    const outerR = badge.radius;
    const innerR = badge.radius * 0.72;
    const circle = (r: number) => `M${-r} 0A${r} ${r} 0 1 1 ${r} 0A${r} ${r} 0 1 1 ${-r} 0Z`;
    const m: Matrix = [badge.pulse, 0, 0, badge.pulse, badge.x, badge.y];
    particles.push(
      {
        kind: 'particle',
        key: 'badge-ring',
        d: circle(outerR),
        box: { x: -outerR, y: -outerR, w: 2 * outerR, h: 2 * outerR },
        matrix: m,
        fill: badge.ringFill,
        front: true,
      },
      {
        kind: 'particle',
        key: 'badge-dot',
        d: circle(innerR),
        box: { x: -innerR, y: -innerR, w: 2 * innerR, h: 2 * innerR },
        matrix: m,
        fill: badge.fill,
        front: true,
      },
    );
  }

  const marks: FrameShape[] = [];
  if (shrink < 1) {
    for (const part of markParts(b, blended.bang, blended.dots, p.seed, time, options.reducedMotion === true)) {
      const turn: Matrix = [Math.cos(part.turn), Math.sin(part.turn), -Math.sin(part.turn), Math.cos(part.turn), 0, 0];
      const id = `${p.id}-${part.shape}`;
      pathFor(part.d, false, part.box, id);
      marks.push({
        kind: 'mark',
        key: `mark-${part.shape}-${marks.length}`,
        id,
        d: part.d,
        box: part.box,
        matrix: mul(fixed ?? [1, 0, 0, 1, 0, 0], mul(about(pivot[0], pivot[1], turn), mul(translate(part.x, part.y), [part.scale, 0, 0, part.scale, 0, 0]))),
      });
    }
  }

  const ordered: FrameShape[] = [
    ...particles.filter((r) => r.kind === 'particle' && !r.front),
    ...ribbons.filter((r) => r.kind === 'ribbon' && !r.front),
    ...items.map((it) => it.shape),
    ...ribbons.filter((r) => r.kind === 'ribbon' && r.front),
    ...particles.filter((r) => r.kind === 'particle' && r.front),
    ...marks,
  ].map((s, i) => (s.kind === 'ribbon' ? { ...s, key: `ribbon-${i}` } : s));

  return { name: p.def.name, color, highlight, shadow, clay, bodyBox: b, ink, paths: [...paths.values()], root, shapes: ordered, pose: blended };
}

/** 一帧可用的方形范围（viewBox 单位），canvas 用它做位图上限。 */
export function avatarExtent(definition: AvatarDefinition, depth?: number): { x: number; y: number; size: number } {
  const p = prepare(definition, depth);
  const b = p.vol.bounds;
  const [cx, cy] = pivotOf(b);
  const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, Math.max(...p.vol.parts.map((part) => part.depth)) + 3) / 2;
  const rim = p.rim();
  const reach = Math.hypot(rim.cx - cx, rim.cy - cy) + rim.max * 1.1 + 8;
  const half = Math.max(radius + 5, reach);
  return { x: cx - half, y: cy - half, size: 2 * half };
}