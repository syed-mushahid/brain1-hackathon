// Options and the best pass in a moment, valued by expected value (value.ts).
//   scoredOptions: every pass to a teammate's feet (facts.ts), valued; offside = 0.
//   findBestPass:  the best of those, the pro's real through ball, and a ring of spots around every
//                  onside teammate raced with the race model (space.ts), among passes with at least
//                  best.minP chance to arrive; a pass into space has to beat the best pass to feet by
//                  best.spaceGain points.
//   findBravePass: a pass worth more than the best but below best.minP to arrive (the gamble).
// All numbers: model.config.ts (best).
import type { PassOption } from '../types'
import { FPS, idxOf, PITCH_L, PITCH_W, posAt, toPortrait, type Track } from './track'
import { arrivalTime, noOpponentS, offsideBy, offsideLineV, optionAt, passRisk, RACE, simulateSpacePass } from './space'
import { passEV } from './value'
import { proLofted, teammateOptions } from './facts'
import { MODEL } from './model.config'

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

/** search settings (fitted with k, see fitRiskAversion.ts): MODEL.best */
export const SEARCH = MODEL.best

/** two passes are the same when they go to the same player and end within best.samePassM */
export const samePass = (a: { idx: number; end: [number, number] }, b: { idx: number; end: [number, number] }) =>
  a.idx === b.idx && Math.hypot(a.end[0] - b.end[0], a.end[1] - b.end[1]) <= MODEL.best.samePassM

const optCache = new WeakMap<Track, PassOption[]>()

/** Every pass to a teammate's feet, valued by expected value, best first. Offside options are 0. */
export function scoredOptions(tr: Track): PassOption[] {
  const hit = optCache.get(tr)
  if (hit) return hit
  const you = posAt(tr, tr.rec, tr.youIdx)
  const out = teammateOptions(tr)
    .map((o): PassOption => {
      const target = posAt(tr, tr.rec, idxOf(tr, o.pid))
      const e = passEV(you, target, passRisk(tr, target)?.slack ?? noOpponentS())
      return { ...o, value: o.offside ? 0 : e.points, p: e.p, epv: e.epvTarget, ev: e.ev }
    })
    .sort((a, b) => b.value - a.value)
  optCache.set(tr, out)
  return out
}

interface Choice {
  best: BestPass
  /** worth more than the best but below best.minP to arrive; null if there is none */
  brave: BestPass | null
}
const cache = new WeakMap<Track, Choice>()

export const findBestPass = (tr: Track): BestPass => choose(tr).best
export const findBravePass = (tr: Track): BestPass | null => choose(tr).brave

function choose(tr: Track): Choice {
  const hit = cache.get(tr)
  if (hit) return hit
  const m = tr.m
  const f = tr.rec
  const pOf = (c: BestPass) => c.o.p ?? 1
  const { minP, braveGain, spaceGain, runConeDeg, runSpeedMin, ringsM, dirs, samePassM, sameValue } = MODEL.best

  // every candidate pass: to feet, the pro's real through ball, spots around every onside teammate
  const feet: BestPass[] = scoredOptions(tr)
    .filter((o) => !o.offside)
    .map((o) => {
      const idx = idxOf(tr, o.pid)
      return { o, idx, intoSpace: false, end: posAt(tr, f, idx), run: null, t: 0 }
    })
  const spaces: BestPass[] = []
  const tk = m.actual.taker
  let proPass: BestPass | null = null
  if (m.actual.outcome === 'received' && tk) {
    const i = idxOf(tr, tk.pid)
    const end = toPortrait(m.actual.end.x, m.actual.end.y)
    const p = posAt(tr, f, i)
    // valued with its measured flight (lofted when the ball went above 1.8 m); a lofted pass to
    // feet is a candidate too, since it isn't the ground pass to that teammate the options hold
    const loft = proLofted(m)
    const intoSpace = Math.hypot(end[0] - p[0], end[1] - p[1]) >= samePassM
    if (i >= 0 && (intoSpace || loft)) {
      const e: [number, number] = intoSpace ? end : p
      proPass = {
        o: optionAt(tr, i, e, undefined, RACE, loft),
        idx: i,
        intoSpace,
        end: e,
        run: intoSpace ? tk.run.map(([x, y]) => toPortrait(x, y)) : null,
        t: arrivalTime(tr, i, e, RACE, loft),
      }
      spaces.push(proPass)
    }
  }
  const lineV = offsideLineV(tr)
  // only spots a tap can actually play: not within reach of a teammate's feet (taps.snapM) or of the
  // spot where the pro's completed pass was collected (taps.proSnapM: that tap replays the real pass)
  const proSpot = m.actual.outcome === 'received' && tk && idxOf(tr, tk.pid) >= 0 ? toPortrait(m.actual.end.x, m.actual.end.y) : null
  const mates: [number, number][] = []
  for (let i = 0; i < tr.n; i++) if (tr.att[i] && i !== tr.youIdx) mates.push(posAt(tr, f, i))
  for (let i = 0; i < tr.n; i++) {
    if (!tr.att[i] || i === tr.youIdx || offsideBy(tr, i, lineV) > 0) continue
    const p = posAt(tr, f, i)
    const a = posAt(tr, Math.max(0, f - 2), i)
    const spots: [number, number][] = [1, 2].map((s) => [p[0] + ((p[0] - a[0]) * FPS * s) / 2, p[1] + ((p[1] - a[1]) * FPS * s) / 2])
    for (const r of ringsM)
      for (let k = 0; k < dirs; k++) spots.push([p[0] + r * Math.cos((k * 2 * Math.PI) / dirs), p[1] + r * Math.sin((k * 2 * Math.PI) / dirs)])
    const vx = ((p[0] - a[0]) * FPS) / 2
    const vy = ((p[1] - a[1]) * FPS) / 2
    const running = Math.hypot(vx, vy) > runSpeedMin
    for (const q of spots) {
      if (q[0] < 1 || q[0] > PITCH_W - 1 || q[1] < 1 || q[1] > PITCH_L - 1) continue
      if (mates.some((m) => Math.hypot(q[0] - m[0], q[1] - m[1]) <= MODEL.taps.snapM)) continue // a tap there is a pass to feet
      if (proSpot && Math.hypot(q[0] - proSpot[0], q[1] - proSpot[1]) <= MODEL.taps.proSnapM) continue // a tap there plays the pro's pass
      if (runConeDeg !== null && running) {
        const off = Math.acos(((q[0] - p[0]) * vx + (q[1] - p[1]) * vy) / (Math.hypot(q[0] - p[0], q[1] - p[1]) * Math.hypot(vx, vy)))
        if (off > (runConeDeg * Math.PI) / 180) continue // not where his run is taking him
      }
      const o = simulateSpacePass(tr, q)
      if (o.offside) continue
      if (o.option) spaces.push({ o: o.option, idx: o.takerIdx, intoSpace: true, end: o.end, run: o.run, t: o.t })
      else if (o.team === 'def' && o.rivalIdx >= 0 && tr.att[o.rivalIdx] && offsideBy(tr, o.rivalIdx, lineV) <= 0) {
        // lost in the race: still a (brave) candidate, valued for your quickest teammate there
        const t = arrivalTime(tr, o.rivalIdx, q)
        spaces.push({ o: optionAt(tr, o.rivalIdx, q, t), idx: o.rivalIdx, intoSpace: true, end: q, run: null, t })
      }
    }
  }

  // best = highest value with at least minP to arrive; a pass into space must also beat the
  // best such pass to feet by spaceGain (otherwise the simpler pass is the best)
  const safeFeet = feet.filter((c) => pOf(c) >= minP)
  let best: BestPass =
    safeFeet[0] ??
    [...feet, ...spaces].sort((x, y) => pOf(y) - pOf(x))[0] ?? // nothing safe: the likeliest pass
    { o: scoredOptions(tr)[0], idx: idxOf(tr, scoredOptions(tr)[0].pid), intoSpace: false, end: posAt(tr, f, idxOf(tr, scoredOptions(tr)[0].pid)), run: null, t: 0 }
  const feetBest = best.o.value
  for (const c of spaces)
    if (pOf(c) >= minP && c.o.value > best.o.value && c.o.value >= feetBest + spaceGain) best = c
  // a model spot that is really the pro's pass (same receiver, a few metres off, about the same
  // value) is reported as the pro's real pass: it worked, and "the pro found the best pass" is then true
  if (proPass && best !== proPass && pOf(proPass) >= minP && samePass(proPass, best) && proPass.o.value >= best.o.value - sameValue)
    best = proPass

  // brave = the highest value below minP, if it clearly beats the best
  let brave: BestPass | null = null
  for (const c of [...feet, ...spaces])
    if (pOf(c) < minP && c.o.value >= best.o.value + braveGain && (!brave || c.o.value > brave.o.value)) brave = c

  const choice = { best, brave }
  cache.set(tr, choice)
  return choice
}
