// Loading moments: every file is validated against the data contract (validate.ts) and prepared by
// the game's own model (difficulty from game/difficulty.ts). A moment that fails validation or
// can't be prepared is skipped with a console warning - it never stops the app.
import type { Moment } from '../types'
import { buildTrack } from '../game/track'
import { momentDifficulty } from '../game/difficulty'
import { validateMoment } from './validate'

/** Validate and prepare one moment's parsed JSON; null (with a warning) when it is unusable. */
export function prepareMoment(raw: unknown, source: string): Moment | null {
  const v = validateMoment(raw)
  if (!v.ok) {
    console.warn(`[moments] skipped ${source}: ${v.problems.slice(0, 5).join('; ')}`)
    return null
  }
  try {
    return { ...v.value, difficulty: momentDifficulty(buildTrack(v.value)) }
  } catch (e) {
    console.warn(`[moments] skipped ${source}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** All moments from moments.json that pass validation. */
export async function loadMoments(): Promise<Moment[]> {
  const r = await fetch('./moments.json')
  if (!r.ok) throw new Error(`moments.json: HTTP ${r.status}`)
  const d = (await r.json()) as { moments?: unknown[] }
  const list = Array.isArray(d.moments) ? d.moments : []
  return list.map((raw, i) => prepareMoment(raw, `moment #${i + 1}`)).filter((m): m is Moment => m !== null)
}
