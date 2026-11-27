/**
 * 确定性姿态模型。姿态是 (seed, time, state, mood, gaze, reducedMotion) 的纯函数：
 * 没有墙上时钟、没有 Math.random，因此任何一帧都能被精确复现（测试、SSR、拖动进度）。
 *
 * 状态（state）决定“在干什么”：空闲、思考、工作、等待、阻塞、完成。
 * 表情（mood）决定“看起来怎么样”：中性、开心、困倦、惊讶、好奇、不爽、爱心。
 * 两者正交：`sleepy` 的困倦可以叠在 `working` 的忙碌上。
 */
import type { AvatarMood, AvatarState, EyeLook, PoseLike, RenderOptions } from './types.ts';

export type { EyeLook } from './types.ts';

const REST_LOOK: EyeLook = { arc: 0, slit: 0, wide: 0, star: 0, tilt: 0, lid: 0, glint: 0.35 };

function look(patch: Partial<EyeLook>): EyeLook {
  return { ...REST_LOOK, ...patch };
}

/**
 * 每个表情的眼睛配方（15 种）。0.35 的默认高光是“活着”的最低成本：一点反光就够。
 */
const MOOD_LOOK: Record<AvatarMood, EyeLook> = {
  neutral: look({}),
  happy: look({ arc: 1, glint: 0.45 }),
  joy: look({ arc: 1, wide: 0.25, glint: 0.7 }),
  love: look({ star: 1, glint: 0.95 }),
  surprised: look({ wide: 1, glint: 0.9 }),
  curious: look({ wide: 0.35, tilt: 0.4, glint: 0.6 }),
  skeptical: look({ lid: 0.32, tilt: 0.22, glint: 0.4 }),
  sleepy: look({ lid: 0.55, glint: 0.12 }),
  bored: look({ lid: 0.36, slit: 0.25, glint: 0.15 }),
  sad: look({ lid: 0.3, tilt: 0.5, glint: 0.2 }),
  angry: look({ slit: 0.78, tilt: -0.8, glint: 0.1 }),
  focused: look({ slit: 0.42, wide: 0.1, glint: 0.5 }),
  confused: look({ wide: 0.2, tilt: 0.6, glint: 0.4 }),
  shy: look({ lid: 0.28, glint: 0.3 }),
  smug: look({ slit: 0.32, lid: 0.28, tilt: -0.25, glint: 0.45 }),
};

export function moodLook(mood: AvatarMood): EyeLook {
  return { ...(MOOD_LOOK[mood] ?? REST_LOOK) };
}

export type Pose = PoseLike;

export const STATES: readonly AvatarState[] = ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done', 'alert'];
export const MOODS: readonly AvatarMood[] = [
  'neutral',
  'happy',
  'joy',
  'love',
  'surprised',
  'curious',
  'skeptical',
  'sleepy',
  'bored',
  'sad',
  'angry',
  'focused',
  'confused',
  'shy',
  'smug',
];

export function isState(value: unknown): value is AvatarState {
  return STATES.includes(value as AvatarState);
}

export function isMood(value: unknown): value is AvatarMood {
  return MOODS.includes(value as AvatarMood);
}

export function resolveLook(given: { state?: unknown; mood?: unknown }): { state: AvatarState; mood: AvatarMood } {
  const m = given.mood === 'grumpy' ? 'angry' : given.mood;
  return {
    state: isState(given.state) ? given.state : 'idle',
    mood: isMood(m) ? m : 'neutral',
  };
}

/** 静止视角：稍微侧一点、稍微俯一点，体积感能被读到但不抢戏。 */
export const BASE_YAW = -0.3;
export const BASE_PITCH = 0.2;
/** 跟随注视目标时，身体最多转这么多（弧度），眼睛只用其中一部分。 */
export const LOOK_YAW = 0.32;
export const LOOK_PITCH = 0.18;
export const LOOK_EYES = 0.7;

const TAU = Math.PI * 2;

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 无状态 hash 噪声，[0, 1)。 */
export function noise(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * 眨眼闭合 0..1：默认每约 4.2 s 一个槽位，相位由 seed 决定，偶尔连眨两下。
 * 节奏可以按表情改：困的时候槽位更长、闭合更久；惊讶时更短促。
 */
export function blinkAt(seed: number, t: number, rhythm: { slot?: number; dur?: number; double?: number } = {}): number {
  const SLOT = rhythm.slot ?? 4.2;
  const DUR = rhythm.dur ?? 0.19;
  const doubleChance = rhythm.double ?? 0.8;
  const slot = Math.floor(t / SLOT);
  let closure = 0;
  for (const s of [slot - 1, slot]) {
    const start = s * SLOT + 0.5 + noise(seed, s * 2) * (SLOT - 1.3);
    const starts = noise(seed, s * 2 + 1) > doubleChance ? [start, start + DUR * 1.8] : [start];
    for (const b of starts) {
      const u = (t - b) / DUR;
      if (u > 0 && u < 1) closure = Math.max(closure, Math.sin(Math.PI * u));
    }
  }
  return closure;
}

/** 空闲时的视线游走：短暂停留之间快速扫视，多数时候居中。 */
export function wanderAt(seed: number, t: number, reach = 1): [number, number] {
  const SLOT = 1.9;
  const s = Math.floor(t / SLOT);
  const target = (k: number): [number, number] => {
    if (noise(seed, 1000 + k * 3) < 0.4) return [0, 0];
    return [(noise(seed, 1001 + k * 3) * 2 - 1) * 0.6 * reach, (noise(seed, 1002 + k * 3) * 2 - 1) * 0.35 * reach];
  };
  const a = target(s - 1);
  const b = target(s);
  const e = smooth((t - s * SLOT) / 0.16);
  return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
}

/** 工作时：视线在几件事之间快速跳动，多数时候朝下看。 */
function dartAt(seed: number, t: number): [number, number] {
  const SLOT = 0.62;
  const s = Math.floor(t / SLOT);
  const target = (k: number): [number, number] => [(noise(seed, 2001 + k * 3) * 2 - 1) * 0.8, 0.1 + noise(seed, 2002 + k * 3) * 0.5];
  const a = target(s - 1);
  const b = target(s);
  const e = smooth((t - s * SLOT) / 0.12);
  return [mix(a[0], b[0], e), mix(a[1], b[1], e)];
}

/**
 * 微表情：空闲时每隔几秒闪一下别的表情（惊讶一瞬、眯眼一瞬），
 * 让它看起来“在想事情”。返回一个 0..1 的权重与对应表情。
 */
export function microAt(seed: number, t: number): { mood: AvatarMood; weight: number } | null {
  const SLOT = 3.4;
  const s = Math.floor(t / SLOT);
  if (noise(seed, 3000 + s) > 0.42) return null;
  const start = s * SLOT + 0.6 + noise(seed, 3100 + s) * 2.1;
  const dur = 0.26 + noise(seed, 3200 + s) * 0.3;
  const u = (t - start) / dur;
  if (u <= 0 || u >= 1) return null;
  const pick: AvatarMood[] = ['surprised', 'curious', 'angry', 'sleepy', 'skeptical', 'shy'];
  const mood = pick[Math.floor(noise(seed, 3300 + s) * pick.length) % pick.length];
  return { mood, weight: Math.sin(Math.PI * u) * 0.8 };
}

export interface PoseInput {
  seed: number;
  time: number;
  state?: AvatarState;
  mood?: AvatarMood;
  /** 额外叠加的表情（瞬时反应），按权重混进 mood 的眼睛配方。 */
  expression?: { mood: AvatarMood; weight?: number };
  stateAge?: number;
  gaze?: { x: number; y: number; weight?: number };
  reducedMotion: boolean;
  view?: { yaw: number; pitch: number };
}

/** 两个姿态之间的一段（同一时刻取两边，于是各自的动效仍在跑）。 */
export function blendPoses(a: Pose, b: Pose, t: number): Pose {
  const k = clamp(t, 0, 1);
  const m = (x: number, y: number) => mix(x, y, k);
  const sweep = a.ribbons > 0 && b.ribbons > 0 ? m(a.sweep, b.sweep) : a.ribbons > 0 ? a.sweep : b.sweep;
  const cage = a.ribbons > 0 && b.ribbons > 0 ? m(a.cage, b.cage) : a.ribbons > 0 ? a.cage : b.cage;
  return {
    yaw: m(a.yaw, b.yaw),
    pitch: m(a.pitch, b.pitch),
    roll: m(a.roll, b.roll),
    lift: m(a.lift, b.lift),
    sx: m(a.sx, b.sx),
    sy: m(a.sy, b.sy),
    gazeX: m(a.gazeX, b.gazeX),
    gazeY: m(a.gazeY, b.gazeY),
    blink: m(a.blink, b.blink),
    squintL: m(a.squintL, b.squintL),
    squintR: m(a.squintR, b.squintR),
    eyes: {
      arc: m(a.eyes.arc, b.eyes.arc),
      slit: m(a.eyes.slit, b.eyes.slit),
      wide: m(a.eyes.wide, b.eyes.wide),
      star: m(a.eyes.star, b.eyes.star),
      tilt: m(a.eyes.tilt, b.eyes.tilt),
      lid: m(a.eyes.lid, b.eyes.lid),
      glint: m(a.eyes.glint, b.eyes.glint),
    },
    ribbons: m(a.ribbons, b.ribbons),
    cage,
    sweep,
    bang: m(a.bang, b.bang),
    dots: m(a.dots, b.dots),
    bloom: m(a.bloom, b.bloom),
    // 粒子的时间轴不插值：新的一侧在场就用它的，否则粒子的运动会“倒放”。
    bloomAge: b.bloom > 0 ? b.bloomAge : a.bloomAge,
  };
}

/** 完成时的庆祝节拍：3.87 s 转完并收回，整轮 6.2 s 起，每个头像略微不同。 */
export const DONE_TURN_S = 3.87;
export const DONE_CYCLE_S = 6.2;
const DONE_SWEEPS = 9;

const WORK_FIRST_S = 1.2;
const WORK_FIRST_JITTER_S = 1.2;
const WORK_GAP_S = 7.5;
const WORK_JITTER_S = 1.5;
const WORK_TURN_S = 1.5;
const WORK_EASE = 6.2;

/** 工作状态下 `age` 秒时，正处于第几秒的绕圈中；两圈之间为 null。 */
function workTurn(seed: number, age: number): number | null {
  const first = WORK_FIRST_S + WORK_FIRST_JITTER_S * noise(seed, 41);
  if (age < first) return null;
  const n = Math.floor((age - first) / WORK_GAP_S);
  for (const k of [n, n - 1]) {
    if (k < 0) continue;
    const start = first + k * WORK_GAP_S + (k ? WORK_JITTER_S * noise(seed, 60 + k) : 0);
    if (age >= start && age < start + WORK_TURN_S) return age - start;
  }
  return null;
}

const near = (angle: number) => angle - TAU * Math.round(angle / TAU);

const CELEBRATION_END_S = 3.79;
const CELEBRATION_SPEED = (DONE_SWEEPS * TAU + 0.5) / 2.4625;

/** 庆祝时彩带在 `t` 秒走过了多少弧度：先反向蓄 0.24 s，加速，再从 2.54 s 减速落在整数圈。 */
function celebration(t: number): number {
  const v = CELEBRATION_SPEED;
  if (t <= 0) return 0;
  if (t < 0.24) return -0.25 * (1 - Math.cos((Math.PI * t) / 0.24));
  if (t < 0.54) return -0.5 + (v * (t - 0.24) ** 2) / 0.6;
  if (t < 2.54) return -0.5 + v * (t - 0.39);
  if (t < CELEBRATION_END_S) return -0.5 + v * 2.15 + (1.25 * v * (1 - (1 - (t - 2.54) / 1.25) ** 4)) / 4;
  return DONE_SWEEPS * TAU;
}

/** 表情对姿态的额外影响：身体倾向、呼吸节奏、视线偏好。 */
interface MoodBody {
  /** 呼吸节奏倍数（<1 更慢）。 */
  pace: number;
  /** 视线偏好（叠加在基础游走上）。 */
  gazeBias: [number, number];
  /** 基础倾角（度）。 */
  roll: number;
  /** 眨眼节奏。 */
  blink: { slot?: number; dur?: number; double?: number };
}

const MOOD_BODY: Record<AvatarMood, MoodBody> = {
  neutral: { pace: 1, gazeBias: [0, 0], roll: 0, blink: {} },
  happy: { pace: 1.15, gazeBias: [0, -0.05], roll: 0, blink: { slot: 3.6 } },
  joy: { pace: 1.3, gazeBias: [0, -0.08], roll: 0, blink: { slot: 3.1 } },
  love: { pace: 1.25, gazeBias: [0, -0.15], roll: 0, blink: { slot: 3.1, dur: 0.16 } },
  surprised: { pace: 1.5, gazeBias: [0, 0], roll: 0, blink: { slot: 2.4, dur: 0.13 } },
  curious: { pace: 1.05, gazeBias: [0.18, -0.1], roll: 5, blink: { slot: 3.2 } },
  skeptical: { pace: 0.95, gazeBias: [0.2, -0.05], roll: 3.5, blink: { slot: 4.8 } },
  sleepy: { pace: 0.55, gazeBias: [-0.05, 0.35], roll: -3, blink: { slot: 7.4, dur: 0.46, double: 1.4 } },
  bored: { pace: 0.72, gazeBias: [0.22, 0.15], roll: -4, blink: { slot: 6.0, dur: 0.3 } },
  sad: { pace: 0.78, gazeBias: [0, 0.38], roll: -4.5, blink: { slot: 5.5, dur: 0.28 } },
  angry: { pace: 0.9, gazeBias: [-0.3, 0.1], roll: -2.5, blink: { slot: 5.6, dur: 0.14 } },
  focused: { pace: 1.2, gazeBias: [0, 0.05], roll: 0, blink: { slot: 5.2, dur: 0.14 } },
  confused: { pace: 0.95, gazeBias: [-0.2, -0.15], roll: 6.5, blink: { slot: 3.5 } },
  shy: { pace: 0.9, gazeBias: [-0.28, 0.24], roll: -4, blink: { slot: 3.0, double: 0.65 } },
  smug: { pace: 0.95, gazeBias: [0.24, -0.08], roll: 3, blink: { slot: 4.4 } },
};

function moodBody(mood: AvatarMood): MoodBody {
  return MOOD_BODY[mood] ?? MOOD_BODY.neutral;
}

/** 把两个表情按权重叠进一个 look（用于 `expression` 需求）。 */
function mixLook(a: EyeLook, b: EyeLook, k: number): EyeLook {
  const m = (x: number, y: number) => mix(x, y, k);
  return {
    arc: m(a.arc, b.arc),
    slit: m(a.slit, b.slit),
    wide: m(a.wide, b.wide),
    star: m(a.star, b.star),
    tilt: m(a.tilt, b.tilt),
    lid: m(a.lid, b.lid),
    glint: m(a.glint, b.glint),
  };
}

export function computePose(input: PoseInput): Pose {
  const { seed, time, gaze, reducedMotion, view } = input;
  const { state, mood } = resolveLook(input);
  const body = moodBody(mood);
  const t = reducedMotion ? 0 : time + noise(seed, 7) * 10;
  const live = reducedMotion ? 0 : 1;
  const wave = (period: number, phase = 0) => (reducedMotion ? 0 : Math.sin((TAU * t) / period + phase));
  const given = gaze && Number.isFinite(gaze.x) && Number.isFinite(gaze.y) ? ([clamp(gaze.x, -1, 1), clamp(gaze.y, -1, 1)] as [number, number]) : null;
  const weight = given ? (Number.isFinite(gaze?.weight) ? clamp(gaze?.weight as number, 0, 1) : 1) : 0;
  const sway = 1 - 0.7 * weight;

  let eyes = moodLook(mood);
  if (input.expression) {
    const extra = (input.expression.mood as string) === 'grumpy' ? 'angry' : input.expression.mood;
    if (isMood(extra)) {
      const w = Number.isFinite(input.expression.weight) ? clamp(input.expression.weight as number, 0, 1) : 1;
      eyes = mixLook(eyes, moodLook(extra), w);
    }
  }

  const pose: Pose = {
    yaw: BASE_YAW,
    pitch: BASE_PITCH,
    roll: 0,
    lift: 0,
    sx: 1,
    sy: 1,
    gazeX: 0,
    gazeY: 0,
    blink: 0,
    squintL: 0,
    squintR: 0,
    eyes,
    ribbons: 0,
    cage: 0,
    sweep: 0,
    bang: 0,
    dots: 0,
    bloom: 0,
    bloomAge: 0,
  };

  /** 安静时的呼吸、摇摆、眨眼与游走。 */
  const rest = (paceScale: number) => {
    const pace = body.pace * paceScale;
    pose.yaw += 0.07 * sway * wave(6.1 * pace);
    pose.pitch += 0.04 * sway * wave(4.7 * pace, 1);
    pose.roll += 1.6 * wave(5.3 * pace, 2) + body.roll * 0.35;
    pose.lift = reducedMotion ? 0 : -0.45 * (1 - Math.cos((TAU * t) / (3.4 * pace)));
    const breath = wave(3.4 * pace, -Math.PI / 2);
    pose.sy = 1 + 0.012 * breath;
    pose.sx = 1 - 0.008 * breath;
    if (!reducedMotion) {
      pose.blink = blinkAt(seed, t, body.blink);
      const [wx, wy] = wanderAt(seed, t, mood === 'curious' ? 1.35 : mood === 'sleepy' ? 0.5 : 1);
      pose.gazeX = wx + body.gazeBias[0];
      pose.gazeY = wy + body.gazeBias[1];
    }
  };

  // 困倦：偶尔“点头”——慢慢垂下去再惊醒一下。
  const nodOff = () => {
    if (reducedMotion || mood !== 'sleepy') return;
    const p = (((t % 9) + 9) % 9) / 9;
    const drop = p < 0.62 ? smooth(p / 0.62) : 1 - smooth((p - 0.62) / 0.12);
    pose.pitch += 0.16 * drop;
    pose.roll += 3.5 * drop;
    pose.lift += 0.6 * drop;
    pose.eyes.lid = clamp(pose.eyes.lid + 0.35 * drop, 0, 1);
  };

  // 惊讶：一下急停，然后微微发抖。
  const startle = () => {
    if (reducedMotion || mood !== 'surprised') return;
    pose.pitch -= 0.05;
    pose.lift -= 0.5 * Math.abs(wave(0.9));
    pose.roll += 0.8 * wave(0.42);
  };

  if (state === 'idle' && (mood === 'happy' || mood === 'joy')) {
    // 没事可做的开心 bot 会跳。
    const period = mood === 'joy' ? 0.76 : 0.92;
    const p = reducedMotion ? 0.5 : (((t % period) + period) % period) / period;
    const air = 4 * p * (1 - p);
    const land = reducedMotion ? 0 : clamp(1 - Math.min(p, 1 - p) / 0.12, 0, 1);
    pose.lift = reducedMotion ? 0 : -(mood === 'joy' ? 4.0 : 3.2) * air;
    pose.sy = 1 - 0.09 * land + 0.03 * air * live;
    pose.sx = 1 + 0.07 * land - 0.015 * air * live;
    pose.roll = 4.5 * wave(period * 2);
    pose.yaw += 0.1 * wave(period * 2, 0.6);
    if (!reducedMotion) {
      pose.blink = blinkAt(seed, t, body.blink);
      [pose.gazeX, pose.gazeY] = wanderAt(seed, t, 1.1);
    }
  } else if (state === 'idle' && mood === 'love') {
    // 爱心：小幅弹跳 + 身体轻微搏动，像心跳。
    const beat = reducedMotion ? 0 : (1 - Math.cos((TAU * t) / 0.76)) / 2;
    pose.lift = reducedMotion ? 0 : -1.6 * beat;
    pose.sy = 1 + 0.035 * beat;
    pose.sx = 1 - 0.02 * beat;
    pose.roll += 2.2 * wave(4.4);
    pose.yaw += 0.06 * wave(6.2, 0.4);
    if (!reducedMotion) {
      pose.blink = blinkAt(seed, t, body.blink);
      [pose.gazeX, pose.gazeY] = wanderAt(seed, t, 0.8);
      pose.gazeY -= 0.12;
    }
  } else if (state === 'idle') {
    rest(1);
    if (mood === 'sleepy') nodOff();
    if (mood === 'surprised') startle();
    if (mood === 'curious' || mood === 'confused') {
      // 好奇/困惑：头歪一点，视线在两边之间来回打量。
      pose.roll += (mood === 'confused' ? 6 : 4) + 2.5 * wave(5.1);
      pose.yaw += 0.08 * wave(4.2);
    }
    if (mood === 'angry') {
      pose.sy *= 0.985;
      pose.roll -= 1.2;
    }
    if (mood === 'sad') {
      pose.pitch += 0.1;
      pose.lift += 0.6;
    }
    if (!reducedMotion && mood === 'neutral') {
      // 微表情抖动：每隔几秒闪一下别的表情。
      const micro = microAt(seed, t);
      if (micro) {
        const w = micro.weight;
        pose.eyes = mixLook(pose.eyes, moodLook(micro.mood), w);
        if (micro.mood === 'curious') pose.roll += 3 * w;
        if (micro.mood === 'surprised') pose.lift -= 0.8 * w;
        if (micro.mood === 'sleepy') pose.pitch += 0.06 * w;
      }
    }
  } else if (state === 'thinking') {
    pose.yaw += 0.12 + 0.05 * sway * wave(7.3);
    pose.pitch += 0.08;
    pose.roll = -5 + 1.4 * wave(4.1);
    pose.lift = -0.5 * (1 - Math.cos((TAU * t) / 5.2)) * live;
    pose.gazeX = 0.55 + 0.3 * wave(5.6);
    pose.gazeY = -0.8;
    pose.squintL = 0.22;
    pose.squintR = 0.32 + 0.1 * wave(3.1);
    if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.7, body.blink);
    pose.dots = 1;
  } else if (state === 'working') {
    const beat = wave(0.7);
    pose.yaw += 0.08 * sway * wave(2.3, 0.4);
    pose.pitch -= 0.05;
    pose.roll = 3 + 0.6 * beat;
    pose.lift = -0.3 * (0.5 + 0.5 * beat) * live;
    pose.sy = 0.99 - 0.008 * beat;
    pose.sx = 1.005 + 0.005 * beat;
    pose.squintL = 0.25;
    pose.squintR = 0.25;
    if (reducedMotion) {
      pose.gazeX = 0.15;
      pose.gazeY = 0.3;
    } else {
      [pose.gazeX, pose.gazeY] = dartAt(seed, t);
      pose.blink = blinkAt(seed, t * 1.3, body.blink);
    }
    const age = Number.isFinite(input.stateAge) ? Math.max(0, input.stateAge as number) : Math.max(0, time);
    const into = reducedMotion ? null : workTurn(seed, age);
    if (into !== null) {
      const e = WORK_EASE * into;
      const turn = TAU * (1 - (1 + e) * Math.exp(-e));
      const swell = Math.sin(turn / 2);
      pose.ribbons = clamp(into / 0.16, 0, 1) * clamp((WORK_TURN_S - into) / 0.5, 0, 1);
      pose.sweep = turn;
      pose.yaw += 0.22 * swell;
      pose.roll += 3 * swell;
      pose.lift -= 1.2 * swell;
      pose.gazeX = clamp(pose.gazeX * (1 - swell) - 0.85 * Math.sin(turn), -1, 1);
      pose.gazeY = pose.gazeY * (1 - swell) - 0.3 * swell;
    }
  } else if (state === 'waiting') {
    const p = reducedMotion ? 0 : (((t % 6.5) + 6.5) % 6.5) / 6.5;
    const sigh = Math.sin(TAU * clamp(p / 0.33, 0, 1));
    pose.yaw += 0.04 * sway * wave(7.4);
    pose.pitch += 0.02 + 0.03 * sigh;
    pose.roll = 7 + 1.2 * wave(6.4, 2);
    pose.lift = -0.3 * (1 - Math.cos((TAU * t) / 6.5)) * live;
    pose.sy = 1 + 0.025 * sigh;
    pose.sx = 1 - 0.012 * sigh;
    pose.gazeX = 0.5 + 0.15 * wave(8.2);
    pose.gazeY = 0.1;
    // 等待天生半眯着眼；开心之类的表情会用弧线覆盖掉细缝。
    pose.eyes = mixLook(pose.eyes, look({ slit: 1 }), 1 - pose.eyes.arc);
    if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.6, body.blink);
  } else if (state === 'blocked') {
    pose.sy = 1.02;
    pose.sx = 0.99;
    pose.bang = 1;
  } else if (state === 'alert') {
    // 警觉 / 通知态：身体保持警醒，轻微高频脉冲 + 抬头注意。
    const pulse = reducedMotion ? 0 : (1 - Math.cos((TAU * t) / 1.1)) / 2;
    pose.yaw += 0.05 * sway * wave(3.2);
    pose.pitch -= 0.06;
    pose.lift = -0.9 * pulse;
    pose.sy = 1 + 0.025 * pulse;
    pose.sx = 1 - 0.015 * pulse;
    pose.roll = 2.2 * wave(1.6);
    if (!reducedMotion) {
      pose.blink = blinkAt(seed, t * 1.1, { slot: 2.6, dur: 0.14 });
      [pose.gazeX, pose.gazeY] = dartAt(seed, t * 0.7);
    }
  } else if (state === 'done') {
    rest(1.25);
    const age = !reducedMotion && Number.isFinite(input.stateAge) ? Math.max(0, input.stateAge as number) : DONE_TURN_S;
    const length = DONE_CYCLE_S * (1 + 0.15 * noise(seed, 31));
    const cycle = Math.floor(age / length);
    const since = age - cycle * length;
    if (since < DONE_TURN_S) {
      const swell = Math.sin((Math.PI * since) / DONE_TURN_S);
      const way = cycle % 2 ? -1 : 1;
      const sweep = celebration(since) * way;
      pose.yaw += near(sweep / 3);
      pose.lift -= 2.2 * swell;
      pose.sy += 0.04 * swell;
      // 完成态用粒子绽放，而不是彩带笼：粒子有自己的一条时间轴（bloomAge）。
      pose.bloom = clamp(since / 0.12, 0, 1) * clamp((DONE_TURN_S + 0.6 - since) / 1.1, 0, 1);
      pose.bloomAge = since;
    }
  } else {
    rest(1);
  }

  // 眨眼关掉高光：闭上的眼睛不该有反光。
  if (pose.blink > 0.55) pose.eyes.glint *= clamp((1 - pose.blink) / 0.45, 0, 1);

  if (given && weight > 0) {
    const share = reducedMotion ? 1 : LOOK_EYES;
    const follow = weight * (1 - pose.eyes.arc * 0.6);
    pose.gazeX = mix(pose.gazeX, given[0] * share, follow);
    pose.gazeY = mix(pose.gazeY, given[1] * share, follow);
    if (!reducedMotion) {
      pose.yaw += weight * (given[0] * LOOK_YAW - BASE_YAW);
      pose.pitch += weight * (-given[1] * LOOK_PITCH - BASE_PITCH / 2);
    }
  }
  if (view && Number.isFinite(view.yaw) && Number.isFinite(view.pitch)) {
    pose.yaw += view.yaw;
    pose.pitch += view.pitch;
  }
  return pose;
}

/** `RenderOptions` 里与姿态有关的部分。 */
export function poseFromOptions(seed: number, options: RenderOptions): Pose {
  return computePose({
    seed,
    time: Number.isFinite(options.time) ? (options.time as number) : 0,
    state: options.state,
    mood: options.mood,
    expression: options.expression,
    stateAge: options.stateAge,
    gaze: options.gaze,
    reducedMotion: options.reducedMotion === true,
    view: options.view,
  });
}