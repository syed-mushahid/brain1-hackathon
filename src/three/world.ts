import type { Moment } from '../types'

// three.js world: Y is up. Data (x along the pitch, y across, origin bottom-left)
// maps to X = x - 52.5, Z = 34 - y. Seen from above with screen-up = +X this is the
// 2D portrait view (attack upwards), so it is a rotation of the data, not a mirror.
export const PITCH_L = 105
export const PITCH_W = 68
export const BALL_R = 0.11
export const FPS = 10
const ARC_MIN_M = 20 // pass 1 longer than this gets a parabolic arc (no ball height in moments.json)

export const wx = (x: number) => x - PITCH_L / 2
export const wz = (y: number) => PITCH_W / 2 - y

export interface World {
  m: Moment
  n: number
  nFrames: number
  pids: string[]
  nums: number[]
  att: boolean[]
  youIdx: number
  bestIdx: number
  proIdx: number
  /** [f * n + i] */
  px: Float32Array
  pz: Float32Array
  /** smoothed velocity (m/s), for facing and animation blending */
  vx: Float32Array
  vz: Float32Array
  /** ball X, height, Z per frame */
  bx: Float32Array
  by: Float32Array
  bz: Float32Array
  rec: number
  pass1: number
}

export function buildWorld(m: Moment): World {
  const first = m.frames[0].players
  const pids = first.map((p) => p.pid)
  const index = new Map(pids.map((p, i) => [p, i]))
  const n = pids.length
  const nFrames = m.frames.length
  const px = new Float32Array(nFrames * n)
  const pz = new Float32Array(nFrames * n)
  const bx = new Float32Array(nFrames)
  const by = new Float32Array(nFrames)
  const bz = new Float32Array(nFrames)
  m.frames.forEach((fr, f) => {
    for (const p of fr.players) {
      const i = index.get(p.pid)
      if (i === undefined) continue
      px[f * n + i] = wx(p.x)
      pz[f * n + i] = wz(p.y)
    }
    bx[f] = wx(fr.ball.x)
    bz[f] = wz(fr.ball.y)
    by[f] = fr.ball.z !== undefined ? Math.max(BALL_R, fr.ball.z) : BALL_R
  })

  // no measured ball height: lift long passes on a parabola (peak grows with distance)
  const p1 = m.pass1_frame_index ?? 0
  const rec = m.reception_frame_index
  // (frames after the reception, from plays.json, do carry the measured height)
  const hasZ = m.frames.slice(p1, rec + 1).some((fr) => fr.ball.z !== undefined)
  if (!hasZ && rec > p1) {
    const d = Math.hypot(bx[rec] - bx[p1], bz[rec] - bz[p1])
    if (d > ARC_MIN_M) {
      const peak = Math.min(9, 0.12 * d)
      for (let f = p1; f <= rec; f++) {
        const s = (f - p1) / (rec - p1)
        by[f] = BALL_R + 4 * peak * s * (1 - s)
      }
    }
  }

  // velocity: central difference over +-2 frames (0.4 s) to smooth tracking jitter
  const vx = new Float32Array(nFrames * n)
  const vz = new Float32Array(nFrames * n)
  for (let f = 0; f < nFrames; f++) {
    const a = Math.max(0, f - 2)
    const b = Math.min(nFrames - 1, f + 2)
    const dt = (b - a) / FPS
    for (let i = 0; i < n; i++) {
      vx[f * n + i] = dt > 0 ? (px[b * n + i] - px[a * n + i]) / dt : 0
      vz[f * n + i] = dt > 0 ? (pz[b * n + i] - pz[a * n + i]) / dt : 0
    }
  }

  const proPid = m.actual.intended_pid ?? m.actual.target_pid
  return {
    m,
    n,
    nFrames,
    pids,
    nums: first.map((p) => p.num),
    att: first.map((p) => p.team === 'att'),
    youIdx: index.get(m.you_pid) ?? 0,
    bestIdx: index.get(m.best_option_pid) ?? -1,
    proIdx: proPid ? (index.get(proPid) ?? -1) : -1,
    px,
    pz,
    vx,
    vz,
    bx,
    by,
    bz,
    rec,
    pass1: p1,
  }
}

export interface WorldSample {
  x: Float32Array
  z: Float32Array
  vx: Float32Array
  vz: Float32Array
  ball: [number, number, number]
}

export function makeSample(w: World): WorldSample {
  return {
    x: new Float32Array(w.n),
    z: new Float32Array(w.n),
    vx: new Float32Array(w.n),
    vz: new Float32Array(w.n),
    ball: [0, BALL_R, 0],
  }
}

/** Linear interpolation at fractional frame f (writes into `out`, no allocation). */
export function sampleWorld(w: World, f: number, out: WorldSample): void {
  const fc = Math.max(0, Math.min(w.nFrames - 1, f))
  const f0 = Math.floor(fc)
  const f1 = Math.min(f0 + 1, w.nFrames - 1)
  const t = fc - f0
  const { n } = w
  for (let i = 0; i < n; i++) {
    const a = f0 * n + i
    const b = f1 * n + i
    out.x[i] = w.px[a] + (w.px[b] - w.px[a]) * t
    out.z[i] = w.pz[a] + (w.pz[b] - w.pz[a]) * t
    out.vx[i] = w.vx[a] + (w.vx[b] - w.vx[a]) * t
    out.vz[i] = w.vz[a] + (w.vz[b] - w.vz[a]) * t
  }
  out.ball[0] = w.bx[f0] + (w.bx[f1] - w.bx[f0]) * t
  out.ball[1] = w.by[f0] + (w.by[f1] - w.by[f0]) * t
  out.ball[2] = w.bz[f0] + (w.bz[f1] - w.bz[f0]) * t
}
