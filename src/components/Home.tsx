import { useEffect, useState } from 'react'
import type { Moment } from '../types'
import type { Profile } from '../lib/profile'
import { RATING_MIN_ROUNDS, ratings, streakView } from '../lib/profile'
import { findMoments, momentLabel } from '../lib/findMoment'
import { dayKey, shortDate } from '../lib/util'
import { homeInsight } from '../lib/insights'
import { useMedia } from '../lib/useMedia'
import { PlayerCard } from './PlayerCard'
import { ShareButton } from './ShareButton'
import { MomentPreview } from './MomentPreview'
import { shareText } from '../lib/share'
import { FEATURES } from '../lib/features'
import { sound } from '../lib/sound'

interface Props {
  profile: Profile
  /** every loaded moment, for "Test a moment" */
  moments: Moment[]
  /** the moment shown on a loop (not one of today's daily moments) */
  preview: Moment | null
  onDaily: () => void
  onTraining: () => void
  /** play one moment again and again (testing) */
  onTest: (m: Moment) => void
  onToggleMute: () => void
  onTogglePro: () => void
  /** "How to play": shown only when there is a tutorial to start (lib/features.ts) */
  onHowToPlay?: () => void
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase())

export function Home({ profile, moments, preview, onDaily, onTraining, onTest, onToggleMute, onTogglePro, onHowToPlay }: Props) {
  const wide = useMedia('(min-width: 1024px)')
  useHomeMusic(profile.muted)
  // a clock for the "next challenge in" countdown; at midnight the new challenge appears by itself
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])
  const today = dayKey(new Date(now))
  const st = streakView(profile, today)
  const daily = profile.daily?.day === today ? profile.daily : null
  const r = ratings(profile)
  const insight = homeInsight(profile, today)
  const card = (
    <>
      <PlayerCard after={r} level={profile.level} locked={r.rounds < RATING_MIN_ROUNDS} />
      {insight && <p className={`insight ${insight.tone}`}>{insight.text}</p>}
    </>
  )
  const main = (
    <div className={`screen home ${wide ? '' : 'fade-in'}`}>
      <header className="home-top">
        <div className={`streak ${st.count > 0 ? 'on' : ''}`}>
          🔥{' '}
          {st.count > 0 ? (
            <>
              <b>{st.count}</b>
              <span className="streak-sub">{st.doneToday ? 'done today' : st.atRisk ? 'freeze will save it' : 'day streak'}</span>
            </>
          ) : (
            <span className="streak-sub">Start your streak today</span>
          )}
        </div>
        {st.count >= 1 && <Freeze ready={st.freezeAvailable} />}
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

      {card}

      <section className="daily-card">
        <div className="daily-head">
          <div>
            <div className="eyebrow">Daily Challenge · {shortDate(new Date(now))}</div>
            <div className="daily-title">5 real moments, same for everyone</div>
            <div className="daily-meta">about 3 min</div>
          </div>
        </div>
        {daily ? (
          <div className="daily-done">
            <div className="done-line">
              Done ✓ · Brain Score {daily.score}
              <small>
                next challenge in {untilMidnight(now)}
              </small>
            </div>
            <ShareButton text={shareText(daily.brains, daily.score)} compact />
          </div>
        ) : (
          <button className="cta" onClick={onDaily}>
            Play Daily Challenge
          </button>
        )}
      </section>

      <button className={`cta ${daily ? '' : 'ghost'}`} onClick={onTraining}>
        Free training · Level: {cap(profile.level)} <small className="cta-sub">(adapts to you)</small>
      </button>
      {FEATURES.proMode && (
        <button className={`pro-toggle ${profile.proMode ? 'on' : ''}`} onClick={onTogglePro} role="switch" aria-checked={profile.proMode}>
          <span className="knob" />
          <span>
            <b>Pro mode</b> <span className="badge">Beta</span> · scan in 3D first-person (training &amp; tests)
          </span>
        </button>
      )}
      {onHowToPlay && (
        <button className="cta ghost how-btn" onClick={onHowToPlay}>
          How to play
        </button>
      )}

      <ol className="how">
        <li>
          <b>Scan</b>: hold &amp; turn the dial (or drag on the pitch) to look around while the ball comes
        </li>
        <li>
          <b>Remember</b>: the screen goes dark when you receive
        </li>
        <li>
          <b>Pass</b>: tap a teammate or into space within 2 s · double-tap for a lofted pass
        </li>
      </ol>

      <TestMoment moments={moments} onTest={onTest} />

      <footer className="credit">Data: Deutsche Fußball Liga (DFL), Bassek et al. 2025, Scientific Data</footer>
    </div>
  )
  // the moment fills the whole screen behind everything (outside the animated layer: a transform
  // there would pin the fixed background to it)
  const bg = preview && <MomentPreview moment={preview} focusX={wide ? 0.33 : 0.5} />
  return (
    <>
      {bg}
      {/* desktop: the card and buttons on the right, the moment showing on the left */}
      {wide ? <div className="home-wide fade-in">{main}</div> : main}
    </>
  )
}

/** Streak freeze pill with a tooltip (hover / focus on desktop, tap on touch). */
function Freeze({ ready }: { ready: boolean }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => setOpen(false), 3000)
    return () => clearTimeout(t)
  }, [open])
  return (
    <button
      className={`freeze ${ready ? 'on' : ''} ${open ? 'tip-open' : ''}`}
      onClick={() => setOpen((o) => !o)}
      onBlur={() => setOpen(false)}
      aria-describedby="freeze-tip"
    >
      ❄️ {ready ? 'Freeze ready' : 'Freeze used'}
      <span role="tooltip" id="freeze-tip" className="tip">
        {ready ? 'Miss one day without losing your streak' : 'Used this week: a new one comes on Monday'}
      </span>
    </button>
  )
}

/** Time left until the next daily challenge (local midnight): "8 h 12 min". */
function untilMidnight(now: number): string {
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  const min = Math.max(1, Math.ceil((midnight.getTime() - now) / 60000))
  const h = Math.floor(min / 60)
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`
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

/**
 * Background music while the home screen is open (lib/sound.ts musicOn): browsers only allow sound
 * after a tap or key press, so it starts with the first one (or straight away when audio is already
 * unlocked, e.g. back from a session). Off when muted, while the tab is hidden, and when leaving home.
 */
function useHomeMusic(muted: boolean) {
  useEffect(() => {
    if (muted) return
    const start = () => {
      sound.unlock()
      if (!document.hidden) sound.musicOn()
    }
    const onVisible = () => (document.hidden ? sound.musicOff() : sound.ready && sound.musicOn())
    if (sound.ready) start()
    window.addEventListener('pointerdown', start, { once: true })
    window.addEventListener('keydown', start, { once: true })
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('pointerdown', start)
      window.removeEventListener('keydown', start)
      document.removeEventListener('visibilitychange', onVisible)
      sound.musicOff()
    }
  }, [muted])
}
