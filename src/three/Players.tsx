import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BALL_R, makeSample, sampleWorld, type World } from './world'

// "Man" by Quaternius, CC0 1.0 (via poly.pizza), trimmed to Idle / Walk / Run.
export const MODEL_URL = './models/player.glb'
useGLTF.preload(MODEL_URL)

export interface Clock {
  f: number // fractional frame index into the moment
  rate: number // animation speed multiplier (0 = frozen)
  highlight: boolean // show the best option beam
  hideYou?: boolean // first-person: don't render your own body around the camera
  ballScale?: number // far cameras (TV): draw the ball bigger so it stays visible
}

const HEIGHT_M = 1.8
// Natural speeds of the clips (one cycle = two steps): stride-matched playback.
const WALK_SPEED = 1.4 // m/s at timeScale 1 (Walk cycle 1.04 s)
const RUN_SPEED = 3.3 // m/s at timeScale 1 (Run cycle 0.875 s)
const TURN_RATE = 9 // rad/s max body rotation

const KITS = {
  att: { Shirt: '#2f6fe8', Pants: '#f2f4f8', Socks: '#2f6fe8' },
  def: { Shirt: '#d9302c', Pants: '#18181c', Socks: '#d9302c' },
} as const

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const SHARED_MAT = new THREE.MeshLambertMaterial({ vertexColors: true }) // Lambert = cheap lighting

/**
 * One skinned mesh per character instead of six (shirt, skin, pants, ...): the kit colours
 * are baked into vertex colours and the parts merged. 22 draw calls and 22 skeleton
 * updates per frame instead of 132 – the difference between ~16 and 30+ fps on phones.
 */
function teamModel(src: THREE.Object3D, team: 'att' | 'def'): THREE.Object3D {
  const copy = cloneSkinned(src)
  const parts: THREE.SkinnedMesh[] = []
  copy.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) parts.push(o as THREE.SkinnedMesh)
  })
  if (parts.length === 0) return copy
  const kit = KITS[team] as Record<string, string>
  const keep = ['position', 'normal', 'skinIndex', 'skinWeight']
  const geoms = parts.map((m) => {
    const g = m.geometry.clone()
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name)
    g.morphAttributes = {}
    const mat = m.material as THREE.MeshStandardMaterial
    const c = kit[mat.name] ? new THREE.Color(kit[mat.name]) : mat.color
    const n = g.attributes.position.count
    const col = new Float32Array(n * 3)
    for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3)
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g.index ? g : g.toNonIndexed()
  })
  const indexed = geoms.every((g) => g.index)
  const merged = mergeGeometries(indexed ? geoms : geoms.map((g) => (g.index ? g.toNonIndexed() : g)), false)
  if (!merged) return copy
  const first = parts[0]
  const mesh = new THREE.SkinnedMesh(merged, SHARED_MAT)
  mesh.position.copy(first.position)
  mesh.quaternion.copy(first.quaternion)
  mesh.scale.copy(first.scale)
  mesh.bind(first.skeleton, first.bindMatrix)
  mesh.frustumCulled = false // bind-pose bounds are wrong for skinned meshes
  first.parent!.add(mesh)
  for (const p of parts) p.parent?.remove(p)
  return copy
}

interface Rig {
  root: THREE.Group
  mixer: THREE.AnimationMixer
  idle: THREE.AnimationAction
  walk: THREE.AnimationAction
  run: THREE.AnimationAction
  yaw: number
  pending: number // animation time not yet applied (LOD: skipped frames)
}

export function Players({ world, clock }: { world: World; clock: { current: Clock } }) {
  const gltf = useGLTF(MODEL_URL)
  const sample = useMemo(() => makeSample(world), [world])

  const rigs = useMemo(() => {
    // measure the skinned model once and normalise it to 1.8 m, feet on the ground
    const src = gltf.scene
    src.updateMatrixWorld(true)
    src.traverse((o) => {
      const sm = o as THREE.SkinnedMesh
      if (sm.isSkinnedMesh) sm.skeleton.update()
    })
    const box = new THREE.Box3().setFromObject(src, true)
    const h = box.max.y - box.min.y
    const scale = h > 0.01 && h < 1000 ? HEIGHT_M / h : 1
    const lift = -box.min.y * scale

    const teamSrc = { att: teamModel(src, 'att'), def: teamModel(src, 'def') }
    const clip = (name: string) => gltf.animations.find((a) => a.name === name) ?? gltf.animations[0]

    const rigs: Rig[] = world.pids.map((_, i) => {
      const model = cloneSkinned(teamSrc[world.att[i] ? 'att' : 'def']) as THREE.Group
      model.scale.setScalar(scale)
      model.position.y = lift
      const root = new THREE.Group()
      root.add(model)
      const mixer = new THREE.AnimationMixer(model)
      const mk = (name: string) => {
        const a = mixer.clipAction(clip(name))
        a.play()
        a.setEffectiveWeight(0)
        a.time = Math.random() * a.getClip().duration // de-synchronise the players
        return a
      }
      return { root, mixer, idle: mk('Idle'), walk: mk('Walk'), run: mk('Run'), yaw: 0, pending: 0 }
    })
    return rigs
  }, [gltf, world])

  // initial facing: towards the ball, so nobody spins on the first frame
  useEffect(() => {
    sampleWorld(world, clock.current.f, sample)
    rigs.forEach((r, i) => {
      r.yaw = Math.atan2(sample.ball[0] - sample.x[i], sample.ball[2] - sample.z[i])
    })
  }, [rigs, world, sample, clock])

  const youRing = useRef<THREE.Mesh>(null)
  const bestRing = useRef<THREE.Mesh>(null)
  const beam = useRef<THREE.Mesh>(null)
  const ball = useRef<THREE.Mesh>(null)
  const ballShadow = useRef<THREE.Mesh>(null)
  const lod = useMemo(() => ({ frustum: new THREE.Frustum(), m: new THREE.Matrix4(), sphere: new THREE.Sphere(new THREE.Vector3(), 1.3), frame: 0 }), [])

  useFrame((state, dt) => {
    const c = clock.current
    sampleWorld(world, c.f, sample)
    const step = Math.min(dt, 0.05)
    // animation LOD: players outside the view are not animated (they still move);
    // players far from the camera animate every 3rd frame with the accumulated time
    const cam = state.camera
    lod.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    lod.frustum.setFromProjectionMatrix(lod.m)
    lod.frame++
    for (let i = 0; i < rigs.length; i++) {
      const r = rigs[i]
      const x = sample.x[i]
      const z = sample.z[i]
      r.root.position.set(x, 0, z)
      r.root.visible = !(c.hideYou && i === world.youIdx)
      const vx = sample.vx[i]
      const vz = sample.vz[i]
      const speed = Math.hypot(vx, vz)
      // face the movement direction; when (almost) standing, face the ball
      const target = speed > 0.7 ? Math.atan2(vx, vz) : Math.atan2(sample.ball[0] - x, sample.ball[2] - z)
      let d = target - r.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      r.yaw += Math.sign(d) * Math.min(Math.abs(d), TURN_RATE * step * Math.max(c.rate, 0.0001))
      r.root.rotation.y = r.yaw
      // blend idle -> walk -> run by speed; play each clip at the speed that matches the stride
      const wWalk = smooth(0.3, 1.2, speed) * (1 - smooth(1.8, 3.0, speed))
      const wRun = smooth(1.8, 3.0, speed)
      const wIdle = 1 - smooth(0.3, 1.2, speed)
      r.idle.setEffectiveWeight(wIdle)
      r.walk.setEffectiveWeight(wWalk)
      r.run.setEffectiveWeight(wRun)
      r.walk.timeScale = Math.max(0.6, Math.min(1.6, speed / WALK_SPEED))
      r.run.timeScale = Math.max(0.8, Math.min(2.2, speed / RUN_SPEED)) // > 1 = sprint
      r.pending += step * c.rate
      lod.sphere.center.set(x, 0.9, z)
      if (!lod.frustum.intersectsSphere(lod.sphere)) continue
      const far = cam.position.distanceToSquared(lod.sphere.center) > 45 * 45
      if (far && (lod.frame + i) % 3 !== 0) continue
      r.mixer.update(r.pending)
      r.pending = 0
    }
    // ball + its blob shadow (there are no real shadows)
    ball.current?.position.set(sample.ball[0], sample.ball[1], sample.ball[2])
    ball.current?.scale.setScalar(c.ballScale ?? 1)
    if (ballShadow.current) {
      ballShadow.current.position.set(sample.ball[0], 0.02, sample.ball[2])
      const k = 1 / (1 + sample.ball[1] * 0.25)
      ballShadow.current.scale.setScalar(k)
      ;(ballShadow.current.material as THREE.MeshBasicMaterial).opacity = 0.45 * k
    }
    if (youRing.current) {
      youRing.current.position.set(sample.x[world.youIdx], 0.03, sample.z[world.youIdx])
      youRing.current.visible = !c.hideYou // first person: it would sit right under the camera
    }
    const b = world.bestIdx
    const t = state.clock.elapsedTime
    if (bestRing.current && beam.current && b >= 0) {
      bestRing.current.visible = beam.current.visible = c.highlight
      bestRing.current.position.set(sample.x[b], 0.04, sample.z[b])
      beam.current.position.set(sample.x[b], 6, sample.z[b])
      const pulse = 1 + 0.12 * Math.sin(t * 6)
      bestRing.current.scale.setScalar(pulse)
    }
  })

  return (
    <group>
      {rigs.map((r, i) => (
        <primitive key={i} object={r.root} />
      ))}
      <mesh ref={ball}>
        <icosahedronGeometry args={[BALL_R * 1.4, 1]} />
        <meshLambertMaterial color="#ffffff" />
      </mesh>
      <mesh ref={ballShadow} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.28, 16]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <mesh ref={youRing} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.75, 0.95, 32]} />
        <meshBasicMaterial color="#ffd400" />
      </mesh>
      <mesh ref={bestRing} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.9, 1.2, 32]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <mesh ref={beam} visible={false}>
        <cylinderGeometry args={[0.5, 0.5, 12, 16, 1, true]} />
        <meshBasicMaterial color="#9ff4ff" transparent opacity={0.28} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}
