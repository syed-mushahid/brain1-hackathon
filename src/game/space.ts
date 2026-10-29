// A pass into space (a tap away from every teammate): who gets to the ball first?
//
// Simple race model, evaluated with everyone's true position and velocity at reception:
//   ball    rolls from "you" to the tap point at ballSpeed and stops there; passes longer than
//           loftFrom are lofted and can only be reached in the last LOFT_LANDING share of the flight
//   player  keeps running for react seconds, then sprints straight at runSpeed; he can control
//           the ball within reach metres
//   an opponent wins the ball at a point on its path if he gets there before the ball does; anyone
//   wins it at the end point (where you aimed) whenever he gets there (it waits). Teammates go for
//   the end point; only if they lose that race may one of them stop the ball on its way. Earliest winner takes it; a tap outside the pitch
//   nobody reaches in time goes out of play.
// The numbers are fitted to the 30 real moments: with the pro's actual pass as the "tap", the model
// should name the player who really won the ball (see RACE).
import type { PassOption, Team } from '../types'
import { FPS, PITCH_L, PITCH_W, posAt, type Track } from './track'

export interface RaceParams {
  ballSpeed: number // m/s
  loftFrom: number // m
  react: number // s, opponents: they have to read the pass first
  reactMates: number // s, your teammates: they expect it (they are making the run)
  runSpeed: number // m/s
  reach: number // m
}
// fitted on the 30 moments: the right team wins the ball in 25 / 30 (pro pass as the tap: 19 / 24
// completed, 6 / 6 intercepted). Giving near ties to your teammate was tried: it lost 3 of the real
// interceptions (they are close races), so a tap that matches the pro's pass uses the real outcome instead.
export const RACE: RaceParams = { ballSpeed: 15, loftFrom: 30, react: 0.5, reactMates: 0.4, runSpeed: 7, reach: 1 }
const LOFT_LANDING = 0.2
const STEP_M = 0.5
const START_M = 1.5 // the first metre and a half is still at your feet

// Same option value as extract_moments.py (VALUE_PARAMS / option_value)
const V = {
  wLane: 0.3,
  wProgress: 0.5,
  wSpace: 0.2,
  laneFull: 5,
  laneBlock: 2,
  spaceFull: 6,
  progMin: -10,
  progMax: 25,
  longFrom: 25,
  longPerM: 0.5,
  longMax: 15,
}
const clip01 = (x: number) => Math.max(0, Math.min(1, x))

export function optionValue(dist: number, laneOpen: number, progress: number, space: number): number {
  const base =
    100 *
    (V.wLane * clip01(laneOpen / V.laneFull) +
      V.wProgress * clip01((progress - V.progMin) / (V.progMax - V.progMin)) +
      V.wSpace * clip01(space / V.spaceFull))
  const penalty = Math.min(V.longMax, V.longPerM * Math.max(0, dist - V.longFrom))
  return Math.max(0, Math.min(100, base * clip01(laneOpen / V.laneBlock) - penalty))
}

/** Distance from the nearest defender ahead of the passer to the pass line (capped at 30 m). */
function laneOpen(a: [number, number], b: [number, number], defs: [number, number][]): number {
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

export interface SpaceOutcome {
  /** where the ball was won, or where it crossed the line */
  end: [number, number]
  /** -1 = nobody: out of play */
  takerIdx: number
  team: Team | null
  /** the taker's run from his position at reception to the ball */
  run: [number, number][]
  /** seconds after the pass the ball was won */
  t: number
  /** fastest player of the other team, and how much later he would have got there (s) */
  rivalIdx: number
  margin: number
  /** the pass scored like a normal option, when a teammate wins it */
  option: PassOption | null
  /** your tap matched the pro's real pass: this is what really happened, not the model */
  asPro?: boolean
  /** the teammate who got it was offside when you passed: free kick to the opponents */
  offside?: boolean
}

/**
 * Offside (Law 11), same rule as offside_line() in extract_moments.py: judged when you pass (the
 * reception frame); a teammate is offside in the opponents' half when nearer their goal line than
 * both the ball and the second-last opponent, by more than OFFSIDE_TOL_M (tracking noise).
 * Portrait coordinates: attack is up (smaller v). Returns the v of the line.
 */
export const OFFSIDE_TOL_M = 0.5
export function offsideLineV(tr: Track): number {
  const vs: number[] = []
  for (let i = 0; i < tr.n; i++) if (!tr.att[i]) vs.push(posAt(tr, tr.rec, i)[1])
  vs.sort((a, b) => a - b)
  return Math.min(vs[1] ?? PITCH_L, tr.ball[tr.rec * 2 + 1], PITCH_L / 2) - OFFSIDE_TOL_M
}
/** metres a teammate is beyond the offside line (> 0 = offside) */
export const offsideBy = (tr: Track, i: number, lineV = offsideLineV(tr)) => lineV - posAt(tr, tr.rec, i)[1]

/** Everyone's sprint time to any point, from their true position and velocity at reception. */
function race(tr: Track, P: RaceParams) {
  const f = tr.rec
  const you = posAt(tr, f, tr.youIdx)
  const react = (i: number) => (tr.att[i] ? P.reactMates : P.react)
  const starts: [number, number][] = []
  for (let i = 0; i < tr.n; i++) {
    const a = posAt(tr, Math.max(0, f - 2), i)
    const b = posAt(tr, f, i)
    const k = (FPS / Math.min(2, f || 1)) * react(i) // keeps running the same way while he reacts
    starts.push([b[0] + (b[0] - a[0]) * k, b[1] + (b[1] - a[1]) * k])
  }
  const timeTo = (i: number, q: [number, number]) =>
    react(i) + Math.max(0, Math.hypot(q[0] - starts[i][0], q[1] - starts[i][1]) - P.reach) / P.runSpeed
  return { you, starts, timeTo }
}

/** Where on the path to `target` (length L) the ball can first be reached, by distance from "you". */
const reachableFrom = (L: number, P: RaceParams) => (L > P.loftFrom ? L * (1 - LOFT_LANDING) : START_M)

/**
 * Risk levels for passRisk's slack. The model is too simple to say "this pass would be cut out"
 * (it can't see which way players face), so the levels are relative to the pros: of the 24 real
 * completed pro passes in moments.json, 6 were tighter than RISK_HIGH_S and 16 tighter than RISK_MEDIUM_S.
 */
export const RISK_HIGH_S = -0.5
export const RISK_MEDIUM_S = 0.3
export const riskLevel = (slack: number): 'low' | 'medium' | 'high' =>
  slack < RISK_HIGH_S ? 'high' : slack < RISK_MEDIUM_S ? 'medium' : 'low'

/**
 * The closest an opponent comes to winning a pass from "you" to `target`, received there at time
 * tRecv (s): slack = how much later than the ball (or than the receiver, at the end) he gets there.
 * Negative slack = he would cut it out. Null when no opponent can get near it.
 */
export interface Risk {
  idx: number
  slack: number
  /** where he would meet the ball */
  at: [number, number]
}

export function passRisk(tr: Track, target: [number, number], tRecv?: number, P: RaceParams = RACE): Risk | null {
  const { you, timeTo } = race(tr, P)
  const L = Math.hypot(target[0] - you[0], target[1] - you[1])
  if (L < 1e-3) return null
  const ux = (target[0] - you[0]) / L
  const uy = (target[1] - you[1]) / L
  const tEnd = tRecv ?? L / P.ballSpeed
  let best: Risk | null = null
  for (let i = 0; i < tr.n; i++) {
    if (tr.att[i]) continue
    for (let s = Math.min(reachableFrom(L, P), L); s <= L + 1e-6; s += STEP_M) {
      const q: [number, number] = [you[0] + ux * s, you[1] + uy * s]
      const slack = timeTo(i, q) - (s >= L - STEP_M ? Math.max(s / P.ballSpeed, tEnd) : s / P.ballSpeed)
      if (!best || slack < best.slack) best = { idx: i, slack, at: q }
    }
  }
  return best
}

/** When teammate `idx` can collect a ball played to `end`: the ball's arrival or his, whichever is later. */
export function arrivalTime(tr: Track, idx: number, end: [number, number], P: RaceParams = RACE): number {
  const { you, timeTo } = race(tr, P)
  return Math.max(Math.hypot(end[0] - you[0], end[1] - you[1]) / P.ballSpeed, timeTo(idx, end))
}

/** A pass to `end`, collected there by teammate `idx` at time tWin, scored like a normal option. */
export function optionAt(tr: Track, idx: number, end: [number, number], tWin?: number, P: RaceParams = RACE): PassOption {
  const { you, timeTo } = race(tr, P)
  const dist = Math.hypot(end[0] - you[0], end[1] - you[1])
  const t = tWin ?? Math.max(dist / P.ballSpeed, timeTo(idx, end))
  const defs: [number, number][] = []
  let nearest = Infinity // how much later the quickest opponent reaches the same spot (s)
  for (let i = 0; i < tr.n; i++) {
    if (tr.att[i]) continue
    defs.push(posAt(tr, tr.rec, i))
    nearest = Math.min(nearest, timeTo(i, end) - t)
  }
  const progress = you[1] - end[1] // attack is up the screen
  // a lofted pass can only be blocked where it comes down (same rule as the race)
  const k = dist > P.loftFrom ? 1 - LOFT_LANDING : 0
  const lane = laneOpen([you[0] + (end[0] - you[0]) * k, you[1] + (end[1] - you[1]) * k], end, defs)
  const space = Math.min(30, Math.max(0, nearest) * P.runSpeed) // that head start, in metres of running
  const r1 = (x: number) => Math.round(x * 10) / 10
  return {
    pid: tr.pids[idx],
    num: tr.nums[idx],
    dist: r1(dist),
    lane_open: r1(lane),
    progress: r1(progress),
    receiver_space: r1(space),
    direction: progress >= 3 && progress >= dist / 2 ? 'forward' : progress <= -3 && -progress >= dist / 2 ? 'backward' : 'sideways',
    value: r1(optionValue(dist, lane, progress, space)),
  }
}

export function simulateSpacePass(tr: Track, target: [number, number], P: RaceParams = RACE): SpaceOutcome {
  // teammates go for the spot you aimed at; only when that race is lost may one of them stop the
  // ball on its way there (before the opponent who would win it)
  const aimed = race1(tr, target, P, false)
  if (aimed.team === 'att') return aimed
  const onWay = race1(tr, target, P, true)
  return onWay.team === 'att' ? onWay : aimed
}

function race1(tr: Track, target: [number, number], P: RaceParams, matesOnPath: boolean): SpaceOutcome {
  const { you, starts, timeTo } = race(tr, P)
  // ball path, cut at the touchline / goal line
  const dx = target[0] - you[0]
  const dy = target[1] - you[1]
  const L = Math.hypot(dx, dy)
  const ux = dx / Math.max(L, 1e-6)
  const uy = dy / Math.max(L, 1e-6)
  const inside = (u: number, v: number) => u >= 0 && u <= PITCH_W && v >= 0 && v <= PITCH_L
  let pathL = L
  for (let s = 0; s <= L; s += 0.25) {
    if (!inside(you[0] + ux * s, you[1] + uy * s)) {
      pathL = Math.max(0, s - 0.25)
      break
    }
  }
  const rests = pathL >= L - 1e-6 // the ball stops at the tap point (it is on the pitch)
  const reachFrom = reachableFrom(L, P)
  const at = (s: number): [number, number] => [you[0] + ux * s, you[1] + uy * s]

  // earliest time each player can have the ball, and where
  const T = new Array<number>(tr.n).fill(Infinity)
  const Q: [number, number][] = new Array(tr.n)
  for (let i = 0; i < tr.n; i++) {
    if (i === tr.youIdx) continue
    const onPath = !tr.att[i] || matesOnPath || !rests // (a teammate may stop a ball rolling out of play)
    for (let s = Math.min(reachFrom, pathL); onPath && s <= pathL + 1e-6; s += STEP_M) {
      const q = at(s)
      const tb = s / P.ballSpeed
      if (timeTo(i, q) <= tb) {
        T[i] = tb
        Q[i] = q
        break
      }
    }
    if (rests && T[i] === Infinity) {
      const q = at(L)
      T[i] = Math.max(L / P.ballSpeed, timeTo(i, q))
      Q[i] = q
    }
  }
  let win = -1
  for (let i = 0; i < tr.n; i++) if (T[i] < Infinity && (win < 0 || T[i] < T[win])) win = i
  if (win < 0) {
    return { end: at(pathL), takerIdx: -1, team: null, run: [], t: pathL / P.ballSpeed, rivalIdx: -1, margin: 0, option: null }
  }
  const team: Team = tr.att[win] ? 'att' : 'def'
  let rival = -1
  for (let i = 0; i < tr.n; i++)
    if (i !== tr.youIdx && tr.att[i] !== tr.att[win] && T[i] < Infinity && (rival < 0 || T[i] < T[rival])) rival = i
  const end = Q[win]
  return {
    end,
    takerIdx: win,
    team,
    run: [posAt(tr, tr.rec, win), starts[win], end],
    t: T[win],
    rivalIdx: rival,
    margin: rival >= 0 ? T[rival] - T[win] : Infinity,
    ...(team === 'att' && offsideBy(tr, win) > 0
      ? { option: null, offside: true }
      : { option: team === 'att' ? optionAt(tr, win, end, T[win], P) : null }),
  }
}

/** "0.4 s", or "a split second" when the race was too close to call. */
export const gap = (s: number) => (s < 0.05 ? 'a split second' : `${s.toFixed(1)} s`)

/**
 * Memory for a pass into space: how far the tap was from where your nearest teammate would be
 * when the ball got there (his position + velocity, carried on for the ball's travel time, at most
 * MEMORY_LOOKAHEAD_S). You had to remember where he was and where he was going.
 */
const MEMORY_LOOKAHEAD_S = 2.5
export function spaceMemory(tr: Track, tap: [number, number], P: RaceParams = RACE): { idx: number; dist: number } {
  const f = tr.rec
  const you = posAt(tr, f, tr.youIdx)
  const t = Math.min(MEMORY_LOOKAHEAD_S, Math.hypot(tap[0] - you[0], tap[1] - you[1]) / P.ballSpeed)
  let best = { idx: -1, dist: Infinity }
  for (let i = 0; i < tr.n; i++) {
    if (!tr.att[i] || i === tr.youIdx) continue
    const p = posAt(tr, f, i)
    const a = posAt(tr, Math.max(0, f - 2), i)
    const k = (FPS / Math.min(2, f || 1)) * t
    const d = Math.hypot(tap[0] - (p[0] + (p[0] - a[0]) * k), tap[1] - (p[1] + (p[1] - a[1]) * k))
    if (d < best.dist) best = { idx: i, dist: d }
  }
  return best
}
