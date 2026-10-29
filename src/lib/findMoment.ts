import type { Moment } from '../types'

/**
 * Moments matching what a tester typed: the exact stable id, else every id containing the text
 * (e.g. "37854" or "WOH-37854"), else every moment at that match clock ("18:30"). Case-insensitive.
 */
export function findMoments(moments: Moment[], query: string): Moment[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const exact = moments.filter((m) => m.id.toLowerCase() === q)
  if (exact.length) return exact
  const byId = moments.filter((m) => m.id.toLowerCase().includes(q))
  if (byId.length) return byId
  return moments.filter((m) => m.clock === q.replace(/′$/, ''))
}

/** "18:30′ · Bochum – Bayern · easy" for lists. */
export const momentLabel = (m: Moment) => `${m.clock}′ · ${m.context.home} – ${m.context.away} · ${m.difficulty}`
