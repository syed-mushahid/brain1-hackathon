// A pass into space (a tap away from every teammate): who gets to the ball first?
//
// Simple race model, evaluated with everyone's true position and velocity at reception:
//   ball    rolls from "you" to the tap point at ballSpeed and stops there; passes longer than
//           loftFrom are lofted and can only be reached where they are low (flight())
//   player  keeps running for react seconds, then sprints straight at runSpeed; he can control
//           the ball within reach metres
//   an opponent wins the ball at a point on its path if he gets there before the ball does; anyone
//   wins it at the end point (where you aimed) whenever he gets there (it waits). Teammates go for
//   the end point; only if they lose that race may one of them stop the ball on its way. Earliest winner takes it; a tap outside the pitch
//   nobody reaches in time goes out of play.
// All numbers live in model.config.ts (race, flight, passModel, risk).
import type { PassOption, Team } from '../types'
import { FPS, PITCH_L, PITCH_W, posAt, type Track } from './track'
import { laneOpen, offsideBy, passDirection } from './facts'
export { offsideBy, offsideLineV } from './facts'
import { passEV, pSuccess } from './value'
import { MODEL } from './model.config'

/** race margin used when no opponent can get near the pass at all (P(success) ~ 1) */
export const noOpponentS = () => MODEL.passModel.noOpponentS

export interface RaceParams {
  ballSpeed: number // m/s
  loftFrom: number // m
  react: number // s, opponents: they have to read the pass first
  reactMates: number // s, your teammates: they expect it (they are making the run)
  runSpeed: number // m/s
  reach: number // m
}
// Giving near ties to your teammate was tried: it lost 3 of the real interceptions (they are close
// races), so a tap that matches the pro's pass uses the real outcome instead.
export const RACE: RaceParams = MODEL.race
/**
 * Lofted passes (taps beyond loftFrom, or a pro pass whose measured height went above flight.loftedZ):
 * a launch arc of flight.loftAngleDeg. The ball moves at its ground speed v0·cos(angle) (v0 from the
 * range), can only be reached where it is below flight.reachZ (just after the kick and as it comes
 * down), and the receiver needs flight.controlS extra to control a dropping ball.
 */
const G = 9.81

export interface Flight {
  /** time the ball reaches distance s along its path (s) */
  t: (s: number) => number
  /** height there (m) */
  z: (s: number) => number
  /** can a player reach it there (below head height, and off the passer's feet)? */
  reachable: (s: number) => boolean
  /** arrival at the end of the path, and the extra control time the receiver needs */
  arrive: number
  control: number
}

export function flight(L: number, lofted: boolean, P: RaceParams = RACE): Flight {
  const F = MODEL.flight
  if (!lofted || L < 1e-3)
    return { t: (s) => s / P.ballSpeed, z: () => 0, reachable: (s) => s >= F.startM, arrive: L / P.ballSpeed, control: 0 }
  const a = (F.loftAngleDeg * Math.PI) / 180
  const v0 = Math.sqrt((L * G) / Math.sin(2 * a))
  const vx = v0 * Math.cos(a)
  const z = (s: number) => Math.max(0, s * Math.tan(a) * (1 - s / L))
  return { t: (s) => s / vx, z, reachable: (s) => s >= F.startM && z(s) < F.reachZ, arrive: L / vx, control: F.controlS }
}
const stepM = () => MODEL.flight.stepM
const startM = () => MODEL.flight.startM // the first metre and a half is still at your feet

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
 * Everyone's sprint time to any point, from their true position and velocity at reception.
 * blocks(i, q, t): opponent i is already in the way - while he is still reacting he keeps drifting
 * with his velocity, and if that puts him within reach of the ball's path point q when the ball
 * gets there (time t), the pass is blocked whatever his reaction time ("static blocker").
 */
function race(tr: Track, P: RaceParams) {
  const f = tr.rec
  const you = posAt(tr, f, tr.youIdx)
  const react = (i: number) => (tr.att[i] ? P.reactMates : P.react)
  const starts: [number, number][] = []
  const now: [number, number][] = []
  const vel: [number, number][] = []
  for (let i = 0; i < tr.n; i++) {
    const a = posAt(tr, Math.max(0, f - 2), i)
    const b = posAt(tr, f, i)
    const k = FPS / Math.min(2, f || 1)
    now.push(b)
    vel.push([(b[0] - a[0]) * k, (b[1] - a[1]) * k])
    starts.push([b[0] + vel[i][0] * react(i), b[1] + vel[i][1] * react(i)]) // keeps running the same way while he reacts
  }
  const timeTo = (i: number, q: [number, number]) =>
    react(i) + Math.max(0, Math.hypot(q[0] - starts[i][0], q[1] - starts[i][1]) - P.reach) / P.runSpeed
  const blocks = (i: number, q: [number, number], t: number) => {
    const d = Math.min(t, react(i))
    return Math.hypot(q[0] - now[i][0] - vel[i][0] * d, q[1] - now[i][1] - vel[i][1] * d) <= P.reach
  }
  return { you, starts, timeTo, blocks }
}

/** Risk levels for passRisk's slack, relative to the pros' completed passes (MODEL.risk). */
export const riskLevel = (slack: number): 'low' | 'medium' | 'high' =>
  slack < MODEL.risk.highS ? 'high' : slack < MODEL.risk.mediumS ? 'medium' : 'low'

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

export function passRisk(
  tr: Track,
  target: [number, number],
  tRecv?: number,
  P: RaceParams = RACE,
  lofted?: boolean,
): Risk | null {
  const { you, timeTo, blocks } = race(tr, P)
  const L = Math.hypot(target[0] - you[0], target[1] - you[1])
  if (L < 1e-3) return null
  const ux = (target[0] - you[0]) / L
  const uy = (target[1] - you[1]) / L
  const B = flight(L, lofted ?? L > P.loftFrom, P)
  const tEnd = tRecv ?? B.arrive + B.control
  let best: Risk | null = null
  for (let i = 0; i < tr.n; i++) {
    if (tr.att[i]) continue
    const STEP_M = stepM()
    const blocker = MODEL.passModel.blockerSlack
    for (let s = Math.min(startM(), L); s <= L + 1e-6; s += STEP_M) {
      if (!B.reachable(s) && s < L - STEP_M) continue // over his head
      const q: [number, number] = [you[0] + ux * s, you[1] + uy * s]
      let slack = timeTo(i, q) - (s >= L - STEP_M ? Math.max(B.t(s), tEnd) : B.t(s))
      if (blocker !== null && blocks(i, q, B.t(s))) slack = Math.min(slack, blocker)
      if (!best || slack < best.slack) best = { idx: i, slack, at: q }
    }
  }
  return best
}

/** When teammate `idx` has a ball played to `end` under control: the ball's arrival or his, whichever
 *  is later (plus the control time for a lofted ball). */
export function arrivalTime(tr: Track, idx: number, end: [number, number], P: RaceParams = RACE, lofted?: boolean): number {
  const { you, timeTo } = race(tr, P)
  const L = Math.hypot(end[0] - you[0], end[1] - you[1])
  const B = flight(L, lofted ?? L > P.loftFrom, P)
  return Math.max(B.arrive, timeTo(idx, end)) + B.control
}

/** A pass to `end`, collected there by teammate `idx` at time tWin, valued by its expected value
 *  (value.ts). dist / progress / lane / space are kept as plain facts for the Why? table. */
export function optionAt(
  tr: Track,
  idx: number,
  end: [number, number],
  tWin?: number,
  P: RaceParams = RACE,
  lofted?: boolean,
): PassOption {
  const { you, timeTo } = race(tr, P)
  const dist = Math.hypot(end[0] - you[0], end[1] - you[1])
  const loft = lofted ?? dist > P.loftFrom
  const t = tWin ?? arrivalTime(tr, idx, end, P, loft)
  const defs: [number, number][] = []
  let nearest = Infinity // how much later the quickest opponent reaches the same spot (s)
  for (let i = 0; i < tr.n; i++) {
    if (tr.att[i]) continue
    defs.push(posAt(tr, tr.rec, i))
    nearest = Math.min(nearest, timeTo(i, end) - t)
  }
  const progress = you[1] - end[1] // attack is up the screen
  // a lofted pass can only be blocked where it is low again, as it comes down
  const B = flight(dist, loft, P)
  let k = 0
  if (loft) for (let s = dist; s > 0 && B.reachable(s); s -= stepM()) k = s / dist
  const lane = laneOpen([you[0] + (end[0] - you[0]) * k, you[1] + (end[1] - you[1]) * k], end, defs)
  const space = Math.min(30, Math.max(0, nearest) * P.runSpeed) // that head start, in metres of running
  const ev = passEV(you, end, passRisk(tr, end, t, P, loft)?.slack ?? noOpponentS())
  const r1 = (x: number) => Math.round(x * 10) / 10
  return {
    pid: tr.pids[idx],
    num: tr.nums[idx],
    dist: r1(dist),
    lane_open: r1(lane),
    progress: r1(progress),
    receiver_space: r1(space),
    direction: passDirection(dist, progress),
    value: ev.points,
    p: ev.p,
    epv: ev.epvTarget,
    ev: ev.ev,
  }
}

/**
 * What happens to a pass to `target`. One calculation decides value and outcome together:
 *   1. who on your team gets to it: the quickest teammate to the spot (for a ball rolling out of
 *      play: the first one who can stop it before the line), and when;
 *   2. P(success) of exactly that pass (passRisk -> pSuccess, as in the value);
 *   3. P >= 0.5: he collects it; P < 0.5: the opponent who comes closest to cutting it out
 *      (passRisk) takes it where he meets the ball. Nobody reaches a ball rolling out: out of play.
 * So a pass is completed exactly when it is more likely than not to arrive.
 */
export function simulateSpacePass(tr: Track, target: [number, number], P: RaceParams = RACE, lofted?: boolean): SpaceOutcome {
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
  const at = (s: number): [number, number] => [you[0] + ux * s, you[1] + uy * s]
  const loft = lofted ?? L > P.loftFrom
  const B = flight(L, loft, P)

  // 1. your teammate who gets there first
  let w = -1
  let T = Infinity
  let Q: [number, number] = at(pathL)
  for (let i = 0; i < tr.n; i++) {
    if (!tr.att[i] || i === tr.youIdx) continue
    if (rests) {
      const t = Math.max(B.arrive, timeTo(i, at(L))) + B.control
      if (t < T) [w, T, Q] = [i, t, at(L)]
    } else
      for (let s = Math.min(startM(), pathL); s <= pathL + 1e-6; s += stepM()) {
        if (!B.reachable(s)) continue
        const q = at(s)
        if (timeTo(i, q) <= B.t(s)) {
          if (B.t(s) < T) [w, T, Q] = [i, B.t(s), q]
          break
        }
      }
  }
  // 2. how likely that pass is to arrive (to the line, if nobody can stop it going out)
  const risk = passRisk(tr, w >= 0 ? Q : at(pathL), w >= 0 ? T : undefined, P, loft)
  const p = risk ? pSuccess(risk.slack) : 1
  const run = (i: number, end: [number, number]): [number, number][] => [posAt(tr, tr.rec, i), starts[i], end]
  // 3. the outcome
  if (risk && p < 0.5) {
    const end = risk.at
    return {
      end,
      takerIdx: risk.idx,
      team: 'def',
      run: run(risk.idx, end),
      t: B.t(Math.hypot(end[0] - you[0], end[1] - you[1])),
      rivalIdx: w,
      margin: -(risk.slack + MODEL.passModel.bias),
      option: null,
    }
  }
  if (w < 0) return { end: at(pathL), takerIdx: -1, team: null, run: [], t: B.t(pathL), rivalIdx: -1, margin: 0, option: null }
  return {
    end: Q,
    takerIdx: w,
    team: 'att',
    run: run(w, Q),
    t: T,
    rivalIdx: risk?.idx ?? -1,
    margin: risk ? risk.slack + MODEL.passModel.bias : Infinity,
    ...(offsideBy(tr, w) > 0 ? { option: null, offside: true } : { option: optionAt(tr, w, Q, T, P, loft) }),
  }
}


/**
 * Memory for a pass into space: how far the tap was from where your nearest teammate would be
 * when the ball got there (his position + velocity, carried on for the ball's travel time, at most
 * taps.memoryLookaheadS). You had to remember where he was and where he was going.
 */
export function spaceMemory(tr: Track, tap: [number, number], P: RaceParams = RACE): { idx: number; dist: number } {
  const f = tr.rec
  const you = posAt(tr, f, tr.youIdx)
  const t = Math.min(MODEL.taps.memoryLookaheadS, Math.hypot(tap[0] - you[0], tap[1] - you[1]) / P.ballSpeed)
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

/**
 * "through ball" only when the receiver runs forward onto a ball played behind the defensive line
 * (beyond the deepest outfield defender); any other ball ahead of a teammate is a "pass into space".
 */
export function passKind(tr: Track, idx: number, end: [number, number]): 'through ball' | 'pass into space' {
  const vs: number[] = []
  for (let i = 0; i < tr.n; i++) if (!tr.att[i]) vs.push(posAt(tr, tr.rec, i)[1])
  vs.sort((a, b) => a - b)
  const line = vs[1] ?? 0 // deepest outfield defender (the goalkeeper is the deepest player)
  const from = posAt(tr, tr.rec, idx)
  return end[1] < line && end[1] < from[1] - MODEL.geometry.throughBallM ? 'through ball' : 'pass into space'
}
