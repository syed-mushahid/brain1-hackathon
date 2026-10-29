// Difficulty from the game's own pass values (best.ts / value.ts) - the same rule as
// difficulty() in extract_moments.py, which used the old heuristic values:
//   n_close = passes within CLOSE_POINTS of the best (to feet, plus the best / brave pass into space)
//   points  = min(n_close - 1, 2) + (2 if the nearest defender < 2.5 m, 1 if < 5 m, else 0)
//   easy    = one obvious option and points <= 1;  hard = points >= 3;  medium = the rest
import type { Difficulty } from '../types'
import { findBestPass, findBravePass, scoredOptions } from './best'
import type { Track } from './track'
import { pressure as pressureAt } from './facts'

const CLOSE_POINTS = 10

export function momentDifficulty(tr: Track): Difficulty {
  const best = findBestPass(tr)
  const brave = findBravePass(tr)
  const values = scoredOptions(tr)
    .filter((o) => !o.offside)
    .map((o) => o.value)
  if (best.intoSpace) values.push(best.o.value)
  if (brave?.intoSpace) values.push(brave.o.value)
  const nClose = values.filter((v) => v >= best.o.value - CLOSE_POINTS).length
  const pressure = pressureAt(tr)
  const points = Math.min(Math.max(nClose, 1) - 1, 2) + (pressure < 2.5 ? 2 : pressure < 5 ? 1 : 0)
  if (nClose <= 1 && points <= 1) return 'easy'
  if (points >= 3) return 'hard'
  return 'medium'
}
