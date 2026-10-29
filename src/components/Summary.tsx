import type { Ratings } from '../lib/profile'
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
  levelBefore: string
}

export function Summary({ s, onHome, onTraining }: { s: SessionSummary; onHome: () => void; onTraining: () => void }) {
  const score = useCountUp(s.score, 1200, 300)
  return (
    <div className="screen summary fade-in">
      <div className="done-badge">Daily training done ✓</div>
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
      {s.level !== s.levelBefore && (
        <div className="level-line">
          Level {s.levelBefore} → <b>{s.level}</b>
        </div>
      )}
      <PlayerCard before={s.before} after={s.after} level={s.level} />
      <ShareButton text={shareText(s.brains, s.score, s.kind === 'training')} />
      <div className="row">
        <button className="cta ghost" onClick={onHome}>
          Home
        </button>
        <button className="cta ghost" onClick={onTraining}>
          Train more
        </button>
      </div>
    </div>
  )
}
