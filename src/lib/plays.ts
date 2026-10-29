import type { MomentData, Play } from '../types'

// The rest of each play (reception -> pass -> takeover), from plays.json. Only fetched when a
// replay is watched, so the game itself starts with moments.json alone.
export type { Play }

/** A moment with its play appended, plus where the pass and the takeover happen (frame indices). */
export interface PlayedMoment extends MomentData {
  kickFrame: number
  takeFrame: number
}

let cache: Promise<Record<string, Play>> | null = null

export function loadPlays(): Promise<Record<string, Play>> {
  cache ??= fetch('./plays.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`plays.json: HTTP ${r.status}`))))
    .then((d: { plays: Record<string, Play> }) => d.plays)
    .catch((e) => {
      cache = null // let a later attempt retry
      throw e
    })
  return cache
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
  const plays = await loadPlays()
  const play = plays[m.id]
  if (!play) throw new Error(`no replay for ${m.id}`)
  return withPlay(m, play)
}
