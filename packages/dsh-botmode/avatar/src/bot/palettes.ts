/**
 * 12 套黏土主题色板（Base + Highlight + Inner Shadow + Eye Ink + Accent）。
 * 也支持从任意 #rgb/#rrggbb 主色通过 OKLCH 自动派生配套的高光、内阴影和对比墨色。
 */
import { autoEyeColor, oklch, parseHex, toHex, toOklch, type Rgb } from '../core/color.ts';

export interface BotPalette {
  id: string;
  name: string;
  /** 躯干底层主色。 */
  base: string;
  /** 左上角高光色（径向渐变起始）。 */
  highlight: string;
  /** 右下角内阴影色。 */
  shadow: string;
  /** 眼睛颜色（与主色高对比）。 */
  eye: string;
  /** 轨道粒子 / 强调色。 */
  accent: string;
}

export const PALETTES: readonly BotPalette[] = [
  { id: 'coral', name: '赤陶橙', base: '#ff6a1a', highlight: '#ffd4b8', shadow: '#8c2800', eye: '#141622', accent: '#ffaa66' },
  { id: 'cobalt', name: '钴蓝', base: '#2563eb', highlight: '#bfdbfe', shadow: '#132a73', eye: '#fafaff', accent: '#60a5fa' },
  { id: 'emerald', name: '薄荷翠', base: '#10b981', highlight: '#ccfbf1', shadow: '#064e3b', eye: '#141622', accent: '#5eead4' },
  { id: 'amber', name: '琥珀金', base: '#f59e0b', highlight: '#fef3c7', shadow: '#78350f', eye: '#141622', accent: '#fcd34d' },
  { id: 'crimson', name: '绯红', base: '#ef4444', highlight: '#fecaca', shadow: '#7f1d1d', eye: '#fafaff', accent: '#fca5a5' },
  { id: 'violet', name: '暮紫', base: '#8b5cf6', highlight: '#ede9fe', shadow: '#4c1d95', eye: '#fafaff', accent: '#c4b5fd' },
  { id: 'teal', name: '深海青', base: '#0d9488', highlight: '#ccfbf1', shadow: '#11423e', eye: '#fafaff', accent: '#2dd4bf' },
  { id: 'rose', name: '蔷薇粉', base: '#ec4899', highlight: '#fce7f3', shadow: '#831843', eye: '#fafaff', accent: '#f9a8d4' },
  { id: 'indigo', name: '靛青', base: '#4f46e5', highlight: '#e0e7ff', shadow: '#1e1b4b', eye: '#fafaff', accent: '#818cf8' },
  { id: 'lime', name: '青柠', base: '#84cc16', highlight: '#f7fee7', shadow: '#365314', eye: '#141622', accent: '#bef264' },
  { id: 'obsidian', name: '黑曜石', base: '#27272a', highlight: '#71717a', shadow: '#09090b', eye: '#fafaff', accent: '#a1a1aa' },
  { id: 'pearl', name: '陶瓷白', base: '#ede9e2', highlight: '#ffffff', shadow: '#9c9284', eye: '#141622', accent: '#ff6a1a' },
] as const;

export const DEFAULT_PALETTE = PALETTES[0];

/** 按 ID 或 hex 匹配预设色板。 */
export function findPalette(idOrColor: string | undefined): BotPalette | undefined {
  if (!idOrColor) return undefined;
  const key = idOrColor.trim().toLowerCase();
  return PALETTES.find((p) => p.id === key || p.base.toLowerCase() === key);
}

/** 从任意合法主色通过 OKLCH 空间自动派生黏土高光色、内阴影色和眼睛颜色。 */
export function derivePalette(baseColor: string, id = 'custom', name = 'Custom'): BotPalette {
  const preset = findPalette(baseColor);
  if (preset) return preset;
  const rgb: Rgb = parseHex(baseColor) ?? (parseHex(DEFAULT_PALETTE.base) as Rgb);
  const base = toHex(rgb);
  const [L, C, H] = toOklch(rgb);
  const hiL = Math.min(0.97, L + (1 - L) * 0.58);
  const hiC = C * 0.45;
  const shL = Math.max(0.16, L * 0.46);
  const shC = Math.min(0.24, C * 0.95);
  const highlight = toHex(oklch(hiL, hiC, (H + 8) % 360));
  const shadow = toHex(oklch(shL, shC, (H - 12 + 360) % 360));
  const accent = toHex(oklch(Math.min(0.84, L + 0.14), Math.max(0.1, C * 0.85), (H + 16) % 360));
  const eye = toHex(autoEyeColor(rgb));
  return { id, name, base, highlight, shadow, eye, accent };
}
