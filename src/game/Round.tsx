import { Suspense, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { FPS, posAt, sample, type Track } from './track'
import { PitchRenderer, type RevealDraw, type Scene, type View } from './renderer'
import { evaluate, type RoundResult } from './evaluate'
import { coneVis, dirTo, HEAD_TURN, turnTowards, type ScanRecord } from './vision'
import { ScanDial } from './ScanDial'
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
const FRAME_MARGIN_M = 7 // space kept around the action when the reveal camera frames it

interface Props {
  track: Track
  settings: RoundSettings
  label: string
  onResult: (r: RoundResult, scans: ScanRecord[]) => void
  /** shown in the bottom panel once the round is revealed */
  children?: ReactNode
  /** Pro mode: the scan phase is played first-person in 3D (lazy-loaded) */
  proMode?: boolean
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
}

export function Round({ track, settings, label, onResult, children, proMode = false }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dialRef = useRef<HTMLDivElement>(null)
  const dialTimeRef = useRef<HTMLElement>(null)
  const [phase, setPhase] = useState<Phase>('intro')
  const api = useRef<Api | null>(null)
  const pitchAim = useRef(false) // a finger is aiming on the pitch
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
    const bestIdx = track.pids.indexOf(track.m.best_option_pid)
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
    }
    sound.whistle(1, 0.22)
    sound.crowd(0.25)
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
    const finish = (tap: [number, number] | null, now: number) => {
      g.f = track.rec
      stopLook()
      sample(track, track.rec, pos, ball) // reveal the TRUE positions at reception
      const res = evaluate(track, { tap, scans: g.scans })
      g.reveal = { progress: 0, tap: res.tap, chosenIdx: res.chosenIdx, proEnd: res.proEnd, bestIdx: res.bestIdx }
      if (tap) {
        sound.kick(0.9)
        vibrate(15)
      }
      sound.react(res.tone === 'great')
      setTimeout(() => vibrate(res.tone === 'great' ? [20, 60, 20] : res.tone === 'bad' ? 70 : 30), 350)
      go('reveal', now)
      onResultRef.current(res, g.scans)
    }
    /** The box that matters at the reveal, fitted into the canvas area not covered by the sheet. */
    const revealView = (R: RevealDraw): View => {
      const pts: [number, number][] = [posAt(track, track.rec, track.youIdx), R.proEnd]
      if (R.bestIdx >= 0) pts.push(posAt(track, track.rec, R.bestIdx))
      if (R.chosenIdx >= 0) pts.push(posAt(track, track.rec, R.chosenIdx))
      if (R.tap) pts.push(R.tap)
      const us = pts.map((p) => p[0])
      const vs = pts.map((p) => p[1])
      let visibleH = r.h
      const root = rootRef.current
      const sheet = root?.querySelector<HTMLElement>('.result-sheet')
      if (root && sheet) {
        // offsetTop ignores the sheet's slide-in transform: we aim for where it will settle
        const sheetTop = root.getBoundingClientRect().top + sheet.offsetTop
        visibleH = Math.max(120, Math.min(r.h, sheetTop - canvas.getBoundingClientRect().top - 6))
      }
      return r.fitView(
        Math.min(...us) - FRAME_MARGIN_M,
        Math.min(...vs) - FRAME_MARGIN_M,
        Math.max(...us) + FRAME_MARGIN_M,
        Math.max(...vs) + FRAME_MARGIN_M,
        visibleH,
      )
    }
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
        finish(r.toPitch(cx - rect.left, cy - rect.top), performance.now())
      },
      ready() {
        if (g.waitFor3D) {
          g.waitFor3D = false
          g.t0 = performance.now()
        }
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
      if (g.phase === 'intro' && g.waitFor3D) g.t0 = now
      if (g.phase === 'intro' && now - g.t0 >= INTRO_MS) go('approach', now)
      if (g.phase === 'approach') {
        g.f += (dt / 1000) * FPS * S.speed
        if (!g.kicked && g.f >= track.pass1) {
          g.kicked = true
          sound.kick()
        }
        sound.crowd(0.3 + 0.75 * (g.f / track.rec)) // the crowd builds towards the decision
        if (g.f >= track.rec) {
          g.f = track.rec
          stopLook()
          sound.kick(0.4) // first touch
          sound.crowd(1.1)
          vibrate(25)
          go('decide', now)
        }
      }
      if (g.phase === 'decide' && now - g.t0 >= S.decideMs) finish(null, now)
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
        reveal: g.reveal,
        view: g.view,
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
    }
  }
  const onPitchMove = (e: RPointerEvent) => {
    if (pitchAim.current && api.current) api.current.lookMove(api.current.dirToPoint(e.clientX, e.clientY))
  }
  const onPitchUp = () => {
    if (!pitchAim.current) return
    pitchAim.current = false
    api.current?.lookEnd()
  }
  const m = track.m

  return (
    <div ref={rootRef} className={`round phase-${phase}`} data-moment={track.m.id}>
      <header className="hud-top">
        <span className="chip">{label}</span>
        <span className="clock">{m.clock}′</span>
        <span className={`chip diff diff-${m.difficulty}`}>{m.difficulty}</span>
      </header>
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
          <div className="overlay intro">
            <div className="big">Get ready</div>
            <div className="sub">Hold &amp; turn the dial – or drag on the pitch – to look around.</div>
          </div>
        )}
        {phase === 'decide' && <div className="overlay banner">PASS! Tap your teammate</div>}
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
          </div>
        )}
      </div>
      <footer className="hud-bottom">
        {/* the controller stays in the layout during the reveal so the pitch never resizes */}
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
      {phase === 'reveal' && children}
    </div>
  )
}
