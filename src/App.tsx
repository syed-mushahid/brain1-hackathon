import { Suspense, useEffect, useMemo, useState } from 'react'
import type { Moment, MomentsFile } from './types'
import { buildTrack } from './game/track'
import { momentDifficulty } from './game/difficulty'
import { Round, type RoundSettings } from './game/Round'
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
import { dayKey } from './lib/util'
import { sound } from './lib/sound'
import { loadProScan3D, loadReplay3D, Replay3D } from './three/lazy'
import { loadPlays, withPlay } from './lib/plays'
import { buildUserPlay, proStory, type PlayStory } from './game/userPlay'
import type { ReplayMode } from './three/Replay3D'

export const ROUNDS_PER_SESSION = 5

interface Session {
  kind: 'daily' | 'training'
  queue: Moment[]
  index: number
  brains: number[]
  settings: RoundSettings
  result: RoundResult | null
  before: Ratings
  levelBefore: Level
}

export default function App() {
  const [data, setData] = useState<MomentsFile | null>(null)
  const [error, setError] = useState('')
  const [profile, setProfileState] = useState<Profile>(loadProfile)
  const [session, setSession] = useState<Session | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [replay, setReplay] = useState<{ moment: Moment; mode: ReplayMode; bestIdx: number } | null>(null)
  const [replayLoading, setReplayLoading] = useState(false)

  useEffect(() => {
    fetch('./moments.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      // difficulty from the game's own pass values (difficulty.ts), not the pipeline's heuristic
      .then((d: MomentsFile) => setData({ ...d, moments: d.moments.map((m) => ({ ...m, difficulty: momentDifficulty(buildTrack(m)) })) }))
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => sound.setMuted(profile.muted), [profile.muted])

  const setProfile = (p: Profile) => {
    setProfileState(p)
    saveProfile(p)
  }

  const current = session ? session.queue[session.index] : null
  const track = useMemo(() => (current ? buildTrack(current) : null), [current])

  const start = (kind: Session['kind']) => {
    if (!data) return
    sound.unlock() // user gesture: allowed to start audio now
    if (kind === 'training' && profile.proMode) void loadProScan3D() // warm up the 3D chunk
    let queue: Moment[]
    if (kind === 'daily') queue = dailyMoments(data.moments)
    else {
      // ?moment=m05 forces the first training moment (handy for testing)
      const forced = data.moments.find((m) => m.id === new URLSearchParams(location.search).get('moment'))
      queue = [forced ?? pickTraining(profile, data.moments, [])]
    }
    setSummary(null)
    setSession({
      kind,
      queue,
      index: 0,
      brains: [],
      settings: kind === 'daily' ? LEVEL_SETTINGS.normal : LEVEL_SETTINGS[profile.level],
      result: null,
      before: ratings(profile),
      levelBefore: profile.level,
    })
  }

  const onResult = (res: RoundResult) => {
    if (!session || !current) return
    setProfile(recordRound(profile, current.id, res.scores))
    setSession({ ...session, result: res, brains: [...session.brains, res.scores.brain] })
  }

  const next = () => {
    if (!session || !data) return
    if (session.brains.length >= ROUNDS_PER_SESSION) {
      const score = Math.round(session.brains.reduce((a, b) => a + b, 0) / session.brains.length)
      const { profile: p, usedFreeze } = completeDay(profile)
      const final = session.kind === 'daily' ? { ...p, daily: { day: dayKey(), brains: session.brains, score } } : p
      setProfile(final)
      setSummary({
        kind: session.kind,
        brains: session.brains,
        score,
        before: session.before,
        after: ratings(final),
        streak: final.streak.count,
        usedFreeze,
        level: final.level,
        levelBefore: session.levelBefore,
      })
      setSession(null)
      sound.crowdOff()
      sound.whistle(3, 0.28) // final whistle
      return
    }
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

  /** 3D replay: the pro's real play, or your pass simulated (both need plays.json first) */
  const watch3D = (mode: ReplayMode, who: PlayStory['who'] = 'pro') => {
    if (!current || !track || !session?.result) return
    const res = session.result
    setReplayLoading(true)
    void loadReplay3D()
    loadPlays()
      .then((plays) => plays[current.id] ?? null)
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

  if (error) return <div className="screen center">Could not load moments.json – {error}</div>
  if (!data) return <div className="screen center">Loading…</div>

  if (summary)
    return <Summary s={summary} onHome={() => setSummary(null)} onTraining={() => start('training')} />

  if (session && track) {
    const n = session.index + 1
    const label = session.kind === 'daily' ? `Daily ${n}/${ROUNDS_PER_SESSION}` : `Training ${n}/${ROUNDS_PER_SESSION}`
    const last = session.brains.length >= ROUNDS_PER_SESSION
    return (
      <>
        <Round
          key={`${session.kind}-${session.index}`}
          track={track}
          settings={session.settings}
          label={label}
          onResult={onResult}
          proMode={session.kind === 'training' && profile.proMode}
        >
          {session.result && (
            <ResultSheet
              result={session.result}
              onNext={next}
              nextLabel={last ? 'See summary' : 'Next moment'}
              onWatch3D={watch3D}
            />
          )}
        </Round>
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
      onDaily={() => start('daily')}
      onTraining={() => start('training')}
      onToggleMute={toggleMute}
      onTogglePro={togglePro}
    />
  )
}
