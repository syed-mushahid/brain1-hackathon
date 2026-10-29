// The data contract (src/data/moment.schema.json, schema_version 1): raw facts only, one file per
// moment written by extract_moments.py. Everything the game judges (options' values, the best
// pass, difficulty, risk) is computed at load time from these facts and src/game/model.config.ts.
// Coordinates: metres, origin bottom-left, x 0-105 (attack left -> right), y 0-68.

export type Team = 'att' | 'def'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type Direction = 'forward' | 'sideways' | 'backward'

export interface Player {
  pid: string
  num: number
  team: Team
  x: number
  y: number
}

export interface Frame {
  t: number
  /** z (height, m) is optional: without it the 3D view arcs long passes with an estimated parabola */
  ball: { x: number; y: number; z?: number }
  players: Player[]
}

/** One moment file, public/moments/<id>.json. */
export interface MomentData {
  schema_version: 1
  /** stable id <match_id>-<reception_frame> (DFL tracking frame number); the file name and the progress key */
  id: string
  match_id: string
  period: 1 | 2
  clock: string
  frames: Frame[]
  you_pid: string
  passer_pid: string
  pass1_frame_index: number
  reception_frame_index: number
  /** optional, informational: how long the pro held the ball before passing (s) */
  hold_s?: number
  actual: {
    target_pid: string | null
    intended_pid: string | null
    /** where the ball was taken over (or went out of play) */
    end: { x: number; y: number }
    length: number
    success: boolean
    outcome: 'received' | 'intercepted' | 'out' | 'loose'
    /** who took the ball over: his run from the reception frame to the takeover (t s later) */
    taker: { pid: string; t: number; run: [number, number][] } | null
    /** highest the ball got during the pass (m, measured). Optional: without it the pass counts as
     *  lofted only beyond race.loftFrom (model.config.ts) */
    ball_max_z?: number
  }
  /** match facts (DFL match information) */
  context: MatchContext
  /** pid -> real name and line-up position (pos is null for substitutes without one) */
  names: Record<string, { name: string | null; pos: string | null }>
}

/** A moment as the game uses it: the raw facts plus the game's own difficulty (game/difficulty.ts). */
export interface Moment extends MomentData {
  difficulty: Difficulty
}

/** Replay data, public/moments/<id>.play.json (loaded only when a replay is watched). */
export interface Play {
  schema_version: 1
  id: string
  /** frames from the reception (index 0 = the moment's reception frame), 10 fps, ball z = height */
  frames: Frame[]
  /** pass 2 kicked / ball taken over, in frames after the reception */
  kick_index: number
  take_index: number
}

/** One passing option, computed by the game from the reception frame (game/facts.ts) and valued by
 *  expected value (game/value.ts). */
export interface OptionFacts {
  pid: string
  num: number
  dist: number
  lane_open: number
  progress: number
  receiver_space: number
  direction: Direction
  /** beyond the offside line when you would pass (value is then 0) */
  offside?: boolean
}

export interface PassOption extends OptionFacts {
  /** expected value of the pass on the 0-100 scale (game/value.ts) */
  value: number
  /** P(the pass reaches your team), EPV where it is won, raw expected value */
  p?: number
  epv?: number
  ev?: number
}

export interface MatchContext {
  competition: string
  season: string
  matchday: number
  date: string // YYYY-MM-DD
  home: string
  away: string
  result: string // final, home:away
  stadium: string | null
  attacking: 'home' | 'away'
  score: string // home:away just before the moment
  minute: number // 1-based match minute (P2 continues from 46)
}
