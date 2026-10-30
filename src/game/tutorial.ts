// The tutorial: three guided rounds for new players. Round 1 pauses at every step and points at what
// to do (the dial, the teammate to tap, the results); round 2 is played on your own with tips;
// round 3 is at real speed. The coach cards are scripted here; Round.tsx shows them when their
// moment comes (Coach.tsx draws them). Tutorial rounds never touch the profile.
import type { Moment } from '../types'
import type { RoundSettings } from './Round'
import { buildTrack, FPS } from './track'
import { findBestPass } from './best'

/** When a step appears: the start screen, early in the approach, when the ball reaches you (only
 *  when the pro held it), when the screen goes dark, or once the result is shown. */
export type CoachWhen = 'intro' | 'approach' | 'received' | 'decide' | 'reveal'

/** What a step points at: a part of the screen, or a player on the pitch. */
export type CoachTarget = 'pitch' | 'you' | 'best' | 'dial' | 'why' | 'replay' | 'score' | 'next'

export interface CoachStep {
  when: CoachWhen
  title?: string
  text: string
  target?: CoachTarget
  /** the game stops (the ball, the clock) until the step is done */
  pause?: boolean
  /** how the step ends: next = its button (or tapping what it points at), start = the round starts,
   *  scan = you start looking around, pass = you pass, auto = after a few seconds */
  done: 'next' | 'start' | 'scan' | 'pass' | 'auto'
}

const START: CoachStep = { when: 'intro', text: 'Tap anywhere on the pitch to start.', target: 'pitch', done: 'start' }

export const TUTORIAL: CoachStep[][] = [
  // round 1: every step shown, the game waits for you
  [
    {
      when: 'intro',
      title: 'Welcome to Scan & Play',
      text: 'Every round is a real Bundesliga moment. You are the player in the yellow ring – a teammate is about to pass you the ball.',
      target: 'you',
      done: 'next',
    },
    START,
    {
      when: 'approach',
      title: 'Look around',
      text: 'Before the ball arrives, check who is free. Press and hold the dial, then turn your finger to look that way. (You can also drag on the pitch.)',
      target: 'dial',
      pause: true,
      done: 'scan',
    },
    {
      when: 'approach',
      text: 'The bright cone is what you see. Keep turning to find your teammates – your scan time runs down while you look.',
      target: 'dial',
      done: 'auto',
    },
    {
      when: 'received',
      title: 'Ball at your feet',
      text: 'The ball is yours now. Keep scanning – it is free until the moment the pro passed. The ring around you counts down.',
      target: 'you',
      pause: true,
      done: 'next',
    },
    {
      when: 'decide',
      title: 'Pass!',
      text: 'The screen goes dark – now you play from memory. This time we show you: tap the ring, the best teammate.',
      target: 'best',
      done: 'pass',
    },
    {
      when: 'reveal',
      title: 'Your result',
      text: 'Cyan is your pass, yellow is what the pro really did, and the white dashed ring is the best option.',
      done: 'next',
    },
    { when: 'reveal', text: 'Tap Why? to see why one pass was better than another.', target: 'why', done: 'next' },
    { when: 'reveal', text: 'Ready? Tap Next round – this time without help.', target: 'next', done: 'next' },
  ],
  // round 2: on your own, with tips
  [
    {
      when: 'intro',
      title: 'Round 2 – your turn',
      text: 'Nobody shows you the pass this time: scan, remember where your teammates are, then pass.',
      done: 'next',
    },
    START,
    {
      when: 'approach',
      text: 'Tip: look again late. A look in the last 1.5 s before you pass counts as fresh.',
      target: 'dial',
      done: 'auto',
    },
    {
      when: 'decide',
      text: 'Tap a teammate – or tap empty space to play the ball into a runner’s path. Double-tap for a lofted pass.',
      done: 'pass',
    },
    {
      when: 'reveal',
      title: 'Brain Score',
      text: 'Decision = how good your pass was. Scan = looking around late and spotting the best option. Memory = how exactly you tapped.',
      target: 'score',
      done: 'next',
    },
    { when: 'reveal', text: 'Tap Replay to watch the real play – or what would have happened after your pass.', target: 'replay', done: 'next' },
    { when: 'reveal', text: 'One more: the last round is at real speed.', target: 'next', done: 'next' },
  ],
  // round 3: real speed
  [
    {
      when: 'intro',
      title: 'Last round – real speed',
      text: 'Once the screen goes dark you have 2 seconds to pass. Good luck!',
      done: 'next',
    },
    START,
    {
      when: 'reveal',
      title: 'Tutorial complete',
      text: 'Start Training to play as many real moments as you like – the game adapts to your level.',
      target: 'next',
      done: 'next',
    },
  ],
]

/** Rounds 1 and 2 wait for your pass (no 2 s limit) at a slightly slower speed; round 3 is the real thing. */
export const TUTORIAL_SETTINGS: RoundSettings[] = [
  { scanBudgetMs: 2600, speed: 0.85, decideMs: Infinity },
  { scanBudgetMs: 2600, speed: 0.85, decideMs: Infinity },
  { scanBudgetMs: 2000, speed: 1, decideMs: 2000 },
]

/**
 * The tutorial's three moments, always the same: round 1 an easy one with a short hold (so the hold
 * step shows) whose best option is a ground pass to a teammate's feet (the ring a single tap plays);
 * round 2 easy or medium;
 * round 3 medium. Falls back to any moment when the set has no such one.
 */
export function tutorialMoments(moments: Moment[]): Moment[] {
  const all = [...moments].sort((a, b) => a.id.localeCompare(b.id))
  const hold = (m: Moment) => (m.decision_frame_index - m.reception_frame_index) / FPS
  const groundToFeet = (m: Moment) => {
    const b = findBestPass(buildTrack(m))
    return !b.intoSpace && !b.lofted
  }
  const used = new Set<string>()
  const pick = (ok: (m: Moment) => boolean) => {
    const m = all.find((x) => !used.has(x.id) && ok(x)) ?? all.find((x) => !used.has(x.id)) ?? all[0]
    used.add(m.id)
    return m
  }
  return [
    pick((m) => m.difficulty === 'easy' && m.actual.success && hold(m) >= 0.6 && hold(m) <= 1.6 && groundToFeet(m)),
    pick((m) => m.difficulty !== 'hard' && m.actual.success),
    pick((m) => m.difficulty === 'medium'),
  ]
}
