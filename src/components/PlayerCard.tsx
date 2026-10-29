import type { Ratings } from '../lib/profile'
import { useCountUp } from './ResultSheet'

function Stat({ label, from, to, delay }: { label: string; from: number; to: number; delay: number }) {
  const v = useCountUp(to, 1100, delay, from)
  const d = to - from
  return (
    <div className="pc-stat">
      <span className="pc-val">{Math.round(v)}</span>
      <span className="pc-lab">{label}</span>
      {d !== 0 && (
        <span className={`pc-delta ${d > 0 ? 'up' : 'down'}`} style={{ animationDelay: `${delay + 900}ms` }}>
          {d > 0 ? '▲' : '▼'}
          {Math.abs(d)}
        </span>
      )}
    </div>
  )
}

/** FIFA-style card. Pass `before` to animate the change after a session. */
export function PlayerCard({ after, before, level }: { after: Ratings; before?: Ratings; level?: string }) {
  const b = before ?? after
  const ovr = useCountUp(after.overall, 1300, 300, b.overall)
  const tier = after.overall >= 75 ? 'gold' : after.overall >= 60 ? 'silver' : 'bronze'
  return (
    <div className={`player-card ${tier}`}>
      <div className="pc-head">
        <div className="pc-ovr">
          <span>{Math.round(ovr)}</span>
          <small>OVR</small>
        </div>
        <div className="pc-badge" aria-hidden>
          <svg viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" />
            <circle cx="24" cy="24" r="7" fill="currentColor" />
            <path d="M24 4v8M24 36v8M4 24h8M36 24h8" stroke="currentColor" strokeWidth="3" />
          </svg>
        </div>
      </div>
      <div className="pc-name">YOU</div>
      <div className="pc-sub">
        {after.rounds} rounds{level ? ` · ${level}` : ''}
      </div>
      <div className="pc-stats">
        <Stat label="SCAN" from={b.scan} to={after.scan} delay={200} />
        <Stat label="MEMORY" from={b.memory} to={after.memory} delay={350} />
        <Stat label="DECISION" from={b.decision} to={after.decision} delay={500} />
      </div>
    </div>
  )
}
