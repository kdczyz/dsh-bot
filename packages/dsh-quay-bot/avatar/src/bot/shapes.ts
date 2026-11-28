/**
 * 8 种标准化基础躯干（Circle、Squircle、Hexagon、Cloud、Capsule、Droplet、Star、Blob）。
 *
 * 每个躯干同时提供：
 * 1. 归一化到 [-1, 1] 的采样顶点，方便 Android / Flutter / Canvas 2D 按任意半径直接缩放；
 * 2. 符合 AvatarDefinition（0..100 viewBox）契约的 SVG 路径与眼睛锚点，无缝接入体积切片引擎。
 */
import type { AvatarDefinition } from '../core/types.ts';
import type { Pt } from './ring.ts';

export type ShapeId = 'circle' | 'sphere' | 'squircle' | 'hexagon' | 'cloud' | 'capsule' | 'droplet' | 'star' | 'blob';

export interface CanonicalShape {
  id: ShapeId;
  name: string;
  /** 归一化 [-1, 1] 闭合采样点（用于跨端几何复用或直接按半径绘制）。 */
  unitPoints: Pt[];
  /** 标准 100×100 AvatarDefinition。 */
  definition: AvatarDefinition;
}

const TAU = Math.PI * 2;
const r2 = (n: number) => Math.round(n * 100) / 100;

function polygonToRoundedPath(pts: Pt[], cornerRadius: number): string {
  const n = pts.length;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const d1 = Math.min(cornerRadius, l1 * 0.42);
    const d2 = Math.min(cornerRadius, l2 * 0.42);
    const ax = curr.x + (v1x / l1) * d1;
    const ay = curr.y + (v1y / l1) * d1;
    const bx = curr.x + (v2x / l2) * d2;
    const by = curr.y + (v2y / l2) * d2;
    if (i === 0) parts.push(`M${r2(ax)} ${r2(ay)}`);
    else parts.push(`L${r2(ax)} ${r2(ay)}`);
    parts.push(`Q${r2(curr.x)} ${r2(curr.y)} ${r2(bx)} ${r2(by)}`);
  }
  parts.push('Z');
  return parts.join('');
}

function catmullRomPath(pts: Pt[], tension = 1): string {
  const n = pts.length;
  let d = `M${r2(pts[0].x)} ${r2(pts[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension;
    d += `C${r2(c1x)} ${r2(c1y)} ${r2(c2x)} ${r2(c2y)} ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return `${d}Z`;
}

function sampleCircleUnit(steps = 64): Pt[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * TAU;
    return { x: Math.cos(a), y: Math.sin(a) };
  });
}

function sampleSuperellipseUnit(n: number, rx = 1, ry = 1, steps = 64): Pt[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return {
      x: Math.sign(c) * Math.abs(c) ** (2 / n) * rx,
      y: Math.sign(s) * Math.abs(s) ** (2 / n) * ry,
    };
  });
}

function unitToPath(pts: Pt[], cx = 50, cy = 50, scale = 39): string {
  const scaled = pts.map((p) => ({ x: cx + p.x * scale, y: cy + p.y * scale }));
  return catmullRomPath(scaled, 0.9);
}

function normalizePoints(pts: Pt[]): Pt[] {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let maxR = 1e-6;
  for (const p of pts) maxR = Math.max(maxR, Math.abs(p.x - cx), Math.abs(p.y - cy));
  return pts.map((p) => ({ x: r2((p.x - cx) / maxR), y: r2((p.y - cy) / maxR) }));
}

const circlePts = sampleCircleUnit(48);
const squirclePts = sampleSuperellipseUnit(4.2, 1, 1, 48);

const hexVerts: Pt[] = Array.from({ length: 6 }, (_, i) => {
  const a = -Math.PI / 2 + (i * TAU) / 6;
  return { x: 50 + Math.cos(a) * 40, y: 50 + Math.sin(a) * 40 };
});

const cloudControlPts: Pt[] = [
  { x: 24, y: 76 },
  { x: 11, y: 66 },
  { x: 12, y: 47 },
  { x: 24, y: 37 },
  { x: 32, y: 21 },
  { x: 50, y: 17 },
  { x: 68, y: 22 },
  { x: 76, y: 37 },
  { x: 88, y: 47 },
  { x: 89, y: 66 },
  { x: 76, y: 76 },
  { x: 50, y: 78 },
];

const dropletPts: Pt[] = [
  { x: 50, y: 11 },
  { x: 68, y: 24 },
  { x: 84, y: 48 },
  { x: 86, y: 71 },
  { x: 72, y: 86 },
  { x: 50, y: 89 },
  { x: 28, y: 86 },
  { x: 14, y: 71 },
  { x: 16, y: 48 },
  { x: 32, y: 24 },
];

const starVerts: Pt[] = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * TAU) / 10;
  const r = i % 2 === 0 ? 41 : 27;
  return { x: 50 + Math.cos(a) * r, y: 51 + Math.sin(a) * r };
});

const blobControlPts: Pt[] = [
  { x: 50, y: 12 },
  { x: 72, y: 16 },
  { x: 85, y: 34 },
  { x: 87, y: 61 },
  { x: 74, y: 83 },
  { x: 50, y: 88 },
  { x: 26, y: 83 },
  { x: 13, y: 61 },
  { x: 15, y: 34 },
  { x: 28, y: 16 },
];

export const SHAPES: readonly CanonicalShape[] = [
  {
    id: 'circle',
    name: '圆盘 Circle',
    unitPoints: circlePts,
    definition: {
      version: 1,
      id: 'shape-circle',
      name: 'Circle',
      body: { path: 'M11 50A39 39 0 1 1 89 50A39 39 0 1 1 11 50Z' },
      eyes: { x: 50, y: 48, spacing: 18, scale: 1.15 },
    },
  },
  {
    id: 'sphere',
    name: '球形 Sphere',
    unitPoints: circlePts,
    definition: {
      version: 1,
      id: 'shape-sphere',
      name: 'Sphere',
      body: { path: 'M11 50A39 39 0 1 1 89 50A39 39 0 1 1 11 50Z' },
      eyes: { x: 50, y: 48, spacing: 18, scale: 1.12 },
    },
  },
  {
    id: 'squircle',
    name: '超椭圆 Squircle',
    unitPoints: squirclePts,
    definition: {
      version: 1,
      id: 'shape-squircle',
      name: 'Squircle',
      body: { path: unitToPath(squirclePts, 50, 50, 38) },
      eyes: { x: 50, y: 48, spacing: 18, scale: 1.15 },
    },
  },
  {
    id: 'hexagon',
    name: '六边形 Hexagon',
    unitPoints: normalizePoints(hexVerts),
    definition: {
      version: 1,
      id: 'shape-hexagon',
      name: 'Hexagon',
      body: { path: polygonToRoundedPath(hexVerts, 11) },
      eyes: { x: 50, y: 49, spacing: 17, scale: 1.1 },
    },
  },
  {
    id: 'cloud',
    name: '软云 Cloud',
    unitPoints: normalizePoints(cloudControlPts),
    definition: {
      version: 1,
      id: 'shape-cloud',
      name: 'Cloud',
      body: { path: catmullRomPath(cloudControlPts, 0.95) },
      eyes: { x: 50, y: 52, spacing: 17, scale: 1.05 },
    },
  },
  {
    id: 'capsule',
    name: '胶囊 Capsule',
    unitPoints: sampleSuperellipseUnit(3.0, 1, 0.82, 48),
    definition: {
      version: 1,
      id: 'shape-capsule',
      name: 'Capsule',
      body: { path: 'M43 17H57A33 33 0 0 1 90 50A33 33 0 0 1 57 83H43A33 33 0 0 1 10 50A33 33 0 0 1 43 17Z' },
      eyes: { x: 50, y: 49, spacing: 18, scale: 1.1 },
    },
  },
  {
    id: 'droplet',
    name: '水滴 Droplet',
    unitPoints: normalizePoints(dropletPts),
    definition: {
      version: 1,
      id: 'shape-droplet',
      name: 'Droplet',
      body: { path: catmullRomPath(dropletPts, 0.95) },
      eyes: { x: 50, y: 57, spacing: 16, scale: 1.08 },
    },
  },
  {
    id: 'star',
    name: '软星 Star',
    unitPoints: normalizePoints(starVerts),
    definition: {
      version: 1,
      id: 'shape-star',
      name: 'Star',
      body: { path: polygonToRoundedPath(starVerts, 9) },
      eyes: { x: 50, y: 51, spacing: 15, scale: 0.96 },
    },
  },
  {
    id: 'blob',
    name: '果冻 Blob',
    unitPoints: normalizePoints(blobControlPts),
    definition: {
      version: 1,
      id: 'shape-blob',
      name: 'Blob',
      body: { path: catmullRomPath(blobControlPts, 1) },
      eyes: { x: 50, y: 50, spacing: 18, scale: 1.15 },
    },
  },
] as const;

export function findShape(id: string | undefined): CanonicalShape | undefined {
  if (!id) return undefined;
  const key = id.trim().toLowerCase().replace(/^shape-/, '');
  return SHAPES.find((s) => s.id === key);
}
