import { useEffect, useRef } from 'react'
import type { Moment } from '../types'
import { buildTrack, PITCH_L, PITCH_W, sample } from '../game/track'
import { PitchRenderer } from '../game/renderer'
import { dirTo } from '../game/vision'

// A real moment on a loop behind the home screen: the ball coming to "you" in the fog, a look over
// the shoulder sweeping the pitch. The game's own renderer, one data frame per draw (~10 fps), filling
// the screen like a cover image (centred on "you"); paused in a hidden tab and with reduced motion
// (one still frame).

const STEP_MS = 100 // one 10 fps data frame per draw
const HOLD_FRAMES = 12 // the picture rests on the reception before the loop restarts
const SWEEP = 2.3 // rad: how far the look swings away from the ball
const MARGIN = 2.5 // the renderer's grass around the pitch (m)

/** `focusX`: where across the screen "you" should sit (0.5 = centre; desktop puts him left of the card). */
export function MomentPreview({ moment, focusX = 0.5 }: { moment: Moment; focusX?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current!
    const canvas = canvasRef.current!
    const tr = buildTrack(moment)
    const r = new PitchRenderer(canvas, tr)
    const pos = new Float32Array(tr.n * 2)
    const ball = new Float32Array(2)
    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    let f = 0
    let timer = 0

    const draw = (frame: number) => {
      const fc = Math.min(frame, tr.rec)
      sample(tr, fc, pos, ball)
      const yu = pos[tr.youIdx * 2]
      const yv = pos[tr.youIdx * 2 + 1]
      const toBall = dirTo(yu, yv, ball[0], ball[1])
      // the look: a sweep away from the ball and back, between 20 % and 75 % of the approach
      const t = (fc / tr.rec - 0.2) / 0.55
      const look = t > 0 && t < 1 ? Math.min(1, Math.sin(Math.PI * t) * 3) : 0
      r.draw({
        mode: 'approach',
        pos,
        ball,
        headDir: toBall + SWEEP * Math.sin(2 * Math.PI * Math.max(0, Math.min(1, t))),
        look,
        decideLeft: 1,
        blend: 0,
        reveal: null,
        time: performance.now(),
      })
    }
    const layout = () => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (!w || !h) return
      // cover: the pitch at least as wide and as tall as the screen (a background needs no retina pixels)
      const aspect = (PITCH_W + 2 * MARGIN) / (PITCH_L + 2 * MARGIN)
      const cw = Math.max(w, h * aspect)
      r.resize(cw, cw / aspect, 1)
      // centred on "you" (a little towards where the ball comes from), never showing past the pitch
      const youU = tr.pos[(tr.rec * tr.n + tr.youIdx) * 2]
      const youV = tr.pos[(tr.rec * tr.n + tr.youIdx) * 2 + 1]
      const ballV = tr.ball[1] // first frame
      const clamp = (x: number, lo: number) => Math.max(lo, Math.min(0, x))
      const tx = clamp(w * focusX - r.X(youU), w - r.w)
      const ty = clamp(h / 2 - r.Y(0.8 * youV + 0.2 * ballV), h - r.h)
      canvas.style.transform = `translate(${tx}px, ${ty}px)`
      draw(f)
    }
    const tick = () => {
      if (document.hidden) return
      f = f >= tr.rec + HOLD_FRAMES ? 0 : f + 1
      draw(f)
    }
    const run = () => {
      clearInterval(timer)
      if (reduce.matches) {
        f = Math.round(tr.rec * 0.45) // still frame: mid-scan, the look cone open
        draw(f)
      } else timer = window.setInterval(tick, STEP_MS)
    }
    layout()
    run()
    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    reduce.addEventListener('change', run)
    return () => {
      clearInterval(timer)
      ro.disconnect()
      reduce.removeEventListener('change', run)
    }
  }, [moment, focusX])

  return (
    <div className="home-bg" ref={wrapRef} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  )
}
