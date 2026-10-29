import { useState } from 'react'
import type { Moment } from '../types'
import type { Profile } from '../lib/profile'
import { findMoments, momentLabel } from '../lib/findMoment'
import { ratings, streakView } from '../lib/profile'
import { dayKey, shortDate } from '../lib/util'
import { PlayerCard } from './PlayerCard'
import { ShareButton } from './ShareButton'
import { shareText } from '../lib/share'

interface Props {
  profile: Profile
  /** every loaded moment, for "Test a moment" */
  moments: Moment[]
  onDaily: () => void
  onTraining: () => void
  /** play one moment again and again (testing) */
  onTest: (m: Moment) => void
  onToggleMute: () => void
  onTogglePro: () => void
}

export function Home({ profile, moments, onDaily, onTraining, onTest, onToggleMute, onTogglePro }: Props) {
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
          <b>Pro mode</b> · scan in 3D first-person (training &amp; tests)
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

      <TestMoment moments={moments} onTest={onTest} />

      <footer className="credit">Data: Deutsche Fußball Liga (DFL), Bassek et al. 2025, Scientific Data</footer>
    </div>
  )
}

/** Testing aid: play a moment by its id (or part of it, or its match clock), as often as you like. */
function TestMoment({ moments, onTest }: { moments: Moment[]; onTest: (m: Moment) => void }) {
  const [q, setQ] = useState('')
  const [tried, setTried] = useState(false)
  const found = findMoments(moments, q)
  const play = () => {
    setTried(true)
    if (found.length === 1) onTest(found[0])
  }
  return (
    <details className="test-moment">
      <summary>Test a moment</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          play()
        }}
      >
        <input
          list="moment-ids"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setTried(false)
          }}
          placeholder="Moment id, part of it, or a clock like 18:30"
          aria-label="Moment id"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button className="cta" type="submit" disabled={!q.trim()}>
          Play
        </button>
      </form>
      <datalist id="moment-ids">
        {moments.map((m) => (
          <option key={m.id} value={m.id}>
            {momentLabel(m)}
          </option>
        ))}
      </datalist>
      {tried && found.length === 0 && <p className="test-msg">No moment matches “{q.trim()}”.</p>}
      {tried && found.length > 1 && (
        <div className="test-msg">
          {found.length} moments match – pick one:
          <ul>
            {found.slice(0, 8).map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onTest(m)}>
                  <b>{m.id}</b> · {momentLabel(m)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="test-hint">
        Plays that moment again and again (“Play again” after each try). Test rounds don’t count towards your ratings or
        streak. Link straight to one with <code>?test=&lt;id&gt;</code>.
      </p>
    </details>
  )
}
