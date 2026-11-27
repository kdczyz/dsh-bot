/**
 * 头像定义契约 v1。
 *
 * 定义只描述几何：一条 100×100 坐标系里的单色轮廓路径，以及一对眼睛的位置。
 * 颜色、隐含体积、视角、凝视、眨眼、动效全部由运行时渲染器决定。
 */

export interface AvatarEyes {
  /** 眼睛对的中心，viewBox 单位。 */
  x: number;
  y: number;
  /** 两眼中心距，viewBox 单位。 */
  spacing: number;
  /** 1 = 单只中性眼睛约宽 4、高 11。 */
  scale: number;
}

export interface AvatarDefinition {
  version: 1;
  /** 小写 slug，例如 "controller"。 */
  id: string;
  /** 展示用名称。 */
  name: string;
  /** 一条填充路径，nonzero 填充；孔洞反向绕行。 */
  body: { path: string };
  eyes: AvatarEyes;
}

export type AvatarState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'alert';
/**
 * 表情（15 种）。它只改“脸”（眼睛形状、开合、闪烁、高光），以及一点点身体倾向；
 * 状态决定“在干什么”，表情决定“看起来怎么样”。两者可以任意组合。
 */
export type AvatarMood =
  | 'neutral'
  | 'happy'
  | 'joy'
  | 'love'
  | 'surprised'
  | 'curious'
  | 'skeptical'
  | 'sleepy'
  | 'bored'
  | 'sad'
  | 'angry'
  | 'focused'
  | 'confused'
  | 'shy'
  | 'smug';

export type BadgeKind = 'none' | 'red' | 'blue';

export interface RingPoint {
  x: number;
  y: number;
}

export interface RenderOptions {
  /** 身体颜色 #rgb / #rrggbb，非法值回落到默认色。 */
  color?: string;
  /** 高光颜色（用于黏土质感左上角渐变）。 */
  highlightColor?: string;
  /** 阴影颜色（用于黏土质感右下角内阴影）。 */
  shadowColor?: string;
  /** 眼睛颜色，默认近黑墨色。 */
  eyeColor?: string;
  /** 渲染尺寸（CSS px）；省略则为流式 SVG。 */
  size?: number;
  /** 体积量 0..14，默认 6；0 = 完全扁平。 */
  depth?: number;
  /** 是否叠加伪 3D 黏土质感（左上角高光 + 右下角内阴影）。默认 true。 */
  clay?: boolean;
  /** 在静止视角之上叠加的视角旋转（弧度）。 */
  view?: { yaw: number; pitch: number };
  /** 动画时钟（秒）。同样的输入永远得到同样的输出。 */
  time?: number;
  /** 注视目标，每轴 -1..1（x 向右，y 向下）。 */
  gaze?: { x: number; y: number; weight?: number };
  state?: AvatarState;
  mood?: AvatarMood;
  /** 状态开始后经过的秒数；`done` 用它驱动庆祝动作。 */
  stateAge?: number;
  /** 冻结身体动作、眨眼、彩带与标记，只保留凝视。 */
  reducedMotion?: boolean;
  /** 额外叠加一个表情（0..1 权重），用来做“表情闪现”或外部驱动的瞬时反应。 */
  expression?: { mood: AvatarMood; weight?: number };
  /**
   * 从上一帧的姿态缓动到这一帧：`from` 通常是上一帧返回的 `frame.pose`，
   * `t` 0..1。状态与表情的切换都靠它变得有过渡，而不是硬切。
   */
  poseBlend?: { from: PoseLike; t: number };
  /** 外部弹簧引擎输出的 48 点闭合眼环（左右眼，单位：eyes.scale = 1 时的 viewBox）。 */
  eyeRings?: [RingPoint[], RingPoint[]];
  /** 独立眨眼纵向缩放（1 = 睁开，0.08 = 闭眼），配合 `eyeRings` 使用。 */
  blinkScale?: number;
  /** 是否显示外围轨道粒子。 */
  orbit?: boolean;
  /** 通知角标（红点 / 蓝点）。 */
  badge?: BadgeKind;
}

/**
 * 眼睛怎么画，全部是数值，于是任意两种 look 都能插值成中间形状。
 * 六个形状轴 + 眨眼/高光两个辅助量。
 */
export interface EyeLook {
  /** 0 = 普通药丸，1 = 开心弧。 */
  arc: number;
  /** 0 = 普通药丸，1 = 等待时的扁平细缝。 */
  slit: number;
  /** 0..1，惊讶：眼睛更高更圆。 */
  wide: number;
  /** 0..1，闪光星。 */
  star: number;
  /** -1..1，眼轴倾斜（负 = 内角朝下）。 */
  tilt: number;
  /** 0..1，上眼皮下垂。 */
  lid: number;
  /** 0..1，高光。 */
  glint: number;
}

/**
 * 一帧姿态的全部数值。它是纯函数的结果，也可以作为 `poseBlend.from`
 * 从“屏幕上正在显示的样子”继续缓动到新姿态。
 */
export interface PoseLike {
  yaw: number;
  pitch: number;
  roll: number;
  lift: number;
  sx: number;
  sy: number;
  gazeX: number;
  gazeY: number;
  blink: number;
  squintL: number;
  squintR: number;
  eyes: EyeLook;
  ribbons: number;
  cage: number;
  sweep: number;
  bang: number;
  dots: number;
  /** 完成态的粒子绽放强度，0..1。 */
  bloom: number;
  /** 粒子绽放已经进行了几秒（粒子自己的时间轴）。 */
  bloomAge: number;
}

export type ValidationResult =
  | { ok: true; value: AvatarDefinition }
  | { ok: false; errors: string[] };