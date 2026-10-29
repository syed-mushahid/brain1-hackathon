// Shape of moments.json (written by extract_moments.py).
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
  ball: { x: number; y: number; z?: number } // z (height) is optional; the 3D replay arcs long passes without it
  players: Player[]
}

export interface PassOption {
  pid: string
  num: number
  dist: number
  lane_open: number
  progress: number
  receiver_space: number
  direction: Direction
  /** beyond the offside line when you would pass (value is then 0) */
  offside?: boolean
  /** moments.json: the old heuristic (used to select the moments); in the game: the expected value
   *  of the pass on a 0-100 scale (game/value.ts) */
  value: number
  /** game only: P(the pass reaches your team), EPV where it is won, raw expected value */
  p?: number
  epv?: number
  ev?: number
}

export interface Moment {
  id: string
  match_id: string
  period: number
  clock: string
  frames: Frame[]
  you_pid: string
  passer_pid: string
  pass1_frame_index: number
  reception_frame_index: number
  options: PassOption[]
  best_option_pid: string
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
    /** highest the ball got during the pass (m, measured), and lofted = above 1.8 m */
    ball_max_z?: number
    lofted?: boolean
  }
  pro_was_best: boolean
  /** match facts (DFL match information) */
  context: MatchContext
  /** pid -> real name and line-up position (pos is null for substitutes without one) */
  names: Record<string, { name: string | null; pos: string | null }>
  difficulty: Difficulty
  pressure_m: number
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

export interface MomentsFile {
  meta: { source: string; licence: string; pitch: [number, number]; fps: number }
  moments: Moment[]
}
