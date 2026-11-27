/**
 * Grok 风格 Agent 头像引擎公共导出。
 *
 * - 纯数学与调度层（ring / spring / scheduler / shapes / palettes / effects）零 DOM 依赖，
 *   适合直接嵌入 Web 应用、DeepSeek harness 或转译至 Android Canvas / Flutter。
 * - GrokBot 与 <grok-bot> Web Component 可零依赖嵌入任意宿主。
 */
export * from './ring.ts';
export * from './spring.ts';
export * from './scheduler.ts';
export * from './shapes.ts';
export * from './palettes.ts';
export * from './effects.ts';
export * from './clay.ts';
export * from './grok-bot.ts';
