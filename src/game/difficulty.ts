// Difficulty from the game's own model (best.ts / value.ts / facts.ts), computed at load time for
// every moment. Thresholds: MODEL.difficulty.
//   n_close = passes within closePoints of the best (to feet, plus the best / brave pass into space)
//   points  = min(n_close - 1, 2)                                  several good options to choose from
//           + (2 if the nearest opponent < pressureHardM, 1 if < pressureMediumM)   time on the ball
//           + (1 if the best option's chance to arrive < safeP)    it has to be played precisely
//   easy    = one obvious option and points <= 1;  hard = points >= hardPoints;  medium = the rest
import type { Difficulty } from '../types'
import { findBestPass, findBravePass, scoredOptions } from './best'
import type { Track } from './track'
import { pressure as pressureAt } from './facts'
import { MODEL } from './model.config'

export interface DifficultyParts {
  difficulty: Difficulty
  nClose: number
  pressure: number
  bestP: number
  points: number
}

export function difficultyParts(tr: Track): DifficultyParts {
  const D = MODEL.difficulty
  const best = findBestPass(tr)
  const brave = findBravePass(tr)
  const values = scoredOptions(tr)
    .filter((o) => !o.offside)
    .map((o) => o.value)
  if (best.intoSpace) values.push(best.o.value)
  if (brave?.intoSpace) values.push(brave.o.value)
  const nClose = Math.max(1, values.filter((v) => v >= best.o.value - D.closePoints).length)
  const pressure = pressureAt(tr)
  const bestP = best.o.p ?? 1
  const points =
    Math.min(nClose - 1, 2) + (pressure < D.pressureHardM ? 2 : pressure < D.pressureMediumM ? 1 : 0) + (bestP < D.safeP ? 1 : 0)
  const difficulty: Difficulty = nClose <= 1 && points <= 1 ? 'easy' : points >= D.hardPoints ? 'hard' : 'medium'
  return { difficulty, nClose, pressure, bestP, points }
}

export const momentDifficulty = (tr: Track): Difficulty => difficultyParts(tr).difficulty
