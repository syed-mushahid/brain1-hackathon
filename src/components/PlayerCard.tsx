import { useRef } from 'react'
import { RATING_MIN_ROUNDS, type Ratings } from '../lib/profile'
import { TIERS, tierOf, type Tier } from '../lib/tiers'
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

const Badge = () => (
  <div className="pc-badge" aria-hidden>
    <svg viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="24" cy="24" r="7" fill="currentColor" />
      <path d="M24 4v8M24 36v8M4 24h8M36 24h8" stroke="currentColor" strokeWidth="3" />
    </svg>
  </div>
)

/** FIFA-style card in one of six tiers by OVR (lib/tiers.ts), with an ⓘ that shows all of them.
 *  Pass `before` to animate the change after a session; `locked` = too few rounds for a rating yet. */
export function PlayerCard({ after, before, locked }: { after: Ratings; before?: Ratings; locked?: boolean }) {
  return (
    <div className="card-wrap">
      {locked ? <LockedCard rounds={after.rounds} /> : <RatedCard after={after} before={before} />}
      <TierInfo current={locked ? null : tierOf(after.overall)} />
    </div>
  )
}

function LockedCard({ rounds }: { rounds: number }) {
  return (
    <div className="player-card locked">
      <div className="pc-lock" aria-hidden>
        <svg viewBox="0 0 24 24">
          <rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor" />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        </svg>
      </div>
      <div className="pc-name">YOU</div>
      <div className="pc-sub">
        {rounds}/{RATING_MIN_ROUNDS} rounds
      </div>
      <div className="pc-locked-text">Play {RATING_MIN_ROUNDS} rounds to unlock your rating</div>
    </div>
  )
}

function RatedCard({ after, before }: { after: Ratings; before?: Ratings }) {
  const b = before ?? after
  const ovr = useCountUp(after.overall, 1300, 300, b.overall)
  const tier = tierOf(after.overall)
  return (
    <div className={`player-card ${tier.id}`} aria-label={`${tier.name} card, overall ${after.overall}`}>
      <div className="pc-head">
        <div className="pc-ovr">
          <span>{Math.round(ovr)}</span>
          <small>OVR</small>
        </div>
        <Badge />
      </div>
      <div className="pc-tier">{tier.name}</div>
      <div className="pc-name">YOU</div>
      <div className="pc-sub">{after.rounds} rounds</div>
      <div className="pc-stats">
        <Stat label="SCAN" from={b.scan} to={after.scan} delay={200} />
        <Stat label="MEMORY" from={b.memory} to={after.memory} delay={350} />
        <Stat label="DECISION" from={b.decision} to={after.decision} delay={500} />
      </div>
    </div>
  )
}

/** ⓘ next to the card: all six tiers, yours marked. */
function TierInfo({ current }: { current: Tier | null }) {
  const ref = useRef<HTMLDialogElement>(null)
  return (
    <>
      <button className="tier-info-btn" onClick={() => ref.current?.showModal()} aria-label="All card tiers">
        ⓘ
      </button>
      <dialog ref={ref} className="tier-dialog" aria-label="Card tiers" onClick={(e) => e.target === e.currentTarget && ref.current?.close()}>
        <h2>Card tiers</h2>
        <p className="tier-note">Your card's tier follows your overall rating (OVR): the average Brain Score of your last 20 rounds.</p>
        <div className="tier-grid">
          {TIERS.map((t) => (
            <div key={t.id} className={`tier-mini ${current?.id === t.id ? 'you' : ''}`}>
              <div className={`player-card mini ${t.id}`}>
                <div className="pc-tier">{t.name}</div>
                <Badge />
              </div>
              <span className="tier-range">
                {t.min}–{t.max}
              </span>
              {current?.id === t.id && <span className="tier-you">You</span>}
            </div>
          ))}
        </div>
        <button className="cta ghost" onClick={() => ref.current?.close()}>
          Close
        </button>
      </dialog>
    </>
  )
}
