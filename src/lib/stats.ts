import type { RoundResult } from '../game/evaluate'

// Lifetime counts for the Statistics screen. They are counters (the round history only keeps the
// last 100 rounds) and start on `since` - rounds played before they existed weren't counted.

export interface Stats {
  since: string
  rounds: number
  /** you found the best option (or one as good) */
  best: number
  /** the game said "Better than the pro!" */
  betterThanPro: number
  /** you played the pro's pass */
  sameAsPro: number
  /** your pass was cut out by an opponent */
  intercepted: number
  /** no pass in time */
  tooSlow: number
}

export type RoundTags = Omit<Stats, 'since' | 'rounds'>

export const emptyStats = (since: string): Stats => ({ since, rounds: 0, best: 0, betterThanPro: 0, sameAsPro: 0, intercepted: 0, tooSlow: 0 })

/** What a round adds to the statistics (1 or 0 each). */
export function roundTags(res: RoundResult): RoundTags {
  const n = (b: boolean) => (b ? 1 : 0)
  return {
    best: n(res.mineIsBest),
    betterThanPro: n(res.headline === 'Better than the pro!'),
    sameAsPro: n(res.mineIsPro),
    intercepted: n(!!res.lost || res.space?.team === 'def'),
    tooSlow: n(!res.tap),
  }
}

export function addRound(s: Stats, t: RoundTags): Stats {
  return {
    since: s.since,
    rounds: s.rounds + 1,
    best: s.best + t.best,
    betterThanPro: s.betterThanPro + t.betterThanPro,
    sameAsPro: s.sameAsPro + t.sameAsPro,
    intercepted: s.intercepted + t.intercepted,
    tooSlow: s.tooSlow + t.tooSlow,
  }
}
