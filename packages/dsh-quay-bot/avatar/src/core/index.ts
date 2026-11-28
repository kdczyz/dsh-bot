/** 公共入口：定义契约、校验、体积推断、帧数据与两个渲染器。 */
export type { AvatarDefinition, AvatarEyes, AvatarMood, AvatarState, RenderOptions, ValidationResult } from './types.ts';
export { validateAvatar, analyzeBody, eyeClearance, gazeRange, EYE_W, EYE_H, GAZE_X, GAZE_Y, HAPPY_ARC } from './validate.ts';
export type { BodyAnalysis, BodySubpath, BodyHole, GazeRange } from './validate.ts';
export { buildVolume, boostedEyeScale, faceRoom, MAX_PART_DEPTH, EYE_BOOST, EYE_BOOST_PAD, FACE_ROOM_TARGET } from './volume.ts';
export type { Volume, VolumePart, VolumeSlice, EyePlane, FaceRoom } from './volume.ts';
export {
  computeFrame,
  prepare,
  avatarExtent,
  viewBasis,
  planeMatrix,
  sidePlaneMatrix,
  projectPoint,
  activeStack,
  pivotOf,
  DEFAULT_COLOR,
  DEFAULT_DEPTH,
  DEFAULT_EYE_COLOR,
} from './frame.ts';
export type { Frame, FramePath, FrameShape, EyeMark, Matrix, ViewBasis, Prepared } from './frame.ts';
export { renderSvg, placeholderSvg } from './svg.ts';
export { mountCanvas, paintFrame, fitSquare } from './paint.ts';
export type { Surface, Square } from './paint.ts';
export {
  computePose,
  blendPoses,
  blinkAt,
  wanderAt,
  hashString,
  noise,
  STATES,
  MOODS,
  BASE_YAW,
  BASE_PITCH,
  DONE_CYCLE_S,
  DONE_TURN_S,
} from './pose.ts';
export type { Pose, EyeLook, PoseInput } from './pose.ts';
export { eyePath, eyeOutline, plainLook } from './eyes.ts';
export type { EyeSpot } from './eyes.ts';
export { autoEyeColor, contrast, oklch, parseHex, toHex, toOklch } from './color.ts';
export type { Rgb } from './color.ts';
export { bodyScale, markParts, rimOf, ribbonPieces } from './fx.ts';
export type { Box, MarkPart, RibbonPiece, Rim } from './fx.ts';
export { parsePath, serializePath, flattenPath, winding, insideRow, bounds, filledArea, edgeBands, PathError, PATH_LIMITS } from './path.ts';
export type { Segment, Point, Bounds } from './path.ts';
export { contourLoops, loopsToPath, simplifyLoop, segDist2 } from './field.ts';
export type { Field, Grid } from './field.ts';