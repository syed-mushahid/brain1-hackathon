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
  /** played lofted (a double tap) */
  lofted: boolean
}

/** search settings (fitted with k, see fitRiskAversion.ts): MODEL.best */
export const SEARCH = MODEL.best

type PassRef = { idx: number; end: [number, number]; lofted?: boolean }
/** two passes are the same when they go to the same player, end within best.samePassM and fly the same way */
export const samePass = (a: PassRef, b: PassRef) =>
  a.idx === b.idx && !!a.lofted === !!b.lofted && Math.hypot(a.end[0] - b.end[0], a.end[1] - b.end[1]) <= MODEL.best.samePassM

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
  /** the best pass to each teammate (best.minP+ to arrive), most valuable first (rankedPasses) */
  ranked: BestPass[]
}
const cache = new WeakMap<Track, Choice>()

export const findBestPass = (tr: Track): BestPass => choose(tr).best
export const findBravePass = (tr: Track): BestPass | null => choose(tr).brave
/** The value the best option is chosen by: a pass into space has to make up best.spaceGain first. */
export const rankValue = (c: { o: { value: number }; intoSpace: boolean }) => c.o.value - (c.intoSpace ? MODEL.best.spaceGain : 0)
/**
 * The model's ranking of your options: for every teammate his most valuable pass with at least best.minP
 * to arrive (to feet or into space, either flight), ordered by rankValue - how the best is chosen.
 */
export const rankedPasses = (tr: Track): BestPass[] => choose(tr).ranked

function choose(tr: Track): Choice {
  const hit = cache.get(tr)
  if (hit) return hit
  const m = tr.m
  const f = tr.rec
  const pOf = (c: BestPass) => c.o.p ?? 1
  const { minP, braveGain, spaceGain, runConeDeg, runSpeedMin, ringsM, dirs, samePassM, sameValue, loftMinM } = MODEL.best
  const you = posAt(tr, f, tr.youIdx)
  const far = (q: [number, number]) => Math.hypot(q[0] - you[0], q[1] - you[1]) >= loftMinM

  // every candidate pass: to feet (along the ground, and lofted when far enough), the pro's real
  // pass, spots around every onside teammate (both flights)
  const feet: BestPass[] = []
  for (const o of scoredOptions(tr)) {
    if (o.offside) continue
    const idx = idxOf(tr, o.pid)
    const end = posAt(tr, f, idx)
    feet.push({ o, idx, intoSpace: false, end, run: null, t: 0, lofted: false })
    if (far(end)) {
      const lo = optionAt(tr, idx, end, undefined, RACE, true)
      feet.push({ o: lo, idx, intoSpace: false, end, run: null, t: arrivalTime(tr, idx, end, RACE, true), lofted: true })
    }
  }
  feet.sort((a, b) => b.o.value - a.o.value)
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
        lofted: loft,
      }
      spaces.push(proPass)
    }
  }
  const lineV = offsideLineV(tr)
  // only spots a tap can actually play: not within reach of a teammate's feet (taps.snapM) or of the
  // spot where the pro's completed pass was collected (taps.proSnapM: that tap, with the pro's flight,
  // replays the real pass)
  const proSpot = m.actual.outcome === 'received' && tk && idxOf(tr, tk.pid) >= 0 ? toPortrait(m.actual.end.x, m.actual.end.y) : null
  const proLoft = proLofted(m)
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
      const nearPro = !!proSpot && Math.hypot(q[0] - proSpot[0], q[1] - proSpot[1]) <= MODEL.taps.proSnapM
      if (runConeDeg !== null && running) {
        const off = Math.acos(((q[0] - p[0]) * vx + (q[1] - p[1]) * vy) / (Math.hypot(q[0] - p[0], q[1] - p[1]) * Math.hypot(vx, vy)))
        if (off > (runConeDeg * Math.PI) / 180) continue // not where his run is taking him
      }
      for (const loft of far(q) ? [false, true] : [false]) {
        if (nearPro && loft === proLoft) continue // a tap there plays the pro's pass
        const o = simulateSpacePass(tr, q, RACE, loft)
        if (o.offside) continue
        if (o.option) spaces.push({ o: o.option, idx: o.takerIdx, intoSpace: true, end: o.end, run: o.run, t: o.t, lofted: loft })
        else if (o.team === 'def' && o.rivalIdx >= 0 && tr.att[o.rivalIdx] && offsideBy(tr, o.rivalIdx, lineV) <= 0) {
          // lost in the race: still a (brave) candidate, valued for your quickest teammate there
          const t = arrivalTime(tr, o.rivalIdx, q, RACE, loft)
          spaces.push({ o: optionAt(tr, o.rivalIdx, q, t, RACE, loft), idx: o.rivalIdx, intoSpace: true, end: q, run: null, t, lofted: loft })
        }
      }
    }
  }

  // best = highest value with at least minP to arrive; a pass into space must also beat the
  // best such pass to feet by spaceGain (otherwise the simpler pass is the best)
  const safeFeet = feet.filter((c) => pOf(c) >= minP)
  let best: BestPass =
    safeFeet[0] ??
    [...feet, ...spaces].sort((x, y) => pOf(y) - pOf(x))[0] ?? // nothing safe: the likeliest pass
    { o: scoredOptions(tr)[0], idx: idxOf(tr, scoredOptions(tr)[0].pid), intoSpace: false, end: posAt(tr, f, idxOf(tr, scoredOptions(tr)[0].pid)), run: null, t: 0, lofted: false }
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

  const top = new Map<number, BestPass>()
  for (const c of [...feet, ...spaces])
    if (pOf(c) >= minP && (!top.has(c.idx) || rankValue(c) > rankValue(top.get(c.idx)!))) top.set(c.idx, c)
  const ranked = [...top.values()].sort((a, b) => rankValue(b) - rankValue(a))
  const choice = { best, brave, ranked }
  cache.set(tr, choice)
  return choice
}
