import { WEIGHTS } from '../game/scoring'
import { MODEL } from '../game/model.config'
import { ROUNDS_PER_SESSION } from '../App'

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase())

/** Big screens, right of the pitch during a round: where you are, a way home, the rules. */
export function GuidePanel({
  kind,
  round,
  level,
  onHome,
  onEnd,
}: {
  kind: 'daily' | 'training' | 'test'
  round: number
  level: string | null
  onHome: () => void
  /** training: end the session and see the summary */
  onEnd?: () => void
}) {
  const pct = (w: number) => `${Math.round(w * 100)}%`
  const { green, yellow } = MODEL.scoring.squares
  return (
    <aside className="desk-panel desk-right" aria-label="Rules and guide">
      <div className="guide-nav">
        <button className="cta ghost" onClick={onHome}>
          ← Home
        </button>
        {onEnd && (
          <button className="cta ghost" onClick={onEnd}>
            End training · summary
          </button>
        )}
      </div>
      <p className="guide-where">
        {kind === 'daily'
          ? `Daily Challenge · moment ${round} of ${ROUNDS_PER_SESSION}`
          : kind === 'training'
            ? `Free training · round ${round} · level ${cap(level ?? 'normal')} (adapts to you) · play as long as you like`
            : `Test · try ${round} · not recorded`}
      </p>

      <h3>How to play</h3>
      <ol className="how">
        <li>
          <b>Scan</b>: while the ball comes, look around: drag on the pitch, hold the dial, or use the arrow keys
        </li>
        <li>
          <b>Remember</b>: the screen goes dark when you receive the ball
        </li>
        <li>
          <b>Pass</b>: click a teammate or into space within 2 s · double-click for a lofted pass
        </li>
      </ol>

      <h3>Scoring</h3>
      <ul className="guide-list">
        <li>
          <b>Decision {pct(WEIGHTS.decision)}</b>: how good your pass was against the best option
        </li>
        <li>
          <b>Scan {pct(WEIGHTS.scan)}</b>: looking around just before the ball arrives, and spotting the best option
        </li>
        <li>
          <b>Memory {pct(WEIGHTS.memory)}</b>: how close your click was to where your teammate really stood
        </li>
        <li className="guide-bands">
          <span className="band green">{green}+</span>
          <span className="band yellow">
            {yellow}–{green - 1}
          </span>
          <span className="band red">below {yellow}</span>
        </li>
      </ul>

      <h3>After your pass</h3>
      <ul className="guide-list">
        <li>Drag the pitch to look around; double-click to recentre</li>
        <li>Why? explains the best option; tap a Brave or Danger row to see its line on the pitch</li>
        <li>Replay shows your pass (simulated) or the pro's real play, in 2D or 3D</li>
      </ul>
    </aside>
  )
}
