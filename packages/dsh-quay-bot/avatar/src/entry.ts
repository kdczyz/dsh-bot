/**
 * Browser & catalog entrypoint for the embedded Image-bot (Avatar Forge) module.
 *
 * Exposes the full 19-avatar catalog (10 gallery + 9 canonical shapes, matching
 * `public-bot`'s `BotAvatarCatalog`), 12 clay palettes, `<grok-bot>` custom element,
 * `GrokBot` controller, and static SVG rendering helpers on `window.__DSH_AVATAR_ENGINE__`.
 */
import droidJson from '../gallery/droid.json';
import ghostJson from '../gallery/ghost.json';
import grokPodJson from '../gallery/grok-pod.json';
import guardianJson from '../gallery/guardian.json';
import mechaJson from '../gallery/mecha.json';
import mochiJson from '../gallery/mochi.json';
import nekoJson from '../gallery/neko.json';
import orbiterJson from '../gallery/orbiter.json';
import relayJson from '../gallery/relay.json';
import sparkJson from '../gallery/spark.json';

import {
  DEFAULT_PALETTE,
  EXPRESSIONS,
  GrokBot,
  GrokBotElement,
  PALETTES,
  SHAPES,
  derivePalette,
  findPalette,
  findShape,
  registerGrokBot,
} from './bot/index.ts';
import {
  placeholderSvg,
  renderSvg,
  validateAvatar,
} from './core/index.ts';
import type { AvatarDefinition, AvatarMood, AvatarState, BadgeKind, RenderOptions } from './core/types.ts';

export interface BotAvatarPrefs {
  avatarId?: string;
  customJson?: string;
  color?: string;
  eyeColor?: string;
  material?: 'flat' | 'fluffy' | string;
  clay?: boolean;
  yaw?: number;
  pitch?: number;
  orbit?: boolean;
  badge?: boolean | BadgeKind;
  depth?: number;
  followPointer?: boolean;
}

const RAW_GALLERY: unknown[] = [
  droidJson,
  ghostJson,
  grokPodJson,
  guardianJson,
  mechaJson,
  mochiJson,
  nekoJson,
  orbiterJson,
  relayJson,
  sparkJson,
];

export const GALLERY: readonly AvatarDefinition[] = RAW_GALLERY
  .map((item) => validateAvatar(item))
  .filter((res): res is { ok: true; value: AvatarDefinition } => res.ok)
  .map((res) => res.value);

export const ALL_AVATARS: readonly AvatarDefinition[] = [
  ...GALLERY,
  ...SHAPES.map((shape) => shape.definition),
].sort((a, b) => a.id.localeCompare(b.id));

const AVATAR_MAP = new Map<string, AvatarDefinition>();
for (const def of ALL_AVATARS) {
  AVATAR_MAP.set(def.id, def);
}

export const DEFAULT_AVATAR_ID = 'mochi';
export const DEFAULT_AVATAR_COLOR = '#ff8a1f';
export const DEFAULT_AVATAR_EYE_COLOR = '#1b1b1b';

export function findDefinition(id: string | undefined): AvatarDefinition | undefined {
  if (!id) return undefined;
  const key = id.trim().toLowerCase();
  return AVATAR_MAP.get(key)
    ?? AVATAR_MAP.get(`shape-${key}`)
    ?? findShape(key)?.definition;
}

export function resolveDefinition(avatar?: BotAvatarPrefs | null): AvatarDefinition {
  if (avatar && typeof avatar.customJson === 'string' && avatar.customJson.trim() !== '') {
    try {
      const parsed = JSON.parse(avatar.customJson);
      const checked = validateAvatar(parsed);
      if (checked.ok) return checked.value;
    } catch {
      // Fall back to built-in definition below.
    }
  }
  return findDefinition(avatar?.avatarId)
    ?? AVATAR_MAP.get(DEFAULT_AVATAR_ID)
    ?? ALL_AVATARS[0];
}

export function normalizeBadge(badge: boolean | BadgeKind | undefined): BadgeKind {
  if (badge === 'red' || badge === 'blue') return badge;
  if (badge === true) return 'red';
  return 'none';
}

export function renderAvatarSvg(
  avatar?: BotAvatarPrefs | null,
  overrides: {
    size?: number;
    state?: AvatarState;
    mood?: AvatarMood;
    reducedMotion?: boolean;
    time?: number;
  } = {},
): string {
  const def = resolveDefinition(avatar);
  const color = typeof avatar?.color === 'string' && avatar.color.trim() !== ''
    ? avatar.color.trim()
    : DEFAULT_AVATAR_COLOR;
  const pal = derivePalette(color);
  const eyeColor = typeof avatar?.eyeColor === 'string' && avatar.eyeColor.trim() !== ''
    ? avatar.eyeColor.trim()
    : pal.eye;
  const depth = typeof avatar?.depth === 'number' && Number.isFinite(avatar.depth)
    ? Math.max(0, Math.min(14, avatar.depth))
    : 6;
  const yaw = typeof avatar?.yaw === 'number' && Number.isFinite(avatar.yaw)
    ? Math.max(-0.9, Math.min(0.9, avatar.yaw))
    : 0;
  const pitch = typeof avatar?.pitch === 'number' && Number.isFinite(avatar.pitch)
    ? Math.max(-0.6, Math.min(0.6, avatar.pitch))
    : 0;
  const opts: RenderOptions = {
    color: pal.base,
    highlightColor: pal.highlight,
    shadowColor: pal.shadow,
    eyeColor,
    size: overrides.size ?? 64,
    depth,
    clay: avatar?.clay !== false,
    view: { yaw, pitch },
    orbit: avatar?.orbit === true,
    badge: normalizeBadge(avatar?.badge),
    state: overrides.state ?? 'idle',
    mood: overrides.mood ?? 'neutral',
    time: overrides.time ?? 0,
    reducedMotion: overrides.reducedMotion !== false,
  };
  return renderSvg(def, opts);
}

export function mountBotAvatar(
  container: HTMLElement,
  avatar?: BotAvatarPrefs | null,
  extra: {
    size?: number;
    state?: AvatarState;
    mood?: AvatarMood | 'auto' | null;
    interactive?: boolean;
    sleepWhenIdle?: boolean;
    reducedMotion?: boolean;
    onFrame?: (info: { mood: AvatarMood; sleeping: boolean; visible: boolean; fps: number }) => void;
  } = {},
): GrokBot {
  const def = resolveDefinition(avatar);
  const color = typeof avatar?.color === 'string' && avatar.color.trim() !== ''
    ? avatar.color.trim()
    : DEFAULT_AVATAR_COLOR;
  const eyeColor = typeof avatar?.eyeColor === 'string' && avatar.eyeColor.trim() !== ''
    ? avatar.eyeColor.trim()
    : undefined;
  const depth = typeof avatar?.depth === 'number' && Number.isFinite(avatar.depth)
    ? Math.max(0, Math.min(14, avatar.depth))
    : 6;
  const yaw = typeof avatar?.yaw === 'number' && Number.isFinite(avatar.yaw)
    ? Math.max(-0.9, Math.min(0.9, avatar.yaw))
    : 0;
  const pitch = typeof avatar?.pitch === 'number' && Number.isFinite(avatar.pitch)
    ? Math.max(-0.6, Math.min(0.6, avatar.pitch))
    : 0;

  const bot = new GrokBot({
    container,
    definition: def,
    color,
    eyeColor,
    size: extra.size ?? 96,
    depth,
    clay: avatar?.clay !== false,
    state: extra.state ?? 'idle',
    mood: extra.mood ?? 'auto',
    orbit: avatar?.orbit === true,
    badge: normalizeBadge(avatar?.badge),
    followPointer: avatar?.followPointer !== false,
    interactive: extra.interactive !== false,
    sleepWhenIdle: extra.sleepWhenIdle ?? true,
    reducedMotion: extra.reducedMotion,
    onFrame: extra.onFrame,
  });
  if (yaw !== 0 || pitch !== 0) {
    bot.setView(yaw, pitch, true);
  }
  return bot;
}

export {
  DEFAULT_PALETTE,
  EXPRESSIONS,
  GrokBot,
  GrokBotElement,
  PALETTES,
  SHAPES,
  derivePalette,
  findPalette,
  findShape,
  placeholderSvg,
  registerGrokBot,
  renderSvg,
  validateAvatar,
};

export const ENGINE = {
  version: 1,
  ALL_AVATARS,
  GALLERY,
  SHAPES,
  PALETTES,
  DEFAULT_PALETTE,
  EXPRESSIONS,
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_EYE_COLOR,
  findDefinition,
  findShape,
  findPalette,
  derivePalette,
  resolveDefinition,
  normalizeBadge,
  validateAvatar,
  renderSvg,
  placeholderSvg,
  renderAvatarSvg,
  mountBotAvatar,
  GrokBot,
  GrokBotElement,
  registerGrokBot,
};

if (typeof window !== 'undefined') {
  registerGrokBot('grok-bot');
  (window as unknown as Record<string, unknown>).__DSH_AVATAR_ENGINE__ = ENGINE;
}
