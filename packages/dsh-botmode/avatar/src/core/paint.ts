/**
 * canvas 渲染器：把一帧扁平数据画到一张 canvas 上，所以无论展示多少截面，
 * 一个头像只占一个合成层和一张小位图。
 *
 * 位图只覆盖这一帧真正画到的范围（再加一点余量），并随尺寸与像素比变化重建；
 * 一个宽度变化频繁的头像不会因为“预留所有可能视角”而付出三倍显存。
 */
import type { Frame, FrameShape, Matrix } from './frame.ts';
import { avatarExtent } from './frame.ts';
import type { AvatarDefinition } from './types.ts';
import type { Box } from './fx.ts';
import { applyClayToCanvas, createClayScratch, type ClayScratch } from '../bot/clay.ts';

/** 位图布局时给动态余量留的边，viewBox 单位。 */
export const FIT_SLACK = 8;
/** 位图边缘保留的抗锯齿余量。 */
export const FIT_PAD = 1;

export interface Square {
  x: number;
  y: number;
  size: number;
}

export interface Bounds2 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EMPTY: Bounds2 = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

interface Section {
  rule: CanvasFillRule;
  path: Path2D;
}

const sections = new Map<string, Section>();

/** 每帧的变换（已含 root 动作）与它画到的范围（以及身体切片的实际投影包围盒）。 */
export function placement(frame: Frame): { matrices: Matrix[]; bounds: Bounds2; sliceBounds: Bounds2 } {
  const boxes = new Map<string, Box>();
  for (const p of frame.paths) boxes.set(p.id, p.box);
  for (const s of frame.shapes) if (s.kind === 'mark') boxes.set(s.id, s.box);
  const [ra, rb, rc, rd, re, rf] = frame.root;
  const bounds: Bounds2 = { ...EMPTY };
  const sliceBounds: Bounds2 = { ...EMPTY };
  const add = (target: Bounds2, m: Matrix, x: number, y: number) => {
    const X = m[0] * x + m[2] * y + m[4];
    const Y = m[1] * x + m[3] * y + m[5];
    if (X < target.x0) target.x0 = X;
    if (X > target.x1) target.x1 = X;
    if (Y < target.y0) target.y0 = Y;
    if (Y > target.y1) target.y1 = Y;
  };
  const matrices = frame.shapes.map((shape) => {
    const [a, b, c, d, e, f] = shape.matrix;
    const m: Matrix = [ra * a + rc * b, rb * a + rd * b, ra * c + rc * d, rb * c + rd * d, ra * e + rc * f + re, rb * e + rd * f + rf];
    const box =
      shape.kind === 'slice'
        ? boxes.get(shape.path)
        : shape.kind === 'mark'
          ? boxes.get(shape.id)
          : shape.kind === 'eye'
            ? eyeBox(shape)
            : shape.box;
    if (box) {
      add(bounds, m, box.x, box.y);
      add(bounds, m, box.x + box.w, box.y);
      add(bounds, m, box.x, box.y + box.h);
      add(bounds, m, box.x + box.w, box.y + box.h);
      if (shape.kind === 'slice') {
        add(sliceBounds, m, box.x, box.y);
        add(sliceBounds, m, box.x + box.w, box.y);
        add(sliceBounds, m, box.x, box.y + box.h);
        add(sliceBounds, m, box.x + box.w, box.y + box.h);
      }
    }
    return m;
  });
  return { matrices, bounds, sliceBounds };
}

/** 一条路径（绝对坐标）的包围盒；点成对读取，描边宽度另外加。 */
function boxOfPath(d: string, pad = 0): Box {
  const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k + 1 < nums.length; k += 2) {
    const x = nums[k];
    const y = nums[k + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

function eyeBox(shape: Extract<FrameShape, { kind: 'eye' }>): Box {
  const mark = shape.mark;
  if (mark.shape === 'pill') return { x: mark.x, y: mark.y, w: mark.width, h: mark.height };
  return boxOfPath(mark.d, mark.shape === 'arc' ? mark.strokeWidth / 2 : 0);
}

/** 布局用的方形：`prev` 还能装下 `b` 就用它，否则长到装下并加余量；不超过 `cap`。 */
export function fitSquare(prev: Square | null, b: Bounds2, cap: Square): Square {
  if (!(b.x0 <= b.x1 && b.y0 <= b.y1)) return prev ?? cap;
  if (prev && b.x0 - FIT_PAD >= prev.x && b.y0 - FIT_PAD >= prev.y && b.x1 + FIT_PAD <= prev.x + prev.size && b.y1 + FIT_PAD <= prev.y + prev.size) {
    return prev;
  }
  let x0 = b.x0 - FIT_SLACK;
  let y0 = b.y0 - FIT_SLACK;
  let x1 = b.x1 + FIT_SLACK;
  let y1 = b.y1 + FIT_SLACK;
  if (prev) {
    x0 = Math.min(x0, prev.x);
    y0 = Math.min(y0, prev.y);
    x1 = Math.max(x1, prev.x + prev.size);
    y1 = Math.max(y1, prev.y + prev.size);
  }
  const size = Math.max(x1 - x0, y1 - y0);
  const inCap = b.x0 >= cap.x && b.y0 >= cap.y && b.x1 <= cap.x + cap.size && b.y1 <= cap.y + cap.size;
  if (size >= cap.size && inCap) return cap;
  return { x: (x0 + x1 - size) / 2, y: (y0 + y1 - size) / 2, size };
}

export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  cap: Square;
  fit: Square | null;
  layout: string;
  left: number;
  top: number;
  clay: ClayScratch | null;
}

export function mountCanvas(canvas: HTMLCanvasElement, definition: AvatarDefinition, depth?: number): Surface {
  canvas.setAttribute('aria-hidden', 'true');
  return {
    canvas,
    ctx: canvas.getContext('2d'),
    cap: avatarExtent(definition, depth),
    fit: null,
    layout: '',
    left: 0,
    top: 0,
    clay: createClayScratch(),
  };
}

/** 切换形象或深度时复用已有 Surface 与离屏黏土画布，避免重建 DOM Canvas 引起首帧掉帧。 */
export function remountCanvas(surface: Surface, definition: AvatarDefinition, depth?: number): Surface {
  surface.cap = avatarExtent(definition, depth);
  // 若当前已分配的位图能继续装下新轮廓，保留 surface.fit，避免重新分配 GPU 画布纹理。
  if (surface.fit) {
    const c = surface.cap;
    const f = surface.fit;
    if (f.x < c.x - 16 || f.y < c.y - 16 || f.size > c.size * 1.45) {
      surface.fit = null;
    }
  }
  return surface;
}

/** 画一帧，宽度 `size` CSS px。 */
export function paintFrame(surface: Surface, frame: Frame, size: number): void {
  const { canvas, ctx } = surface;
  if (!ctx || size <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const scale = (size / 100) * dpr;
  const layout = `${size}|${dpr}`;
  if (sections.size > 4096) sections.clear();
  for (const { id, d, evenOdd } of frame.paths) {
    if (!sections.has(id)) sections.set(id, { rule: evenOdd ? 'evenodd' : 'nonzero', path: new Path2D(d) });
  }
  const { matrices, bounds, sliceBounds } = placement(frame);
  const fit = fitSquare(surface.layout === layout ? surface.fit : null, bounds, surface.cap);
  if (surface.layout === layout && fit === surface.fit) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    // 整设备像素，位图永不重采样。设置宽高本身会清空画布。
    surface.layout = layout;
    surface.fit = fit;
    surface.left = Math.floor(fit.x * scale);
    surface.top = Math.floor(fit.y * scale);
    const bitmap = Math.ceil(fit.size * scale) + 1;
    canvas.width = canvas.height = bitmap;
    canvas.style.left = `${surface.left / dpr}px`;
    canvas.style.top = `${surface.top / dpr}px`;
    canvas.style.width = canvas.style.height = `${bitmap / dpr}px`;
  }

  const clay = frame.clay ? surface.clay : null;
  let clayReady = false;
  let baseBodyDrawn = false;
  if (clay && sliceBounds.x0 <= sliceBounds.x1) {
    if (clay.body.width !== canvas.width || clay.body.height !== canvas.height) {
      clay.body.width = canvas.width;
      clay.body.height = canvas.height;
    } else {
      clay.bodyCtx.setTransform(1, 0, 0, 1, 0, 0);
      clay.bodyCtx.clearRect(0, 0, clay.body.width, clay.body.height);
    }
    // 一次性把全部身体切片合集画到 clay.body，确保侧面旋转且与眼睛穿插时仍保持无缝的整体黏土质感。
    for (let i = 0; i < frame.shapes.length; i++) {
      const shape = frame.shapes[i];
      if (shape.kind !== 'slice') continue;
      const section = sections.get(shape.path);
      if (!section) continue;
      const m = matrices[i];
      clay.bodyCtx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4] - surface.left, scale * m[5] - surface.top);
      clay.bodyCtx.fillStyle = frame.color;
      clay.bodyCtx.fill(section.path, section.rule);
      clayReady = true;
    }
    if (clayReady) {
      const cx = ((sliceBounds.x0 + sliceBounds.x1) * 0.5) * scale - surface.left;
      const cy = ((sliceBounds.y0 + sliceBounds.y1) * 0.5) * scale - surface.top;
      const rx = ((sliceBounds.x1 - sliceBounds.x0) * 0.5) * scale;
      const ry = ((sliceBounds.y1 - sliceBounds.y0) * 0.5) * scale;
      applyClayToCanvas(clay, canvas.width, canvas.height, cx, cy, rx, ry, frame.highlight, frame.shadow);
    }
  }

  ctx.lineCap = 'round';
  let i = 0;
  while (i < frame.shapes.length) {
    const shape = frame.shapes[i];
    if (shape.kind === 'slice') {
      if (clay && clayReady) {
        if (!baseBodyDrawn) {
          baseBodyDrawn = true;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(clay.body, 0, 0);
          while (i < frame.shapes.length && frame.shapes[i].kind === 'slice') i++;
          continue;
        }
        // 侧转时如果眼/高光穿插在前后切片之间，把在眼之后的这段切片从已着色 clay.body 中扣出覆盖，既遮挡后眼又无缝隙。
        if (clay.front.width !== canvas.width || clay.front.height !== canvas.height) {
          clay.front.width = canvas.width;
          clay.front.height = canvas.height;
        } else {
          clay.frontCtx.setTransform(1, 0, 0, 1, 0, 0);
          clay.frontCtx.clearRect(0, 0, clay.front.width, clay.front.height);
        }
        clay.frontCtx.globalCompositeOperation = 'source-over';
        clay.frontCtx.fillStyle = '#000';
        while (i < frame.shapes.length && frame.shapes[i].kind === 'slice') {
          const s = frame.shapes[i] as Extract<FrameShape, { kind: 'slice' }>;
          const section = sections.get(s.path);
          if (section) {
            const m = matrices[i];
            clay.frontCtx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4] - surface.left, scale * m[5] - surface.top);
            clay.frontCtx.fill(section.path, section.rule);
          }
          i++;
        }
        clay.frontCtx.setTransform(1, 0, 0, 1, 0, 0);
        clay.frontCtx.globalCompositeOperation = 'source-in';
        clay.frontCtx.drawImage(clay.body, 0, 0);
        clay.frontCtx.globalCompositeOperation = 'source-over';
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(clay.front, 0, 0);
        continue;
      }
      const section = sections.get(shape.path);
      if (section) {
        const m = matrices[i];
        ctx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4] - surface.left, scale * m[5] - surface.top);
        ctx.fillStyle = frame.color;
        ctx.fill(section.path, section.rule);
      }
      i++;
      continue;
    }

    const m = matrices[i];
    ctx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4] - surface.left, scale * m[5] - surface.top);
    if (shape.kind === 'eye') {
      ctx.fillStyle = frame.ink;
      ctx.strokeStyle = frame.ink;
      paintEye(ctx, shape.mark);
    } else if (shape.kind === 'ribbon') {
      const g = shape.gradient;
      const paint = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
      g.stops.forEach((c, k) => paint.addColorStop(k / Math.max(1, g.stops.length - 1), c));
      ctx.fillStyle = paint;
      ctx.fill(new Path2D(shape.d));
    } else if (shape.kind === 'particle') {
      let section = sections.get(shape.d);
      if (!section) {
        section = { rule: 'nonzero', path: new Path2D(shape.d) };
        sections.set(shape.d, section);
      }
      ctx.fillStyle = shape.fill;
      ctx.fill(section.path, section.rule);
    } else {
      const section = sections.get(shape.id);
      if (section) {
        ctx.fillStyle = frame.color;
        ctx.fill(section.path, section.rule);
      }
    }
    i++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function paintEye(ctx: CanvasRenderingContext2D, mark: Extract<FrameShape, { kind: 'eye' }>['mark']): void {
  if (mark.shape === 'pill') {
    const r = Math.min(mark.radius, mark.width / 2, mark.height / 2);
    ctx.beginPath();
    ctx.roundRect(mark.x, mark.y, mark.width, mark.height, r);
    ctx.fill();
  } else if (mark.shape === 'arc') {
    ctx.lineWidth = mark.strokeWidth;
    ctx.beginPath();
    const path = new Path2D(mark.d);
    ctx.stroke(path);
  } else {
    ctx.fill(new Path2D(mark.d));
  }
}