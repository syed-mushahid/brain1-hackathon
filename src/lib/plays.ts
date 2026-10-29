import type { MomentData, Play } from '../types'
import { MOMENTS_DIR } from '../data/manifest'
import { validatePlay } from '../data/validate'

// The rest of each play (reception -> pass -> takeover), from public/moments/<id>.play.json. Only
// fetched when a replay is watched, so the game itself starts with the moment files alone.
export type { Play }

/** A moment with its play appended, plus where the pass and the takeover happen (frame indices). */
export interface PlayedMoment extends MomentData {
  kickFrame: number
  takeFrame: number
}

const cache = new Map<string, Promise<Play>>()

/** The replay data of one moment (validated); rejects when there is none. */
export function loadPlay(id: string): Promise<Play> {
  let p = cache.get(id)
  if (!p) {
    p = fetch(`${MOMENTS_DIR}/${encodeURIComponent(id)}.play.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${id}.play.json: HTTP ${r.status}`))))
      .then((raw: unknown) => {
        const v = validatePlay(raw, id)
        if (!v.ok) throw new Error(`${id}.play.json: ${v.problems.slice(0, 3).join('; ')}`)
        return v.value
      })
      .catch((e) => {
        cache.delete(id) // let a later attempt retry
        throw e
      })
    cache.set(id, p)
  }
  return p
}

export function withPlay(m: MomentData, play: Play): PlayedMoment {
  const rec = m.reception_frame_index
  return {
    ...m,
    frames: [...m.frames.slice(0, rec + 1), ...play.frames.slice(1)],
    kickFrame: rec + play.kick_index,
    takeFrame: rec + play.take_index,
  }
}

export async function loadPlayedMoment(m: MomentData): Promise<PlayedMoment> {
  return withPlay(m, await loadPlay(m.id))
}
