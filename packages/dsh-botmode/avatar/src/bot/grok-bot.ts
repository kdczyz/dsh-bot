/**
 * 无框架 GrokBot 引擎控制器 + 原生 Web Component `<grok-bot>`。
 *
 * 特性：
 * - 48 点闭合眼环 + 三缓冲弹簧物理 + 双节奏状态机调度；
 * - 伪 3D 体积切片躯干 + 黏土高光与内阴影 + 轨道粒子 + 通知角标；
 * - IntersectionObserver 离开视口自动暂停；
 * - 休眠降帧（sleepWhenIdle）：Idle 且弹簧/眨眼收敛后停掉 rAF，靠精确唤醒定时器恢复。
 */
import { computeFrame, DEFAULT_EYE_COLOR } from '../core/frame.ts';
import { mountCanvas, paintFrame, remountCanvas, type Surface } from '../core/paint.ts';
import { renderSvg } from '../core/svg.ts';
import { validateAvatar } from '../core/validate.ts';
import type { AvatarDefinition, AvatarMood, AvatarState, BadgeKind, PoseLike } from '../core/types.ts';
import { derivePalette, type BotPalette } from './palettes.ts';
import { BotScheduler } from './scheduler.ts';
import { findShape, SHAPES, type ShapeId } from './shapes.ts';

const BLEND_MS = 420;

export interface GrokBotOptions {
  /** 容器元素（若传则内部创建包装 div + canvas）。 */
  container?: HTMLElement;
  /** 或直接传入现成的 canvas（需位于可定位容器内）。 */
  canvas?: HTMLCanvasElement;
  definition?: AvatarDefinition;
  shape?: ShapeId;
  palette?: string;
  color?: string;
  eyeColor?: string;
  size?: number;
  depth?: number;
  clay?: boolean;
  state?: AvatarState;
  mood?: AvatarMood | 'auto' | null;
  orbit?: boolean;
  badge?: BadgeKind;
  followPointer?: boolean;
  interactive?: boolean;
  reducedMotion?: boolean;
  /** Idle 且弹簧/眨眼收敛后自动暂停 rAF，仅在下次事件时唤醒。默认 false。 */
  sleepWhenIdle?: boolean;
  /** 离开视口时自动暂停渲染循环。默认 true。 */
  observeVisibility?: boolean;
  onFrame?: (info: { mood: AvatarMood; sleeping: boolean; visible: boolean; fps: number }) => void;
}

export class GrokBot {
  readonly canvas: HTMLCanvasElement;
  readonly wrapper: HTMLElement;
  readonly scheduler: BotScheduler;

  private def: AvatarDefinition;
  private palette: BotPalette;
  private eyeColorOverride: string | undefined;
  private size: number;
  private depth: number;
  private clay: boolean;
  private orbit: boolean;
  private badge: BadgeKind;
  private followPointer: boolean;
  private interactive: boolean;
  private reducedMotion: boolean;
  private sleepWhenIdle: boolean;
  private surface: Surface;

  private view = { yaw: 0, pitch: 0 };
  private viewTarget: { yaw: number; pitch: number } | null = null;
  private time = 0;
  private lastTick = 0;
  private rafId: number | null = null;
  private wakeTimer: number | null = null;
  private visible = true;
  private sleeping = false;
  private dirty = false;
  private destroyed = false;
  private dragging: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;

  private lastPose: PoseLike | null = null;
  private blendFrom: { pose: PoseLike; start: number } | null = null;

  private fpsFrames = 0;
  private fpsSince = 0;
  private currentFps = 0;
  private onFrame?: GrokBotOptions['onFrame'];

  private io: IntersectionObserver | null = null;
  private cleanupListeners: (() => void)[] = [];

  constructor(options: GrokBotOptions) {
    const def = options.definition ?? findShape(options.shape)?.definition ?? SHAPES[0].definition;
    const res = validateAvatar(def);
    if (!res.ok) throw new Error(`Invalid avatar definition: ${res.errors.join('; ')}`);
    this.def = res.value;

    this.palette = derivePalette(options.palette ?? options.color ?? '#ff6a1a');
    this.eyeColorOverride = options.eyeColor;
    this.size = Math.max(24, options.size ?? 160);
    this.depth = options.depth ?? 6;
    this.clay = options.clay ?? true;
    this.orbit = options.orbit ?? false;
    this.badge = options.badge ?? 'none';
    this.followPointer = options.followPointer ?? true;
    this.interactive = options.interactive ?? true;
    this.reducedMotion = options.reducedMotion ?? (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    this.sleepWhenIdle = options.sleepWhenIdle ?? false;
    this.onFrame = options.onFrame;

    if (options.canvas) {
      this.canvas = options.canvas;
      this.wrapper = options.canvas.parentElement ?? options.canvas;
    } else if (options.container) {
      this.wrapper = document.createElement('div');
      this.wrapper.style.cssText = 'position:relative;display:block;margin:auto';
      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('role', 'img');
      this.canvas.style.cssText = 'display:block;position:absolute;pointer-events:none';
      this.wrapper.append(this.canvas);
      options.container.append(this.wrapper);
    } else {
      throw new Error('GrokBot requires either container or canvas');
    }

    const lockedMood = options.mood && options.mood !== 'auto' ? options.mood : null;
    this.scheduler = new BotScheduler({
      state: options.state ?? 'idle',
      mood: lockedMood,
    });

    this.surface = mountCanvas(this.canvas, this.def, this.depth);
    this.applyWrapperSize();
    this.bindEvents(options.observeVisibility !== false);
    this.renderOnce();
    this.wake();
  }

  private applyWrapperSize(): void {
    this.wrapper.style.width = `${this.size}px`;
    this.wrapper.style.height = `${this.size}px`;
    this.canvas.setAttribute('aria-label', `${this.def.name} 头像`);
  }

  private bindEvents(observeVisibility: boolean): void {
    if (typeof window === 'undefined') return;

    const onPointerMove = (e: PointerEvent) => {
      if (this.dragging) {
        const dx = e.clientX - this.dragging.x;
        const dy = e.clientY - this.dragging.y;
        if (Math.hypot(dx, dy) > 3) this.dragging.moved = true;
        this.viewTarget = null;
        this.view = {
          yaw: this.dragging.yaw + (dx / 160) * 1.6,
          pitch: Math.max(-0.9, Math.min(0.9, this.dragging.pitch - (dy / 160) * 1.2)),
        };
        this.wake();
        return;
      }
      if (!this.followPointer) {
        this.scheduler.setGazeTarget(0, 0);
        return;
      }
      const rect = this.wrapper.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (Math.max(rect.width, 160) * 0.75);
      const dy = (e.clientY - cy) / (Math.max(rect.height, 160) * 0.75);
      const m = Math.hypot(dx, dy);
      const k = m < 1e-9 ? 0 : Math.tanh(m) / m;
      this.scheduler.setGazeTarget(dx * k, dy * k);
      this.wake();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    this.cleanupListeners.push(() => window.removeEventListener('pointermove', onPointerMove));

    if (this.interactive) {
      const target = this.wrapper;
      const onDown = (e: PointerEvent) => {
        this.dragging = { x: e.clientX, y: e.clientY, yaw: this.view.yaw, pitch: this.view.pitch, moved: false };
        target.setPointerCapture?.(e.pointerId);
        this.wake();
      };
      const onUp = () => {
        if (this.dragging && !this.dragging.moved) {
          this.poke();
        }
        this.dragging = null;
      };
      target.addEventListener('pointerdown', onDown);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
      target.style.touchAction = 'none';
      this.cleanupListeners.push(() => {
        target.removeEventListener('pointerdown', onDown);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
      });
    }

    if (observeVisibility && typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(
        (entries) => {
          const isVisible = entries.some((entry) => entry.isIntersecting);
          if (isVisible === this.visible) return;
          this.visible = isVisible;
          if (this.visible) {
            this.wake();
          } else {
            this.pauseLoop();
            this.onFrame?.({ mood: this.scheduler.activeMood, sleeping: true, visible: false, fps: 0 });
          }
        },
        { threshold: 0.01 },
      );
      this.io.observe(this.wrapper);
    }
  }

  private pauseLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  /** 捕获屏幕当前最后一帧姿态，作为下次切换动画/状态/表情的过渡起点。 */
  private beginBlend(now = performance.now()): void {
    if (!this.lastPose || this.reducedMotion) return;
    this.blendFrom = { pose: this.lastPose, start: now };
  }

  /** 合并同帧多次属性修改，在下一帧 vsync 统一渲染，避免点击回调里同步连画多帧导致首帧掉帧。 */
  private scheduleRender(): void {
    this.dirty = true;
    this.wake();
  }

  /** 唤醒动画循环。 */
  wake(): void {
    if (this.destroyed || !this.visible) return;
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.sleeping = false;
    if (this.rafId === null) {
      this.lastTick = performance.now();
      this.fpsSince = this.lastTick;
      this.fpsFrames = 0;
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number): void => {
    if (this.destroyed || !this.visible) {
      this.rafId = null;
      return;
    }
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    if (!this.reducedMotion) this.time += dt;

    const prevMood = this.scheduler.activeMood;
    this.scheduler.update(dt, this.reducedMotion);
    if (this.scheduler.activeMood !== prevMood) {
      this.beginBlend(now);
    }

    if (this.viewTarget) {
      if (this.reducedMotion) {
        this.view = { ...this.viewTarget };
        this.viewTarget = null;
      } else {
        const k = 1 - Math.exp(-12 * dt);
        this.view.yaw += (this.viewTarget.yaw - this.view.yaw) * k;
        this.view.pitch += (this.viewTarget.pitch - this.view.pitch) * k;
        if (Math.hypot(this.viewTarget.yaw - this.view.yaw, this.viewTarget.pitch - this.view.pitch) < 1e-3) {
          this.view = { ...this.viewTarget };
          this.viewTarget = null;
        }
      }
    }

    this.dirty = false;
    this.renderOnce(now);

    this.fpsFrames++;
    if (now - this.fpsSince > 500) {
      this.currentFps = Math.round((this.fpsFrames * 1000) / (now - this.fpsSince));
      this.fpsSince = now;
      this.fpsFrames = 0;
    }

    const canSleep =
      this.reducedMotion ||
      (this.sleepWhenIdle &&
        this.scheduler.state === 'idle' &&
        !this.orbit &&
        this.badge === 'none' &&
        !this.dragging &&
        !this.blendFrom &&
        !this.viewTarget &&
        !this.dirty &&
        this.scheduler.eyes.isSettled());

    if (canSleep) {
      this.sleeping = true;
      this.rafId = null;
      this.onFrame?.({ mood: this.scheduler.activeMood, sleeping: true, visible: this.visible, fps: 0 });
      if (!this.reducedMotion) {
        const delayMs = this.scheduler.nextWakeDelayMs();
        this.wakeTimer = window.setTimeout(() => {
          this.scheduler.advanceSleep(delayMs / 1000);
          this.wake();
        }, delayMs);
      }
      return;
    }

    this.onFrame?.({ mood: this.scheduler.activeMood, sleeping: false, visible: this.visible, fps: this.currentFps });
    this.rafId = requestAnimationFrame(this.tick);
  };

  private currentRenderOptions(px?: number, now = performance.now()) {
    const look = this.scheduler.eyes.getLookOffset();
    const blendT = this.blendFrom ? Math.min(1, (now - this.blendFrom.start) / BLEND_MS) : 1;
    if (this.blendFrom && blendT >= 1) this.blendFrom = null;
    return {
      color: this.palette.base,
      highlightColor: this.palette.highlight,
      shadowColor: this.palette.shadow,
      eyeColor: this.eyeColorOverride ?? this.palette.eye ?? DEFAULT_EYE_COLOR,
      depth: this.depth,
      clay: this.clay,
      size: px ?? this.size,
      time: this.time,
      stateAge: this.scheduler.stateAge,
      state: this.scheduler.state,
      mood: this.scheduler.activeMood,
      gaze: { x: look.x, y: look.y, weight: 1 },
      view: this.view,
      reducedMotion: this.reducedMotion,
      eyeRings: this.scheduler.eyes.getRings(),
      blinkScale: this.scheduler.eyes.getBlinkScale(),
      orbit: this.orbit,
      badge: this.badge,
      poseBlend: this.blendFrom ? { from: this.blendFrom.pose, t: blendT } : undefined,
    };
  }

  /** 立即渲染一帧到 Canvas。 */
  renderOnce(now = performance.now()): void {
    const frame = computeFrame(this.def, this.currentRenderOptions(undefined, now), this.size);
    this.lastPose = frame.pose;
    paintFrame(this.surface, frame, this.size);
  }

  // -------------------------------------------------------------------------
  // 公共控制 API

  setState(state: AvatarState): void {
    if (state === this.scheduler.state) return;
    this.beginBlend();
    this.scheduler.setState(state, this.reducedMotion);
    this.scheduleRender();
  }

  setMood(mood: AvatarMood | 'auto' | null): void {
    this.beginBlend();
    this.scheduler.setMood(mood === 'auto' ? null : mood, this.reducedMotion);
    this.scheduleRender();
  }

  setShape(shapeOrDef: ShapeId | AvatarDefinition): void {
    const next = typeof shapeOrDef === 'string' ? findShape(shapeOrDef)?.definition : shapeOrDef;
    if (!next) return;
    const res = validateAvatar(next);
    if (!res.ok) throw new Error(`Invalid avatar definition: ${res.errors.join('; ')}`);
    if (res.value.id === this.def.id && res.value.body.path === this.def.body.path) return;
    this.beginBlend();
    this.def = res.value;
    this.surface = remountCanvas(this.surface, this.def, this.depth);
    this.applyWrapperSize();
    this.scheduleRender();
  }

  setPalette(idOrColor: string): void {
    this.palette = derivePalette(idOrColor);
    this.scheduleRender();
  }

  setEyeColor(hex: string | undefined): void {
    this.eyeColorOverride = hex;
    this.scheduleRender();
  }

  setSize(px: number): void {
    this.size = Math.max(24, px);
    this.applyWrapperSize();
    this.scheduleRender();
  }

  setDepth(depth: number): void {
    this.depth = depth;
    this.surface = remountCanvas(this.surface, this.def, this.depth);
    this.scheduleRender();
  }

  setClay(clay: boolean): void {
    this.clay = clay;
    this.scheduleRender();
  }

  setOrbit(orbit: boolean): void {
    this.orbit = orbit;
    this.scheduleRender();
  }

  setBadge(badge: BadgeKind): void {
    this.badge = badge;
    this.scheduleRender();
  }

  setFollowPointer(follow: boolean): void {
    this.followPointer = follow;
    if (!follow) {
      this.scheduler.setGazeTarget(0, 0);
      this.scheduleRender();
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.blendFrom = null;
    this.scheduler.update(0, reduced);
    this.scheduleRender();
  }

  setSleepWhenIdle(sleep: boolean): void {
    this.sleepWhenIdle = sleep;
    this.wake();
  }

  setView(yaw: number, pitch: number, immediate = false): void {
    if (immediate || this.reducedMotion) {
      this.viewTarget = null;
      this.view = { yaw, pitch };
    } else {
      this.viewTarget = { yaw, pitch };
    }
    this.scheduleRender();
  }

  setGaze(x: number, y: number): void {
    this.scheduler.setGazeTarget(x, y);
    this.wake();
  }

  poke(mood?: AvatarMood): AvatarMood {
    this.beginBlend();
    const picked = this.scheduler.poke(mood);
    this.scheduleRender();
    return picked;
  }

  toSvg(px = 512): string {
    return renderSvg(this.def, { ...this.currentRenderOptions(px), reducedMotion: true });
  }

  getDefinition(): AvatarDefinition {
    return this.def;
  }

  getState() {
    return {
      state: this.scheduler.state,
      mood: this.scheduler.activeMood,
      lockedMood: this.scheduler.lockedMood,
      sleeping: this.sleeping,
      visible: this.visible,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.pauseLoop();
    this.io?.disconnect();
    for (const off of this.cleanupListeners) off();
    this.cleanupListeners = [];
  }
}

// ---------------------------------------------------------------------------
// 原生 Web Component：<grok-bot>

const ATTRS = [
  'shape',
  'color',
  'palette',
  'eye-color',
  'state',
  'mood',
  'size',
  'depth',
  'clay',
  'orbit',
  'badge',
  'follow',
  'sleep-idle',
  'reduced-motion',
] as const;

export class GrokBotElement extends HTMLElement {
  static observedAttributes = [...ATTRS];
  private bot: GrokBot | null = null;
  private mountEl: HTMLDivElement | null = null;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `:host{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;user-select:none}`;
      this.mountEl = document.createElement('div');
      root.append(style, this.mountEl);
    }
    if (!this.bot && this.mountEl) {
      this.bot = new GrokBot({
        container: this.mountEl,
        shape: (this.getAttribute('shape') as ShapeId) || 'circle',
        palette: this.getAttribute('palette') ?? this.getAttribute('color') ?? 'coral',
        eyeColor: this.getAttribute('eye-color') ?? undefined,
        state: (this.getAttribute('state') as AvatarState) || 'idle',
        mood: (this.getAttribute('mood') as AvatarMood | 'auto') || 'auto',
        size: Number(this.getAttribute('size')) || 120,
        depth: this.hasAttribute('depth') ? Number(this.getAttribute('depth')) : 6,
        clay: this.getAttribute('clay') !== 'false',
        orbit: this.hasAttribute('orbit') && this.getAttribute('orbit') !== 'false',
        badge: (this.getAttribute('badge') as BadgeKind) || 'none',
        followPointer: this.getAttribute('follow') !== 'false',
        sleepWhenIdle: this.getAttribute('sleep-idle') !== 'false',
        reducedMotion: this.hasAttribute('reduced-motion') && this.getAttribute('reduced-motion') !== 'false',
      });
    }
  }

  disconnectedCallback(): void {
    this.bot?.destroy();
    this.bot = null;
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null): void {
    if (!this.bot) return;
    switch (name) {
      case 'shape':
        if (newVal) this.bot.setShape(newVal as ShapeId);
        break;
      case 'color':
      case 'palette':
        if (newVal) this.bot.setPalette(newVal);
        break;
      case 'eye-color':
        this.bot.setEyeColor(newVal ?? undefined);
        break;
      case 'state':
        if (newVal) this.bot.setState(newVal as AvatarState);
        break;
      case 'mood':
        this.bot.setMood((newVal as AvatarMood | 'auto' | null) ?? 'auto');
        break;
      case 'size':
        if (newVal) this.bot.setSize(Number(newVal) || 120);
        break;
      case 'depth':
        this.bot.setDepth(newVal === null ? 6 : Number(newVal));
        break;
      case 'clay':
        this.bot.setClay(newVal !== 'false');
        break;
      case 'orbit':
        this.bot.setOrbit(newVal !== null && newVal !== 'false');
        break;
      case 'badge':
        this.bot.setBadge((newVal as BadgeKind) || 'none');
        break;
      case 'follow':
        this.bot.setFollowPointer(newVal !== 'false');
        break;
      case 'sleep-idle':
        this.bot.setSleepWhenIdle(newVal !== 'false');
        break;
      case 'reduced-motion':
        this.bot.setReducedMotion(newVal !== null && newVal !== 'false');
        break;
    }
  }

  poke(mood?: AvatarMood): AvatarMood | undefined {
    const res = this.bot?.poke(mood);
    if (res) this.dispatchEvent(new CustomEvent('grok-poke', { detail: { mood: res } }));
    return res;
  }

  setDefinition(def: AvatarDefinition): void {
    this.bot?.setShape(def);
  }

  toSvg(px = 512): string {
    return this.bot?.toSvg(px) ?? '';
  }

  get instance(): GrokBot | null {
    return this.bot;
  }
}

export function registerGrokBot(tagName = 'grok-bot'): void {
  if (typeof customElements !== 'undefined' && !customElements.get(tagName)) {
    customElements.define(tagName, GrokBotElement);
  }
}
