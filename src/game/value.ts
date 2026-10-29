// Expected value of a pass, after Spearman (2017) pitch control and Laurie Shaw's LaurieOnTracking
// (Metrica_PitchControl.py, Metrica_EPV.py):
//
//   P(success)  = logistic of the race margin (space.ts passRisk "slack": how much later than the ball /
//                 the receiver the quickest opponent gets to the ball's path), Spearman-style:
//                   P = 1 / (1 + exp(-pi / (sqrt 3 * sigma) * (slack + bias)))
//                 Spearman's sigma = 0.45 s with no bias scored worse than a constant guess on our data;
//                 bias and sigma are fitted on 991 real DFL passes by calibrate_pass_model.py
//                 (pass_model_calibration.json): bias 1.0 s, sigma 0.95 s, log-loss 0.299 vs 0.375
//                 for the base rate, AUC of the slack 0.86. (Our race model gets defenders to the ball
//                 about a second too early; the bias puts that right.)
//   EV          = P * (EPV(target) - EPV(ball)) - (1 - P) * EPV_opponent(target)
//   EPV         = Shaw's EPV grid (epvGrid.ts, MIT); for the opponents the same grid mirrored
//   points      = EV rescaled linearly to 0-100 (EV_LO -> 0, EV_HI -> 100, clipped) for display/scoring
//
// Coordinates here are the game's portrait metres (u across, v along, attack = up); EPV is looked up
// in data coordinates (x = 105 - v along the pitch towards the opponents' goal, y = 68 - u).
import { EPV_GRID } from './epvGrid'
import { PITCH_L, PITCH_W } from './track'

/** time-to-intercept uncertainty (s), fitted (Spearman / Shaw use 0.45) */
export const TTI_SIGMA = 0.95
/** shift of the race margin (s), fitted: the race model's defenders are a bit too quick */
export const SLACK_BIAS = 1.0
const K = Math.PI / (Math.sqrt(3) * TTI_SIGMA)

/** Probability the pass reaches your team, from the race margin (s; > 0 = your side gets there first). */
export const pSuccess = (slack: number) => 1 / (1 + Math.exp(-K * (slack + SLACK_BIAS)))

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

// Display scale: EV_LO -> 0 and EV_HI -> 100. Set from the spread of all options (passes to feet and
// the spots searched for passes into space, 7,384 in the 42 moments): about the 2nd and 98th percentiles.
// A pass that keeps the attack's value unchanged (EV 0) scores 70.
export const EV_LO = -0.035
export const EV_HI = 0.015
export const toPoints = (ev: number) => Math.round(1000 * Math.max(0, Math.min(1, (ev - EV_LO) / (EV_HI - EV_LO)))) / 10

export function passEV(ball: [number, number], target: [number, number], slack: number): PassEV {
  const p = pSuccess(slack)
  const epvTarget = epvUs(target)
  const ev = p * (epvTarget - epvUs(ball)) - (1 - p) * epvThem(target)
  return { p, epvTarget, ev, points: toPoints(ev) }
}
