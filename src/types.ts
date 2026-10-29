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
  value: number
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
    end: { x: number; y: number }
    length: number
    success: boolean
  }
  pro_was_best: boolean
  difficulty: Difficulty
  pressure_m: number
}

export interface MomentsFile {
  meta: { source: string; licence: string; pitch: [number, number]; fps: number }
  moments: Moment[]
}
