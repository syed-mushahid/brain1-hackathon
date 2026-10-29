import { RECENT_SCAN_S, type ScanRecord } from './vision'

export interface Scores {
  decision: number
  scan: number
  /** null = not tested (a pass into space: there was no teammate position to remember) */
  memory: number | null
  brain: number
}

export const WEIGHTS = { decision: 0.5, scan: 0.25, memory: 0.25 }

/** Decision = value of the chosen option / value of the best option. Miss = 0. */
export function decisionScore(chosenValue: number | null, bestValue: number): number {
  if (chosenValue === null) return 0
  if (bestValue <= 0) return 100
  return Math.round(100 * Math.max(0, Math.min(1, chosenValue / bestValue)))
}

/**
 * Scan = timing (max 60) + target (max 40).
 *   timing: 60 if you were looking around in the last 1.5 s before reception,
 *           15 if you only looked earlier
 *   target: 40 if the best option was inside your look cone in the last 1.5 s,
 *           20 if you only saw it earlier
 */
export function scanScore(scans: ScanRecord[]): number {
  const { timing, target } = scanParts(scans)
  return timing + target
}

export function scanParts(scans: ScanRecord[]): { timing: number; target: number } {
  const timing = scans.some((s) => s.endBefore <= RECENT_SCAN_S) ? 60 : scans.length > 0 ? 15 : 0
  const seen = scans.map((s) => s.sawBestBefore).filter((b): b is number => b !== null)
  const target = seen.some((b) => b <= RECENT_SCAN_S) ? 40 : seen.length > 0 ? 20 : 0
  return { timing, target }
}

/** Memory = how close the tap was to the chosen teammate's true position: 1.5 m = perfect, 0 at 6 m
 *  (a pass to feet needs a tap within 5 m, so it always scores something). */
export function memoryScore(tapDist: number | null): number {
  if (tapDist === null) return 0
  const PERFECT_M = 1.5
  const ZERO_M = 6
  return Math.round(100 * Math.max(0, Math.min(1, (ZERO_M - tapDist) / (ZERO_M - PERFECT_M))))
}

/** Memory for a pass into space: tap vs where your teammate would be when the ball arrived
 *  (space.ts spaceMemory). 3 m = perfect, 0 at 12 m: a through ball is meant to lead the runner. */
export function spaceMemoryScore(dist: number): number {
  const PERFECT_M = 3
  const ZERO_M = 12
  return Math.round(100 * Math.max(0, Math.min(1, (ZERO_M - dist) / (ZERO_M - PERFECT_M))))
}

export function brainScore(s: Omit<Scores, 'brain'>): number {
  if (s.memory === null) return Math.round((WEIGHTS.decision * s.decision + WEIGHTS.scan * s.scan) / (1 - WEIGHTS.memory))
  return Math.round(WEIGHTS.decision * s.decision + WEIGHTS.scan * s.scan + WEIGHTS.memory * s.memory)
}

/** Colour square for the share text. */
export function square(brain: number): string {
  return brain >= 75 ? '🟩' : brain >= 50 ? '🟨' : '🟥'
}
