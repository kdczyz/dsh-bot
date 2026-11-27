/**
 * 三缓冲 + 二阶阻尼弹簧物理插值引擎（纯 TS，无 DOM 依赖，可直接跨端移植）。
 *
 * - sourceRings：触发新表情瞬间深拷贝当前 displayRings，支持中途随时打断，绝不跳帧。
 * - targetRings：目标表情的 48 点闭合眼环。
 * - displayRings：每帧按弹簧进度 springX 逐点插值输出。
 *
 * 弹簧模型：d²x/dt² = -k(x - 1) - c(dx/dt)，默认 k=220, c=18（轻微欠阻尼回弹）。
 * 眨眼与视线低通滤波独立运行，不污染主表情缓冲。
 */
import type { AvatarMood } from '../core/types.ts';
import { clonePair, expressionRings, lerpPair, type EyePair, type Pt } from './ring.ts';

export interface SpringOptions {
  /** 刚度系数 k，建议 180..260，默认 220。 */
  stiffness?: number;
  /** 阻尼系数 c，建议 16..22，默认 18。 */
  damping?: number;
  /** 单次眨眼耗时（秒），默认 0.15。 */
  blinkDuration?: number;
  /** 眨眼最扁时的纵向缩放比例，默认 0.08。 */
  blinkMinScale?: number;
  /** 视线低通滤波速率（1/s，指数平滑，帧率无关），默认 10。 */
  lookRate?: number;
}

interface BlinkPulse {
  elapsed: number;
  duration: number;
  /** 第二次连眨延迟（> 0 表示正在排队）。 */
  nextDelay: number | null;
}

export class SpringEyeEngine {
  private source: EyePair;
  private target: EyePair;
  private display: EyePair;
  private currentMood: AvatarMood = 'neutral';

  private springX = 1;
  private springV = 0;
  private stiffness: number;
  private damping: number;
  private blinkDuration: number;
  private blinkMinScale: number;
  private lookRate: number;

  private blinkState: BlinkPulse | null = null;
  private blinkScale = 1;

  private lookTarget: Pt = { x: 0, y: 0 };
  private lookCurrent: Pt = { x: 0, y: 0 };

  constructor(initialMood: AvatarMood = 'neutral', options: SpringOptions = {}) {
    this.stiffness = options.stiffness ?? 220;
    this.damping = options.damping ?? 18;
    this.blinkDuration = options.blinkDuration ?? 0.15;
    this.blinkMinScale = options.blinkMinScale ?? 0.08;
    this.lookRate = options.lookRate ?? 10;

    this.currentMood = initialMood;
    const init = expressionRings(initialMood);
    this.source = clonePair(init);
    this.target = clonePair(init);
    this.display = clonePair(init);
  }

  get mood(): AvatarMood {
    return this.currentMood;
  }

  /** 触发新表情（随时打断当前动画而不跳帧）。 */
  setExpression(mood: AvatarMood, immediate = false): void {
    if (mood === this.currentMood && !immediate && this.springX > 0.999 && Math.abs(this.springV) < 0.01) {
      return;
    }
    this.currentMood = mood;
    const next = expressionRings(mood);
    if (immediate) {
      this.source = clonePair(next);
      this.target = clonePair(next);
      this.display = clonePair(next);
      this.springX = 1;
      this.springV = 0;
      return;
    }
    this.source = clonePair(this.display);
    this.target = next;
    this.springX = 0;
    this.springV = 0;
  }

  /** 触发一次独立眨眼（1 -> 0.08 -> 1），可选连眨两下。 */
  triggerBlink(doubleBlink = false, duration = this.blinkDuration): void {
    this.blinkState = {
      elapsed: 0,
      duration: Math.max(0.08, duration),
      nextDelay: doubleBlink ? 0.08 : null,
    };
  }

  /** 设置归一化凝视目标（各轴 -1..1）。 */
  setLookTarget(x: number, y: number, immediate = false): void {
    const nx = Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0));
    const ny = Math.max(-1, Math.min(1, Number.isFinite(y) ? y : 0));
    this.lookTarget = { x: nx, y: ny };
    if (immediate) this.lookCurrent = { x: nx, y: ny };
  }

  /** 推进物理状态，`dt` 单位为秒。 */
  update(dt: number, reducedMotion = false): void {
    const clamped = Math.min(0.05, Math.max(0, Number.isFinite(dt) ? dt : 0));

    if (reducedMotion) {
      if (this.springX !== 1 || this.springV !== 0) {
        this.source = clonePair(this.target);
        this.display = clonePair(this.target);
        this.springX = 1;
        this.springV = 0;
      }
      this.blinkState = null;
      this.blinkScale = 1;
      this.lookCurrent.x = this.lookTarget.x;
      this.lookCurrent.y = this.lookTarget.y;
      return;
    }

    // 1. 二阶阻尼弹簧（子步积分保证在低帧率下仍稳定）
    if (Math.abs(this.springX - 1) > 1e-4 || Math.abs(this.springV) > 1e-3) {
      const subSteps = Math.max(1, Math.ceil(clamped / (1 / 120)));
      const subDt = clamped / subSteps;
      for (let i = 0; i < subSteps; i++) {
        const force = -this.stiffness * (this.springX - 1);
        const damper = -this.damping * this.springV;
        this.springV += (force + damper) * subDt;
        this.springX += this.springV * subDt;
      }
      if (Math.abs(this.springX - 1) <= 1e-4 && Math.abs(this.springV) <= 1e-3) {
        this.springX = 1;
        this.springV = 0;
      }
      lerpPair(this.source, this.target, this.springX, this.display);
    }

    // 2. 独立眨眼缩放（不影响主表情缓冲）
    if (this.blinkState) {
      this.blinkState.elapsed += clamped;
      const { elapsed, duration, nextDelay } = this.blinkState;
      if (elapsed < duration) {
        const u = elapsed / duration;
        this.blinkScale = 1 - (1 - this.blinkMinScale) * Math.sin(Math.PI * u);
      } else if (nextDelay !== null) {
        const gapElapsed = elapsed - duration;
        if (gapElapsed < nextDelay) {
          this.blinkScale = 1;
        } else {
          this.blinkState = { elapsed: gapElapsed - nextDelay, duration, nextDelay: null };
          const u = Math.min(1, this.blinkState.elapsed / duration);
          this.blinkScale = 1 - (1 - this.blinkMinScale) * Math.sin(Math.PI * u);
        }
      } else {
        this.blinkState = null;
        this.blinkScale = 1;
      }
    } else {
      this.blinkScale = 1;
    }

    // 3. 视线低通滤波（与帧率无关的指数平滑）
    const alpha = 1 - Math.exp(-this.lookRate * clamped);
    this.lookCurrent.x += (this.lookTarget.x - this.lookCurrent.x) * alpha;
    this.lookCurrent.y += (this.lookTarget.y - this.lookCurrent.y) * alpha;
    if (Math.abs(this.lookTarget.x - this.lookCurrent.x) < 5e-4) this.lookCurrent.x = this.lookTarget.x;
    if (Math.abs(this.lookTarget.y - this.lookCurrent.y) < 5e-4) this.lookCurrent.y = this.lookTarget.y;
  }

  getRings(): EyePair {
    return this.display;
  }

  getBlinkScale(): number {
    return this.blinkScale;
  }

  getLookOffset(): Pt {
    return { x: this.lookCurrent.x, y: this.lookCurrent.y };
  }

  /** 是否所有物理插值（弹簧、眨眼、视线）都已收敛，可供外层休眠降帧。 */
  isSettled(): boolean {
    const springDone = this.springX === 1 && this.springV === 0;
    const blinkDone = this.blinkState === null && this.blinkScale === 1;
    const lookDone = this.lookCurrent.x === this.lookTarget.x && this.lookCurrent.y === this.lookTarget.y;
    return springDone && blinkDone && lookDone;
  }
}
