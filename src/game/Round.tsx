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
const DARKEN_MS = 300 // vision shrinking to "you" at reception
const LIFT_MS = 350 // darkness lifting at the reveal
const FRAME_MARGIN_M = 6 // space kept around the action when the reveal camera frames it
/** a touch screen: "Tap anywhere to start" rather than "Click anywhere or press Enter" */
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const REPLAY_LEAD_S = 1 // the 2D replay starts this long before the reception
const REPLAY_HOLD_MS = 1200 // ...and holds the last frame this long before returning to the reveal
/** the reveal camera may zoom out this far: with the tall results sheet only a strip of pitch is left */
const REVEAL_MIN_K = 0.15

/** Lets the results sheet (rendered as a child of the round) start the 2D replay. */
export const RoundControls = createContext<{
  replay2D: (who: PlayStory['who']) => void
  stopReplay: () => void
  replaying: boolean
  /** optional pitch layers (a tapped Brave / Danger row in the Why? tab) */
  setLayers: (show: RevealDraw['show']) => void
  /** the open "what the lines mean" popover (the ⓘ in the header): the results sheet fills it */
  legendEl: HTMLElement | null
  /** the layer a Why? row stands for: 'brave', 't<opponent index>' (his danger line) or null */
  layerOf: (point: string) => string | null
}>({
  replay2D: () => {},
  stopReplay: () => {},
  replaying: false,
  setLayers: () => {},
  layerOf: () => null,
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
  setLayers: (show: RevealDraw['show']) => void
}

export function Round({ track, settings, label, onResult, children, proMode = false, desk = false, guide }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dialRef = useRef<HTMLDivElement>(null)
  const dialTimeRef = useRef<HTMLElement>(null)
  const [phase, setPhase] = useState<Phase>('intro')
  const [started, setStarted] = useState(false) // the player started the round
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

  useEffect(() => {
    const canvas = canvasRef.current!
    const wrap = wrapRef.current!
    const S = settingsRef.current
    const r = new PitchRenderer(canvas, track)
    const pos = new Float32Array(track.n * 2)
    const ball = new Float32Array(2)
    const bestIdx = findBestPass(track).idx // may be a pass into space: the receiver is who you should spot
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
      waitFor3D: proMode, // Pro mode: hold the intro until the 3D view is ready
      waitForStart: true, // nothing moves until the player presses "Start scanning"
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
    const before = () => (track.rec - g.f) / FPS
    const stopLook = () => {
      g.look.active = false
      g.look.rec = null
    }
    const finish = (tap: [number, number] | null, now: number, lofted = false) => {
      if (g.pending) clearTimeout(g.pending.timer)
      g.pending = null
      g.f = track.rec
      stopLook()
      sample(track, track.rec, pos, ball) // reveal the TRUE positions at reception
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
        show: { brave: false, threats: [] },
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
        if (g.phase !== 'approach' || g.look.active || g.budget <= 0) return
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
        g.waitForStart = false
        g.t0 = performance.now() - INTRO_MS // straight into the approach (Pro mode still waits for 3D)
        sound.whistle(1, 0.22)
        setStarted(true)
      },
      replay(played, kick, take) {
        if (g.phase !== 'reveal') return
        // frame the whole play: the ball's path, you and whoever ends up with it
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
      setLayers(show) {
        if (!g.reveal) return
        g.reveal.show = show
        g.settled = false
      },
      stopReplay() {
        if (!g.replay) return
        g.replay = null
        sample(track, track.rec, pos, ball) // back to the reveal picture
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
      if (g.phase === 'intro' && (g.waitFor3D || g.waitForStart)) g.t0 = now
      if (g.phase === 'intro' && now - g.t0 >= INTRO_MS) go('approach', now)
      if (g.phase === 'approach') {
        g.f += (dt / 1000) * FPS * S.speed
        if (!g.kicked && g.f >= track.pass1) {
          g.kicked = true
          sound.kick()
        }
        if (g.f >= track.rec) {
          g.f = track.rec
          stopLook()
          sound.kick(0.4) // first touch
          vibrate(25)
          go('decide', now)
        }
      }
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
        if (L.active) {
          g.budget -= dt
          L.alpha = Math.min(1, L.alpha + dt / LOOK_FADE_IN_MS)
          if (L.rec) {
            L.rec.endBefore = before()
            if (bestInCone(L.dir)) L.rec.sawBestBefore = before()
          }
          if (g.budget <= 0) {
            g.budget = 0
            stopLook()
            vibrate(30)
          }
        } else {
          L.alpha = Math.max(0, L.alpha - dt / LOOK_FADE_OUT_MS)
        }
        if (dial) {
          dial.style.setProperty('--head', `${(L.dir * 180) / Math.PI}deg`)
          const b = Math.round(g.budget / 100) // update the DOM only when the tenth changes
          if (b !== shownBudget) {
            shownBudget = b
            dial.style.setProperty('--budget', String(g.budget / S.scanBudgetMs))
            if (dialTime) dialTime.textContent = `${(g.budget / 1000).toFixed(1)}s`
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
      onPointerDown={(e) => phase === 'intro' && !(e.target as HTMLElement).closest('button, .legend-pop') && api.current?.start()}
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
        {phase === 'decide' && (
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
            <div className="sub">Look around before the ball arrives</div>
            <Who m={m} />
            {startHint}
          </div>
        )}
      </div>
      <footer className="hud-bottom">
        {/* the controller keeps its place until the reveal (the pitch doesn't resize while you play);
            at the reveal it goes and the pitch grows under the results sheet */}
        <div className="scan-controls" style={phase === 'reveal' || proMode ? { visibility: 'hidden' } : undefined}>
          <span className="dial-hint">{phase === 'approach' ? 'Hold & turn to scan' : phase === 'decide' ? 'Pass!' : ''}</span>
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
      {phase === 'reveal' && (
        <RoundControls.Provider
          value={{
            replaying: replayStage >= 0,
            stopReplay,
            setLayers: (show) => api.current?.setLayers(show),
            legendEl,
            layerOf: (point) => {
              const res = lastResult.current
              if (!res) return null
              if (res.brave && /^brave option/i.test(point)) return 'brave'
              const t = res.threats.find((t) => new RegExp(`(?<![A-Za-z])[Rr]ed #${track.nums[t.idx]}(?!\\d)`).test(point))
              return t ? `t${t.idx}` : null
            },
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
  const pts: [number, number][] = [posAt(track, track.rec, track.youIdx), [track.ball[track.rec * 2], track.ball[track.rec * 2 + 1]], R.proEnd]
  for (const i of players) pts.push(posAt(track, track.rec, i))
  for (const t of R.threats) if (R.show.threats.includes(t.idx)) pts.push(t.from, t.at)
  if (R.bestIdx >= 0) pts.push(posAt(track, track.rec, R.bestIdx), R.best.end, R.best.ring, ...(R.best.alone ? (R.best.run ?? []) : []))
  if (R.brave && R.show.brave) pts.push(R.brave.end, ...(R.brave.run ?? []))
  if (R.chosenIdx >= 0) pts.push(posAt(track, track.rec, R.chosenIdx))
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

