import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CoachStep, CoachTarget } from '../game/tutorial'

// One tutorial step on screen: a card with the instruction and a pulsing ring around what it points
// at. The ring follows its target (the results sheet slides in, players move), so it is re-measured
// every frame. Tapping the target itself also completes a "next" step. Portalled to <body>: a
// transformed ancestor (the big-screen round layout) would otherwise move its fixed position.

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Where each screen part is; a target can match several elements (phone sheet / big-screen panel). */
const SELECTORS: Partial<Record<CoachTarget, string[]>> = {
  pitch: ['.pitch-wrap'],
  dial: ['.dial'],
  why: ['.chips .chip-btn', '.desk-tabs .chip-btn'],
  replay: ['.chip-btn.replay', '.desk-panel .replay-picks'],
  score: ['.brain-ring'],
  next: ['.next-btn'],
}

function findEl(target: CoachTarget): HTMLElement | null {
  for (const sel of SELECTORS[target] ?? [])
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && (target !== 'why' || /why/i.test(el.textContent ?? ''))) return el
    }
  return null
}

interface Props {
  step: CoachStep
  /** e.g. "1/3" */
  progress: string
  /** a player on the pitch ('you', 'best'): his circle in client px (radius r), or null */
  pitchPoint: (target: 'you' | 'best') => { x: number; y: number; r: number } | null
  onNext: () => void
  onSkip: () => void
}

export function Coach({ step, progress, pitchPoint, onNext, onSkip }: Props) {
  const [box, setBox] = useState<Box | null>(null)
  const nextRef = useRef(onNext)
  nextRef.current = onNext

  useEffect(() => {
    const t = step.target
    if (!t) return setBox(null)
    let raf = 0
    let el: HTMLElement | null = null
    const onTap = () => step.done === 'next' && nextRef.current()
    const measure = () => {
      raf = requestAnimationFrame(measure)
      if (t === 'you' || t === 'best') {
        const p = pitchPoint(t)
        setBox(p ? { x: p.x - p.r, y: p.y - p.r, w: 2 * p.r, h: 2 * p.r } : null)
        return
      }
      const found = findEl(t)
      if (found !== el) {
        el?.removeEventListener('click', onTap)
        el = found
        el?.addEventListener('click', onTap)
      }
      const r = el?.getBoundingClientRect()
      setBox((b) =>
        !r ? null : b && b.x === r.left && b.y === r.top && b.w === r.width && b.h === r.height ? b : { x: r.left, y: r.top, w: r.width, h: r.height },
      )
    }
    measure()
    return () => {
      cancelAnimationFrame(raf)
      el?.removeEventListener('click', onTap)
    }
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  // the card goes where it doesn't cover the target: at the top unless the target is up there
  const top = !box || box.y + box.h / 2 > window.innerHeight * 0.42 || step.when === 'reveal'
  const round = step.target === 'you' || step.target === 'best'
  const pad = 6
  return createPortal(
    <div className="coach" aria-live="polite">
      {box && (
        <div
          className={`coach-ring ${round ? 'circle' : ''}`}
          style={{ left: box.x - pad, top: box.y - pad, width: box.w + 2 * pad, height: box.h + 2 * pad }}
        />
      )}
      <div className={`coach-card ${top ? 'top' : 'bottom'}`} role="dialog" aria-label="Tutorial">
        <div className="coach-head">
          <span className="coach-step">Tutorial {progress}</span>
          <button className="coach-skip" onClick={onSkip}>
            Skip tutorial
          </button>
        </div>
        {step.title && <div className="coach-title">{step.title}</div>}
        <p>{step.text}</p>
        {/* a step pointing at the round's own Next button ends with that button */}
        {step.done === 'next' && step.target !== 'next' && (
          <button className="cta coach-next" onClick={onNext}>
            Next
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
