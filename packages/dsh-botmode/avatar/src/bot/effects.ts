/**
 * 外围独立图层动效：轨道粒子（Orbit）与通知角标（红/蓝点 Badge）。
 * 输出 viewBox 单位下的纯几何数据，由 frame.ts 统一参与前后景深度排序。
 */
import type { AvatarState, BadgeKind } from '../core/types.ts';
import type { Bounds } from '../core/path.ts';
import { noise } from '../core/pose.ts';
import type { Box, Rim } from '../core/fx.ts';

const TAU = Math.PI * 2;
const f = (n: number) => Math.round(n * 100) / 100;

function circlePath(r: number): string {
  return `M${f(-r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(-r)} 0Z`;
}

export interface OrbitPiece {
  d: string;
  box: Box;
  matrix: [number, number, number, number, number, number];
  fill: string;
  front: boolean;
}

/**
 * 环绕躯干运行的轨道粒子：两条倾斜椭圆轨道，支持前后景遮挡排序。
 */
export function orbitPieces(
  rim: Rim,
  seed: number,
  time: number,
  state: AvatarState,
  palette: readonly string[],
  reducedMotion: boolean,
): OrbitPiece[] {
  const count = 6;
  const speed = state === 'working' ? 1.55 : state === 'thinking' ? 0.95 : state === 'alert' ? 1.8 : 0.65;
  const t = reducedMotion ? 0 : time * speed;
  const out: OrbitPiece[] = [];
  const baseRadius = rim.max + 5.5;

  for (let i = 0; i < count; i++) {
    const track = i % 2;
    const tilt = (track === 0 ? 0.34 : -0.42) + (noise(seed, 810 + track) - 0.5) * 0.12;
    const roll = (track === 0 ? -0.32 : 0.45) + (noise(seed, 820 + track) - 0.5) * 0.14;
    const radius = baseRadius + (track === 0 ? 0 : 2.8) + noise(seed, 830 + i) * 2.2;
    const phase = (i / count) * TAU + noise(seed, 840 + i) * 0.8;
    const theta = phase + t * (track === 0 ? 1 : -0.82);

    const x3 = radius * Math.cos(theta);
    const y3 = radius * Math.sin(theta) * Math.cos(tilt);
    const z3 = radius * Math.sin(theta) * Math.sin(tilt);

    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);
    const x = rim.cx + x3 * cosR - y3 * sinR;
    const y = rim.cy + y3 * cosR + x3 * sinR;

    const depthNorm = z3 / Math.max(1, radius);
    const r0 = 1.45 + (i % 3) * 0.48;
    const scale = 0.8 + 0.35 * depthNorm + (reducedMotion ? 0 : 0.08 * Math.sin(t * 2.2 + i));
    const fill = palette[i % palette.length];

    out.push({
      d: circlePath(r0),
      box: { x: -r0, y: -r0, w: 2 * r0, h: 2 * r0 },
      matrix: [scale, 0, 0, scale, x, y],
      fill,
      front: z3 >= 0,
    });
  }
  return out;
}

export interface BadgePiece {
  x: number;
  y: number;
  radius: number;
  fill: string;
  ringFill: string;
  pulse: number;
}

/**
 * 通知红/蓝点角标：锚定在躯干右上角外缘，附带浅色外环和轻微呼吸脉冲。
 */
export function badgePiece(b: Bounds, badge: BadgeKind | undefined, time: number, reducedMotion: boolean): BadgePiece | null {
  if (!badge || badge === 'none') return null;
  const x = Math.min(91, b.maxX - 3);
  const y = Math.max(9, b.minY + 3);
  const pulse = reducedMotion ? 1 : 1 + 0.09 * Math.sin(time * 4.2);
  return {
    x,
    y,
    radius: 6.2,
    fill: badge === 'red' ? '#ef4444' : '#3b82f6',
    ringFill: '#fffcf7',
    pulse,
  };
}
