import type { Profile, RoundRecord } from './profile'
import { dayKey, daysBetween } from './util'

// One-line insights from the saved history (home screen). Presentation only: they read the
// scores the game already saved and never change them.

export type Skill = 'decision' | 'scan' | 'memory'
export interface Insight {
  text: string
  tone: 'up' | 'down' | 'neutral'
}

export const SKILLS: Skill[] = ['decision', 'scan', 'memory']
export const SKILL_NAME: Record<Skill, string> = { decision: 'Decision', scan: 'Scan', memory: 'Memory' }
const WEAK_SPOT: Record<Skill, string> = {
  decision: 'picking the best pass',
  scan: 'looking around before the ball arrives',
  memory: 'remembering where your teammates stand',
}

/** the home insight needs this many saved rounds */
export const INSIGHT_MIN_ROUNDS = 10
/** a weekly change smaller than this (points) isn't worth a line */
const TREND_MIN = 5
/** the weakest skill must trail the other two by this much to be called a weak spot */
const WEAK_GAP = 8

/** Average of one skill over some rounds (memory can be "not tested"), or null without data. */
export function skillAvg(rounds: Pick<RoundRecord, Skill>[], k: Skill): number | null {
  const xs = rounds.map((r) => r[k]).filter((x): x is number => x !== null)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/** "Decision ▲6 this week", else "Your weak spot: …", else nothing; null below INSIGHT_MIN_ROUNDS. */
export function homeInsight(p: Profile, today = dayKey()): Insight | null {
  const h = p.history
  if (h.length < INSIGHT_MIN_ROUNDS) return null
  // this week's rounds against the (up to 20) rounds before them
  const week = h.filter((r) => daysBetween(r.day, today) < 7)
  const older = h.filter((r) => daysBetween(r.day, today) >= 7).slice(-20)
  if (week.length >= 3 && older.length >= 3) {
    const moves = SKILLS.map((k) => {
      const a = skillAvg(week, k)
      const b = skillAvg(older, k)
      return { k, d: a === null || b === null ? 0 : Math.round(a - b) }
    }).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    const top = moves[0]
    if (Math.abs(top.d) >= TREND_MIN)
      return { text: `${SKILL_NAME[top.k]} ${top.d > 0 ? '▲' : '▼'}${Math.abs(top.d)} this week`, tone: top.d > 0 ? 'up' : 'down' }
  }
  const last = h.slice(-20)
  const avgs = SKILLS.map((k) => ({ k, v: skillAvg(last, k) })).filter((x): x is { k: Skill; v: number } => x.v !== null)
  if (avgs.length < 3) return null
  avgs.sort((a, b) => a.v - b.v)
  const [low, ...rest] = avgs
  if (rest.reduce((s, x) => s + x.v, 0) / rest.length - low.v >= WEAK_GAP)
    return { text: `Your weak spot: ${WEAK_SPOT[low.k]}`, tone: 'neutral' }
  return null
}
