import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Moment } from '../types'
import { buildWorld, FPS, type World } from './world'
import { Players, type Clock } from './Players'
import { Stadium } from './Stadium'
import { EYE_H, firstPersonFov, gazeQuat, TOP_FOV, topDownPose, updateGaze, type Gaze } from './camera'

type Stage = 'loading' | 'flyIn' | 'play' | 'pause' | 'flyOut' | 'done'

const FLY_S = 1.6
const PAUSE_S = 3.5
const REPLAY_S = 3

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Drives the clock and the camera: top-down -> eyes -> replay -> pause -> top-down. */
function Director({
  world,
  clock,
  onStage,
  skip,
}: {
  world: World
  clock: { current: Clock }
  onStage: (s: Stage) => void
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
    }),
    [],
  )
  const f0 = Math.max(0, world.rec - REPLAY_S * FPS)

  const eyeAt = (f: number, out: THREE.Vector3) => {
    const i = Math.round(f) * world.n + world.youIdx
    return out.set(world.px[i], EYE_H, world.pz[i])
  }
  const ballAt = (f: number, out: THREE.Vector3) => {
    const k = Math.round(f)
    return out.set(world.bx[k], world.by[k], world.bz[k])
  }

  useEffect(() => {
    clock.current = { f: f0, rate: 0, highlight: false }
    // start the gaze already looking at the ball, so the fly-in lands smoothly
    eyeAt(f0, tmp.eye)
    ballAt(f0, tmp.target)
    const dx = tmp.target.x - tmp.eye.x
    const dz = tmp.target.z - tmp.eye.z
    gaze.current = { yaw: Math.atan2(-dx, -dz), pitch: -0.15 }
    st.current = { stage: 'flyIn', t: 0 }
    skip.current = false
    onStage('flyIn')
  }, [world])

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

    if (s.stage === 'play') {
      c.f = Math.min(world.rec, c.f + dt * FPS)
      if (c.f >= world.rec) {
        c.rate = 0
        c.highlight = true
        go('pause')
      }
    }

    // first-person pose at the current frame; gaze follows the ball, then the best option
    eyeAt(c.f, tmp.eye)
    if (s.stage === 'pause' || s.stage === 'flyOut' || s.stage === 'done') {
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
      go('flyOut')
    } else if (s.stage === 'flyOut' && s.t >= FLY_S) {
      go('done')
    }
  })
  return null
}

export default function Replay3D({ moment, onClose }: { moment: Moment; onClose: () => void }) {
  const world = useMemo(() => buildWorld(moment), [moment])
  const clock = useRef<Clock>({ f: Math.max(0, world.rec - REPLAY_S * FPS), rate: 0, highlight: false })
  const skip = useRef(false)
  const [stage, setStage] = useState<Stage>('loading')
  const [run, setRun] = useState(0)

  const best = world.bestIdx >= 0 ? world.nums[world.bestIdx] : null
  const pro = world.proIdx >= 0 ? world.nums[world.proIdx] : null
  const caption: Record<Stage, string> = {
    loading: 'Loading 3D…',
    flyIn: 'Into your eyes…',
    play: `${REPLAY_S} seconds before you receive the ball`,
    pause:
      best === null
        ? 'Decision moment'
        : `Decision moment – #${best} was the best option${pro !== null && pro !== best ? ` · the pro played #${pro}` : ''}`,
    flyOut: 'Back to the overview',
    done: 'Replay finished',
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
          <Director key={run} world={world} clock={clock} onStage={setStage} skip={skip} />
        </Suspense>
      </Canvas>
      <div className="r3-hud">
        <div className="r3-top">
          <span className="chip">3D replay · {moment.clock}′</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close 3D replay">
            ✕
          </button>
        </div>
        <div className={`r3-caption stage-${stage}`} key={stage}>
          {caption[stage]}
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
