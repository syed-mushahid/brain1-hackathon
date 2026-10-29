import type { Ratings } from '../lib/profile'
import type { Insight } from '../lib/insights'
import type { LevelChange } from '../App'
import { square } from '../game/scoring'
import { shareText } from '../lib/share'
import { PlayerCard } from './PlayerCard'
import { ShareButton } from './ShareButton'
import { useCountUp } from './ResultSheet'

export interface SessionSummary {
  kind: 'daily' | 'training'
  brains: number[]
  score: number
  before: Ratings
  after: Ratings
  streak: number
  usedFreeze: boolean
  level: string
  levelChanges: LevelChange[]
  insight: Insight | null
}

export function Summary({ s, onHome, onTraining }: { s: SessionSummary; onHome: () => void; onTraining: () => void }) {
  const score = useCountUp(s.score, 1200, 300)
  return (
    <div className="screen summary fade-in">
      <div className="done-badge">{s.kind === 'daily' ? 'Daily Challenge done ✓' : 'Training done ✓'}</div>
      <div className="sum-score">
        <span className="sum-num">{Math.round(score)}</span>
        <span className="sum-cap">Brain Score{s.kind === 'daily' ? ' · Daily Challenge' : ' · Training'}</span>
      </div>
      <div className="squares">
        {s.brains.map((b, i) => (
          <span key={i} style={{ animationDelay: `${400 + i * 120}ms` }}>
            {square(b)}
          </span>
        ))}
      </div>
      <div className="streak-line">
        🔥 {s.streak} day streak{s.usedFreeze ? ' · ❄️ freeze used to save it' : ''}
      </div>
      {/* recordRound's rule: the last 3 rounds average above 80 = one level up, below 50 = one down */}
      {s.levelChanges.map((c, i) => (
        <div key={i} className="level-line">
          Level {c.from} → <b>{c.to}</b>
          <small>
            your last 3 rounds averaged {c.avg} ({c.avg > 80 ? 'above 80' : 'below 50'})
          </small>
        </div>
      ))}
      <PlayerCard before={s.before} after={s.after} level={s.level} />
      {s.insight && <p className={`insight ${s.insight.tone}`}>{s.insight.text}</p>}
      <ShareButton text={shareText(s.brains, s.score, s.kind === 'training')} />
      <div className="row next-actions">
        <button className="cta ghost" onClick={onHome}>
          Home
        </button>
        <button className="cta ghost" onClick={onTraining}>
          Train again
        </button>
      </div>
    </div>
  )
}
