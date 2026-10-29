// What "you" can see. Angles are in screen space of the portrait pitch:
// 0 = straight up (towards the opponent goal), +PI/2 = right, -PI/2 = left.

const DEG = Math.PI / 180

/** Always visible: a bubble around "you" and around the ball (m). */
export const VISION_R = 10
export const VISION_FEATHER = 3
/** A look reveals a cone: ~100° wide is about what a player takes in with one glance. */
export const CONE_HALF = 50 * DEG
const CONE_EDGE = 10 * DEG // soft angular edge
/** Beyond this distance you can't read the play anymore (m). */
export const CONE_RANGE = 50
const RANGE_FEATHER = 8
/** A head can't snap round: max turn speed (rad/s). Looking behind takes ~0.5 s. */
export const HEAD_TURN = 360 * DEG
/** Looks in the last 1.5 s before reception count as "recent". */
export const RECENT_SCAN_S = 1.5

/** One continuous look (hold on the dial or the pitch). Times = seconds before reception. */
export interface ScanRecord {
  dir: number
  startBefore: number
  endBefore: number
  /** latest moment the best option was inside your cone, or null if never */
  sawBestBefore: number | null
}

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export function dirTo(u0: number, v0: number, u1: number, v1: number): number {
  return Math.atan2(u1 - u0, -(v1 - v0))
}

/** Move an angle towards a target at a limited speed, the short way round. */
export function turnTowards(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur)
  return wrapAngle(cur + Math.sign(d) * Math.min(Math.abs(d), maxStep))
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** 0..1: how visible point (u, v) is inside the look cone from (yu, yv) facing `dir`. */
export function coneVis(u: number, v: number, yu: number, yv: number, dir: number): number {
  const d = Math.hypot(u - yu, v - yv)
  if (d < 0.5) return 1
  const off = Math.abs(wrapAngle(dirTo(yu, yv, u, v) - dir))
  return clamp01((CONE_HALF - off) / CONE_EDGE + 0.5) * clamp01((CONE_RANGE - d) / RANGE_FEATHER + 0.5)
}

/** Plain-language location of a point relative to "you" (attack = up). */
export function whereIs(yu: number, yv: number, u: number, v: number): string {
  const a = dirTo(yu, yv, u, v) / DEG
  if (Math.abs(a) <= 30) return 'ahead of you'
  if (Math.abs(a) >= 150) return 'behind you'
  return a > 0 ? 'on your right' : 'on your left'
}
