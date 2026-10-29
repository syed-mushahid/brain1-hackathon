// Options and the best pass in a moment, valued by expected value (value.ts).
//   scoredOptions: every pass to a teammate's feet (from moments.json), re-valued; offside = 0.
//   findBestPass:  the best of those, the pro's real through ball, and a ring of spots around every
//                  onside teammate raced with the race model (space.ts). The risk is inside the value
//                  (P(success)), so no extra margin or risk filter: a pass into space only has to beat
//                  the best pass to feet by BEST_SPACE_GAIN points.
import type { PassOption } from '../types'
import { FPS, idxOf, PITCH_L, PITCH_W, posAt, toPortrait, type Track } from './track'
import { arrivalTime, NO_OPPONENT_S, offsideBy, offsideLineV, optionAt, passRisk, simulateSpacePass } from './space'
import { passEV } from './value'

export interface BestPass {
  o: PassOption
  idx: number
  intoSpace: boolean
  /** where the ball is played: the receiver's position, or the spot in space */
  end: [number, number]
  /** the receiver's run to that spot (null for a pass to feet) */
  run: [number, number][] | null
  /** when he collects it (s after the pass) */
  t: number
}

const BEST_SPACE_GAIN = 2
const RINGS_M = [4, 8, 12]
const DIRS = 8
/** two passes are the same when they go to the same player and end within this distance */
export const SAME_PASS_M = 5
/** ...and score within this many value points of each other */
export const SAME_VALUE = 5

export const samePass = (a: { idx: number; end: [number, number] }, b: { idx: number; end: [number, number] }) =>
  a.idx === b.idx && Math.hypot(a.end[0] - b.end[0], a.end[1] - b.end[1]) <= SAME_PASS_M

const optCache = new WeakMap<Track, PassOption[]>()

/** Every pass to a teammate's feet, valued by expected value, best first. Offside options are 0. */
export function scoredOptions(tr: Track): PassOption[] {
  const hit = optCache.get(tr)
  if (hit) return hit
  const you = posAt(tr, tr.rec, tr.youIdx)
  const out = tr.m.options
    .map((o): PassOption => {
      const target = posAt(tr, tr.rec, idxOf(tr, o.pid))
      const e = passEV(you, target, passRisk(tr, target)?.slack ?? NO_OPPONENT_S)
      return { ...o, value: o.offside ? 0 : e.points, p: e.p, epv: e.epvTarget, ev: e.ev }
    })
    .sort((a, b) => b.value - a.value)
  optCache.set(tr, out)
  return out
}

const cache = new WeakMap<Track, BestPass>()

export function findBestPass(tr: Track): BestPass {
  const hit = cache.get(tr)
  if (hit) return hit
  const m = tr.m
  const f = tr.rec
  const feetOpt = scoredOptions(tr)[0]
  const feetIdx = idxOf(tr, feetOpt.pid)
  let best: BestPass = { o: feetOpt, idx: feetIdx, intoSpace: false, end: posAt(tr, f, feetIdx), run: null, t: 0 }
  const beats = (v: number) => v > best.o.value && v >= feetOpt.value + BEST_SPACE_GAIN

  // the pro's real through ball (it really happened, so it is always a candidate)
  const tk = m.actual.taker
  let proPass: BestPass | null = null
  if (m.actual.outcome === 'received' && tk) {
    const i = idxOf(tr, tk.pid)
    const end = toPortrait(m.actual.end.x, m.actual.end.y)
    const p = posAt(tr, f, i)
    if (i >= 0 && Math.hypot(end[0] - p[0], end[1] - p[1]) >= SAME_PASS_M) {
      proPass = { o: optionAt(tr, i, end), idx: i, intoSpace: true, end, run: tk.run.map(([x, y]) => toPortrait(x, y)), t: arrivalTime(tr, i, end) }
      if (beats(proPass.o.value)) best = proPass
    }
  }

  // spots around every onside teammate
  const lineV = offsideLineV(tr)
  for (let i = 0; i < tr.n; i++) {
    if (!tr.att[i] || i === tr.youIdx || offsideBy(tr, i, lineV) > 0) continue
    const p = posAt(tr, f, i)
    const a = posAt(tr, Math.max(0, f - 2), i)
    const spots: [number, number][] = [1, 2].map((s) => [p[0] + ((p[0] - a[0]) * FPS * s) / 2, p[1] + ((p[1] - a[1]) * FPS * s) / 2])
    for (const r of RINGS_M)
      for (let k = 0; k < DIRS; k++) spots.push([p[0] + r * Math.cos((k * 2 * Math.PI) / DIRS), p[1] + r * Math.sin((k * 2 * Math.PI) / DIRS)])
    for (const q of spots) {
      if (q[0] < 1 || q[0] > PITCH_W - 1 || q[1] < 1 || q[1] > PITCH_L - 1) continue
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < SAME_PASS_M - 1) continue // that's a pass to his feet
      const o = simulateSpacePass(tr, q)
      if (!o.option || o.offside || !beats(o.option.value)) continue
      best = { o: o.option, idx: o.takerIdx, intoSpace: true, end: o.end, run: o.run, t: o.t }
    }
  }
  // a model spot that is really the pro's pass (same receiver, a few metres off, about the same
  // value) is reported as the pro's real pass: it worked, and "the pro found the best pass" is then true
  if (proPass && best !== proPass && samePass(proPass, best) && proPass.o.value >= best.o.value - SAME_VALUE)
    best = proPass
  cache.set(tr, best)
  return best
}
