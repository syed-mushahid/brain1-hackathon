import type { MomentData } from '../types'

// Portrait pitch: the attacking team plays bottom -> top.
//   u = across the pitch, 0..68 (left -> right on screen)
//   v = along the pitch, 0..105 (top = opponent goal, bottom = own goal)
// This is a 90° rotation of the data (not a mirror), so left/right wings stay correct.
export const PITCH_W = 68
export const PITCH_L = 105
export const FPS = 10

export function toPortrait(x: number, y: number): [number, number] {
  return [PITCH_W - y, PITCH_L - x]
}

/** A moment converted to flat typed arrays for fast per-frame sampling. */
export interface Track {
  m: MomentData
  n: number
  nFrames: number
  pids: string[]
  nums: number[]
  att: boolean[]
  youIdx: number
  /** [frame][player][u, v] */
  pos: Float32Array
  /** [frame][u, v] */
  ball: Float32Array
  rec: number
  pass1: number
}

export function buildTrack(m: MomentData): Track {
  const first = m.frames[0].players
  const pids = first.map((p) => p.pid)
  const index = new Map(pids.map((pid, i) => [pid, i]))
  const n = pids.length
  const nFrames = m.frames.length
  const pos = new Float32Array(nFrames * n * 2)
  const ball = new Float32Array(nFrames * 2)
  m.frames.forEach((fr, f) => {
    for (const p of fr.players) {
      const i = index.get(p.pid)
      if (i === undefined) continue
      const [u, v] = toPortrait(p.x, p.y)
      pos[(f * n + i) * 2] = u
      pos[(f * n + i) * 2 + 1] = v
    }
    const [bu, bv] = toPortrait(fr.ball.x, fr.ball.y)
    ball[f * 2] = bu
    ball[f * 2 + 1] = bv
  })
  return {
    m,
    n,
    nFrames,
    pids,
    nums: first.map((p) => p.num),
    att: first.map((p) => p.team === 'att'),
    youIdx: index.get(m.you_pid) ?? 0,
    pos,
    ball,
    rec: m.reception_frame_index,
    pass1: m.pass1_frame_index ?? 0,
  }
}

/** Linear interpolation between the 10 fps frames; f is a fractional frame index. */
export function sample(tr: Track, f: number, outPos: Float32Array, outBall: Float32Array): void {
  const fc = Math.max(0, Math.min(tr.nFrames - 1, f))
  const i0 = Math.floor(fc)
  const i1 = Math.min(i0 + 1, tr.nFrames - 1)
  const w = fc - i0
  const len = tr.n * 2
  const a = i0 * len
  const b = i1 * len
  for (let k = 0; k < len; k++) outPos[k] = tr.pos[a + k] * (1 - w) + tr.pos[b + k] * w
  outBall[0] = tr.ball[i0 * 2] * (1 - w) + tr.ball[i1 * 2] * w
  outBall[1] = tr.ball[i0 * 2 + 1] * (1 - w) + tr.ball[i1 * 2 + 1] * w
}

/** Player position at an integer frame. */
export function posAt(tr: Track, f: number, i: number): [number, number] {
  const k = (f * tr.n + i) * 2
  return [tr.pos[k], tr.pos[k + 1]]
}

export function idxOf(tr: Track, pid: string | null): number {
  return pid === null ? -1 : tr.pids.indexOf(pid)
}
