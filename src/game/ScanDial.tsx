import type { PointerEvent as RPointerEvent, RefObject } from 'react'

interface Props {
  disabled: boolean
  onStart: (dir: number | null) => void
  onMove: (dir: number) => void
  onEnd: () => void
  /** the round loop writes --head (deg) and --budget (0..1) on this element */
  rootRef: RefObject<HTMLDivElement | null>
  /** ...and the remaining scan time into this one */
  timeRef: RefObject<HTMLElement | null>
}

/**
 * 360° scan controller: press and turn. The direction of your finger from the centre is
 * where you look (0 = up the pitch). The ring is the scan time you have left.
 */
export function ScanDial({ disabled, onStart, onMove, onEnd, rootRef, timeRef }: Props) {
  const angleOf = (e: RPointerEvent): number | null => {
    const r = rootRef.current!.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    if (Math.hypot(dx, dy) < r.width * 0.12) return null // centre: keep the current direction
    return Math.atan2(dx, -dy)
  }
  const setAim = (a: number | null) => {
    if (a !== null) rootRef.current?.style.setProperty('--aim', `${(a * 180) / Math.PI}deg`)
  }
  return (
    <div
      ref={rootRef}
      className={`dial ${disabled ? 'off' : ''}`}
      role="slider"
      aria-label="Scan direction: press and turn"
      onPointerDown={(e) => {
        if (disabled) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const a = angleOf(e)
        setAim(a)
        rootRef.current?.classList.add('held')
        onStart(a)
      }}
      onPointerMove={(e) => {
        if (!rootRef.current?.classList.contains('held')) return
        const a = angleOf(e)
        setAim(a)
        if (a !== null) onMove(a)
      }}
      onPointerUp={() => {
        rootRef.current?.classList.remove('held')
        onEnd()
      }}
      onPointerCancel={() => {
        rootRef.current?.classList.remove('held')
        onEnd()
      }}
    >
      <div className="dial-ring" />
      <div className="dial-face">
        <div className="dial-cone" />
        <div className="dial-knob" />
        <div className="dial-center">
          <b ref={timeRef as RefObject<HTMLElement>}>–</b>
          <span>SCAN</span>
        </div>
      </div>
    </div>
  )
}
