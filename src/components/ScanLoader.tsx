import type { CSSProperties } from 'react'

// The loading screen: "you" in the middle of a dark pitch, a look over the shoulder sweeping round,
// and the players around you lighting up as it passes - the game's scan, as a spinner. CSS only.

const SWEEP_S = 2.4 // one full turn of the look
const CONE_DEG = 60 // the cone's width; its bright leading edge is where players light up
/** players around you: [angle clockwise from up (deg), distance (0-1 of the radius), team] */
const PLAYERS: [number, number, 'att' | 'def'][] = [
  [28, 0.66, 'att'],
  [92, 0.46, 'def'],
  [148, 0.74, 'att'],
  [212, 0.56, 'def'],
  [276, 0.7, 'att'],
  [332, 0.42, 'def'],
]

export function ScanLoader({ progress }: { progress: [number, number] | null }) {
  const share = progress && progress[1] ? progress[0] / progress[1] : 0
  return (
    <div className="screen center loader" role="status" aria-live="polite">
      <div className="scan-loader" aria-hidden style={{ '--sweep': `${SWEEP_S}s`, '--cone': `${CONE_DEG}deg` } as CSSProperties}>
        <div className="sl-pitch" />
        <div className="sl-cone" />
        {PLAYERS.map(([deg, dist, team]) => {
          const a = (deg * Math.PI) / 180
          // the bright edge reaches this angle (deg - CONE_DEG) / 360 of a turn in: blip then
          const at = (((deg - CONE_DEG) % 360) + 360) % 360
          return (
            <span
              key={deg}
              className={`sl-dot ${team}`}
              style={{
                left: `${50 + 50 * dist * Math.sin(a)}%`,
                top: `${50 - 50 * dist * Math.cos(a)}%`,
                animationDelay: `${(at / 360 - 1) * SWEEP_S}s`,
              }}
            />
          )
        })}
        <span className="sl-you" />
      </div>
      <div className="loader-text">Scanning the pitch…</div>
      <div className="loader-sub">Loading real Bundesliga moments</div>
      <div className="loader-bar" aria-label={`${Math.round(share * 100)}% loaded`}>
        <i style={{ transform: `scaleX(${share})` }} />
      </div>
    </div>
  )
}
