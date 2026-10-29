import type { Profile } from '../lib/profile'
import { ratings, streakView } from '../lib/profile'
import { dayKey, shortDate } from '../lib/util'
import { PlayerCard } from './PlayerCard'
import { ShareButton } from './ShareButton'
import { shareText } from '../lib/share'

interface Props {
  profile: Profile
  onDaily: () => void
  onTraining: () => void
  onToggleMute: () => void
  onTogglePro: () => void
}

export function Home({ profile, onDaily, onTraining, onToggleMute, onTogglePro }: Props) {
  const st = streakView(profile)
  const daily = profile.daily?.day === dayKey() ? profile.daily : null
  return (
    <div className="screen home fade-in">
      <header className="home-top">
        <div className={`streak ${st.count > 0 ? 'on' : ''}`} title="Streak">
          🔥 <b>{st.count}</b>
          <span className="streak-sub">{st.doneToday ? 'done today' : st.atRisk ? 'freeze will save it' : 'day streak'}</span>
        </div>
        <div className={`freeze ${st.freezeAvailable ? 'on' : ''}`} title="One free streak freeze per week">
          ❄️ {st.freezeAvailable ? 'Freeze ready' : 'Freeze used'}
        </div>
        <button className="icon-btn" onClick={onToggleMute} aria-label={profile.muted ? 'Unmute' : 'Mute'}>
          {profile.muted ? '🔇' : '🔊'}
        </button>
      </header>

      <div className="brand">
        <div className="logo-ring" aria-hidden />
        <h1>
          Scan <span>&amp;</span> Play
        </h1>
        <p className="tag">Brain1 · train attention, memory &amp; decisions with real Bundesliga moments</p>
      </div>

      <PlayerCard after={ratings(profile)} level={profile.level} />

      <section className="daily-card">
        <div className="daily-head">
          <div>
            <div className="eyebrow">Daily Challenge · {shortDate()}</div>
            <div className="daily-title">5 real moments, same for everyone</div>
          </div>
          {daily && <div className="daily-score">{daily.score}</div>}
        </div>
        {daily ? (
          <>
            <div className="done-line">Daily training done ✓</div>
            <ShareButton text={shareText(daily.brains, daily.score)} />
          </>
        ) : (
          <button className="cta" onClick={onDaily}>
            Play Daily Challenge
          </button>
        )}
      </section>

      <button className={`cta ${daily ? '' : 'ghost'}`} onClick={onTraining}>
        Free training · {profile.level}
      </button>
      <button className={`pro-toggle ${profile.proMode ? 'on' : ''}`} onClick={onTogglePro} role="switch" aria-checked={profile.proMode}>
        <span className="knob" />
        <span>
          <b>Pro mode</b> · scan in 3D first-person (training)
        </span>
      </button>

      <ol className="how">
        <li>
          <b>Scan</b> – hold &amp; turn the dial (or drag on the pitch) to look around while the ball comes
        </li>
        <li>
          <b>Remember</b> – the screen goes dark when you receive
        </li>
        <li>
          <b>Pass</b> – tap where your teammate is, within 2 s
        </li>
      </ol>

      <footer className="credit">Data: Deutsche Fußball Liga (DFL), Bassek et al. 2025, Scientific Data</footer>
    </div>
  )
}
