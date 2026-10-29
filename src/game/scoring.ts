import type { ScanRecord } from './vision'
import { MODEL } from './model.config'

export interface Scores {
  decision: number
  scan: number
  /** null = not tested (a pass into space: there was no teammate position to remember) */
  memory: number | null
  brain: number
}

/** weights, thresholds: MODEL.scoring */
export const WEIGHTS = MODEL.scoring.weights

/** Decision = value of the chosen option / value of the best option. Miss = 0. */
export function decisionScore(chosenValue: number | null, bestValue: number): number {
  if (chosenValue === null) return 0
  if (bestValue <= 0) return 100
  return Math.round(100 * Math.max(0, Math.min(1, chosenValue / bestValue)))
}

/**
 * Scan = timing + target (MODEL.scoring.scan; 60 + 40 by default).
 *   timing: timingFresh if you were looking around in the last recentS before reception,
 *           timingEarly if you only looked earlier
 *   target: targetFresh if the best option was inside your look cone in the last recentS,
 *           targetEarly if you only saw it earlier
 */
export function scanScore(scans: ScanRecord[]): number {
  const { timing, target } = scanParts(scans)
  return timing + target
}

export function scanParts(scans: ScanRecord[]): { timing: number; target: number } {
  const { recentS, scan } = MODEL.scoring
  const timing = scans.some((s) => s.endBefore <= recentS) ? scan.timingFresh : scans.length > 0 ? scan.timingEarly : 0
  const seen = scans.map((s) => s.sawBestBefore).filter((b): b is number => b !== null)
  const target = seen.some((b) => b <= recentS) ? scan.targetFresh : seen.length > 0 ? scan.targetEarly : 0
  return { timing, target }
}

const ramp = (d: number, { perfectM, zeroM }: { perfectM: number; zeroM: number }) =>
  Math.round(100 * Math.max(0, Math.min(1, (zeroM - d) / (zeroM - perfectM))))

/** Memory = how close the tap was to the chosen teammate's true position: scoring.memory.perfectM =
 *  perfect, 0 at zeroM (a pass to feet needs a tap within taps.snapM, so it always scores something). */
export function memoryScore(tapDist: number | null): number {
  return tapDist === null ? 0 : ramp(tapDist, MODEL.scoring.memory)
}

/** Memory for a pass into space: tap vs where your teammate would be when the ball arrived
 *  (space.ts spaceMemory), scoring.spaceMemory: a through ball is meant to lead the runner. */
export function spaceMemoryScore(dist: number): number {
  return ramp(dist, MODEL.scoring.spaceMemory)
}

export function brainScore(s: Omit<Scores, 'brain'>): number {
  if (s.memory === null) return Math.round((WEIGHTS.decision * s.decision + WEIGHTS.scan * s.scan) / (1 - WEIGHTS.memory))
  return Math.round(WEIGHTS.decision * s.decision + WEIGHTS.scan * s.scan + WEIGHTS.memory * s.memory)
}

/** Colour square for the share text. */
export function square(brain: number): string {
  const { green, yellow } = MODEL.scoring.squares
  return brain >= green ? '🟩' : brain >= yellow ? '🟨' : '🟥'
}
