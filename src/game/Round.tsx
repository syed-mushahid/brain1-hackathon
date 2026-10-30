import { createContext, Suspense, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { buildTrack, FPS, posAt, sample, type Track } from './track'
import { MODEL } from './model.config'
import { loadPlay, withPlay } from '../lib/plays'
import { buildUserPlay, proStory, storyCaption, type PlayStory } from './userPlay'
import { PLAYER, Rich } from '../components/Rich'
import { LineLegend } from '../components/Legend'
import { PitchRenderer, type RevealDraw, type Scene, type View } from './renderer'
import { evaluate, type RoundResult } from './evaluate'
import { coneVis, dirTo, HEAD_TURN, turnTowards, type ScanRecord } from './vision'
import { ScanDial } from './ScanDial'
import { findBestPass } from './best'
import type { MomentData } from '../types'
import { sound } from '../lib/sound'
import { vibrate } from '../lib/util'
import { ProScan3D } from '../three/lazy'
import { Coach } from '../components/Coach'
import type { CoachStep, CoachWhen } from './tutorial'
import type { Clock } from '../three/Players'

export interface RoundSettings {
  /** total time you may spend looking around per round (ms) */
  scanBudgetMs: number
  speed: number
  decideMs: number
}

export const DEFAULT_SETTINGS: RoundSettings = { scanBudgetMs: 2000, speed: 1, decideMs: 2000 }

export type Phase = 'intro' | 'approach' | 'decide' | 'reveal'

const INTRO_MS = 1300
const LOOK_FADE_IN_MS = 80
const LOOK_FADE_OUT_MS = 160
const REVEAL_ANIM_MS = 900
const DARKEN_MS = 300 // vision shrinking to "you" at the decision frame
const LIFT_MS = 350 // darkness lifting at the reveal
const FRAME_MARGIN_M = 6 // space kept around the action when the reveal camera frames it
/** a touch screen: "Tap anywhere to start" rather than "Click anywhere or press Enter" */
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
/** a hold this short (s) is a one-touch pass: no hold phase, the screen goes dark at the reception */
const HOLD_MIN_S = 0.15
const REPLAY_LEAD_S = 1 // the 2D replay starts this long before the reception
const REPLAY_HOLD_MS = 1200 // ...and holds the last frame this long before returning to the reveal
/** the reveal camera may zoom out this far: with the tall results sheet only a strip of pitch is left */
const REVEAL_MIN_K = 0.15

/** Lets the results sheet (rendered as a child of the round) start the 2D replay. */
export const RoundControls = createContext<{
  replay2D: (who: PlayStory['who']) => void
  stopReplay: () => void
  replaying: boolean
  /** the open "what the lines mean" popover (the ⓘ in the header): the results sheet fills it */
  legendEl: HTMLElement | null
}>({
  replay2D: () => {},
  stopReplay: () => {},
  replaying: false,
  legendEl: null,
})

interface Props {
  track: Track
  settings: RoundSettings
  label: string
  onResult: (r: RoundResult, scans: ScanRecord[]) => void
  /** shown in the bottom panel once the round is revealed */
  children?: ReactNode
  /** Pro mode: the scan phase is played first-person in 3D (lazy-loaded) */
  proMode?: boolean
  /** big screens: the intro's instructions are in the panel left of the pitch (only the start button here) */
  desk?: boolean
  /** phones: the rules toggle in the header (big screens have it at the screen's top right) */
  guide?: { open: boolean; toggle: () => void }
  /** a tutorial round: its coach steps (game/tutorial.ts), "1/3", and leaving the tutorial */
  tutorial?: { steps: CoachStep[]; progress: string; onSkip: () => void }
}

interface Api {
  lookStart: (dir: number | null) => void
  lookMove: (dir: number) => void
  lookEnd: () => void
  /** screen point -> direction from "you" */
  dirToPoint: (cx: number, cy: number) => number
  proLook: (dir: number) => void
  tap: (cx: number, cy: number) => void
  ready: () => void
  /** the player pressed "Start scanning": the ball starts rolling */
  start: () => void
  /** play the real frames (reception -> pass -> takeover) on the pitch */
  replay: (played: Track, kick: number, take: number) => void
  /** reveal: drag the pitch by (dx, dy) css px; recenter = back to the automatic framing */
  panBy: (dx: number, dy: number) => void
  recenter: () => void
  stopReplay: () => void
  /** tutorial: the current step is done */
  coachNext: () => void
  /** tutorial: a player's circle on screen (client px), for the coach's ring; null at the reveal */
  pitchPoint: (t: 'you' | 'best') => { x: number; y: number; r: number } | null
}

export function Round({ track, settings, label, onResult, children, proMode = false, desk = false, guide, tutorial }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dialRef = useRef<HTMLDivElement>(null)
  const dialTimeRef = useRef<HTMLElement>(null)
  const [phase, setPhase] = useState<Phase>('intro')
  const [holding, setHolding] = useState(false) // the hold phase: ball at your feet, still scanning
  const [started, setStarted] = useState(false) // the player started the round
  const [coach, setCoach] = useState<CoachStep | null>(null) // the tutorial step on screen
  const steps = tutorial?.steps ?? []
  const [legendOpen, setLegendOpen] = useState(false)
  const [legendEl, setLegendEl] = useState<HTMLDivElement | null>(null)
  // 2D replay: -1 = off, 0 = ball coming, 1 = on the ball, 2 = pass travelling, 3 = taken over
  const [replayStage, setReplayStage] = useState(-1)
  const [replayError, setReplayError] = useState('')
  const replayTok = useRef(0) // a stop while plays.json is still loading cancels that replay
  const [replayStory, setReplayStory] = useState<PlayStory | null>(null)
  const lastResult = useRef<RoundResult | null>(null) // for the "your pass" replay
  const stopReplay = () => {
    replayTok.current++
    setReplayStage(-1)
    api.current?.stopReplay()
  }
  const api = useRef<Api | null>(null)
  const pitchAim = useRef(false) // a finger is aiming on the pitch
  const drag = useRef<{ x: number; y: number } | null>(null) // reveal: dragging the pitch around
  const lastDown = useRef(0) // reveal: a double tap on the pitch recentres it
  // shared with the 3D view in Pro mode
  const clock = useRef<Clock>({ f: 0, rate: 0, highlight: false })
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const stepsRef = useRef(steps)
  stepsRef.current = steps

  useEffect(() => {
    const canvas = canvasRef.current!
    const wrap = wrapRef.current!
    const S = settingsRef.current
    const r = new PitchRenderer(canvas, track)
    const pos = new Float32Array(track.n * 2)
    const ball = new Float32Array(2)
    const best = findBestPass(track)
    const bestIdx = best.idx // may be a pass into space: the receiver is who you should spot
    // where the best pass goes (the tutorial's "tap here" ring)
    const bestEnd: [number, number] = best.intoSpace ? best.end : posAt(track, track.dec, best.idx)
    sample(track, 0, pos, ball)
    const startDir = dirTo(pos[track.youIdx * 2], pos[track.youIdx * 2 + 1], ball[0], ball[1])
    const g = {
      phase: 'intro' as Phase,
      t0: performance.now(),
      f: 0,
      scans: [] as ScanRecord[],
      // where you look: the head turns at a human speed towards the target
      look: { active: false, target: startDir, dir: startDir, alpha: 0, rec: null as ScanRecord | null },
      budget: S.scanBudgetMs,
      reveal: null as RevealDraw | null,
      view: { k: 1, tx: 0, ty: 0 } as View,
      settled: false, // reveal animation finished: stop redrawing every frame
      kicked: false,
      received: false, // pass 1 reached you (the hold phase starts, if the pro held the ball)
      waitFor3D: proMode, // Pro mode: hold the intro until the 3D view is ready
      waitForStart: true, // nothing moves until the player presses "Start scanning"
      // tutorial: the step being shown (index into its steps), when it appeared, and the game paused for it
      coach: { idx: 0, on: false, at: 0 },
      paused: false,
      top: [track.youIdx] as number[], // drawn on top, never nudged (the reveal adds who the text is about)
      framed: [] as number[], // reveal: the players the headline and detail name (the camera keeps them in view)
      replay: null as null | { tr: Track; f: number; end: number; kick: number; take: number; hold: number; stage: number; view: View },
      // reveal / replay: how far the player dragged the pitch (css px), on top of the automatic framing
      pan: { x: 0, y: 0 },
      // the decision: a first tap waits taps.doubleTapMs for a second one (double tap = lofted pass)
      pending: null as null | { q: [number, number]; at: number; timer: ReturnType<typeof setTimeout> },
    }
    let scene: Scene | null = null

    const fit = () => {
      r.resize(wrap.clientWidth, wrap.clientHeight)
      if (scene) r.draw(scene)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)

    const go = (p: Phase, now: number) => {
      g.phase = p
      g.t0 = now
      setPhase(p)
    }
    // ---- tutorial: show each coach step when its moment comes, pause the game for it if it says so
    const ORDER: Record<Phase, number> = { intro: 0, approach: 1, decide: 2, reveal: 3 }
    const WHEN: Record<CoachWhen, number> = { intro: 0, approach: 1, received: 1, decide: 2, reveal: 3 }
    const coachStep = () => (g.coach.on ? (stepsRef.current[g.coach.idx] ?? null) : null)
    const coachNext = () => {
      if (!stepsRef.current[g.coach.idx]) return
      g.coach = { idx: g.coach.idx + 1, on: false, at: 0 }
      g.paused = false
      setCoach(null)
    }
    const coachTick = (now: number) => {
      const st = stepsRef.current[g.coach.idx]
      if (!st) return
      if (!g.coach.on) {
        // its moment has passed (or never comes: no hold phase in a one-touch moment): skip it
        if (ORDER[g.phase] > WHEN[st.when] || (st.when === 'received' && g.received && holdFrames === 0)) return coachNext()
        const due =
          st.when === 'intro'
            ? !g.waitFor3D
            : st.when === 'approach'
              ? g.phase === 'approach' && g.f >= 4
              : st.when === 'received'
                ? g.phase === 'approach' && g.received
                : st.when === 'decide'
                  ? g.phase === 'decide'
                  : g.phase === 'reveal' && now - g.t0 >= REVEAL_ANIM_MS
        if (!due) return
        g.coach = { idx: g.coach.idx, on: true, at: now }
        if (st.pause) g.paused = true
        setCoach(st)
      } else if (st.done === 'auto' && (now - g.coach.at > 4500 || ORDER[g.phase] > WHEN[st.when] || (st.when === 'approach' && g.received && holdFrames > 0)))
        coachNext()
    }

    // every judgement is made at the decision frame: where the pro really passed (track.dec)
    const before = () => (track.dec - g.f) / FPS
    const holdFrames = (track.dec - track.rec) / FPS >= HOLD_MIN_S ? track.dec - track.rec : 0
    const stopLook = () => {
      g.look.active = false
      g.look.rec = null
    }
    const finish = (tap: [number, number] | null, now: number, lofted = false) => {
      if (coachStep()?.done === 'pass') coachNext()
      if (g.pending) clearTimeout(g.pending.timer)
      g.pending = null
      g.f = track.dec
      stopLook()
      sample(track, track.dec, pos, ball) // reveal the TRUE positions when you had to pass
      const res = evaluate(track, { tap, scans: g.scans, lofted })
      g.top = involved(track, res)
      g.framed = named(track, [res.headline, res.detail])
      g.reveal = {
        progress: 0,
        tap: res.tap,
        chosenIdx: res.chosenIdx,
        proEnd: res.proEnd,
        bestIdx: res.bestIdx,
        best: { end: res.best.end, run: res.best.run, alone: res.best.alone, lofted: res.best.lofted, ring: res.best.ring },
        mineLofted: res.lofted,
        proLofted: res.proLofted,
        run: res.run,
        space: res.space && {
          end: res.space.end,
          run: res.space.team ? { pts: res.space.run, team: res.space.team } : null,
        },
        threats: res.threats,
        // the brave option and every high-risk line are on the pitch from the start
        show: { brave: !!res.brave, threats: res.threats.map((t) => t.idx) },
        offsideV: res.offsideV,
        brave: res.brave && { end: res.brave.end, run: res.brave.run, lofted: res.brave.lofted },
      }
      if (tap) {
        sound.kick(lofted ? 1 : 0.9)
        vibrate(lofted ? [15, 40, 15] : 15)
      }
      setTimeout(() => vibrate(res.tone === 'great' ? [20, 60, 20] : res.tone === 'bad' ? 70 : 30), 350)
      go('reveal', now)
      lastResult.current = res
      onResultRef.current(res, g.scans)
    }
    /** Height of the canvas area not covered by the results sheet (css px). */
    const visibleHeight = () => {
      const root = rootRef.current
      const sheet = root?.querySelector<HTMLElement>('.result-sheet')
      if (!root || !sheet) return r.h
      // offsetTop ignores the sheet's slide-in transform: we aim for where it will settle
      const sheetTop = root.getBoundingClientRect().top + sheet.offsetTop
      return Math.max(40, Math.min(r.h, sheetTop - canvas.getBoundingClientRect().top - 6))
    }
    /** The box that matters at the reveal, fitted into the canvas area not covered by the sheet. */
    const revealView = (R: RevealDraw): View =>
      withPan(r.fitView(...revealBox(track, R, [...g.framed, ...R.show.threats]), visibleHeight(), REVEAL_MIN_K))
    /** the automatic framing moved by the player's drag */
    const withPan = (v: View): View => ({ k: v.k, tx: v.tx + g.pan.x, ty: v.ty + g.pan.y })
    const bestInCone = (dir: number) =>
      bestIdx >= 0 &&
      coneVis(pos[bestIdx * 2], pos[bestIdx * 2 + 1], pos[track.youIdx * 2], pos[track.youIdx * 2 + 1], dir) > 0.5

    api.current = {
      lookStart(dir) {
        // the hold phase: the ball is at your feet, you may look around until the pro passes
        const holdingNow = g.received && holdFrames > 0
        if (g.phase !== 'approach' || g.look.active || (g.budget <= 0 && !holdingNow)) return
        // tutorial: while a step holds the game, only the "look around" step lets you look
        const st = coachStep()
        if (g.paused && st?.done !== 'scan') return
        if (st?.done === 'scan') coachNext()
        g.look.active = true
        if (dir !== null) g.look.target = dir
        g.look.rec = { dir: g.look.target, startBefore: before(), endBefore: before(), sawBestBefore: null }
        g.scans.push(g.look.rec)
        sound.tick()
        vibrate(10)
      },
      lookMove(dir) {
        g.look.target = dir
        if (g.look.rec) g.look.rec.dir = dir
      },
      lookEnd() {
        stopLook()
      },
      dirToPoint(cx, cy) {
        const rect = canvas.getBoundingClientRect()
        const [u, v] = r.toPitch(cx - rect.left, cy - rect.top)
        return dirTo(pos[track.youIdx * 2], pos[track.youIdx * 2 + 1], u, v)
      },
      proLook(dir) {
        // Pro mode: the player really turned their head in 3D; record that glance
        if (g.phase !== 'approach') return
        g.scans.push({ dir, startBefore: before(), endBefore: before(), sawBestBefore: bestInCone(dir) ? before() : null })
        sound.tick()
      },
      tap(cx, cy) {
        if (g.phase !== 'decide') return
        const rect = canvas.getBoundingClientRect()
        const q = r.toPitch(cx - rect.left, cy - rect.top)
        const now = performance.now()
        const T = MODEL.taps
        const first = g.pending
        if (first && now - first.at <= T.doubleTapMs && Math.hypot(q[0] - first.q[0], q[1] - first.q[1]) <= T.doubleTapM) {
          finish(first.q, now, true) // double tap: a lofted pass to where you first tapped
          return
        }
        if (first) {
          finish(first.q, now) // a second tap somewhere else: the first one stands, along the ground
          return
        }
        // a single tap is a ground pass - once it is clear no second tap is coming
        g.pending = { q, at: now, timer: setTimeout(() => g.pending && finish(g.pending.q, performance.now()), T.doubleTapMs) }
        vibrate(8)
      },
      panBy(dx, dy) {
        if (g.phase !== 'reveal') return
        // keep at least part of the pitch on screen
        const lim = (x: number, m: number) => Math.max(-m, Math.min(m, x))
        const x = lim(g.pan.x + dx, r.w * 0.8)
        const y = lim(g.pan.y + dy, r.h * 0.8)
        g.view.tx += x - g.pan.x // follow the finger directly, no easing
        g.view.ty += y - g.pan.y
        g.pan = { x, y }
        g.settled = false
      },
      recenter() {
        g.pan = { x: 0, y: 0 }
        g.settled = false
      },
      ready() {
        if (g.waitFor3D) {
          g.waitFor3D = false
          g.t0 = performance.now()
        }
      },
      /** the player clicked / tapped anywhere or pressed Enter: the ball starts rolling */
      start() {
        if (g.phase !== 'intro' || !g.waitForStart) return
        // tutorial: read the welcome card first; the "tap to start" step ends here
        const st = coachStep()
        if (st && st.done !== 'start') return
        if (st) coachNext()
        g.waitForStart = false
        g.t0 = performance.now() - INTRO_MS // straight into the approach (Pro mode still waits for 3D)
        sound.whistle(1, 0.22)
        setStarted(true)
      },
      replay(played, kick, take) {
        if (g.phase !== 'reveal') return
        // frame the whole play: the ball's path, you and whoever ends up with it (from just before
        // the reception, so the hold before the pass is in it)
        const f0 = Math.max(0, played.rec - REPLAY_LEAD_S * FPS)
        const end = played.nFrames - 1
        const us: number[] = []
        const vs: number[] = []
        for (let f = f0; f <= end; f++) {
          us.push(played.ball[f * 2], posAt(played, f, played.youIdx)[0])
          vs.push(played.ball[f * 2 + 1], posAt(played, f, played.youIdx)[1])
        }
        const view = r.fitView(
          Math.min(...us) - FRAME_MARGIN_M,
          Math.min(...vs) - FRAME_MARGIN_M,
          Math.max(...us) + FRAME_MARGIN_M,
          Math.max(...vs) + FRAME_MARGIN_M,
          visibleHeight(),
        )
        g.replay = { tr: played, f: f0, end, kick, take, hold: 0, stage: -1, view }
        sound.whistle(1, 0.12)
      },
      coachNext,
      pitchPoint(t) {
        if (g.phase === 'reveal') return null // the reveal camera moves the pitch
        const rect = canvas.getBoundingClientRect()
        const [u, v] = t === 'you' ? [pos[track.youIdx * 2], pos[track.youIdx * 2 + 1]] : bestEnd
        return { x: rect.left + r.X(u), y: rect.top + r.Y(v), r: 3.2 * r.s }
      },
      stopReplay() {
        if (!g.replay) return
        g.replay = null
        sample(track, track.dec, pos, ball) // back to the reveal picture
        g.settled = false
        setReplayStage(-1)
      },
    }

    const dial = dialRef.current
    const dialTime = dialTimeRef.current
    let shownBudget = -1
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(50, now - last)
      last = now
      coachTick(now)
      if (g.phase === 'intro' && (g.waitFor3D || g.waitForStart)) g.t0 = now
      if (g.phase === 'intro' && now - g.t0 >= INTRO_MS) go('approach', now)
      if (g.phase === 'approach') {
        if (!g.paused) g.f += (dt / 1000) * FPS * S.speed
        if (!g.kicked && g.f >= track.pass1) {
          g.kicked = true
          sound.kick()
        }
        if (!g.received && g.f >= track.rec) {
          g.received = true
          sound.kick(0.4) // first touch
          vibrate(25)
          if (holdFrames > 0) setHolding(true) // the ball stays at your feet: keep scanning
        }
        if (g.f >= track.dec) {
          // the moment the pro passed: the screen goes dark
          g.f = track.dec
          stopLook()
          if (holdFrames > 0) {
            setHolding(false)
            vibrate(15)
          }
          go('decide', now)
        }
      }
      if (g.phase === 'decide' && g.paused) g.t0 += dt // the clock waits for the coach
      if (g.phase === 'decide' && now - g.t0 >= S.decideMs) finish(g.pending?.q ?? null, now) // a pending tap still counts
      if (g.phase !== 'reveal') sample(track, g.f, pos, ball)
      clock.current.f = g.f
      clock.current.rate = g.phase === 'approach' ? S.speed : 0

      // --- looking around: head turns at a human speed; when you let go it returns to the ball
      if (g.phase === 'intro' || g.phase === 'approach') {
        const L = g.look
        const yu = pos[track.youIdx * 2]
        const yv = pos[track.youIdx * 2 + 1]
        const want = L.active ? L.target : dirTo(yu, yv, ball[0], ball[1])
        L.dir = turnTowards(L.dir, want, (HEAD_TURN * dt) / 1000)
        // scanning in the hold phase is free: it never runs out before the pro's pass (the decision frame)
        const holdingNow = g.received && holdFrames > 0
        if (L.active) {
          if (!holdingNow) g.budget -= dt
          L.alpha = Math.min(1, L.alpha + dt / LOOK_FADE_IN_MS)
          if (L.rec) {
            L.rec.endBefore = before()
            if (bestInCone(L.dir)) L.rec.sawBestBefore = before()
          }
          if (g.budget <= 0 && !holdingNow) {
            g.budget = 0
            stopLook()
            vibrate(30)
          }
        } else {
          L.alpha = Math.max(0, L.alpha - dt / LOOK_FADE_OUT_MS)
        }
        if (dial) {
          dial.style.setProperty('--head', `${(L.dir * 180) / Math.PI}deg`)
          const b = holdingNow ? -1 : Math.round(g.budget / 100) // update the DOM only when the tenth changes
          if (b !== shownBudget) {
            shownBudget = b
            // hold phase: free scanning until the pass (a full ring, ∞)
            dial.style.setProperty('--budget', holdingNow ? '1' : String(g.budget / S.scanBudgetMs))
            if (dialTime) dialTime.textContent = holdingNow ? '∞' : `${(g.budget / 1000).toFixed(1)}s`
          }
        }
      }

      // Pro mode: the 3D view covers the pitch until reception, skip the 2D draw
      if (proMode && (g.phase === 'intro' || g.phase === 'approach')) return
      if (g.replay) {
        // 2D replay of the real play: real frames at real speed, then back to the reveal
        const P = g.replay
        P.f = Math.min(P.end, P.f + (dt / 1000) * FPS)
        sample(P.tr, P.f, pos, ball)
        const stage = P.f < P.tr.rec ? 0 : P.f < P.kick ? 1 : P.f < P.take ? 2 : 3
        if (stage !== P.stage) {
          P.stage = stage
          setReplayStage(stage)
          if (stage === 2) sound.kick(0.8)
        }
        if (P.f >= P.end && (P.hold += dt) > REPLAY_HOLD_MS) {
          api.current?.stopReplay()
          return
        }
        const v = g.view
        const a = 1 - Math.exp(-dt / 160)
        const t = withPan(P.view)
        v.k += (t.k - v.k) * a
        v.tx += (t.tx - v.tx) * a
        v.ty += (t.ty - v.ty) * a
        r.draw({ mode: 'reveal', pos, ball, headDir: 0, look: 0, decideLeft: 1, reveal: null, view: v, blend: 1, time: now, top: g.top })
        return
      }
      if (g.reveal) {
        // reveal camera: ease towards a view that keeps the action above the results sheet
        const tgt = revealView(g.reveal)
        const v = g.view
        const moving = Math.abs(tgt.k - v.k) > 0.002 || Math.abs(tgt.tx - v.tx) > 0.5 || Math.abs(tgt.ty - v.ty) > 0.5
        if (moving) {
          const a = 1 - Math.exp(-dt / 140)
          v.k += (tgt.k - v.k) * a
          v.tx += (tgt.tx - v.tx) * a
          v.ty += (tgt.ty - v.ty) * a
        }
        const animating = g.reveal.progress < 1 || moving
        if (!animating && g.settled) return // nothing changes: stop redrawing
        g.reveal.progress = Math.min(1, (now - g.t0) / REVEAL_ANIM_MS)
        g.settled = !animating
      }
      scene = {
        mode: g.phase,
        pos,
        ball,
        headDir: g.look.dir,
        look: g.look.alpha,
        decideLeft: g.phase === 'decide' ? Math.max(0, 1 - (now - g.t0) / S.decideMs) : 1,
        holdLeft: g.phase === 'approach' && g.received && holdFrames > 0 ? Math.max(0, Math.min(1, (track.dec - g.f) / holdFrames)) : null,
        aim: g.phase === 'decide' ? (g.pending?.q ?? null) : null,
        reveal: g.reveal,
        view: g.view,
        top: g.top,
        blend: g.phase === 'decide' ? Math.min(1, (now - g.t0) / DARKEN_MS) : g.phase === 'reveal' ? Math.min(1, (now - g.t0) / LIFT_MS) : 0,
        time: now,
      }
      r.draw(scene)
    }
    raf = requestAnimationFrame(loop)

    // keyboard: arrow keys look up/down/left/right (and diagonals), released = stop
    const held = new Set<string>()
    const keyDir = () => {
      const x = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0)
      const y = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0)
      return x === 0 && y === 0 ? null : Math.atan2(x, y)
    }
    const onKey = (e: KeyboardEvent) => {
      // Enter / Space on the start screen starts the round
      if (e.type === 'keydown' && (e.key === 'Enter' || e.key === ' ') && g.phase === 'intro' && g.waitForStart) {
        e.preventDefault()
        api.current?.start()
        return
      }
      if (!e.key.startsWith('Arrow')) return
      e.preventDefault()
      if (e.type === 'keydown') held.add(e.key)
      else held.delete(e.key)
      const d = keyDir()
      if (d === null) api.current?.lookEnd()
      else if (g.look.active) api.current?.lookMove(d)
      else api.current?.lookStart(d)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      cancelAnimationFrame(raf)
      if (g.pending) clearTimeout(g.pending.timer)
      ro.disconnect()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [track])

  // the pitch itself is a controller too: press and drag = look towards your finger
  const onPitchDown = (e: RPointerEvent) => {
    if (phase === 'approach' && !proMode) {
      const a = api.current
      if (!a) return
      e.currentTarget.setPointerCapture(e.pointerId)
      pitchAim.current = true
      a.lookStart(a.dirToPoint(e.clientX, e.clientY))
    } else if (phase === 'decide') {
      api.current?.tap(e.clientX, e.clientY)
    } else if (phase === 'reveal') {
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { x: e.clientX, y: e.clientY }
      if (e.timeStamp - lastDown.current < MODEL.taps.doubleTapMs) api.current?.recenter()
      lastDown.current = e.timeStamp
    }
  }
  const onPitchMove = (e: RPointerEvent) => {
    if (drag.current) {
      api.current?.panBy(e.clientX - drag.current.x, e.clientY - drag.current.y)
      drag.current = { x: e.clientX, y: e.clientY }
    }
    if (pitchAim.current && api.current) api.current.lookMove(api.current.dirToPoint(e.clientX, e.clientY))
  }
  const onPitchUp = () => {
    drag.current = null
    if (!pitchAim.current) return
    pitchAim.current = false
    api.current?.lookEnd()
  }
  const m = track.m
  const startHint = !started && (
    <div className="start-hint">{TOUCH ? 'Tap anywhere to start' : 'Click anywhere or press Enter to start'}</div>
  )

  return (
    <div
      ref={rootRef}
      className={`round phase-${phase}`}
      data-moment={track.m.id}
      // the round starts on a click / tap anywhere (the pitch, the dial...) except the header's buttons
      onPointerDown={(e) => phase === 'intro' && !(e.target as HTMLElement).closest('button, .legend-pop, .coach-card') && api.current?.start()}
    >
      <header className="hud-top">
        <span className="chip">{label}</span>
        <span className="clock">{m.clock}′</span>
        <button
          className={`icon-btn legend-btn ${legendOpen ? 'on' : ''}`}
          onClick={() => setLegendOpen((o) => !o)}
          aria-expanded={legendOpen}
          aria-label="What the lines mean"
        >
          ⓘ
        </button>
        {guide && (
          <button className={`icon-btn guide-btn ${guide.open ? 'on' : ''}`} onClick={guide.toggle} aria-pressed={guide.open}>
            Rules
          </button>
        )}
      </header>
      {legendOpen && (
        <div className="legend-pop" ref={setLegendEl} role="dialog" aria-label="What the lines mean">
          {/* after the pass the results sheet puts this round's lines here */}
          {phase !== 'reveal' && <LineLegend />}
        </div>
      )}
      <div
        className="pitch-wrap"
        ref={wrapRef}
        onPointerDown={onPitchDown}
        onPointerMove={onPitchMove}
        onPointerUp={onPitchUp}
        onPointerCancel={onPitchUp}
      >
        <canvas ref={canvasRef} className="pitch" />
        {phase === 'intro' && !proMode && (
          <div className={`overlay intro ${desk ? 'desk' : ''}`}>
            {/* big screens: the instructions are in the panel on the left */}
            {!desk && (
              <>
                <div className="big">Get ready</div>
                <div className="sub">Hold &amp; turn the dial – or drag on the pitch – to look around.</div>
                <Who m={m} />
              </>
            )}
            {startHint}
          </div>
        )}
        {replayStage >= 0 && (
          <div className="replay2d-bar">
            <span className="rec-dot" />
            <span className="replay2d-text">
              <Rich text={replayStory ? storyCaption(track.m, replayStory, replayStage) : 'Loading the play…'} />
            </span>
            <button className="icon-btn" onClick={stopReplay} aria-label="Stop replay">
              ✕
            </button>
          </div>
        )}
        {replayError && <div className="replay2d-bar error">Replay unavailable – {replayError}</div>}
        {phase === 'approach' && holding && !coach && (
          <div className="overlay hold-hint" role="status">
            Ball at your feet – keep scanning
          </div>
        )}
        {phase === 'decide' && !coach && (
          <div className="overlay banner">
            PASS! Tap a teammate – or the space
            <small>tap = along the ground · double-tap = lofted</small>
          </div>
        )}
        {proMode && (phase === 'intro' || phase === 'approach') && (
          <Suspense fallback={<div className="overlay intro"><div className="sub">Loading 3D…</div></div>}>
            <ProScan3D
              moment={track.m}
              clock={clock}
              onScan={(dir) => api.current?.proLook(dir)}
              onReady={() => api.current?.ready()}
            />
          </Suspense>
        )}
        {proMode && phase === 'intro' && (
          <div className="overlay intro pro-intro">
            <div className="big">Pro mode</div>
            <div className="sub">Look around before you have to pass</div>
            <Who m={m} />
            {startHint}
          </div>
        )}
      </div>
      <footer className="hud-bottom">
        {/* the controller keeps its place until the reveal (the pitch doesn't resize while you play);
            at the reveal it goes and the pitch grows under the results sheet */}
        <div className="scan-controls" style={phase === 'reveal' || proMode ? { visibility: 'hidden' } : undefined}>
          <span className="dial-hint">{phase === 'approach' ? (holding ? 'Keep scanning' : 'Hold & turn to scan') : phase === 'decide' ? 'Pass!' : ''}</span>
          <ScanDial
            disabled={phase !== 'approach'}
            onStart={(d) => api.current?.lookStart(d)}
            onMove={(d) => api.current?.lookMove(d)}
            onEnd={() => api.current?.lookEnd()}
            rootRef={dialRef}
            timeRef={dialTimeRef}
          />
          <span className="dial-hint right">{settings.scanBudgetMs / 1000}s scan time</span>
        </div>
      </footer>
      {tutorial && coach && (
        <Coach
          step={coach}
          progress={tutorial.progress}
          pitchPoint={(t) => api.current?.pitchPoint(t) ?? null}
          onNext={() => api.current?.coachNext()}
          onSkip={tutorial.onSkip}
        />
      )}
      {phase === 'reveal' && (
        <RoundControls.Provider
          value={{
            replaying: replayStage >= 0,
            stopReplay,
            legendEl,
            replay2D: (who) => {
              const tok = ++replayTok.current
              setReplayError('')
              setReplayStory(null)
              setReplayStage(0)
              loadPlay(track.m.id)
                .catch(() => null) // no play data: your pass can still be simulated
                .then((play) => {
                  if (tok !== replayTok.current) return
                  const pm =
                    who === 'pro'
                      ? play && proStory(withPlay(track.m, play))
                      : lastResult.current && buildUserPlay(track, lastResult.current, play)
                  if (!pm) throw new Error(who === 'pro' ? 'no data for the real play' : 'you did not pass')
                  setReplayStory(pm.story)
                  api.current?.replay(buildTrack(pm), pm.kickFrame, pm.takeFrame)
                })
                .catch((e) => {
                  setReplayStage(-1)
                  setReplayError(String(e instanceof Error ? e.message : e))
                })
            },
          }}
        >
          {children}
        </RoundControls.Provider>
      )}
    </div>
  )
}

/** The box the reveal camera frames (u0, v0, u1, v1 in metres): every arrow and run, and every
 *  player the reveal is about (`top`), with room around them. */
export function revealBox(track: Track, R: RevealDraw, players: number[]): [number, number, number, number] {
  const f = track.dec
  const pts: [number, number][] = [posAt(track, f, track.youIdx), [track.ball[f * 2], track.ball[f * 2 + 1]], R.proEnd]
  for (const i of players) pts.push(posAt(track, f, i))
  for (const t of R.threats) if (R.show.threats.includes(t.idx)) pts.push(t.from, t.at)
  if (R.bestIdx >= 0) pts.push(posAt(track, f, R.bestIdx), R.best.end, R.best.ring, ...(R.best.alone ? (R.best.run ?? []) : []))
  if (R.brave && R.show.brave) pts.push(R.brave.end, ...(R.brave.run ?? []))
  if (R.chosenIdx >= 0) pts.push(posAt(track, f, R.chosenIdx))
  if (R.tap) pts.push(R.tap)
  if (R.run) pts.push(...R.run.pts)
  if (R.space) pts.push(R.space.end, ...(R.space.run?.pts ?? []))
  const us = pts.map((p) => p[0])
  const vs = pts.map((p) => p[1])
  const M = FRAME_MARGIN_M
  return [Math.min(...us) - M, Math.min(...vs) - M, Math.max(...us) + M, Math.max(...vs) + M]
}

/** Everyone the reveal is about: the result's own list plus every player its texts name ("#25",
 *  "red #24"), so they are all drawn on top, never nudged, and framed by the reveal camera. */
export function involved(tr: Track, res: RoundResult): number[] {
  const b = res.breakdown
  const texts = [
    res.headline,
    res.detail,
    b.why.title,
    ...b.why.points,
    ...b.why.cols.flatMap((c) => [c.label, c.risk ? c.risk.text.replace(/\(#/, '(red #') : '']), // as Breakdown shows them
    ...b.scan.lines,
  ]
  return [...new Set([...res.mentioned, ...named(tr, texts)])]
}

/** The players some texts name ("#25" = teammate, "red #24" = opponent), as track indices. */
export function named(tr: Track, texts: string[]): number[] {
  const out: number[] = []
  for (const t of texts)
    for (const m of t.matchAll(PLAYER)) {
      const att = !m[1]
      const i = tr.nums.findIndex((n, k) => n === Number(m[2]) && tr.att[k] === att)
      if (i >= 0 && !out.includes(i)) out.push(i)
    }
  return out
}

/** "You are <player> · <team> · <minute>" on the intro screen */
export function Who({ m }: { m: MomentData }) {
  const you = m.names[m.you_pid]
  const team = m.context.attacking === 'home' ? m.context.home : m.context.away
  // your shirt number, as the circle you are on the pitch (not the match minute: that read like a number)
  const num = m.frames[0].players.find((p) => p.pid === m.you_pid)?.num
  return (
    <div className="who">
      You are {you?.name ?? 'this player'}{' '}
      <small>
        · {team}
        {num !== undefined && (
          <>
            {' · '}
            <span className="pchip att" role="img" aria-label={`number ${num}`}>
              {num}
            </span>
          </>
        )}
      </small>
    </div>
  )
}

