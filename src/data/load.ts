// Loading moments at runtime: the manifest (public/moments/index.json) lists the files; every file is
// validated against the data contract (validate.ts) and prepared by the game's own model (difficulty
// from game/difficulty.ts). A moment that is missing, malformed or can't be prepared is skipped with
// a console warning - it never stops the app. Adding moments = adding files + regenerating the
// manifest; no rebuild.
import type { Moment } from '../types'
import { buildTrack } from '../game/track'
import { momentDifficulty } from '../game/difficulty'
import { validateMoment } from './validate'
import { MOMENTS_DIR, type Manifest } from './manifest'

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

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function loadManifest(): Promise<Manifest> {
  const d = (await fetchJson(`${MOMENTS_DIR}/index.json`)) as Partial<Manifest>
  if (!Array.isArray(d.moments)) throw new Error('moments/index.json has no "moments" list')
  return d as Manifest
}

/**
 * Every moment in the manifest that loads and passes validation, in manifest order.
 * `onProgress(done, total)` is called as files are prepared (the model takes ~10 ms per moment).
 */
export async function loadMoments(onProgress?: (done: number, total: number) => void): Promise<Moment[]> {
  const { moments: entries } = await loadManifest()
  const out: (Moment | null)[] = new Array(entries.length).fill(null)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < entries.length) {
      const k = next++
      const id = entries[k]?.id
      if (typeof id !== 'string') {
        console.warn(`[moments] skipped manifest entry ${k}: no id`)
      } else {
        try {
          const m = prepareMoment(await fetchJson(`${MOMENTS_DIR}/${encodeURIComponent(id)}.json`), `${id}.json`)
          if (m && m.id !== id) console.warn(`[moments] skipped ${id}.json: its id is ${m.id}`)
          else out[k] = m
        } catch (e) {
          console.warn(`[moments] skipped ${id}.json: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      onProgress?.(++done, entries.length)
      await new Promise((r) => setTimeout(r, 0)) // keep the page responsive while the model runs
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker))
  return out.filter((m): m is Moment => m !== null)
}
