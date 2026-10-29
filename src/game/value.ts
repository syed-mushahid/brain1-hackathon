// Expected value of a pass, after Spearman (2017) pitch control and Laurie Shaw's LaurieOnTracking
// (Metrica_PitchControl.py, Metrica_EPV.py):
//
//   P(success)  = logistic of the race margin (space.ts passRisk "slack": how much later than the ball /
//                 the receiver the quickest opponent gets to the ball's path), Spearman-style:
//                   P = 1 / (1 + exp(-pi / (sqrt 3 * sigma) * (slack + bias)))
//                 sigma and bias in model.config.ts (passModel), fitted by calibrate_pass_model.py
//   EV          = P * (EPV(target) - EPV(ball)) - (1 - P) * k * EPV_opponent(target)
//                 k = risk aversion (model.config.ts value.k)
//   EPV         = Shaw's EPV grid (epvGrid.ts, MIT); for the opponents the same grid mirrored
//   points      = EV rescaled linearly to 0-100 (EV_LO -> 0, EV_HI -> 100, clipped) for display/scoring
//
// Coordinates here are the game's portrait metres (u across, v along, attack = up); EPV is looked up
// in data coordinates (x = 105 - v along the pitch towards the opponents' goal, y = 68 - u).
import { EPV_GRID } from './epvGrid'
import { PITCH_L, PITCH_W } from './track'
import { MODEL } from './model.config'

/** Probability the pass reaches your team, from the race margin (s; > 0 = your side gets there first).
 *  sigma and bias: MODEL.passModel. */
export function pSuccess(slack: number): number {
  const { sigma, bias } = MODEL.passModel
  return 1 / (1 + Math.exp((-Math.PI / (Math.sqrt(3) * sigma)) * (slack + bias)))
}

/** The race margin (s) that gives chance p: the inverse of pSuccess. */
export function slackFor(p: number): number {
  const { sigma, bias } = MODEL.passModel
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p))
  return (Math.log(q / (1 - q)) * Math.sqrt(3) * sigma) / Math.PI - bias
}

const ROWS = EPV_GRID.length
const COLS = EPV_GRID[0].length

/** EPV at data coordinates (x along the pitch, attacking +x), bilinear between cell centres. */
export function epvAt(x: number, y: number): number {
  const cx = Math.max(0, Math.min(COLS - 1, (x / PITCH_L) * COLS - 0.5))
  const cy = Math.max(0, Math.min(ROWS - 1, (y / PITCH_W) * ROWS - 0.5))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(COLS - 1, x0 + 1)
  const y1 = Math.min(ROWS - 1, y0 + 1)
  const tx = cx - x0
  const ty = cy - y0
  const top = EPV_GRID[y0][x0] * (1 - tx) + EPV_GRID[y0][x1] * tx
  const bot = EPV_GRID[y1][x0] * (1 - tx) + EPV_GRID[y1][x1] * tx
  return top * (1 - ty) + bot * ty
}

/** EPV for your team at a portrait point, and for the opponents (attacking the other way). */
export const epvUs = ([u, v]: [number, number]) => epvAt(PITCH_L - v, PITCH_W - u)
export const epvThem = ([u, v]: [number, number]) => epvAt(v, u)

export interface PassEV {
  /** P(success) */
  p: number
  /** EPV where the ball would be won (your team) */
  epvTarget: number
  /** expected value of the pass (change in your team's EPV) */
  ev: number
  /** ev on the 0-100 display scale */
  points: number
}

/** k (risk aversion) and the display scale lo -> 0, hi -> 100: MODEL.value (fitted by fitRiskAversion.ts) */
export const VALUE = MODEL.value
export const toPoints = (ev: number) => Math.round(1000 * Math.max(0, Math.min(1, (ev - VALUE.lo) / (VALUE.hi - VALUE.lo)))) / 10

export function passEV(ball: [number, number], target: [number, number], slack: number): PassEV {
  const p = pSuccess(slack)
  const epvTarget = epvUs(target)
  const ev = p * (epvTarget - epvUs(ball)) - (1 - p) * VALUE.k * epvThem(target)
  return { p, epvTarget, ev, points: toPoints(ev) }
}
