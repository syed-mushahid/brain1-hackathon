import { useEffect, useState } from 'react'
import type { RoundResult } from '../game/evaluate'
import { WEIGHTS } from '../game/scoring'
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

function Bar({ label, weight, value, delay }: { label: string; weight: number; value: number; delay: number }) {
  const v = useCountUp(value, 800, delay)
  return (
    <div className="bar-row">
      <span className="bar-label">
        {label} <small>{Math.round(weight * 100)}%</small>
      </span>
      <span className="bar-track">
        <span className="bar-fill" style={{ transform: `scaleX(${v / 100})` }} />
      </span>
      <span className="bar-val">{Math.round(v)}</span>
    </div>
  )
}

interface SheetProps {
  result: RoundResult
  onNext: () => void
  nextLabel: string
  onWatch3D?: () => void
}

export function ResultSheet({ result, onNext, nextLabel, onWatch3D }: SheetProps) {
  const { scores } = result
  const brain = useCountUp(scores.brain, 1200, 650)
  const [collapsed, setCollapsed] = useState(false)
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
          <div className="headline">{result.headline}</div>
          <div className="detail">{result.detail}</div>
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
      <div className="sheet-details">
        <Bar label="Decision" weight={WEIGHTS.decision} value={scores.decision} delay={100} />
        <Bar label="Scan" weight={WEIGHTS.scan} value={scores.scan} delay={250} />
        <Bar label="Memory" weight={WEIGHTS.memory} value={scores.memory} delay={400} />
      </div>
      <div className="legend">
        <span className="lg mine">You</span>
        <span className="lg pro">Pro</span>
        <span className="lg best">Best</span>
      </div>
      <div className="row">
        {onWatch3D && (
          <button
            className="cta ghost watch3d"
            onPointerDown={() => void loadReplay3D()} // start fetching the 3D chunk a little earlier
            onClick={onWatch3D}
          >
            👁 Watch from your eyes
          </button>
        )}
        <button className="cta" onClick={onNext}>
          {nextLabel}
        </button>
      </div>
    </div>
  )
}
