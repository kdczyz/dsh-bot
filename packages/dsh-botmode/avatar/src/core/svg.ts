/**
 * 静帧 SVG：把一帧扁平数据序列化成独立文件，适合缩略图、导出与分享卡。
 * 只由数字和渲染器自己的标记构成。
 */
import { computeFrame, type EyeMark, type Frame, type FramePath } from './frame.ts';
import type { AvatarDefinition, RenderOptions } from './types.ts';
import { svgClayFilter } from '../bot/clay.ts';

const f = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function matrix(m: Frame['root']): string {
  return `matrix(${m.map((v, i) => (i < 4 ? String(Math.round(v * 10000) / 10000) : f(v))).join(' ')})`;
}

function eyeSvg(mark: EyeMark, ink: string): string {
  if (mark.shape === 'path') return `<path d="${mark.d}" fill="${ink}"/>`;
  if (mark.shape === 'arc') return `<path d="${mark.d}" fill="none" stroke="${ink}" stroke-width="${f(mark.strokeWidth)}" stroke-linecap="round"/>`;
  return `<rect x="${f(mark.x)}" y="${f(mark.y)}" width="${f(mark.width)}" height="${f(mark.height)}" rx="${f(mark.radius)}" fill="${ink}"/>`;
}

function gradientSvg(id: string, g: { x1: number; y1: number; x2: number; y2: number; stops: string[] }): string {
  const stops = g.stops.map((c, i) => `<stop offset="${f(i / Math.max(1, g.stops.length - 1))}" stop-color="${c}"/>`).join('');
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(g.x1)}" y1="${f(g.y1)}" x2="${f(g.x2)}" y2="${f(g.y2)}">${stops}</linearGradient>`;
}

function pathDefs(paths: FramePath[]): string {
  return paths.map((p) => `<path id="${p.id}" d="${p.d}"${p.evenOdd ? ' fill-rule="evenodd"' : ''}/>`).join('');
}

/** 渲染一条定义为独立 SVG 字符串。定义非法时抛错。 */
export function renderSvg(definition: AvatarDefinition, options: RenderOptions = {}): string {
  const frame = computeFrame(definition, options);
  const gradients = new Map<string, string>();
  const hasSlices = frame.shapes.some((s) => s.kind === 'slice');
  const useClay = frame.clay && hasSlices;
  const clayFilterId = useClay ? `clay-${frame.color.slice(1)}` : '';

  const chunks: string[] = [];
  let inSliceGroup = false;
  const closeSliceGroup = () => {
    if (inSliceGroup) {
      chunks.push('</g>');
      inSliceGroup = false;
    }
  };

  for (const s of frame.shapes) {
    if (s.kind === 'slice') {
      if (useClay && !inSliceGroup) {
        chunks.push(`<g filter="url(#${clayFilterId})">`);
        inSliceGroup = true;
      }
      chunks.push(`<use href="#${s.path}" transform="${matrix(s.matrix)}"/>`);
      continue;
    }
    closeSliceGroup();
    if (s.kind === 'mark') chunks.push(`<use href="#${s.id}" transform="${matrix(s.matrix)}"/>`);
    else if (s.kind === 'eye') chunks.push(`<g transform="${matrix(s.matrix)}">${eyeSvg(s.mark, frame.ink)}</g>`);
    else if (s.kind === 'particle') chunks.push(`<g transform="${matrix(s.matrix)}"><path d="${s.d}" fill="${s.fill}"/></g>`);
    else {
      let id = gradients.get(s.key);
      if (!id) {
        id = `g-${s.key.replace(/[^a-z0-9-]/gi, '')}`;
        gradients.set(s.key, id);
      }
      chunks.push(`<g transform="${matrix(s.matrix)}">${gradientSvg(id, s.gradient)}<path d="${s.d}" fill="url(#${id})"/></g>`);
    }
  }
  closeSliceGroup();

  const body = chunks.join('');
  const size = Number.isFinite(options.size) && (options.size as number) > 0 ? Math.min(4096, Math.max(8, options.size as number)) : null;
  const dims = size ? ` width="${f(size)}" height="${f(size)}"` : '';
  const label = esc(frame.name);
  const filterDef = useClay ? svgClayFilter(clayFilterId, frame.highlight, frame.shadow) : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dims} role="img" aria-label="${label}" overflow="visible">` +
    `<title>${label}</title>` +
    `<defs>${filterDef}${pathDefs(frame.paths)}</defs>` +
    `<g transform="${matrix(frame.root)}" fill="${frame.color}">${body}</g>` +
    `</svg>`
  );
}

/** 还没算体积时的轻量占位（缩略图列表首屏用）：真实渲染会替换它。 */
export function placeholderSvg(definition: AvatarDefinition, size = 64): string {
  const label = esc(definition.name);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="${label}">` +
    `<path d="${definition.body.path}" fill="#ff6a1a" fill-rule="nonzero"/>` +
    `</svg>`
  );
}