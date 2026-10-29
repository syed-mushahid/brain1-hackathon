import { useContext, useEffect, useRef, useState } from 'react'
import { RoundControls } from '../game/Round'
import type { RoundResult } from '../game/evaluate'
import { BreakdownPanel, type Tab } from './Breakdown'
import { Rich } from './Rich'
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
    <div className={`bar-row ${value === null ? '' : scoreTone(value)}`}>
      <span className="bar-label">
        {label} <small>{value === null ? 'n/a' : `${Math.round(weight * 100)}%`}</small>
      </span>
      <span className="bar-track">
        <span className="bar-fill" style={{ transform: `scaleX(${v / 100})` }} />
      </span>
      <span className="bar-val" title={value === null ? 'Not tested: a pass into space has no teammate position to remember' : undefined}>
        {value === null ? '–' : Math.round(v)}
      </span>
    </div>
  )
}

const TABS: [Tab, string][] = [
  ['why', 'Why?'],
  ['scan', 'Your scan'],
  ['match', 'Match'],
]

interface SheetProps {
  result: RoundResult
  onNext: () => void
  nextLabel: string
  onWatch3D?: (mode: 'eyes' | 'tv', who: 'pro' | 'you') => void
}

export function ResultSheet({ result, onNext, nextLabel, onWatch3D }: SheetProps) {
  const { scores } = result
  const brain = useCountUp(scores.brain, 1200, 650)
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<Tab | null>(null)
  // replays play on the pitch (2D) unless the 3D switch is on (TV camera)
  const [in3D, setIn3D] = useState(false)
  const [playing, setPlaying] = useState<'pro' | 'you' | null>(null)
  // your pass can be simulated when you made one (a timeout has nothing to show)
  const canSimulate = !!result.tap
  const ctl = useContext(RoundControls)
  // fold the sheet away while the 2D replay runs on the pitch, then put it back as it was
  const before = useRef<boolean | null>(null)
  useEffect(() => {
    if (ctl.replaying) return
    setPlaying(null)
    if (before.current !== null) {
      setCollapsed(before.current)
      before.current = null
    }
  }, [ctl.replaying])
  const play = (who: 'pro' | 'you') => {
    if (ctl.replaying) {
      ctl.stopReplay()
      if (playing === who) return // the same button again = stop
    }
    if (in3D && onWatch3D) return onWatch3D('tv', who)
    if (before.current === null) before.current = collapsed
    setCollapsed(true)
    setPlaying(who)
    ctl.replay2D(who)
  }
  // the legend lists only what this reveal draws (renderer.ts drawReveal)
  const r = result
  const drawn = {
    you: !!r.tap,
    run: !!(r.run || r.space?.team || (r.best.alone && r.best.run) || r.brave?.run),
    steal: r.run?.team === 'def' || r.space?.team === 'def',
    danger: r.threats.length > 0,
    brave: !!r.brave,
    lofted: (!!r.tap && r.lofted) || r.proLofted || (r.best.alone && r.best.lofted) || !!r.brave?.lofted,
  }
  const R = 34
  const circ = 2 * Math.PI * R
  return (
    <div className={`result-sheet tone-${result.tone} ${collapsed ? 'collapsed' : ''}`}>
      {/* collapse to see more of the pitch (the pitch re-frames into the freed space) */}
      <button
        className="sheet-handle"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? 'Show score details' : 'Hide score details'}
        aria-expanded={!collapsed}
      >
        <i />
      </button>
      <div className="result-top">
        <div className="result-text">
          <div className="headline">
            <Rich text={result.headline} />
          </div>
          <div className="detail">
            <Rich text={result.detail} />
          </div>
        </div>
        <div className="brain-ring" aria-label={`Brain Score ${scores.brain}`}>
          <svg viewBox="0 0 80 80">
            <circle cx="40" cy="40" r={R} className="ring-bg" />
            <circle
              cx="40"
              cy="40"
              r={R}
              className="ring-fg"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - brain / 100)}
            />
          </svg>
          <div className="brain-num">{Math.round(brain)}</div>
          <div className="brain-cap">BRAIN</div>
        </div>
      </div>
      <div className="sheet-tabs" role="tablist" aria-label="Round breakdown">
        {TABS.map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab ${tab === t ? 'on' : ''}`}
            onClick={() => setTab(tab === t ? null : t)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab ? (
        <BreakdownPanel tab={tab} b={result.breakdown} />
      ) : (
        <div className="sheet-details">
          <Bar label="Decision" weight={WEIGHTS.decision} value={scores.decision} delay={100} />
          <Bar label="Scan" weight={WEIGHTS.scan} value={scores.scan} delay={250} />
          <Bar label="Memory" weight={WEIGHTS.memory} value={scores.memory} delay={400} />
        </div>
      )}
      <div className="legend">
        {drawn.you && <span className="lg mine">You</span>}
        <span className="lg pro">Pro</span>
        <span className="lg best">Best</span>
        {drawn.run && <span className="lg run">Run</span>}
        {drawn.steal && <span className="lg run def">Steal</span>}
        {drawn.danger && <span className="lg danger">Danger</span>}
        {drawn.brave && <span className="lg brave">Brave</span>}
        {drawn.lofted && <span className="lg loft">Lofted</span>}
      </div>
      <div className="replay-row">
        <div className="replay-you">
          <button
            className={`replay-btn ${playing === 'you' ? 'on' : ''}`}
            disabled={!canSimulate}
            onClick={() => play('you')}
            title={canSimulate ? undefined : 'You did not pass'}
          >
            {playing === 'you' ? '■ Stop' : '▶ Your pass'}
          </button>
          {canSimulate && (
            <small className="replay-note" title="Your pass is simulated with the race model; the other players move as they really did.">
              simulated
            </small>
          )}
        </div>
        <button className={`replay-btn ${playing === 'pro' ? 'on' : ''}`} onClick={() => play('pro')}>
          {playing === 'pro' ? '■ Stop' : "▶ Pro's pass"}
        </button>
        {onWatch3D && (
          <button
            className={`toggle-3d ${in3D ? 'on' : ''}`}
            role="switch"
            aria-checked={in3D}
            aria-label="Replay in 3D (TV camera)"
            onClick={() => {
              if (!in3D) void loadReplay3D() // start fetching the 3D chunk early
              setIn3D((v) => !v)
            }}
          >
            3D
          </button>
        )}
      </div>
      <button className="cta next-btn" onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  )
}
