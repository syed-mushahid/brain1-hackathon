import { useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { RoundControls } from '../game/Round'
import type { RoundResult } from '../game/evaluate'
import { BreakdownPanel, type Layers, type Tab } from './Breakdown'
import { Rich } from './Rich'
import { LineLegend } from './Legend'
import { scoreTone, WEIGHTS } from '../game/scoring'
import { loadReplay3D } from '../three/lazy'

/** Animate a number from `from` to `to` (ease-out), starting after `delay` ms. */
export function useCountUp(to: number, duration = 900, delay = 0, from = 0): number {
  const [v, setV] = useState(from)
  useEffect(() => {
    let raf = 0
    const t0 = performance.now() + delay
    const tick = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - t0) / duration))
      setV(from + (to - from) * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [to, duration, delay, from])
  return v
}

function Bar({ label, weight, value, delay }: { label: string; weight: number; value: number | null; delay: number }) {
  const v = useCountUp(value ?? 0, 800, delay)
  return (
    <div
      className={`bar ${value === null ? '' : scoreTone(value)}`}
      title={value === null ? `${label}: not tested` : `${label} counts ${Math.round(weight * 100)}% of the Brain Score`}
    >
      <span className="bar-label">{label}</span>
      <span className="bar-val" title={value === null ? 'Not tested: a pass into space has no teammate position to remember' : undefined}>
        {value === null ? '–' : Math.round(v)}
      </span>
      <span className="bar-track">
        <span className="bar-fill" style={{ transform: `scaleX(${v / 100})` }} />
      </span>
    </div>
  )
}

const TABS: [Tab, string, string][] = [
  ['why', 'Why?', 'Why?'],
  ['scan', 'Scan', 'Your scan'],
  ['match', 'Match', 'Match'],
]

/** the tall sheet: ~85-90 % of the screen, but always leaving a strip of pitch (px) above it */
const tallPx = () => Math.min(innerHeight * 0.9, innerHeight - 150)

interface SheetProps {
  result: RoundResult
  onNext: () => void
  nextLabel: string
  onWatch3D?: (mode: 'eyes' | 'tv', who: 'pro' | 'you') => void
  /** a link under the buttons (test mode: back home; training: end the session) */
  exit?: { label: string; onExit: () => void }
  /** big screens: the whole result in a panel left of the pitch, only Next under it */
  desk?: boolean
}

/**
 * The results sheet, with two snap points:
 *   compact (default) - headline, score, compact bars, chips (Why? · Scan · Match · ▶ Replay), Next
 *   tall              - a tab's content, scrolling, with Next pinned at the bottom
 * Tapping a tab chip or dragging the handle up opens it tall; × / dragging down / Esc goes back.
 */
export function ResultSheet({ result, onNext, nextLabel, onWatch3D, exit, desk = false }: SheetProps) {
  const { scores } = result
  const brain = useCountUp(scores.brain, 1200, 650)
  const ctl = useContext(RoundControls)
  const [snap, setSnap] = useState<'compact' | 'tall'>('compact')
  const [tab, setTab] = useState<Tab>('why')
  const [chooser, setChooser] = useState(false)
  const [in3D, setIn3D] = useState(false)
  const [playing, setPlaying] = useState<'pro' | 'you' | null>(null)
  const [active, setActive] = useState<string[]>([]) // Why? rows shown on the pitch
  const [dragH, setDragH] = useState<number | null>(null)
  const [compactH, setCompactH] = useState<number | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const gripRef = useRef<HTMLDivElement>(null)
  const compactRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null)
  // your pass can be simulated when you made one (Too slow has nothing to show)
  const canSimulate = !!result.tap

  useEffect(() => {
    if (!ctl.replaying) setPlaying(null)
  }, [ctl.replaying])

  // the pitch shows the brave / danger lines of the highlighted Why? rows
  useEffect(() => {
    ctl.setLayers({ brave: active.includes('brave'), threats: active.filter((k) => k[0] === 't').map((k) => Number(k.slice(1))) })
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  // the compact sheet's own height, so snapping between the two states can animate
  useLayoutEffect(() => {
    const inner = compactRef.current
    const sheet = sheetRef.current
    if (snap !== 'compact' || !inner || !sheet) return
    const measure = () => {
      const cs = getComputedStyle(sheet)
      setCompactH(Math.ceil(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + (gripRef.current?.offsetHeight ?? 0) + inner.offsetHeight))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [snap])

  const open = (t: Tab) => {
    setTab(t)
    setSnap('tall')
    setChooser(false)
  }
  const close = () => {
    setSnap('compact')
    setActive([]) // the lines belong with their rows
  }
  useEffect(() => {
    if (snap !== 'tall') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snap])

  // dragging the handle between the snap points (a tap toggles)
  const onGripDown = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: sheetRef.current?.offsetHeight ?? 0, moved: false }
  }
  const onGripMove = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dy = e.clientY - d.y
    if (Math.abs(dy) > 4) d.moved = true
    if (d.moved) setDragH(Math.max(compactH ?? 0, Math.min(tallPx(), d.h - dy)))
  }
  const onGripUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const h = dragH ?? d.h
    setDragH(null)
    if (!d.moved) return snap === 'tall' ? close() : open(tab)
    if (h > ((compactH ?? 0) + tallPx()) / 2) open(tab)
    else close()
  }

  const play = (who: 'pro' | 'you') => {
    setChooser(false)
    if (ctl.replaying) {
      ctl.stopReplay()
      if (playing === who) return // the same button again = stop
    }
    if (in3D && onWatch3D) return onWatch3D('tv', who)
    setPlaying(who)
    ctl.replay2D(who)
  }

  const layers: Layers = {
    keyOf: ctl.layerOf,
    active,
    toggle: (k) => setActive((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k])),
  }
  const R = 34
  const circ = 2 * Math.PI * R
  const tall = snap === 'tall'
  const height = dragH ?? (tall ? undefined : (compactH ?? undefined))
  const replayPicks = (
    <div className="replay-picks">
      {canSimulate && (
        <button className={`replay-btn ${playing === 'you' ? 'on' : ''}`} onClick={() => play('you')}>
          {playing === 'you' ? '■ Stop' : '▶ Your pass'}
          <small title="Your pass is simulated with the race model; the other players move as they really did.">simulated</small>
        </button>
      )}
      <button className={`replay-btn ${playing === 'pro' ? 'on' : ''}`} onClick={() => play('pro')}>
        {playing === 'pro' ? '■ Stop' : "▶ Pro's pass"}
        <small>the real play</small>
      </button>
    </div>
  )
  const viewSwitch = onWatch3D && (
    <div className="seg" role="radiogroup" aria-label="View">
      {[false, true].map((v) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={in3D === v}
          className={in3D === v ? 'on' : ''}
          onClick={() => {
            if (v) void loadReplay3D() // start fetching the 3D chunk early
            setIn3D(v)
          }}
        >
          {v ? '3D · TV camera' : '2D · on the pitch'}
        </button>
      ))}
    </div>
  )
  const ring = (
    <div className="brain-ring" aria-label={`Brain Score ${scores.brain}`}>
      <svg viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={R} className="ring-bg" />
        <circle cx="40" cy="40" r={R} className="ring-fg" strokeDasharray={circ} strokeDashoffset={circ * (1 - brain / 100)} />
      </svg>
      <div className="brain-num">{Math.round(brain)}</div>
      <div className="brain-cap">BRAIN</div>
    </div>
  )
  const bars = (
    <div className="bars">
      <Bar label="Decision" weight={WEIGHTS.decision} value={scores.decision} delay={100} />
      <Bar label="Scan" weight={WEIGHTS.scan} value={scores.scan} delay={250} />
      <Bar label="Memory" weight={WEIGHTS.memory} value={scores.memory} delay={400} />
    </div>
  )
  // what the lines mean, in the popover under the round's ⓘ (Round.tsx) while it is open
  const legend = ctl.legendEl && createPortal(<LineLegend result={result} active={active} />, ctl.legendEl)
  const nextButtons = (
    <>
      <button className="cta next-btn" onClick={onNext}>
        {nextLabel}
      </button>
      {exit && (
        <button className="test-exit" onClick={exit.onExit}>
          ← {exit.label}
        </button>
      )}
    </>
  )
  if (desk)
    return (
      <>
        {createPortal(
          <aside className="desk-panel desk-left" aria-label="Your result">
            <div className={`result-top tone-${result.tone}`}>
              <div className="result-text">
                <div className="headline">
                  <Rich text={result.headline} />
                </div>
                <div className="detail">
                  <Rich text={result.detail} />
                </div>
              </div>
              {ring}
            </div>
            {bars}
            <div className="desk-tabs" role="tablist" aria-label="Round details">
              {TABS.map(([t, chip]) => (
                <button key={t} role="tab" aria-selected={tab === t} className={`chip-btn ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                  {chip}
                </button>
              ))}
            </div>
            <BreakdownPanel tab={tab} b={result.breakdown} layers={layers} />
            <h3>Replay</h3>
            {replayPicks}
            {viewSwitch}
          </aside>,
          document.body,
        )}
        {legend}
        <div ref={sheetRef} className="result-sheet desk">
          {nextButtons}
        </div>
      </>
    )
  return (
    <>
      {legend}
      <div
        ref={sheetRef}
        className={`result-sheet tone-${result.tone} ${snap} ${dragH !== null ? 'dragging' : ''} ${tall && active.length ? 'peek' : ''}`}
        style={height !== undefined ? { height } : undefined}
      >
        <div
          ref={gripRef}
          className="sheet-grip"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          <button className="sheet-handle" aria-label={tall ? 'Back to the score' : 'Show the details'} aria-expanded={tall}>
            <i />
          </button>
        </div>

        {!tall ? (
          <div ref={compactRef} className="sheet-compact">
            <div className="result-top">
              <div className="result-text">
                <div className="headline">
                  <Rich text={result.headline} />
                </div>
                <div className="detail">
                  <Rich text={result.detail} />
                </div>
              </div>
              {ring}
            </div>
            {bars}
            <div className="chips" role="toolbar" aria-label="Round details">
              {TABS.map(([t, chip]) => (
                <button key={t} className="chip-btn" onClick={() => open(t)}>
                  {chip}
                </button>
              ))}
              <button
                className={`chip-btn replay ${chooser || playing ? 'on' : ''}`}
                aria-expanded={chooser}
                onClick={() => (ctl.replaying ? ctl.stopReplay() : setChooser((c) => !c))}
              >
                {ctl.replaying ? '■ Stop' : '▶ Replay'}
              </button>
            </div>
            {chooser && (
              <div className="replay-chooser" aria-label="Replay">
                {replayPicks}
                {viewSwitch}
              </div>
            )}
            {nextButtons}
          </div>
        ) : (
          <div className="sheet-tall">
            <div className="tall-head">
              <h2>{TABS.find(([t]) => t === tab)![2]}</h2>
              {/* the other two tabs, one tap away */}
              <nav className="tall-switch" aria-label="Other details">
                {TABS.filter(([t]) => t !== tab).map(([t, chip]) => (
                  <button key={t} onClick={() => setTab(t)}>
                    {chip}
                  </button>
                ))}
              </nav>
              <button className="icon-btn close" onClick={close} aria-label="Close">
                ×
              </button>
            </div>
            <div className="tall-body">
              {tab === 'why' && (
                <p className="lead">
                  <Rich text={result.detail} />
                </p>
              )}
              <BreakdownPanel tab={tab} b={result.breakdown} layers={layers} />
            </div>
            <div className="tall-foot">{nextButtons}</div>
          </div>
        )}
      </div>
    </>
  )
}
