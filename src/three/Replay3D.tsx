import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { MomentData as Moment } from '../types'
import type { PlayedMoment } from '../lib/plays'
import { proStory, storyCaption, storyEnd, type StoryMoment } from '../game/userPlay'
import { Rich } from '../components/Rich'
import { buildWorld, FPS, PITCH_L, PITCH_W, type World } from './world'
import { Players, type Clock } from './Players'
import { Stadium } from './Stadium'
import { EYE_H, firstPersonFov, gazeQuat, TOP_FOV, topDownPose, updateGaze, type Gaze } from './camera'

/** eyes = first person from "you"; tv = broadcast camera on the gantry above the stand */
export type ReplayMode = 'eyes' | 'tv'

type Stage = 'loading' | 'flyIn' | 'play' | 'pause' | 'after' | 'flyOut' | 'done'

const FLY_S = 1.6
const PAUSE_S = 3.5
const REPLAY_S = 3 // eyes: seconds shown before the decision (when you had to pass)
const TV_LEAD_S = 1 // tv: seconds shown before the reception
// broadcast camera: on the gantry of the near stand (stands start 8 m beyond the touchline)
const TV_HEIGHT = 18
const TV_Z = PITCH_W / 2 + 12
const TV_WIDTH_M = 62 // how much of the pitch the shot shows across (landscape)
const TV_MAX_VFOV = 50 // portrait phones: a tighter shot instead of a sky full of nothing
const TV_FOLLOW_Z = 0.9 // aim (almost) at the ball across the pitch, keeping a little of the centre
const TV_BALL_SCALE = 2.2 // the ball is 40-80 m from the gantry: draw it bigger

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

const isPlayed = (m: Moment): m is PlayedMoment => 'kickFrame' in m

/** Drives the clock and the camera for both replay modes. */
function Director({
  world,
  mode,
  clock,
  onStage,
  onFrame,
  skip,
}: {
  world: World
  mode: ReplayMode
  clock: { current: Clock }
  onStage: (s: Stage) => void
  onFrame: (f: number) => void
  skip: { current: boolean }
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const st = useRef({ stage: 'flyIn' as Stage, t: 0 })
  const gaze = useRef<Gaze>({ yaw: 0, pitch: 0 })
  const tmp = useMemo(
    () => ({
      topPos: new THREE.Vector3(),
      topQ: new THREE.Quaternion(),
      eye: new THREE.Vector3(),
      fpQ: new THREE.Quaternion(),
      target: new THREE.Vector3(),
      tvLook: new THREE.Vector3(),
      tvPos: new THREE.Vector3(),
    }),
    [],
  )
  const end = world.nFrames - 1
  const hasAfter = end > world.dec
  const f0 = Math.max(0, mode === 'tv' ? world.rec - TV_LEAD_S * FPS : world.dec - REPLAY_S * FPS)

  const eyeAt = (f: number, out: THREE.Vector3) => {
    const i = Math.round(f) * world.n + world.youIdx
    return out.set(world.px[i], EYE_H, world.pz[i])
  }
  const ballAt = (f: number, out: THREE.Vector3) => {
    const k = Math.round(f)
    return out.set(world.bx[k], world.by[k], world.bz[k])
  }

  useEffect(() => {
    clock.current = { f: f0, rate: mode === 'tv' ? 1 : 0, highlight: false }
    if (mode === 'tv') {
      // start already framing the ball
      ballAt(f0, tmp.tvLook)
      tmp.tvLook.set(tmp.tvLook.x, 0, tmp.tvLook.z * TV_FOLLOW_Z)
      tmp.tvPos.set(THREE.MathUtils.clamp(tmp.tvLook.x, -PITCH_L * 0.4, PITCH_L * 0.4), TV_HEIGHT, TV_Z)
      st.current = { stage: 'play', t: 0 }
      onStage('play')
    } else {
      // start the gaze already looking at the ball, so the fly-in lands smoothly
      eyeAt(f0, tmp.eye)
      ballAt(f0, tmp.target)
      gaze.current = { yaw: Math.atan2(-(tmp.target.x - tmp.eye.x), -(tmp.target.z - tmp.eye.z)), pitch: -0.15 }
      st.current = { stage: 'flyIn', t: 0 }
      onStage('flyIn')
    }
    skip.current = false
  }, [world, mode])

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const s = st.current
    const c = clock.current
    const aspect = state.size.width / state.size.height
    s.t += dt
    const go = (next: Stage) => {
      s.stage = next
      s.t = 0
      onStage(next)
    }
    onFrame(c.f)

    // ---- TV: follow the ball from the gantry, real speed, start to end
    if (mode === 'tv') {
      if (s.stage === 'play') {
        c.f = Math.min(end, c.f + dt * FPS)
        if (c.f >= end) {
          c.rate = 0
          go('done')
        }
      }
      ballAt(c.f, tmp.target)
      const a = 1 - Math.exp(-dt * 2.2)
      tmp.tvLook.lerp(new THREE.Vector3(tmp.target.x, 0, tmp.target.z * TV_FOLLOW_Z), a)
      tmp.tvPos.x += (THREE.MathUtils.clamp(tmp.tvLook.x, -PITCH_L * 0.4, PITCH_L * 0.4) - tmp.tvPos.x) * a
      tmp.tvPos.y = TV_HEIGHT
      tmp.tvPos.z = TV_Z
      camera.position.copy(tmp.tvPos)
      camera.lookAt(tmp.tvLook)
      // keep ~TV_WIDTH_M of pitch across the screen, whatever the aspect
      const dist = tmp.tvPos.distanceTo(tmp.tvLook)
      const hfov = 2 * Math.atan(TV_WIDTH_M / 2 / dist)
      const fov = Math.min(TV_MAX_VFOV, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect)))
      if (Math.abs(camera.fov - fov) > 0.05) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }
      c.hideYou = false
      c.ballScale = TV_BALL_SCALE
      return
    }

    // ---- eyes: top-down -> your eyes -> last seconds -> decision -> what happened -> top-down
    if (s.stage === 'play') {
      c.f = Math.min(world.dec, c.f + dt * FPS)
      if (c.f >= world.dec) {
        c.rate = 0
        c.highlight = true
        go('pause')
      }
    } else if (s.stage === 'after') {
      c.f = Math.min(end, c.f + dt * FPS)
      if (c.f >= end) {
        c.rate = 0
        go('flyOut')
      }
    }

    // first-person pose at the current frame; gaze follows the ball, at the decision the best option
    eyeAt(c.f, tmp.eye)
    if (s.stage === 'pause' || ((s.stage === 'flyOut' || s.stage === 'done') && !hasAfter)) {
      const b = world.bestIdx >= 0 ? world.bestIdx : world.youIdx
      const k = Math.round(c.f) * world.n + b
      tmp.target.set(world.px[k], 1.1, world.pz[k])
    } else {
      ballAt(c.f, tmp.target)
    }
    updateGaze(gaze.current, tmp.eye, tmp.target, dt)
    gazeQuat(gaze.current, tmp.fpQ)
    topDownPose(aspect, tmp.topPos, tmp.topQ)
    const fpFov = firstPersonFov(aspect)

    let e = 1 // 0 = top-down, 1 = first person
    if (s.stage === 'flyIn') e = ease(Math.min(1, s.t / FLY_S))
    if (s.stage === 'flyOut') e = 1 - ease(Math.min(1, s.t / FLY_S))
    if (s.stage === 'done') e = 0
    c.hideYou = e > 0.6
    camera.position.lerpVectors(tmp.topPos, tmp.eye, e)
    camera.quaternion.slerpQuaternions(tmp.topQ, tmp.fpQ, e)
    const fov = TOP_FOV + (fpFov - TOP_FOV) * e
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }

    if (s.stage === 'flyIn' && s.t >= FLY_S) {
      c.rate = 1
      go('play')
    } else if (s.stage === 'pause' && (s.t >= PAUSE_S || skip.current)) {
      skip.current = false
      c.highlight = false
      if (hasAfter) {
        c.rate = 1
        go('after')
      } else go('flyOut')
    } else if (s.stage === 'flyOut' && s.t >= FLY_S) {
      go('done')
    }
  })
  return null
}

export default function Replay3D({
  moment,
  mode = 'eyes',
  bestIdx,
  onClose,
}: {
  moment: Moment | PlayedMoment
  mode?: ReplayMode
  /** the best pass's receiver (the game's best pass may be into space), else moments.json's */
  bestIdx?: number
  onClose: () => void
}) {
  const world = useMemo(() => {
    const w = buildWorld(moment)
    return bestIdx !== undefined && bestIdx >= 0 ? { ...w, bestIdx } : w
  }, [moment, bestIdx])
  const clock = useRef<Clock>({ f: Math.max(0, world.dec - REPLAY_S * FPS), rate: 0, highlight: false })
  const skip = useRef(false)
  const [stage, setStage] = useState<Stage>('loading')
  const [beat, setBeat] = useState(0) // what is happening in the real play (for the captions)
  const [run, setRun] = useState(0)

  const played = isPlayed(moment)
  const kick = played ? moment.kickFrame : Infinity
  const take = played ? moment.takeFrame : Infinity
  const onFrame = (f: number) => {
    const b = f < world.rec ? 0 : f < kick ? 1 : f < take ? 2 : 3
    if (b !== beat) setBeat(b)
  }

  // what the replay shows: the pro's real play, or your pass simulated (game/userPlay.ts)
  const story = 'story' in moment ? (moment as StoryMoment).story : played ? proStory(moment).story : null
  const beats = [0, 1, 2, 3].map((b) => (story ? storyCaption(moment, story, b) : ''))
  const best = world.bestIdx >= 0 ? world.nums[world.bestIdx] : null
  const caption: Record<Stage, string> = {
    loading: 'Loading 3D…',
    flyIn: 'Into your eyes…',
    play: mode === 'tv' ? beats[beat] || 'The ball comes to you' : `${REPLAY_S} seconds before you had to pass`,
    pause: best === null ? 'Decision moment' : `Decision moment – #${best} was the best option`,
    after: beats[beat],
    flyOut: 'Back to the overview',
    done: story ? `${story.who === 'pro' ? 'Real play' : 'Your pass'} · ${storyEnd(story)}` : 'Replay finished',
  }

  return (
    <div className="replay3d" onPointerDown={() => (skip.current = true)}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ fov: TOP_FOV, near: 0.1, far: 800, position: [0, 150, 0] }}
      >
        <color attach="background" args={['#a9cdef']} />
        <fog attach="fog" args={['#a9cdef', 160, 520]} />
        <Suspense fallback={null}>
          <Stadium />
          <Players world={world} clock={clock} />
          <Director key={run} world={world} mode={mode} clock={clock} onStage={setStage} onFrame={onFrame} skip={skip} />
        </Suspense>
      </Canvas>
      <div className="r3-hud">
        <div className="r3-top">
          <span className="chip">
            {mode === 'tv' ? 'TV camera' : 'Your eyes'} · {story?.who === 'you' ? 'your pass' : 'real play'} · {moment.clock}′
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close 3D replay">
            ✕
          </button>
        </div>
        <div className={`r3-caption stage-${stage}`} key={`${stage}-${beat}`}>
          <Rich text={caption[stage]} />
          {stage === 'pause' && <small>tap to continue</small>}
        </div>
        {stage === 'done' && (
          <div className="row r3-actions">
            <button className="cta ghost" onClick={() => setRun((r) => r + 1)}>
              Replay
            </button>
            <button className="cta" onClick={onClose}>
              Back to results
            </button>
          </div>
        )}
        <div className="r3-credit">3D players: “Man” by Quaternius (CC0)</div>
      </div>
    </div>
  )
}
