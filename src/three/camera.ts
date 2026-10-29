import * as THREE from 'three'
import { PITCH_L, PITCH_W } from './world'

export const EYE_H = 1.75
export const TOP_FOV = 45
/** Max head / gaze turn speed (rad/s): limits motion sickness. */
export const MAX_TURN = THREE.MathUtils.degToRad(150)
const MAX_PITCH_RATE = THREE.MathUtils.degToRad(90)

/** ~90° horizontal FOV, but never more than 100° vertical (portrait phones). */
export function firstPersonFov(aspect: number): number {
  const v = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(Math.PI / 4) / aspect))
  return Math.min(100, v)
}

/** Camera height that fits the whole pitch top-down, attack pointing up the screen. */
export function topDownHeight(aspect: number): number {
  const t = Math.tan(THREE.MathUtils.degToRad(TOP_FOV / 2))
  return Math.max((PITCH_L / 2 + 6) / t, (PITCH_W / 2 + 6) / (t * aspect))
}

const _m = new THREE.Matrix4()
export function topDownPose(aspect: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
  pos.set(0, topDownHeight(aspect), 0)
  _m.lookAt(pos, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)) // screen-up = +X = attack
  quat.setFromRotationMatrix(_m)
}

/** Yaw/pitch (Euler YXZ) that looks from `from` to `to`. */
export function lookAngles(from: THREE.Vector3, to: THREE.Vector3): { yaw: number; pitch: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}

/** Move an angle towards a target at a limited speed (shortest way round). */
export function approachAngle(cur: number, target: number, maxStep: number): number {
  let d = target - cur
  d = Math.atan2(Math.sin(d), Math.cos(d))
  return cur + Math.sign(d) * Math.min(Math.abs(d), maxStep)
}

export interface Gaze {
  yaw: number
  pitch: number
}

/** Rate-limited gaze update towards a target point. */
export function updateGaze(g: Gaze, eye: THREE.Vector3, target: THREE.Vector3, dt: number, yawOffset = 0): void {
  const a = lookAngles(eye, target)
  g.yaw = approachAngle(g.yaw, a.yaw + yawOffset, MAX_TURN * dt)
  const p = THREE.MathUtils.clamp(a.pitch, -0.45, 0.25)
  g.pitch = approachAngle(g.pitch, p, MAX_PITCH_RATE * dt)
}

const _e = new THREE.Euler(0, 0, 0, 'YXZ')
export function gazeQuat(g: Gaze, out: THREE.Quaternion): THREE.Quaternion {
  _e.set(g.pitch, g.yaw, 0, 'YXZ')
  return out.setFromEuler(_e)
}

/**
 * Gaze as a 2D portrait screen angle (0 = up/attack, +PI/2 = right), the convention of
 * the 2D vision cone. World forward (-sin yaw, -cos yaw) maps to portrait (du, dv) = (dZ, -dX).
 */
export function gazeDir2D(yaw: number): number {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw))
}
