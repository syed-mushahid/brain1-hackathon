import type { Profile } from '../lib/profile'
import { RATING_MIN_ROUNDS, ratings, streakView } from '../lib/profile'
import { tierOf } from '../lib/tiers'
import { PlayerCard } from './PlayerCard'

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase())
const longDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Statistics (from Home): the player card and what your passes did, counted over all your rounds. */
export function StatsScreen({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const r = ratings(profile)
  const s = profile.stats
  const locked = r.rounds < RATING_MIN_ROUNDS
  const pct = (n: number) => (s.rounds ? `${Math.round((100 * n) / s.rounds)}% of your rounds` : '')
  const tiles: [string, number, string, string][] = [
    ['Rounds played', s.rounds, '', ''],
    ['Best option found', s.best, pct(s.best), 'good'],
    ['Better than the pro', s.betterThanPro, pct(s.betterThanPro), 'good'],
    ['Same pass as the pro', s.sameAsPro, pct(s.sameAsPro), ''],
    ['Passes intercepted', s.intercepted, pct(s.intercepted), 'bad'],
    ['Too slow', s.tooSlow, pct(s.tooSlow), 'bad'],
  ]
  return (
    <div className="screen stats fade-in">
      <header className="stats-top">
        <button className="cta ghost back-btn" onClick={onBack}>
          ← Home
        </button>
        <h1>Statistics</h1>
      </header>
      <PlayerCard after={r} locked={locked} />
      {!locked && (
        <p className="stats-tier">
          {tierOf(r.overall).name} card · OVR {r.overall}
        </p>
      )}
      <div className="stat-grid">
        {tiles.map(([label, n, share, tone]) => (
          <div key={label} className={`stat-tile ${tone}`}>
            <span className="stat-num">{n}</span>
            <span className="stat-lab">{label}</span>
            {share && <small className="stat-share">{share}</small>}
          </div>
        ))}
      </div>
      <ul className="stats-more">
        <li>
          Training level: <b>{cap(profile.level)}</b> (adapts to you)
        </li>
        <li>
          Streak: <b>{streakView(profile).count} days</b>
        </li>
        <li>Counted since {longDate(s.since)}{s.rounds ? '' : ': play a round to start'}</li>
      </ul>
    </div>
  )
}
