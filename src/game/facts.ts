// Plain facts about a moment at the decision (the reception frame), computed by the game from the
// raw frames - the data files hold no derived values:
//   teammateOptions  every pass to a teammate's feet: distance, open lane, progress, space, direction, offside
//   pressure         distance from you to the nearest opponent (m)
//   proLofted        whether the pro's real pass was lofted (measured height, or its length as fallback)
//   offsideLineV     the offside line (Law 11) when you pass
import type { Direction, MomentData, OptionFacts } from '../types'
import { PITCH_L, posAt, type Track } from './track'
import { MODEL } from './model.config'

/**
 * 'forward' | 'sideways' | 'backward', by the angle to the opponents' goal line:
 * forward = at least geometry.directionMinM ahead and within 60° of straight ahead (progress >= dist / 2).
 */
export function passDirection(dist: number, progress: number): Direction {
  const min = MODEL.geometry.directionMinM
  if (progress >= min && progress >= dist / 2) return 'forward'
  if (progress <= -min && -progress >= dist / 2) return 'backward'
  return 'sideways'
}

/** Distance from the nearest defender ahead of the passer to the pass line (capped at 30 m). */
export function laneOpen(a: [number, number], b: [number, number], defs: [number, number][]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L2 = dx * dx + dy * dy
  let best = 30
  for (const [u, v] of defs) {
    const t = ((u - a[0]) * dx + (v - a[1]) * dy) / Math.max(L2, 1e-6)
    if (t <= 0) continue // behind the passer
    const k = Math.min(1, t)
    best = Math.min(best, Math.hypot(u - (a[0] + dx * k), v - (a[1] + dy * k)))
  }
  return best
}

/**
 * Offside (Law 11), judged when you pass (the reception frame): a teammate is offside in the
 * opponents' half when nearer their goal line than both the ball and the second-last opponent, by
 * more than geometry.offsideTolM (tracking noise). Portrait coordinates: attack is up (smaller v).
 * Returns the v of the line.
 */
export function offsideLineV(tr: Track): number {
  const vs: number[] = []
  for (let i = 0; i < tr.n; i++) if (!tr.att[i]) vs.push(posAt(tr, tr.rec, i)[1])
  vs.sort((a, b) => a - b)
  return Math.min(vs[1] ?? PITCH_L, tr.ball[tr.rec * 2 + 1], PITCH_L / 2) - MODEL.geometry.offsideTolM
}
/** metres a teammate is beyond the offside line (> 0 = offside) */
export const offsideBy = (tr: Track, i: number, lineV = offsideLineV(tr)) => lineV - posAt(tr, tr.rec, i)[1]

const r1 = (x: number) => Math.round(x * 10) / 10

function defenders(tr: Track): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < tr.n; i++) if (!tr.att[i]) out.push(posAt(tr, tr.rec, i))
  return out
}

const optCache = new WeakMap<Track, OptionFacts[]>()

/** Every pass to a teammate's feet at the reception frame, as plain facts (not valued yet). */
export function teammateOptions(tr: Track): OptionFacts[] {
  const hit = optCache.get(tr)
  if (hit) return hit
  const you = posAt(tr, tr.rec, tr.youIdx)
  const defs = defenders(tr)
  const lineV = offsideLineV(tr)
  const out: OptionFacts[] = []
  for (let i = 0; i < tr.n; i++) {
    if (!tr.att[i] || i === tr.youIdx) continue
    const p = posAt(tr, tr.rec, i)
    const dist = Math.hypot(p[0] - you[0], p[1] - you[1])
    const progress = you[1] - p[1] // attack is up the screen
    const space = Math.min(...defs.map(([u, v]) => Math.hypot(u - p[0], v - p[1])))
    out.push({
      pid: tr.pids[i],
      num: tr.nums[i],
      dist: r1(dist),
      lane_open: r1(laneOpen(you, p, defs)),
      progress: r1(progress),
      receiver_space: r1(space),
      direction: passDirection(dist, progress),
      offside: offsideBy(tr, i, lineV) > 0,
    })
  }
  optCache.set(tr, out)
  return out
}

/** Distance from you to the nearest opponent at the reception (m). */
export function pressure(tr: Track): number {
  const [u, v] = posAt(tr, tr.rec, tr.youIdx)
  return Math.min(...defenders(tr).map(([a, b]) => Math.hypot(a - u, b - v)))
}

/** Was the pro's real pass lofted? Measured height when the file has it (flight.loftedZ), else the
 *  documented fallback: longer than race.loftFrom, like your own taps. */
export function proLofted(m: MomentData): boolean {
  return m.actual.ball_max_z !== undefined ? m.actual.ball_max_z > MODEL.flight.loftedZ : m.actual.length > MODEL.race.loftFrom
}
