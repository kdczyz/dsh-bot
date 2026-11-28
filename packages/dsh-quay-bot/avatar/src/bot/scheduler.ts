/**
 * 双节奏状态机调度层（纯 TS，无 DOM / 定时器副作用）。
 *
 * 将“业务逻辑状态”与“动画表现节奏”解耦：
 * 1. 表情切换定时器：按当前状态的间隔区间（如 thinking 3.5s..7.0s）从专属表情池随机抽新表情；
 * 2. 独立眨眼定时器：按 2.0s..3.6s（随表情微调）独立触发眨眼；
 * 3. 瞬时反应（poke）与手动锁定表情（setMood）均能无缝接入，驱动 SpringEyeEngine。
 */
import type { AvatarMood, AvatarState } from '../core/types.ts';
import { SpringEyeEngine, type SpringOptions } from './spring.ts';

export interface StateCadence {
  pool: readonly AvatarMood[];
  /** 表情切换区间（秒）。 */
  moodInterval: [number, number];
  /** 眨眼间隔区间（秒）。 */
  blinkInterval: [number, number];
  /** 眨眼时长（秒）。 */
  blinkDuration: number;
}

export const STATE_CADENCES: Record<AvatarState, StateCadence> = {
  idle: {
    pool: ['neutral', 'happy', 'curious', 'shy', 'sleepy'],
    moodInterval: [3.2, 6.8],
    blinkInterval: [2.2, 3.8],
    blinkDuration: 0.15,
  },
  thinking: {
    pool: ['curious', 'skeptical', 'focused', 'confused'],
    moodInterval: [3.5, 7.0],
    blinkInterval: [2.4, 4.2],
    blinkDuration: 0.16,
  },
  working: {
    pool: ['focused', 'smug', 'joy', 'neutral'],
    moodInterval: [2.8, 5.5],
    blinkInterval: [1.9, 3.2],
    blinkDuration: 0.13,
  },
  waiting: {
    pool: ['bored', 'sleepy', 'shy', 'curious'],
    moodInterval: [3.8, 7.2],
    blinkInterval: [2.8, 4.8],
    blinkDuration: 0.22,
  },
  blocked: {
    pool: ['sad', 'confused', 'angry'],
    moodInterval: [2.4, 4.8],
    blinkInterval: [2.2, 3.6],
    blinkDuration: 0.15,
  },
  done: {
    pool: ['joy', 'love', 'happy'],
    moodInterval: [2.0, 4.2],
    blinkInterval: [2.0, 3.4],
    blinkDuration: 0.14,
  },
  alert: {
    pool: ['surprised', 'angry', 'focused'],
    moodInterval: [1.8, 3.5],
    blinkInterval: [1.6, 2.8],
    blinkDuration: 0.12,
  },
};

const POKE_POOL: readonly AvatarMood[] = ['surprised', 'love', 'shy', 'curious', 'joy', 'angry'];

export interface SchedulerOptions {
  state?: AvatarState;
  /** 若指定固定表情则锁定；传 null/undefined 时由状态机自动轮换表情。 */
  mood?: AvatarMood | null;
  spring?: SpringOptions;
  /** 确定性伪随机源（默认 Math.random，测试可注入）。 */
  rng?: () => number;
}

export class BotScheduler {
  readonly eyes: SpringEyeEngine;
  private _state: AvatarState;
  private _lockedMood: AvatarMood | null;
  private _activeMood: AvatarMood;
  private _stateAge = 0;

  private moodTimer = 0;
  private blinkTimer = 0;
  private burst: { mood: AvatarMood; remaining: number } | null = null;
  private rng: () => number;

  constructor(options: SchedulerOptions = {}) {
    this.rng = options.rng ?? Math.random;
    this._state = options.state ?? 'idle';
    this._lockedMood = options.mood ?? null;
    const cadence = STATE_CADENCES[this._state];
    this._activeMood = this._lockedMood ?? cadence.pool[0];
    this.eyes = new SpringEyeEngine(this._activeMood, options.spring);
    this.moodTimer = this.randRange(cadence.moodInterval);
    this.blinkTimer = this.randRange(cadence.blinkInterval);
  }

  get state(): AvatarState {
    return this._state;
  }

  get lockedMood(): AvatarMood | null {
    return this._lockedMood;
  }

  /** 当前正在呈现的表情（含自动轮换或 poke 瞬时表情）。 */
  get activeMood(): AvatarMood {
    return this._activeMood;
  }

  get stateAge(): number {
    return this._stateAge;
  }

  private randRange([lo, hi]: [number, number]): number {
    return lo + (hi - lo) * this.rng();
  }

  private pickFromPool(pool: readonly AvatarMood[], exclude?: AvatarMood): AvatarMood {
    const candidates = pool.length > 1 && exclude ? pool.filter((m) => m !== exclude) : pool;
    return candidates[Math.floor(this.rng() * candidates.length) % candidates.length];
  }

  setState(next: AvatarState, immediate = false): void {
    if (next === this._state) return;
    this._state = next;
    this._stateAge = 0;
    const cadence = STATE_CADENCES[next];
    this.moodTimer = this.randRange(cadence.moodInterval);
    this.blinkTimer = Math.min(this.blinkTimer, this.randRange(cadence.blinkInterval));
    if (!this._lockedMood && !this.burst) {
      const picked = cadence.pool[0];
      this._activeMood = picked;
      this.eyes.setExpression(picked, immediate);
    }
  }

  /** 锁定某一个表情；传 `null` 恢复状态机自动轮换。 */
  setMood(mood: AvatarMood | null, immediate = false): void {
    this._lockedMood = mood;
    if (mood !== null) {
      this.burst = null;
      this._activeMood = mood;
      this.eyes.setExpression(mood, immediate);
    } else {
      const cadence = STATE_CADENCES[this._state];
      const next = this.pickFromPool(cadence.pool, this._activeMood);
      this._activeMood = next;
      this.moodTimer = this.randRange(cadence.moodInterval);
      this.eyes.setExpression(next, immediate);
    }
  }

  /** 外部手动设置注视目标（-1..1）。 */
  setGazeTarget(x: number, y: number, immediate = false): void {
    this.eyes.setLookTarget(x, y, immediate);
  }

  /** “逗它一下”：触发一个短暂的随机表情反应，结束后平滑弹回。 */
  poke(mood?: AvatarMood, durationSec = 1.6): AvatarMood {
    const picked = mood ?? this.pickFromPool(POKE_POOL, this._activeMood);
    this.burst = { mood: picked, remaining: Math.max(0.3, durationSec) };
    this._activeMood = picked;
    this.eyes.setExpression(picked);
    return picked;
  }

  /** 主动眨一次眼。 */
  blink(doubleBlink = false): void {
    const cadence = STATE_CADENCES[this._state];
    this.eyes.triggerBlink(doubleBlink, cadence.blinkDuration);
    this.blinkTimer = this.randRange(cadence.blinkInterval);
  }

  /** 推进调度器与弹簧物理（`dt` 秒）。 */
  update(dt: number, reducedMotion = false): void {
    const clamped = Math.min(0.05, Math.max(0, Number.isFinite(dt) ? dt : 0));
    this._stateAge += clamped;
    const cadence = STATE_CADENCES[this._state];

    if (!reducedMotion) {
      // 1. 瞬时反应（逗它一下）倒计时
      if (this.burst) {
        this.burst.remaining -= clamped;
        if (this.burst.remaining <= 0) {
          this.burst = null;
          const fallback = this._lockedMood ?? this.pickFromPool(cadence.pool);
          this._activeMood = fallback;
          this.eyes.setExpression(fallback);
        }
      }

      // 2. 表情池定时轮换（未锁定且无 poke 时）
      if (!this._lockedMood && !this.burst) {
        this.moodTimer -= clamped;
        if (this.moodTimer <= 0) {
          this.moodTimer = this.randRange(cadence.moodInterval);
          const next = this.pickFromPool(cadence.pool, this._activeMood);
          this._activeMood = next;
          this.eyes.setExpression(next);
        }
      }

      // 3. 独立眨眼调度
      this.blinkTimer -= clamped;
      if (this.blinkTimer <= 0) {
        this.blinkTimer = this.randRange(cadence.blinkInterval);
        const doubleBlink = this.rng() > 0.82;
        this.eyes.triggerBlink(doubleBlink, cadence.blinkDuration);
      }
    }

    this.eyes.update(clamped, reducedMotion);
  }

  /**
   * 计算距离下一次定时器事件（眨眼、表情轮换、burst 结束）还剩多少毫秒。
   * 配合 `eyes.isSettled()` 用于 Idle 静止降帧休眠。
   */
  nextWakeDelayMs(): number {
    const timers: number[] = [this.blinkTimer];
    if (!this._lockedMood && !this.burst) timers.push(this.moodTimer);
    if (this.burst) timers.push(this.burst.remaining);
    const minS = Math.max(0.04, Math.min(...timers));
    return Math.round(minS * 1000);
  }

  /** 休眠唤醒：直接把最接近到期的定时器和内部时钟快进 `elapsedSec` 秒。 */
  advanceSleep(elapsedSec: number): void {
    if (elapsedSec <= 0) return;
    this._stateAge += elapsedSec;
    if (this.burst) this.burst.remaining = Math.max(0, this.burst.remaining - elapsedSec);
    if (!this._lockedMood && !this.burst) this.moodTimer = Math.max(0, this.moodTimer - elapsedSec);
    this.blinkTimer = Math.max(0, this.blinkTimer - elapsedSec);
  }
}
