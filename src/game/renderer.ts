import type { Team } from '../types'
import { PITCH_L, PITCH_W, type Track } from './track'
import { CONE_HALF, CONE_RANGE, coneVis, VISION_FEATHER as FEATHER, VISION_R } from './vision'

const MARGIN = 2.5 // metres of grass drawn around the pitch

const C = {
  grassA: '#1d7443',
  grassB: '#217b48',
  line: 'rgba(255,255,255,0.78)',
  fog: '6,10,22',
  att: '#2f7bff',
  def: '#ff4646',
  you: '#ffd400',
  mine: '#22e3ff',
  pro: '#ffd400',
  best: '#ffffff',
  steal: '#ff6464',
  brave: '#ff9f43',
}

export interface RevealDraw {
  progress: number // 0..1, arrows draw in
  tap: [number, number] | null
  chosenIdx: number // -1 = miss
  proEnd: [number, number]
  bestIdx: number
  /** the best pass: its end (a teammate's feet or a spot in space), his run there, and whether it gets
   *  its own arrow (alone = not the same as your pass or the pro's; otherwise only the dashed ring) */
  best: { end: [number, number]; run: [number, number][] | null; alone: boolean }
  /** who took the pro's pass over: his run from the decision frame to the ball */
  run: { pts: [number, number][]; team: Team } | null
  /** your pass into space: where the ball was won and the winner's run (null run = out of play) */
  space: { end: [number, number]; run: { pts: [number, number][]; team: Team } | null } | null
  /** a riskier pass worth more than the best: orange dashed */
  brave: { end: [number, number]; run: [number, number][] | null } | null
  /** offside line (v) to draw, when a teammate was beyond it as you passed */
  offsideV: number | null
  /** opponents who nearly cut a pass out: from where he stood to where he'd meet the ball */
  threats: { from: [number, number]; at: [number, number] }[]
}

export interface Scene {
  mode: 'intro' | 'approach' | 'decide' | 'reveal'
  pos: Float32Array
  /** players drawn on top and never nudged aside (you, the receivers, anyone the text mentions) */
  top?: number[]
  ball: Float32Array
  /** where "you" are looking (screen angle, 0 = up) */
  headDir: number
  /** 0..1 opacity of the look cone (0 = not scanning) */
  look: number
  decideLeft: number // 1 -> 0 during the decision window
  /** transition progress 0..1: decide = vision shrinking to "you", reveal = darkness lifting */
  blend: number
  reveal: RevealDraw | null
  /** reveal camera: zoom k and css-px offset, so the action stays clear of the results sheet */
  view?: View
  time: number // ms, for pulses
}

export interface View {
  k: number
  tx: number
  ty: number
}

export class PitchRenderer {
  private ctx: CanvasRenderingContext2D
  private bg = document.createElement('canvas')
  private fog = document.createElement('canvas')
  private fctx: CanvasRenderingContext2D
  s = 1 // css px per metre
  w = 0
  h = 0
  private dpr = 1

  constructor(private canvas: HTMLCanvasElement, private tr: Track) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.fctx = this.fog.getContext('2d')!
  }

  /** Fit the pitch into a css box (keeps aspect ratio). */
  resize(maxW: number, maxH: number): void {
    const aspect = (PITCH_W + 2 * MARGIN) / (PITCH_L + 2 * MARGIN)
    const w = Math.max(120, Math.min(maxW, maxH * aspect))
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.s = w / (PITCH_W + 2 * MARGIN)
    this.w = w
    this.h = (PITCH_L + 2 * MARGIN) * this.s
    for (const c of [this.canvas, this.bg, this.fog]) {
      c.width = Math.round(this.w * this.dpr)
      c.height = Math.round(this.h * this.dpr)
    }
    this.canvas.style.width = `${this.w}px`
    this.canvas.style.height = `${this.h}px`
    this.drawBackground()
  }

  X(u: number): number {
    return (u + MARGIN) * this.s
  }
  Y(v: number): number {
    return (v + MARGIN) * this.s
  }
  /** css px (relative to the canvas) -> pitch metres */
  toPitch(cx: number, cy: number): [number, number] {
    return [cx / this.s - MARGIN, cy / this.s - MARGIN]
  }

  private drawBackground(): void {
    const g = this.bg.getContext('2d')!
    const s = this.s
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = C.grassA
    g.fillRect(0, 0, this.w, this.h)
    const bands = 14
    g.fillStyle = C.grassB
    for (let i = 0; i < bands; i += 2) g.fillRect(0, this.Y((PITCH_L / bands) * i), this.w, (PITCH_L / bands) * s)
    g.strokeStyle = C.line
    g.lineWidth = Math.max(1, 0.18 * s)
    const rect = (u0: number, v0: number, u1: number, v1: number) =>
      g.strokeRect(this.X(u0), this.Y(v0), (u1 - u0) * s, (v1 - v0) * s)
    rect(0, 0, PITCH_W, PITCH_L)
    g.beginPath()
    g.moveTo(this.X(0), this.Y(PITCH_L / 2))
    g.lineTo(this.X(PITCH_W), this.Y(PITCH_L / 2))
    g.stroke()
    const cu = PITCH_W / 2
    g.beginPath()
    g.arc(this.X(cu), this.Y(PITCH_L / 2), 9.15 * s, 0, Math.PI * 2)
    g.stroke()
    g.fillStyle = C.line
    for (const [v, dir] of [
      [0, 1],
      [PITCH_L, -1],
    ] as const) {
      const box = (depth: number, half: number) =>
        rect(cu - half, dir === 1 ? v : v - depth, cu + half, dir === 1 ? v + depth : v)
      box(16.5, 20.16)
      box(5.5, 9.16)
      const spot = v + dir * 11
      g.beginPath()
      g.arc(this.X(cu), this.Y(spot), 0.3 * s, 0, Math.PI * 2)
      g.fill()
      // penalty arc: the part of the 9.15 m circle outside the box
      const a = Math.acos(5.5 / 9.15)
      g.beginPath()
      if (dir === 1) g.arc(this.X(cu), this.Y(spot), 9.15 * s, Math.PI / 2 - a, Math.PI / 2 + a)
      else g.arc(this.X(cu), this.Y(spot), 9.15 * s, -Math.PI / 2 - a, -Math.PI / 2 + a)
      g.stroke()
      // goal
      g.strokeRect(this.X(cu - 3.66), dir === 1 ? this.Y(-1.6) : this.Y(PITCH_L), 7.32 * s, 1.6 * s)
    }
    g.beginPath()
    g.arc(this.X(cu), this.Y(PITCH_L / 2), 0.3 * s, 0, Math.PI * 2)
    g.fill()
  }

  /**
   * Camera for the reveal: fit the box [u0,v0]-[u1,v1] (metres) into the visible part of
   * the canvas (css px, from the top down to `visibleH`), zooming between minK and maxK.
   */
  fitView(u0: number, v0: number, u1: number, v1: number, visibleH: number, minK = 0.6, maxK = 1.6): View {
    const bw = Math.max(1, (u1 - u0) * this.s)
    const bh = Math.max(1, (v1 - v0) * this.s)
    const k = Math.max(minK, Math.min(maxK, this.w / bw, visibleH / bh))
    const cx = (this.X(u0) + this.X(u1)) / 2
    const cy = (this.Y(v0) + this.Y(v1)) / 2
    return { k, tx: this.w / 2 - k * cx, ty: visibleH / 2 - k * cy }
  }

  draw(sc: Scene): void {
    const { ctx, tr, s, dpr } = this
    const vw = sc.mode === 'reveal' && sc.view ? sc.view : { k: 1, tx: 0, ty: 0 }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (vw.k !== 1 || vw.tx !== 0 || vw.ty !== 0) {
      ctx.fillStyle = '#0a1020' // page background around a panned/zoomed pitch
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    }
    ctx.setTransform(vw.k, 0, 0, vw.k, dpr * vw.tx, dpr * vw.ty)
    ctx.drawImage(this.bg, 0, 0)
    ctx.setTransform(dpr * vw.k, 0, 0, dpr * vw.k, dpr * vw.tx, dpr * vw.ty)

    const yu = sc.pos[tr.youIdx * 2]
    const yv = sc.pos[tr.youIdx * 2 + 1]
    const bu = sc.ball[0]
    const bv = sc.ball[1]

    if (sc.mode === 'reveal') {
      this.drawPlayers(sc.pos, () => 1, sc.top)
      if (sc.reveal) this.drawReveal(sc, yu, yv)
      this.drawBall(bu, bv)
      if (sc.blend < 1) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = `rgba(${C.fog},${0.97 * (1 - sc.blend)})`
        ctx.fillRect(0, 0, this.w, this.h)
        ctx.setTransform(dpr * vw.k, 0, 0, dpr * vw.k, dpr * vw.tx, dpr * vw.ty)
        this.drawYouRing(yu, yv, sc.time)
      }
      return
    }

    // vision radii: shrink smoothly to "you" when the screen goes dark
    const e = sc.mode === 'decide' ? 1 - Math.pow(1 - sc.blend, 3) : 0
    const youR = VISION_R + (4.5 - VISION_R) * e
    const ballR = VISION_R * (1 - e)

    // --- fog of war ------------------------------------------------------------
    const f = this.fctx
    f.setTransform(1, 0, 0, 1, 0, 0)
    f.globalCompositeOperation = 'source-over'
    f.clearRect(0, 0, this.fog.width, this.fog.height)
    f.fillStyle = `rgba(${C.fog},${0.9 + 0.07 * e})`
    f.fillRect(0, 0, this.fog.width, this.fog.height)
    f.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    f.globalCompositeOperation = 'destination-out'
    const hole = (u: number, v: number, r: number) => {
      const g = f.createRadialGradient(this.X(u), this.Y(v), Math.max(0, r - FEATHER) * s, this.X(u), this.Y(v), r * s)
      g.addColorStop(0, 'rgba(0,0,0,1)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      f.fillStyle = g
      f.beginPath()
      f.arc(this.X(u), this.Y(v), r * s, 0, Math.PI * 2)
      f.fill()
    }
    hole(yu, yv, youR)
    if (ballR > FEATHER) hole(bu, bv, ballR)
    const look = sc.look * (1 - e)
    if (look > 0.01) {
      // look cone: stacked wedges give a soft angular edge, the gradient a soft range edge
      const g = f.createRadialGradient(this.X(yu), this.Y(yv), 0, this.X(yu), this.Y(yv), (CONE_RANGE + 4) * s)
      g.addColorStop(0, 'rgba(0,0,0,1)')
      g.addColorStop((CONE_RANGE - 4) / (CONE_RANGE + 4), 'rgba(0,0,0,1)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      f.fillStyle = g
      const steps: [number, number][] = [
        [CONE_HALF + 0.09, 0.35],
        [CONE_HALF, 0.55],
        [CONE_HALF - 0.09, 1],
      ]
      for (const [half, a] of steps) {
        f.globalAlpha = a * look
        this.wedge(f, yu, yv, sc.headDir, half, CONE_RANGE + 4)
        f.fill()
      }
      f.globalAlpha = 1
    }

    // --- players: only what you can see is drawn (bubbles + look cone), live ------
    const vis = (u: number, v: number, cu: number, cv: number, r: number) => {
      const d = Math.hypot(u - cu, v - cv)
      return Math.max(0, Math.min(1, (r - d) / FEATHER))
    }
    this.drawPlayers(sc.pos, (i) => {
      if (i === tr.youIdx) return 1
      const u = sc.pos[i * 2]
      const v = sc.pos[i * 2 + 1]
      const bubble = Math.max(vis(u, v, yu, yv, youR), vis(u, v, bu, bv, ballR)) * (1 - e)
      return look > 0.01 ? Math.max(bubble, coneVis(u, v, yu, yv, sc.headDir) * look) : bubble
    })
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(this.fog, 0, 0)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)

    // --- head direction: a small wedge in front of "you"; brighter while scanning --
    if (e < 1) {
      ctx.globalAlpha = (0.35 + 0.5 * look) * (1 - e)
      ctx.fillStyle = 'rgba(34,227,255,0.55)'
      this.wedge(ctx, yu, yv, sc.headDir, CONE_HALF, 5.5)
      ctx.fill()
      if (look > 0.01) {
        ctx.strokeStyle = 'rgba(34,227,255,0.8)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 4])
        this.wedge(ctx, yu, yv, sc.headDir, CONE_HALF, CONE_RANGE)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.globalAlpha = 1
    }

    if (sc.mode === 'decide') {
      if (e < 1) {
        ctx.globalAlpha = 1 - e
        this.drawBall(bu, bv)
        ctx.globalAlpha = 1
      }
      // countdown ring around "you"
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 0.6 * s
      ctx.beginPath()
      ctx.arc(this.X(yu), this.Y(yv), 4 * s, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = sc.decideLeft > 0.35 ? C.you : '#ff6b3d'
      ctx.beginPath()
      ctx.arc(this.X(yu), this.Y(yv), 4 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sc.decideLeft)
      ctx.stroke()
    } else {
      this.drawBall(bu, bv)
    }
    this.drawYouRing(yu, yv, sc.time)
  }

  /** Path of a cone from (u, v) facing `dir` (0 = up) with half-angle `half`, radius r metres. */
  private wedge(c: CanvasRenderingContext2D, u: number, v: number, dir: number, half: number, r: number): void {
    const a = dir - Math.PI / 2 // canvas angles: 0 = +x
    c.beginPath()
    c.moveTo(this.X(u), this.Y(v))
    c.arc(this.X(u), this.Y(v), r * this.s, a - half, a + half)
    c.closePath()
  }

  /**
   * Where to draw each circle: players closer than a circle's width are nudged apart a little
   * (a few relaxation passes), so numbers stay readable. `top` players never move; the others
   * make room for them.
   */
  private nudged(pos: Float32Array, top: number[]): Float32Array {
    const n = this.tr.n
    const out = Float32Array.from(pos)
    const D = 3.3 // m: circles are 2.9 m wide plus their outline: leave a visible gap
    const pinned = (i: number) => top.includes(i)
    for (let it = 0; it < 6; it++)
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          let dx = out[j * 2] - out[i * 2]
          let dy = out[j * 2 + 1] - out[i * 2 + 1]
          let d = Math.hypot(dx, dy)
          if (d >= D) continue
          if (d < 1e-3) {
            dx = Math.cos(i + j)
            dy = Math.sin(i + j)
            d = 1
          }
          const push = D - Math.hypot(out[j * 2] - out[i * 2], out[j * 2 + 1] - out[i * 2 + 1])
          const [wi, wj] = pinned(i) && !pinned(j) ? [0, 1] : pinned(j) && !pinned(i) ? [1, 0] : [0.5, 0.5]
          out[i * 2] -= (dx / d) * push * wi
          out[i * 2 + 1] -= (dy / d) * push * wi
          out[j * 2] += (dx / d) * push * wj
          out[j * 2 + 1] += (dy / d) * push * wj
        }
    return out
  }

  private drawPlayers(pos: Float32Array, alphaOf: (i: number) => number, top: number[] = [this.tr.youIdx]): void {
    const { ctx, tr, s } = this
    const r = 1.45 * s
    const at = this.nudged(pos, top)
    // the players that matter last, so they are drawn on top
    const order = [...Array(tr.n).keys()].sort((a, b) => Number(top.includes(a)) - Number(top.includes(b)))
    ctx.font = `700 ${Math.max(8, 1.55 * s)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = Math.max(1, 0.25 * s)
    for (const i of order) {
      const a = alphaOf(i)
      if (a <= 0.01) continue
      const x = this.X(at[i * 2])
      const y = this.Y(at[i * 2 + 1])
      ctx.globalAlpha = a
      ctx.fillStyle = tr.att[i] ? C.att : C.def
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.fillText(String(tr.nums[i]), x, y + 0.5)
    }
    ctx.globalAlpha = 1
  }

  private drawBall(u: number, v: number): void {
    const { ctx, s } = this
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.beginPath()
    ctx.arc(this.X(u) + 0.25 * s, this.Y(v) + 0.3 * s, 0.75 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(this.X(u), this.Y(v), 0.75 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  private drawYouRing(u: number, v: number, time: number): void {
    const { ctx, s } = this
    const pulse = 0.5 + 0.5 * Math.sin(time / 260)
    ctx.strokeStyle = C.you
    ctx.lineWidth = 0.45 * s
    ctx.beginPath()
    ctx.arc(this.X(u), this.Y(v), (2.4 + 0.35 * pulse) * s, 0, Math.PI * 2)
    ctx.stroke()
  }

  private drawReveal(sc: Scene, yu: number, yv: number): void {
    const { ctx, s } = this
    const R = sc.reveal!
    const p = R.progress
    const at = (i: number): [number, number] => [sc.pos[i * 2], sc.pos[i * 2 + 1]]
    // offside line across the pitch
    if (R.offsideV !== null) {
      ctx.globalAlpha = Math.min(1, p * 2)
      ctx.strokeStyle = 'rgba(255,212,0,0.7)'
      ctx.lineWidth = 0.2 * s
      ctx.setLineDash([0.9 * s, 0.6 * s])
      ctx.beginPath()
      ctx.moveTo(this.X(0), this.Y(R.offsideV))
      ctx.lineTo(this.X(PITCH_W), this.Y(R.offsideV))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.font = `700 ${Math.max(9, 1.3 * s)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const lx = this.X(yu + 2) // next to you: always in view
      const ly = this.Y(R.offsideV)
      const tw = ctx.measureText('offside line').width
      ctx.fillStyle = 'rgba(10,16,32,0.8)'
      ctx.fillRect(lx - 0.4 * s, ly - 0.9 * s, tw + 0.8 * s, 1.8 * s)
      ctx.fillStyle = 'rgba(255,212,0,0.95)'
      ctx.fillText('offside line', lx, ly)
      ctx.globalAlpha = 1
    }
    // best option (dashed white ring; its own dashed arrow only when nobody played it)
    const [be, bf] = R.best.end
    this.ring(be, bf, C.best, true)
    if (R.best.alone) {
      this.arrow(yu, yv, be, bf, C.best, p, true)
      if (R.best.run) this.run(R.best.run, C.best, Math.max(0, Math.min(1, (p - 0.45) / 0.55)))
    }
    // the brave option (orange dashed): worth more than the best, but below 60 % to arrive
    if (R.brave) {
      const [ru, rv] = R.brave.end
      this.ring(ru, rv, C.brave, true)
      this.arrow(yu, yv, ru, rv, C.brave, Math.max(0, Math.min(1, p * 1.2 - 0.1)), true)
      if (R.brave.run) this.run(R.brave.run, C.brave, Math.max(0, Math.min(1, (p - 0.45) / 0.55)))
    }
    // the pro's actual pass (yellow)
    this.arrow(yu, yv, R.proEnd[0], R.proEnd[1], C.pro, Math.max(0, Math.min(1, p * 1.4 - 0.2)), false)
    // ...and who took it over: his run to the ball (yellow = teammate, red = interception)
    if (R.run) this.takeover(R.run.pts, R.run.team === 'att' ? C.pro : C.steal, p)
    this.ghostBall(R.proEnd, p)
    // your pass into space (cyan): who won the race to the ball (cyan = teammate, red = interception)
    if (R.space) {
      const [eu, ev] = R.space.end
      this.arrow(yu, yv, eu, ev, C.mine, Math.max(0, Math.min(1, p * 1.4 - 0.4)), false)
      const cutOff = !R.space.run || R.space.run.team === 'def' // (aim assist can also move the end a little)
      if (cutOff && R.tap && Math.hypot(R.tap[0] - eu, R.tap[1] - ev) > 2 && p > 0.6) {
        // the rest of the path it never travelled
        ctx.strokeStyle = 'rgba(34,227,255,0.45)'
        ctx.lineWidth = 0.25 * s
        ctx.setLineDash([0.6 * s, 0.6 * s])
        ctx.beginPath()
        ctx.moveTo(this.X(eu), this.Y(ev))
        ctx.lineTo(this.X(R.tap[0]), this.Y(R.tap[1]))
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (R.space.run) this.takeover(R.space.run.pts, R.space.run.team === 'att' ? C.mine : C.steal, p)
      this.ghostBall(R.space.end, p)
    }
    // your pass (cyan) + memory error (tap -> true position)
    if (R.chosenIdx >= 0) {
      const c = at(R.chosenIdx)
      this.ring(c[0], c[1], C.mine, false)
      this.arrow(yu, yv, c[0], c[1], C.mine, Math.max(0, Math.min(1, p * 1.4 - 0.4)), false)
      if (R.tap) {
        ctx.strokeStyle = 'rgba(34,227,255,0.7)'
        ctx.setLineDash([0.6 * s, 0.6 * s])
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(this.X(R.tap[0]), this.Y(R.tap[1]))
        ctx.lineTo(this.X(c[0]), this.Y(c[1]))
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
    // near misses: red dashes from the opponent to where he could have met the ball
    if (p > 0.6) {
      ctx.globalAlpha = Math.min(1, (p - 0.6) / 0.3)
      for (const t of R.threats) {
        ctx.strokeStyle = C.steal
        ctx.lineWidth = 0.22 * s
        ctx.setLineDash([0.5 * s, 0.45 * s])
        ctx.beginPath()
        const d = Math.hypot(t.at[0] - t.from[0], t.at[1] - t.from[1])
        const k = Math.min(1, 1.6 / Math.max(d, 1e-3)) // start at the edge of his dot
        ctx.moveTo(this.X(t.from[0] + (t.at[0] - t.from[0]) * k), this.Y(t.from[1] + (t.at[1] - t.from[1]) * k))
        ctx.lineTo(this.X(t.at[0]), this.Y(t.at[1]))
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(this.X(t.at[0]), this.Y(t.at[1]), 0.6 * s, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    if (R.tap) this.cross(R.tap[0], R.tap[1], R.chosenIdx >= 0 || R.space ? C.mine : '#ff6b3d')
  }

  /** The player who won the ball: a ring where he stood, then his run to the ball. */
  private takeover(pts: [number, number][], col: string, p: number): void {
    const { ctx, s } = this
    const [su, sv] = pts[0]
    ctx.globalAlpha = Math.min(1, p * 2)
    ctx.strokeStyle = col
    ctx.lineWidth = 0.3 * s
    ctx.beginPath()
    ctx.arc(this.X(su), this.Y(sv), 2.1 * s, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
    this.run(pts, col, Math.max(0, Math.min(1, (p - 0.45) / 0.55)))
  }

  /** Where the ball was won (or went out). */
  private ghostBall([u, v]: [number, number], p: number): void {
    if (p <= 0.85) return
    const { ctx, s } = this
    ctx.globalAlpha = (p - 0.85) / 0.15
    ctx.strokeStyle = '#fff'
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 0.25 * s
    ctx.beginPath()
    ctx.arc(this.X(u), this.Y(v), 0.7 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  private ring(u: number, v: number, color: string, dashed: boolean): void {
    const { ctx, s } = this
    ctx.strokeStyle = color
    ctx.lineWidth = 0.35 * s
    if (dashed) ctx.setLineDash([0.8 * s, 0.6 * s])
    ctx.beginPath()
    ctx.arc(this.X(u), this.Y(v), 2.5 * s, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  private cross(u: number, v: number, color: string): void {
    const { ctx, s } = this
    const x = this.X(u)
    const y = this.Y(v)
    const r = 1 * s
    ctx.strokeStyle = color
    ctx.lineWidth = 0.4 * s
    ctx.beginPath()
    ctx.moveTo(x - r, y - r)
    ctx.lineTo(x + r, y + r)
    ctx.moveTo(x + r, y - r)
    ctx.lineTo(x - r, y + r)
    ctx.stroke()
  }

  private arrow(u0: number, v0: number, u1: number, v1: number, color: string, p: number, dashed: boolean): void {
    if (p <= 0) return
    const { ctx, s } = this
    const x0 = this.X(u0)
    const y0 = this.Y(v0)
    const len = Math.hypot(this.X(u1) - x0, this.Y(v1) - y0)
    if (len < 1) return
    const ang = Math.atan2(this.Y(v1) - y0, this.X(u1) - x0)
    const start = 2.4 * s // leave the "you" ring clear
    const end = Math.max(start, (len - 1.6 * s) * p)
    const xe = x0 + Math.cos(ang) * end
    const ye = y0 + Math.sin(ang) * end
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 0.5 * s
    ctx.lineCap = 'round'
    if (dashed) ctx.setLineDash([1.1 * s, 0.8 * s])
    ctx.beginPath()
    ctx.moveTo(x0 + Math.cos(ang) * start, y0 + Math.sin(ang) * start)
    ctx.lineTo(xe, ye)
    ctx.stroke()
    ctx.setLineDash([])
    this.head(xe, ye, ang, 1.5 * s)
  }

  /** A player's run (pitch-metre polyline, smoothed and dotted), drawn in up to p. */
  private run(pts: [number, number][], color: string, p: number): void {
    if (p <= 0 || pts.length < 2) return
    const { ctx, s } = this
    const xy = pts.map(([u, v]): [number, number] => [this.X(u), this.Y(v)])
    const cum = [0]
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]))
    const total = cum[cum.length - 1]
    const d0 = 1.9 * s // leave his dot clear
    if (total < d0 + 1.5 * s) return // barely moved: the ring around him says enough
    const d1 = d0 + (total - d0) * p
    const at = (d: number): [number, number] => {
      let i = 1
      while (i < cum.length - 1 && cum[i] < d) i++
      const w = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])
      return [xy[i - 1][0] + (xy[i][0] - xy[i - 1][0]) * w, xy[i - 1][1] + (xy[i][1] - xy[i - 1][1]) * w]
    }
    const line: [number, number][] = [at(d0)]
    for (let i = 1; i < xy.length; i++) if (cum[i] > d0 && cum[i] < d1) line.push(xy[i])
    line.push(at(d1))
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 0.5 * s
    ctx.lineCap = 'round'
    ctx.setLineDash([0.01 * s, 0.95 * s])
    ctx.beginPath()
    ctx.moveTo(line[0][0], line[0][1])
    // quadratic curves through the midpoints: a smooth run instead of 5 fps corners
    for (let i = 1; i < line.length - 1; i++) {
      const mx = (line[i][0] + line[i + 1][0]) / 2
      const my = (line[i][1] + line[i + 1][1]) / 2
      ctx.quadraticCurveTo(line[i][0], line[i][1], mx, my)
    }
    const [xe, ye] = line[line.length - 1]
    ctx.lineTo(xe, ye)
    ctx.stroke()
    ctx.setLineDash([])
    const [xb, yb] = at(Math.max(d0, d1 - 1.2 * s))
    this.head(xe, ye, Math.atan2(ye - yb, xe - xb), 1.2 * s)
  }

  private head(xe: number, ye: number, ang: number, hs: number): void {
    const { ctx } = this
    ctx.beginPath()
    ctx.moveTo(xe + Math.cos(ang) * hs * 0.6, ye + Math.sin(ang) * hs * 0.6)
    ctx.lineTo(xe + Math.cos(ang + 2.5) * hs, ye + Math.sin(ang + 2.5) * hs)
    ctx.lineTo(xe + Math.cos(ang - 2.5) * hs, ye + Math.sin(ang - 2.5) * hs)
    ctx.closePath()
    ctx.fill()
  }
}
