import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { Moment, MomentData } from './types'
import { buildTrack } from './game/track'
import { loadMoments } from './data/load'
import { Round, Who, type RoundSettings } from './game/Round'
import type { RoundResult } from './game/evaluate'
import { ResultSheet } from './components/ResultSheet'
import { Home } from './components/Home'
import { Summary, type SessionSummary } from './components/Summary'
import {
  completeDay,
  dailyMoments,
  LEVEL_SETTINGS,
  loadProfile,
  pickTraining,
  ratings,
  recordRound,
  saveProfile,
  type Level,
  type Profile,
  type Ratings,
} from './lib/profile'
import { dayKey, hashString } from './lib/util'
import { sessionInsight, type SessionRound } from './lib/insights'
import { MODEL } from './game/model.config'
import { FEATURES } from './lib/features'
import { useMedia } from './lib/useMedia'
import { GuidePanel } from './components/GuidePanel'
import { StatsScreen } from './components/StatsScreen'
import { addRound, roundTags } from './lib/stats'
import { sound } from './lib/sound'
import { loadProScan3D, loadReplay3D, Replay3D } from './three/lazy'
import { loadPlay, withPlay } from './lib/plays'
import { buildUserPlay, proStory, type PlayStory } from './game/userPlay'
import type { ReplayMode } from './three/Replay3D'

/** the Daily Challenge has 5 moments; free training goes on as long as you like, and counts for
 *  your streak from this many rounds */
export const ROUNDS_PER_SESSION = 5

interface Session {
  /** test = one moment again and again (testing aid): nothing is recorded */
  kind: 'daily' | 'training' | 'test'
  queue: Moment[]
  index: number
  brains: number[]
  settings: RoundSettings
  result: RoundResult | null
  before: Ratings
  /** for the summary's insight line */
  rounds: SessionRound[]
  /** level changes during the session, with the 3-round average that triggered each */
  levelChanges: LevelChange[]
}

export interface LevelChange {
  from: Level
  to: Level
  avg: number
}

/** What the summary's insight needs from a round (presentation only). */
const sessionRound = (res: RoundResult): SessionRound => ({
  scores: res.scores,
  risky: res.risk === 'high' || !!res.lost || res.space?.team === 'def',
  best: res.mineIsBest,
  look: res.breakdown.scan.timing >= MODEL.scoring.scan.timingFresh ? 'fresh' : res.breakdown.scan.timing > 0 ? 'early' : 'none',
})

export default function App() {
  const [data, setData] = useState<{ moments: Moment[] } | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [profile, setProfileState] = useState<Profile>(loadProfile)
  // big screens: the result in a panel left of the pitch, rules and a way home on the right
  const desk = useMedia('(min-width: 1180px)')
  // Pro mode (3D first-person scan) is switched off for now: a saved "on" is ignored (lib/features.ts)
  const proMode = FEATURES.proMode && profile.proMode
  const [session, setSession] = useState<Session | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [showStats, setShowStats] = useState(false)
  // the rules during a round: hidden until the "?" in the round's header asks for them
  const [guideOpen, setGuideOpen] = useState(false)
  const [replay, setReplay] = useState<{ moment: MomentData; mode: ReplayMode; bestIdx: number } | null>(null)
  const [replayLoading, setReplayLoading] = useState(false)

  useEffect(() => {
    // the manifest lists the moment files; each is validated against the data contract and
    // prepared by the game's own model (data/load.ts)
    loadMoments((done, total) => setProgress([done, total]))
      .then((moments) => (moments.length ? setData({ moments }) : Promise.reject(new Error('no playable moments'))))
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => sound.setMuted(profile.muted), [profile.muted])

  // ?test=<id>: straight into that moment in test mode (bookmarkable, survives a reload)
  const autoTest = useRef(new URLSearchParams(location.search).get('test'))
  useEffect(() => {
    if (!data || !autoTest.current) return
    const m = data.moments.find((x) => x.id === autoTest.current)
    autoTest.current = null
    if (m) startTest(m)
    else console.warn(`[test] no moment ${new URLSearchParams(location.search).get('test')}`)
  }, [data])

  const setProfile = (p: Profile) => {
    setProfileState(p)
    saveProfile(p)
  }

  // the moment looping on the home screen: one of the moments not in today's challenge, picked by the date
  const preview = useMemo(() => {
    if (!data) return null
    const daily = new Set(dailyMoments(data.moments).map((m) => m.id))
    const pool = data.moments.filter((m) => !daily.has(m.id))
    const list = pool.length ? pool : data.moments
    return list[hashString(`preview:${dayKey()}`) % list.length]
  }, [data])

  const current = session ? session.queue[session.index] : null
  const track = useMemo(() => (current ? buildTrack(current) : null), [current])

  const start = (kind: Session['kind']) => {
    if (!data) return
    sound.unlock() // user gesture: allowed to start audio now
    if (kind === 'training' && proMode) void loadProScan3D() // warm up the 3D chunk
    let queue: Moment[]
    if (kind === 'daily') queue = dailyMoments(data.moments)
    else {
      // ?moment=<id> forces the first training moment (handy for testing)
      const forced = data.moments.find((m) => m.id === new URLSearchParams(location.search).get('moment'))
      queue = [forced ?? pickTraining(profile, data.moments, [])]
    }
    setSummary(null)
    setGuideOpen(false) // a new session starts with the guide hidden
    setSession({
      kind,
      queue,
      index: 0,
      brains: [],
      settings: kind === 'daily' ? LEVEL_SETTINGS.normal : LEVEL_SETTINGS[profile.level],
      result: null,
      before: ratings(profile),
      rounds: [],
      levelChanges: [],
    })
  }

  /** Test mode: play moment m, then "Play again" replays it; nothing goes into your profile. */
  const startTest = (m: Moment) => {
    sound.unlock()
    if (proMode) void loadProScan3D()
    setUrlTest(m.id)
    setSummary(null)
    setGuideOpen(false) // a new session starts with the guide hidden
    setSession({
      kind: 'test',
      queue: [m],
      index: 0,
      brains: [],
      settings: LEVEL_SETTINGS.normal,
      result: null,
      before: ratings(profile),
      rounds: [],
      levelChanges: [],
    })
  }

  const endTest = () => {
    setUrlTest(null)
    setSession(null)
  }

  const onResult = (res: RoundResult) => {
    if (!session || !current) return
    if (session.kind === 'test') {
      // tests don't count: nothing goes into the profile
      setSession({ ...session, result: res, brains: [...session.brains, res.scores.brain], rounds: [...session.rounds, sessionRound(res)] })
      return
    }
    const p = recordRound(profile, current.id, res.scores)
    setProfile({ ...p, stats: addRound(p.stats, roundTags(res)) }) // the Statistics screen's counts
    // the rule (profile.ts recordRound) looks at the last 3 rounds: keep that average for the summary
    const avg = Math.round(p.history.slice(-3).reduce((a, r) => a + r.brain, 0) / Math.min(3, p.history.length))
    setSession({
      ...session,
      result: res,
      brains: [...session.brains, res.scores.brain],
      rounds: [...session.rounds, sessionRound(res)],
      levelChanges: p.level !== profile.level ? [...session.levelChanges, { from: profile.level, to: p.level, avg }] : session.levelChanges,
    })
  }

  const next = () => {
    if (!session || !data) return
    if (session.kind === 'test') {
      // the same moment again (a new round: fresh scan, fresh decision)
      setSession({ ...session, queue: [...session.queue, session.queue[0]], index: session.index + 1, result: null })
      return
    }
    // the Daily Challenge ends after its 5 moments; training goes on until you end it
    if (session.kind === 'daily' && session.brains.length >= ROUNDS_PER_SESSION) return finish(true)
    const queue =
      session.kind === 'training'
        ? [...session.queue, pickTraining(profile, data.moments, session.queue.map((m) => m.id))]
        : session.queue
    setSession({
      ...session,
      queue,
      index: session.index + 1,
      result: null,
      settings: session.kind === 'daily' ? LEVEL_SETTINGS.normal : LEVEL_SETTINGS[profile.level],
    })
  }

  /** End the session: the summary (or straight home). A day counts for the streak with the whole
   *  Daily Challenge or ROUNDS_PER_SESSION training rounds. */
  const finish = (toSummary: boolean) => {
    if (!session) return
    if (!session.brains.length) return setSession(null) // nothing played yet
    const score = Math.round(session.brains.reduce((a, b) => a + b, 0) / session.brains.length)
    const counts = session.brains.length >= ROUNDS_PER_SESSION
    const { profile: p, usedFreeze } = counts ? completeDay(profile) : { profile, usedFreeze: false }
    const final = session.kind === 'daily' ? { ...p, daily: { day: dayKey(), brains: session.brains, score } } : p
    setProfile(final)
    setSession(null)
    if (!toSummary) return
    setSummary({
      kind: session.kind === 'daily' ? 'daily' : 'training',
      brains: session.brains,
      score,
      before: session.before,
      after: ratings(final),
      streak: final.streak.count,
      dayCounted: counts,
      usedFreeze,
      level: final.level,
      levelChanges: session.levelChanges,
      insight: sessionInsight(session.rounds, session.before),
    })
    sound.whistle(3, 0.28) // final whistle
  }

  /** Home from the middle of a session (big screens: the button in the right panel). */
  const goHome = () => {
    if (!session) return
    if (session.kind === 'test') return endTest()
    if (session.kind === 'daily') {
      // an unfinished Daily Challenge doesn't count as today's challenge (its rounds stay in your ratings)
      if (session.brains.length < ROUNDS_PER_SESSION && !confirm('Leave the Daily Challenge? It only counts when all 5 moments are played.')) return
      return setSession(null)
    }
    finish(false)
  }

  /** 3D replay: the pro's real play, or your pass simulated (both need plays.json first) */
  const watch3D = (mode: ReplayMode, who: PlayStory['who'] = 'pro') => {
    if (!current || !track || !session?.result) return
    const res = session.result
    setReplayLoading(true)
    void loadReplay3D()
    loadPlay(current.id)
      .catch(() => null) // no play data: the pro's replay stops at the decision, yours is still simulated
      .then((play) => {
        const pm = who === 'pro' ? play && proStory(withPlay(current, play)) : buildUserPlay(track, res, play)
        setReplay({ moment: pm ?? current, mode, bestIdx: res.bestIdx })
      })
      .finally(() => setReplayLoading(false))
  }

  const togglePro = () => setProfile({ ...profile, proMode: !profile.proMode })

  const toggleMute = () => {
    sound.unlock()
    setProfile({ ...profile, muted: !profile.muted })
  }

  if (error) return <div className="screen center">Could not load the moments – {error}</div>
  if (!data) return <div className="screen center">Loading{progress ? ` moments ${progress[0]}/${progress[1]}` : ''}…</div>

  if (showStats) return <StatsScreen profile={profile} onBack={() => setShowStats(false)} />

  if (summary)
    return <Summary s={summary} onHome={() => setSummary(null)} onTraining={() => start('training')} />

  if (session && track) {
    const n = session.index + 1
    const label =
      session.kind === 'test'
        ? `Test · try ${n}`
        : session.kind === 'daily'
          ? `Daily ${n}/${ROUNDS_PER_SESSION}`
          : `Training ${n}`
    const last = session.kind === 'daily' && session.brains.length >= ROUNDS_PER_SESSION
    return (
      <>
        <Round
          key={`${session.kind}-${session.index}`}
          track={track}
          difficulty={current!.difficulty}
          settings={session.settings}
          label={label}
          onResult={onResult}
          proMode={session.kind !== 'daily' && proMode}
          desk={desk}
          guide={{ open: guideOpen, toggle: () => setGuideOpen((o) => !o) }}
        >
          {session.result && (
            <ResultSheet
              result={session.result}
              onNext={next}
              nextLabel={session.kind === 'test' ? 'Play again' : last ? 'See summary' : 'Next moment'}
              onWatch3D={watch3D}
              exit={
                session.kind === 'test'
                  ? { label: `Moment ${current!.id} · back home`, onExit: endTest }
                  : session.kind === 'training'
                    ? { label: 'End training · see summary', onExit: () => finish(true) }
                    : undefined
              }
              desk={desk}
            />
          )}
        </Round>
        {desk && !session.result && (
          <aside className="desk-panel desk-left intro-panel" aria-label="Get ready">
            <h2>Get ready</h2>
            <Who m={current!} />
            <ol className="how">
              <li>
                <b>Scan</b>: while the ball comes, look around: hold &amp; turn the dial, drag on the pitch, or use the arrow keys
              </li>
              <li>
                <b>Remember</b>: the screen goes dark when you receive the ball
              </li>
              <li>
                <b>Pass</b>: click a teammate or into space within 2 s · double-click for a lofted pass
              </li>
            </ol>
            <p className="intro-note">Press “Start scanning” (or Enter) when you're ready. Your score, the feedback and the replays appear here after your pass.</p>
          </aside>
        )}
        {guideOpen && (
          <GuidePanel
            onHome={goHome}
            onEnd={session.kind === 'training' && session.brains.length ? () => finish(true) : undefined}
            onClose={() => setGuideOpen(false)}
            sheet={!desk}
          />
        )}
        {replayLoading && <div className="replay3d r3-loading">Loading 3D…</div>}
        {replay && (
          <Suspense fallback={<div className="replay3d r3-loading">Loading 3D…</div>}>
            <Replay3D moment={replay.moment} mode={replay.mode} bestIdx={replay.bestIdx} onClose={() => setReplay(null)} />
          </Suspense>
        )}
      </>
    )
  }

  return (
    <Home
      profile={profile}
      preview={preview}
      onDaily={() => start('daily')}
      onTraining={() => start('training')}
      moments={data.moments}
      onTest={startTest}
      onToggleMute={toggleMute}
      onTogglePro={togglePro}
      onStats={() => setShowStats(true)}
      // the hook for the tutorial round: until it exists, FEATURES.tutorial keeps the button hidden
      onHowToPlay={FEATURES.tutorial ? () => start('training') : undefined}
    />
  )
}

/** Keep ?test=<id> in the address bar while testing a moment, so a reload or a bookmark comes back to it. */
function setUrlTest(id: string | null) {
  const u = new URL(location.href)
  if (id) u.searchParams.set('test', id)
  else u.searchParams.delete('test')
  history.replaceState(null, '', u)
}
