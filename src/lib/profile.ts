import type { Difficulty, Moment } from '../types'
import type { RoundSettings } from '../game/Round'
import type { Scores } from '../game/scoring'
import { dayKey, daysBetween, hashString, isoWeek, load, mulberry32, save, shuffle } from './util'

const KEY = 'scan-and-play/profile/v1'

export type Level = 'easy' | 'normal' | 'hard'

export interface RoundRecord extends Scores {
  /** stable moment id (<match_id>-<reception_frame>) */
  id: string
  day: string
}

export interface Profile {
  history: RoundRecord[] // newest last
  level: Level
  levelChangedAt: number // history length when the level last changed
  /** times played, by stable moment id */
  played: Record<string, number>
  /** freezeDay: the day the weekly freeze saved the streak (shown on Home that day only) */
  streak: { count: number; lastDay: string | null; freezeWeek: string | null; freezeDay?: string | null }
  daily: { day: string; brains: number[]; score: number } | null
  muted: boolean
  proMode: boolean // training scan phase in 3D first-person
}

const EMPTY: Profile = {
  history: [],
  level: 'normal',
  levelChangedAt: 0,
  played: {},
  streak: { count: 0, lastDay: null, freezeWeek: null },
  daily: null,
  muted: false,
  proMode: false,
}

export const loadProfile = (): Profile => load(KEY, EMPTY)
export const saveProfile = (p: Profile): void => save(KEY, p)

// ---------------------------------------------------------------- ratings
export interface Ratings {
  scan: number
  memory: number
  decision: number
  overall: number
  rounds: number
}

/** the player card shows numbers from this many rounds on (before that: "play 5 rounds to unlock") */
export const RATING_MIN_ROUNDS = 5

/** Rolling average of the last 20 rounds (50 = starting value). */
export function ratings(p: Profile): Ratings {
  const last = p.history.slice(-20)
  const avg = (k: keyof Scores) => {
    const xs = last.map((r) => r[k]).filter((x): x is number => x !== null) // memory may be "not tested"
    return xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 50
  }
  return { scan: avg('scan'), memory: avg('memory'), decision: avg('decision'), overall: avg('brain'), rounds: p.history.length }
}

// ---------------------------------------------------------------- adaptive difficulty
export const LEVEL_SETTINGS: Record<Level, RoundSettings> = {
  easy: { scanBudgetMs: 2600, speed: 0.85, decideMs: 2500 },
  normal: { scanBudgetMs: 2000, speed: 1, decideMs: 2000 },
  hard: { scanBudgetMs: 1500, speed: 1.2, decideMs: 2000 },
}
const LEVEL_POOL: Record<Level, Difficulty[]> = {
  easy: ['easy', 'easy', 'medium'],
  normal: ['medium', 'medium', 'easy', 'hard'],
  hard: ['hard', 'hard', 'medium'],
}
const ORDER: Level[] = ['easy', 'normal', 'hard']

/**
 * Record a round and adapt: if the last 3 rounds average above 80 go one level harder,
 * below 50 one level easier (at most one step per 3 rounds). Brain Score >= 60 counts
 * as a success; the 50/80 band keeps players around a 70-80 % success rate.
 */
export function recordRound(p: Profile, id: string, s: Scores): Profile {
  const history = [...p.history, { id, day: dayKey(), ...s }].slice(-100)
  let { level, levelChangedAt } = p
  if (history.length - levelChangedAt >= 3) {
    const last3 = history.slice(-3)
    const avg = last3.reduce((a, r) => a + r.brain, 0) / 3
    const i = ORDER.indexOf(level)
    const next = avg > 80 ? ORDER[Math.min(2, i + 1)] : avg < 50 ? ORDER[Math.max(0, i - 1)] : level
    if (next !== level) {
      level = next
      levelChangedAt = history.length
    }
  }
  return { ...p, history, level, levelChangedAt, played: { ...p.played, [id]: (p.played[id] ?? 0) + 1 } }
}

/** Next training moment for the current level: preferred difficulty, least played first. */
export function pickTraining(p: Profile, moments: Moment[], exclude: string[]): Moment {
  const pool = LEVEL_POOL[p.level]
  const want = pool[Math.floor(Math.random() * pool.length)]
  const fresh = moments.filter((m) => !exclude.includes(m.id))
  const cands = fresh.filter((m) => m.difficulty === want)
  const list = cands.length ? cands : fresh.length ? fresh : moments
  const minPlayed = Math.min(...list.map((m) => p.played[m.id] ?? 0))
  const least = list.filter((m) => (p.played[m.id] ?? 0) === minPlayed)
  return least[Math.floor(Math.random() * least.length)]
}

// ---------------------------------------------------------------- daily challenge
/** Same 5 moments for everyone today: 2 easy, 2 medium, 1 hard, seeded by the date. Picked from the
 *  loaded manifest by stable id, so the order of the manifest doesn't matter. */
export function dailyMoments(moments: Moment[], day = dayKey()): Moment[] {
  const rnd = mulberry32(hashString(`scan-and-play:${day}`))
  const sorted = [...moments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const take = (d: Difficulty, n: number) =>
    shuffle(
      sorted.filter((m) => m.difficulty === d),
      rnd,
    ).slice(0, n)
  const picked = [...take('easy', 2), ...take('medium', 2), ...take('hard', 1)]
  // a difficulty with too few moments: top up from the rest, so the challenge always has 5
  const rest = shuffle(
    sorted.filter((m) => !picked.includes(m)),
    rnd,
  )
  return [...picked, ...rest].slice(0, 5)
}

// ---------------------------------------------------------------- streak
export interface StreakView {
  count: number
  doneToday: boolean
  freezeAvailable: boolean
  atRisk: boolean // missed yesterday, the weekly freeze will save it today
  savedToday: boolean // the freeze saved the streak today
}

export function streakView(p: Profile, today = dayKey()): StreakView {
  const { count, lastDay, freezeWeek } = p.streak
  const freezeAvailable = freezeWeek !== isoWeek(today)
  const savedToday = p.streak.freezeDay === today
  if (!lastDay) return { count: 0, doneToday: false, freezeAvailable, atRisk: false, savedToday }
  const gap = daysBetween(lastDay, today)
  if (gap <= 1) return { count, doneToday: gap === 0, freezeAvailable, atRisk: false, savedToday }
  if (gap === 2 && freezeAvailable) return { count, doneToday: false, freezeAvailable, atRisk: true, savedToday }
  return { count: 0, doneToday: false, freezeAvailable, atRisk: false, savedToday }
}

/** Called when a session is finished. One missed day per week is covered by a free freeze. */
export function completeDay(p: Profile, today = dayKey()): { profile: Profile; usedFreeze: boolean } {
  const s = p.streak
  if (s.lastDay === today) return { profile: p, usedFreeze: false }
  const gap = s.lastDay ? daysBetween(s.lastDay, today) : Infinity
  let count = 1
  let freezeWeek = s.freezeWeek
  let usedFreeze = false
  if (gap === 1) count = s.count + 1
  else if (gap === 2 && s.freezeWeek !== isoWeek(today)) {
    count = s.count + 1
    freezeWeek = isoWeek(today)
    usedFreeze = true
  }
  return { profile: { ...p, streak: { count, lastDay: today, freezeWeek, freezeDay: usedFreeze ? today : (s.freezeDay ?? null) } }, usedFreeze }
}
