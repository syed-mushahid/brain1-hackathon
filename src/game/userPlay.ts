// "Your pass" replay: what the race model says happens after YOUR pass, as frames the 2D and
// 3D replays can play like the real ones.
//   - the ball leaves your feet at the decision moment towards where you aimed, with the model's
//     flight (space.ts flight(): ground at RACE.ballSpeed, or a 30° lofted arc beyond RACE.loftFrom),
//     stops there, and is taken by the winner at the time the model gave;
//   - the winner keeps running for his reaction time, then sprints to the spot (the same path the
//     model raced), and carries on with the ball; the quickest player of the other team chases;
//   - everyone else moves as they really did in the match (plays.json): lifelike, but they were
//     reacting to the pro's real pass, not yours.
import type { Frame, Moment } from '../types'
import { withPlay, type Play, type PlayedMoment } from '../lib/plays'
import type { RoundResult } from './evaluate'
import { flight, RACE } from './space'
import { FPS, PITCH_L, PITCH_W, posAt, type Track } from './track'

export interface PlayStory {
  /** whose pass this replay shows */
  who: 'pro' | 'you'
  /** who ended up with the ball ('A8', 'D23'), null when it went out */
  taker: string | null
  outcome: 'received' | 'intercepted' | 'out' | 'offside'
}

export type StoryMoment = PlayedMoment & { story: PlayStory }

const AFTER_S = 1.5 // keep playing this long after the ball is won
const CARRY_SPEED = 3 // m/s, the winner carries the ball on
const CHASE_STOP_M = 1.5 // the chaser stops this close to the winner

/** The pro's real play, with its story. */
export function proStory(m: PlayedMoment): StoryMoment {
  const o = m.actual.outcome
  return { ...m, story: { who: 'pro', taker: m.actual.taker?.pid ?? null, outcome: o === 'loose' ? 'out' : o } }
}

export function buildUserPlay(tr: Track, res: RoundResult, play: Play | null): StoryMoment | null {
  const m: Moment = tr.m
  const rec = tr.rec
  // a pass into space, or a pass to feet the race says was cut out: replay that race
  const sp = res.space ?? res.lost
  // your tap was the pro's pass: what really happened
  if (sp?.asPro && play) {
    const real = proStory(withPlay(m, play))
    return { ...real, story: { ...real.story, who: 'you' } }
  }

  const you = posAt(tr, rec, tr.youIdx)
  let taker = -1
  let end: [number, number]
  let tWin: number
  let outcome: PlayStory['outcome']
  if (sp) {
    taker = sp.takerIdx
    end = sp.end
    tWin = sp.t
    outcome = sp.offside ? 'offside' : taker < 0 ? 'out' : sp.team === 'def' ? 'intercepted' : 'received'
  } else if (res.chosenIdx >= 0) {
    taker = res.chosenIdx
    end = posAt(tr, rec, taker)
    tWin = flight(Math.hypot(end[0] - you[0], end[1] - you[1]), false).arrive
    outcome = res.headline === 'Offside!' ? 'offside' : 'received'
  } else return null // no pass (time ran out)

  const L = Math.hypot(end[0] - you[0], end[1] - you[1])
  const ux = (end[0] - you[0]) / Math.max(L, 1e-6)
  const uy = (end[1] - you[1]) / Math.max(L, 1e-6)
  const F = flight(L, L > RACE.loftFrom) // same flight as the race (lofted beyond 30 m)
  const tBall = F.arrive
  const out = taker < 0
  const total = (out ? tBall + 1 : Math.max(tWin, tBall) + AFTER_S) * FPS

  // the chaser: quickest player of the other team to the spot (his own sprint, same model)
  const vel = (i: number): [number, number] => {
    const a = posAt(tr, Math.max(0, rec - 2), i)
    const b = posAt(tr, rec, i)
    const k = FPS / Math.min(2, rec || 1)
    return [(b[0] - a[0]) * k, (b[1] - a[1]) * k]
  }
  const react = (i: number) => (tr.att[i] ? RACE.reactMates : RACE.react)
  const timeTo = (i: number, q: [number, number]) => {
    const p = posAt(tr, rec, i)
    const v = vel(i)
    return react(i) + Math.hypot(q[0] - p[0] - v[0] * react(i), q[1] - p[1] - v[1] * react(i)) / RACE.runSpeed
  }
  let chaser = -1
  if (!out)
    for (let i = 0; i < tr.n; i++)
      if (i !== tr.youIdx && i !== taker && tr.att[i] !== tr.att[taker] && (chaser < 0 || timeTo(i, end) < timeTo(chaser, end))) chaser = i

  /** a sprinter: keeps his velocity for his reaction time, then runs straight at `target` (moving target
   *  ok); `wait` = he expects the ball where he stands (a pass to feet): no drifting off first */
  const runner = (i: number, wait = false) => {
    const p0 = posAt(tr, rec, i)
    const v: [number, number] = wait ? [0, 0] : vel(i)
    const r = react(i)
    let pos: [number, number] = [...p0]
    let tPrev = 0
    return (t: number, target: [number, number], stopAt: number): [number, number] => {
      const dt = t - tPrev
      tPrev = t
      if (t <= r) pos = [p0[0] + v[0] * t, p0[1] + v[1] * t]
      else {
        const dx = target[0] - pos[0]
        const dy = target[1] - pos[1]
        const d = Math.hypot(dx, dy)
        const step = Math.min(Math.max(0, d - stopAt), RACE.runSpeed * dt)
        if (d > 1e-6) pos = [pos[0] + (dx / d) * step, pos[1] + (dy / d) * step]
      }
      return pos
    }
  }
  const takerRun = taker >= 0 ? runner(taker, !sp) : null
  const chaserRun = chaser >= 0 ? runner(chaser) : null
  // after winning it: carry it on (your team towards the opponents' goal = up, theirs = down)
  const carryDir = taker >= 0 && tr.att[taker] ? -1 : 1

  const realFrames = play ? play.frames : [m.frames[rec]]
  const frames: Frame[] = []
  let won: [number, number] | null = null
  for (let j = 1; j <= Math.ceil(total); j++) {
    const t = j / FPS
    const base = realFrames[Math.min(j, realFrames.length - 1)]
    // ball: travelling, then waiting at the spot, then at the winner's feet
    let ball: [number, number]
    let z = 0
    const s = Math.min((t / Math.max(tBall, 1e-6)) * L, out ? L + 3 : L) // constant ground speed
    ball = [you[0] + ux * s, you[1] + uy * s]
    if (t < tBall) z = F.z(s)
    let tp: [number, number] | null = null
    if (takerRun) {
      if (t < tWin) tp = takerRun(t, end, 0)
      else {
        won ??= [...end]
        won = [won[0], won[1] + carryDir * CARRY_SPEED * (1 / FPS)]
        tp = won
        ball = [won[0], won[1] + carryDir * 0.6]
        z = 0
      }
    }
    const cp = chaserRun ? chaserRun(t, tp ?? end, t < tWin ? 0 : CHASE_STOP_M) : null
    frames.push({
      t: r1((rec + j) / FPS),
      ball: { x: r1(PITCH_L - ball[1]), y: r1(PITCH_W - ball[0]), z: r1(z) },
      players: base.players.map((p) => {
        const i = tr.pids.indexOf(p.pid)
        const q = i === taker ? tp : i === chaser ? cp : null
        return q ? { ...p, x: r1(PITCH_L - q[1]), y: r1(PITCH_W - q[0]) } : p
      }),
    })
  }
  return {
    ...m,
    frames: [...m.frames.slice(0, rec + 1), ...frames],
    kickFrame: rec,
    takeFrame: rec + (out ? tBall : Math.max(tWin, tBall)) * FPS,
    story: { who: 'you', taker: taker >= 0 ? tr.pids[taker] : null, outcome },
  }
}

const r1 = (x: number) => Math.round(x * 10) / 10


/**
 * Replay caption for the current beat: 0 = ball coming, 1 = on the ball, 2 = pass travelling,
 * 3 = taken over. Players as "#8" / "red #23" (shown as number circles by <Rich>).
 */
export function storyCaption(m: Moment, story: PlayStory, beat: number): string {
  const you = `#${m.you_pid.slice(1)}`
  const who = story.who === 'pro' ? 'Real play' : 'Your pass'
  if (beat === 0) return `${who} · the ball comes to ${you}`
  if (beat === 1) return `${who} · ${you} on the ball`
  if (beat === 2) return `${who} · ${story.who === 'pro' ? `${you} passes…` : 'you pass…'}`
  return `${who} · ${storyEnd(story)}`
}

export function storyEnd(story: PlayStory): string {
  const t = story.taker ? `${story.taker[0] === 'D' ? 'red ' : ''}#${story.taker.slice(1)}` : ''
  return story.outcome === 'received'
    ? `${t} takes it`
    : story.outcome === 'intercepted'
      ? `${t} wins the ball`
      : story.outcome === 'offside'
        ? `${t} – offside!`
        : 'out of play'
}
