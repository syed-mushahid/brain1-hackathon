import { useEffect, useRef } from 'react'
import type { Moment } from '../types'
import { buildTrack, sample } from '../game/track'
import { PitchRenderer } from '../game/renderer'
import { dirTo } from '../game/vision'

// A real moment on a loop (home screen). The loops alternate: the whole picture (every player in
// view), then the game's view - a lighter fog, players faint until a look over the shoulder sweeps
// across and reveals them. The game's own renderer, one data frame per draw (~10 fps); paused off
// screen, in a hidden tab and with reduced motion (one still frame, mid-scan).

const STEP_MS = 100 // one 10 fps data frame per draw
const HOLD_FRAMES = 12 // the picture rests on the reception before the loop restarts
const SWEEP = 2.3 // rad: how far the look swings away from the ball
/** [fog strength, how visible the unseen players stay]: the whole picture / the game's view (lighter) */
const CLEAR = [0.15, 1]
const SCAN = [0.65, 0.18]
const EASE = 0.35 // per frame, between the two

export function MomentPreview({ moment, fit }: { moment: Moment; fit: 'band' | 'whole' }) {
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
    let loop = 0 // even: the whole picture, odd: fog + scan
    let [fog, ghost] = CLEAR
    let onScreen = true
    let timer = 0

    const draw = (frame: number) => {
      const fc = Math.min(frame, tr.rec)
      sample(tr, fc, pos, ball)
      const yu = pos[tr.youIdx * 2]
      const yv = pos[tr.youIdx * 2 + 1]
      const toBall = dirTo(yu, yv, ball[0], ball[1])
      // the look: a sweep away from the ball and back, between 20 % and 75 % of the approach
      const t = (fc / tr.rec - 0.2) / 0.55
      const look = loop % 2 && t > 0 && t < 1 ? Math.min(1, Math.sin(Math.PI * t) * 3) : 0
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
        fog,
        ghost,
      })
    }
    const layout = () => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (!w || !h) return
      if (fit === 'whole') {
        r.resize(w, h)
        canvas.style.transform = ''
      } else {
        // a band: the pitch fills the width, centred on "you" (a little towards where the ball comes from)
        r.resize(w, Infinity)
        const ballV = tr.ball[1] // first frame
        const youV = tr.pos[(tr.rec * tr.n + tr.youIdx) * 2 + 1]
        const mid = r.Y(0.8 * youV + 0.2 * ballV)
        canvas.style.transform = `translateY(${-Math.max(0, Math.min(r.h - h, mid - h / 2))}px)`
      }
      draw(f)
    }
    const tick = () => {
      if (!onScreen || document.hidden) return
      if (f >= tr.rec + HOLD_FRAMES) {
        f = 0
        loop++
      } else f++
      const [tf, tg] = loop % 2 ? SCAN : CLEAR
      fog += (tf - fog) * EASE
      ghost += (tg - ghost) * EASE
      draw(f)
    }
    const run = () => {
      clearInterval(timer)
      if (reduce.matches) {
        f = Math.round(tr.rec * 0.45) // still frame: mid-scan, the look cone open
        loop = 1
        ;[fog, ghost] = SCAN
        draw(f)
      } else timer = window.setInterval(tick, STEP_MS)
    }
    layout()
    run()
    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    const io = new IntersectionObserver(([e]) => (onScreen = e.isIntersecting))
    io.observe(wrap)
    reduce.addEventListener('change', run)
    return () => {
      clearInterval(timer)
      ro.disconnect()
      io.disconnect()
      reduce.removeEventListener('change', run)
    }
  }, [moment, fit])

  return (
    <div className={`preview preview-${fit}`} ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label="A real Bundesliga moment from above: the ball comes to you while you look around" />
    </div>
  )
}
