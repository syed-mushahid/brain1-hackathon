import { useMemo } from 'react'
import * as THREE from 'three'
import { PITCH_L, PITCH_W } from './world'

const MARGIN = 5 // grass beyond the lines (m)
const PX_PER_M = 10

/** Pitch texture: mowing stripes + white lines, drawn once on a 2D canvas. */
function pitchTexture(): THREE.CanvasTexture {
  const W = (PITCH_L + 2 * MARGIN) * PX_PER_M
  const H = (PITCH_W + 2 * MARGIN) * PX_PER_M
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const X = (x: number) => (x + MARGIN) * PX_PER_M
  const Y = (y: number) => (y + MARGIN) * PX_PER_M
  g.fillStyle = '#2f8a4c'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#358f52'
  for (let i = 0; i < 14; i += 2) g.fillRect(X((PITCH_L / 14) * i), 0, (PITCH_L / 14) * PX_PER_M, H)
  g.strokeStyle = '#f4f7f2'
  g.lineWidth = 0.14 * PX_PER_M
  g.strokeRect(X(0), Y(0), PITCH_L * PX_PER_M, PITCH_W * PX_PER_M)
  g.beginPath()
  g.moveTo(X(PITCH_L / 2), Y(0))
  g.lineTo(X(PITCH_L / 2), Y(PITCH_W))
  g.stroke()
  g.beginPath()
  g.arc(X(PITCH_L / 2), Y(PITCH_W / 2), 9.15 * PX_PER_M, 0, Math.PI * 2)
  g.stroke()
  const cy = PITCH_W / 2
  for (const [x0, dir] of [
    [0, 1],
    [PITCH_L, -1],
  ] as const) {
    const box = (depth: number, half: number) =>
      g.strokeRect(X(dir === 1 ? x0 : x0 - depth), Y(cy - half), depth * PX_PER_M, 2 * half * PX_PER_M)
    box(16.5, 20.16)
    box(5.5, 9.16)
    const spot = x0 + dir * 11
    g.fillStyle = '#f4f7f2'
    g.beginPath()
    g.arc(X(spot), Y(cy), 0.25 * PX_PER_M, 0, Math.PI * 2)
    g.fill()
    const a = Math.acos(5.5 / 9.15)
    g.beginPath()
    if (dir === 1) g.arc(X(spot), Y(cy), 9.15 * PX_PER_M, -a, a)
    else g.arc(X(spot), Y(cy), 9.15 * PX_PER_M, Math.PI - a, Math.PI + a)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** Random coloured dots = a crowd, on a small repeating texture. */
function crowdTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#1b2333'
  g.fillRect(0, 0, 256, 64)
  const cols = ['#e8e8e8', '#c8323a', '#2c5bd1', '#f2c230', '#3a3f4d', '#8a93a6']
  for (let i = 0; i < 900; i++) {
    g.fillStyle = cols[(i * 7) % cols.length]
    g.fillRect(Math.random() * 256, Math.random() * 64, 2, 3)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

function Goal({ x }: { x: number }) {
  const dir = x > 0 ? 1 : -1
  const post = 0.06
  const white = useMemo(() => new THREE.MeshLambertMaterial({ color: '#ffffff' }), [])
  const net = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, transparent: true, opacity: 0.35 }),
    [],
  )
  return (
    <group position={[x, 0, 0]}>
      {[-3.66, 3.66].map((z) => (
        <mesh key={z} position={[0, 1.22, z]} material={white}>
          <cylinderGeometry args={[post, post, 2.44, 8]} />
        </mesh>
      ))}
      <mesh position={[0, 2.44, 0]} rotation={[Math.PI / 2, 0, 0]} material={white}>
        <cylinderGeometry args={[post, post, 7.32, 8]} />
      </mesh>
      {/* net: back, roof and sides as wireframe planes */}
      <mesh position={[dir * 2, 1.22, 0]} rotation={[0, Math.PI / 2, 0]} material={net}>
        <planeGeometry args={[7.32, 2.44, 14, 5]} />
      </mesh>
      <mesh position={[dir * 1, 2.44, 0]} rotation={[-Math.PI / 2, 0, 0]} material={net}>
        <planeGeometry args={[2, 7.32, 4, 14]} />
      </mesh>
      {[-3.66, 3.66].map((z) => (
        <mesh key={z} position={[dir * 1, 1.22, z]} material={net}>
          <planeGeometry args={[2, 2.44, 4, 5]} />
        </mesh>
      ))}
    </group>
  )
}

/** Low-poly stadium: four sloped stands with a crowd texture and a roof ring. */
function Stands() {
  const { crowd, roof, wall } = useMemo(() => {
    const t = crowdTexture()
    return {
      crowd: (repeat: number) => {
        const tt = t.clone()
        tt.repeat.set(repeat, 3)
        tt.needsUpdate = true
        return new THREE.MeshLambertMaterial({ map: tt })
      },
      roof: new THREE.MeshLambertMaterial({ color: '#c9ced8' }),
      wall: new THREE.MeshLambertMaterial({ color: '#1f2a40' }),
    }
  }, [])
  const gap = 8 // distance from the lines to the first row
  const depth = 26
  const rise = 16
  const slope = Math.atan2(rise, depth)
  const slant = Math.hypot(depth, rise)
  const sides = [
    { len: PITCH_L + 2 * gap + 2 * depth, off: PITCH_W / 2 + gap, rot: 0 },
    { len: PITCH_L + 2 * gap + 2 * depth, off: PITCH_W / 2 + gap, rot: Math.PI },
    { len: PITCH_W + 2 * gap, off: PITCH_L / 2 + gap, rot: Math.PI / 2 },
    { len: PITCH_W + 2 * gap, off: PITCH_L / 2 + gap, rot: -Math.PI / 2 },
  ]
  return (
    <>
      {sides.map((s, i) => (
        <group key={i} rotation={[0, s.rot, 0]}>
          {/* front wall / advertising board */}
          <mesh position={[0, 0.6, -s.off]} material={wall}>
            <boxGeometry args={[s.len, 1.2, 0.3]} />
          </mesh>
          {/* sloped stand */}
          <mesh position={[0, 1.2 + rise / 2, -s.off - depth / 2]} rotation={[-slope, 0, 0]} material={crowd(s.len / 40)}>
            <planeGeometry args={[s.len, slant]} />
          </mesh>
          {/* roof */}
          <mesh position={[0, rise + 9, -s.off - depth * 0.75]} rotation={[0.12, 0, 0]} material={roof}>
            <boxGeometry args={[s.len, 0.6, depth * 0.7]} />
          </mesh>
        </group>
      ))}
    </>
  )
}

export function Stadium() {
  const tex = useMemo(pitchTexture, [])
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[PITCH_L + 2 * MARGIN, PITCH_W + 2 * MARGIN]} />
        <meshLambertMaterial map={tex} />
      </mesh>
      {/* surround grass */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[PITCH_L + 60, PITCH_W + 60]} />
        <meshLambertMaterial color="#2a7a44" />
      </mesh>
      <Goal x={-PITCH_L / 2} />
      <Goal x={PITCH_L / 2} />
      <Stands />
      <hemisphereLight args={['#dfe9ff', '#3a5a3a', 1.6]} />
      <directionalLight position={[30, 60, 20]} intensity={1.6} />
    </group>
  )
}
