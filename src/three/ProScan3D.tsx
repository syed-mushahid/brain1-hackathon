import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { MomentData as Moment } from '../types'
import { buildWorld, type World } from './world'
import { Players, type Clock } from './Players'
import { Stadium } from './Stadium'
import { approachAngle, EYE_H, firstPersonFov, gazeQuat, gazeDir2D, lookAngles, MAX_TURN, type Gaze } from './camera'

const SCAN_OUT = THREE.MathUtils.degToRad(45) // looking this far away from the ball = a scan
const SCAN_BACK = THREE.MathUtils.degToRad(30) // must come back inside this before the next scan
const DRAG_RAD_PER_PX = 0.006

interface Head {
  drag: number // offset from swiping (rad)
  gyro: number // offset from the gyroscope (rad)
}

function HeadCam({
  world,
  clock,
  head,
  onScan,
  onReady,
  onYaw,
}: {
  world: World
  clock: { current: Clock }
  head: { current: Head }
  onScan: (dir: number) => void
  onReady: () => void
  onYaw: (rel: number) => void
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const gaze = useRef<Gaze>({ yaw: 0, pitch: -0.12 })
  const st = useRef({ ready: false, out: false, lastYawReport: 0 })
  const v = useMemo(() => ({ eye: new THREE.Vector3(), ball: new THREE.Vector3(), q: new THREE.Quaternion() }), [])

  useEffect(() => {
    camera.fov = firstPersonFov(size.width / size.height)
    camera.updateProjectionMatrix()
  }, [camera, size])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const f = Math.max(0, Math.min(world.nFrames - 1, clock.current.f))
    const f0 = Math.floor(f)
    const f1 = Math.min(f0 + 1, world.nFrames - 1)
    const t = f - f0
    const i0 = f0 * world.n + world.youIdx
    const i1 = f1 * world.n + world.youIdx
    v.eye.set(world.px[i0] + (world.px[i1] - world.px[i0]) * t, EYE_H, world.pz[i0] + (world.pz[i1] - world.pz[i0]) * t)
    v.ball.set(
      world.bx[f0] + (world.bx[f1] - world.bx[f0]) * t,
      world.by[f0] + (world.by[f1] - world.by[f0]) * t,
      world.bz[f0] + (world.bz[f1] - world.bz[f0]) * t,
    )
    const base = lookAngles(v.eye, v.ball)
    const g = gaze.current
    clock.current.hideYou = true
    if (!st.current.ready) {
      g.yaw = base.yaw // start facing the incoming ball
      st.current.ready = true
      onReady()
    }
    // head turn is rate-limited (motion sickness), whatever the input does
    const want = base.yaw + head.current.drag + head.current.gyro
    g.yaw = approachAngle(g.yaw, want, MAX_TURN * dt)
    g.pitch = approachAngle(g.pitch, THREE.MathUtils.clamp(base.pitch, -0.4, 0.2), MAX_TURN * 0.6 * dt)
    camera.position.copy(v.eye)
    camera.quaternion.copy(gazeQuat(g, v.q))

    // a look far enough away from the ball counts as a scan of that half
    const rel = Math.atan2(Math.sin(g.yaw - base.yaw), Math.cos(g.yaw - base.yaw))
    if (!st.current.out && Math.abs(rel) > SCAN_OUT) {
      st.current.out = true
      onScan(gazeDir2D(g.yaw))
    } else if (st.current.out && Math.abs(rel) < SCAN_BACK) {
      st.current.out = false
    }
    if (Math.abs(rel - st.current.lastYawReport) > 0.05) {
      st.current.lastYawReport = rel
      onYaw(rel)
    }
  })
  return null
}

type DOE = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }

export default function ProScan3D({
  moment,
  clock,
  onScan,
  onReady,
}: {
  moment: Moment
  clock: { current: Clock }
  onScan: (dir: number) => void
  onReady: () => void
}) {
  const world = useMemo(() => buildWorld(moment), [moment])
  const head = useRef<Head>({ drag: 0, gyro: 0 })
  const drag = useRef<{ x: number } | null>(null)
  const [yaw, setYaw] = useState(0)
  const [gyro, setGyro] = useState<'off' | 'on' | 'denied'>('off')
  const hasGyro = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window

  useEffect(() => {
    if (gyro !== 'on') return
    let alpha0: number | null = null
    const onOri = (e: DeviceOrientationEvent) => {
      if (e.alpha === null) return
      if (alpha0 === null) alpha0 = e.alpha
      const d = THREE.MathUtils.degToRad(e.alpha - alpha0) // turning left increases alpha = yaw left
      head.current.gyro = Math.atan2(Math.sin(d), Math.cos(d))
    }
    window.addEventListener('deviceorientation', onOri)
    return () => {
      window.removeEventListener('deviceorientation', onOri)
      head.current.gyro = 0
    }
  }, [gyro])

  const enableGyro = async (e: RPointerEvent) => {
    e.stopPropagation()
    const D = DeviceOrientationEvent as DOE
    try {
      // iOS 13+: permission must be requested from a user gesture
      const res = typeof D.requestPermission === 'function' ? await D.requestPermission() : 'granted'
      setGyro(res === 'granted' ? 'on' : 'denied')
    } catch {
      setGyro('denied')
    }
  }

  return (
    <div
      className="pro3d"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX }
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const dx = e.clientX - drag.current.x
        drag.current.x = e.clientX
        head.current.drag = THREE.MathUtils.clamp(head.current.drag + dx * DRAG_RAD_PER_PX, -2.9, 2.9)
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <Canvas dpr={[1, 1.5]} gl={{ antialias: false, powerPreference: 'high-performance' }} camera={{ fov: 90, near: 0.1, far: 800 }}>
        <color attach="background" args={['#a9cdef']} />
        <fog attach="fog" args={['#a9cdef', 160, 520]} />
        <Suspense fallback={null}>
          <Stadium />
          <Players world={world} clock={clock} />
          <HeadCam world={world} clock={clock} head={head} onScan={onScan} onReady={onReady} onYaw={setYaw} />
        </Suspense>
      </Canvas>
      <div className="pro3d-hud">
        <div className="head-meter" aria-hidden>
          <i style={{ left: `${50 - THREE.MathUtils.clamp(yaw / Math.PI, -1, 1) * 50}%` }} />
        </div>
        <div className="pro3d-hint">Swipe to look around · look away from the ball to scan</div>
        <div className="row">
          <button
            className="chip"
            onPointerDown={(e) => {
              e.stopPropagation()
              head.current.drag = 0
            }}
          >
            ⟲ Ball
          </button>
          {hasGyro && gyro !== 'on' && (
            <button className="chip" onPointerDown={enableGyro}>
              {gyro === 'denied' ? 'Gyro blocked' : '📱 Use gyroscope'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
