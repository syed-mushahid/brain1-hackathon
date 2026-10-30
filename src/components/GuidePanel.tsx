import { WEIGHTS } from '../game/scoring'
import { MODEL } from '../game/model.config'

/** The rules during a round, hidden until asked for (the "?" in the round's header): a panel right
 *  of the pitch on big screens, a full-screen sheet on phones. Also the way home. */
export function GuidePanel({
  onHome,
  onEnd,
  onClose,
  sheet = false,
}: {
  onHome: () => void
  /** training: end the session and see the summary */
  onEnd?: () => void
  onClose: () => void
  /** phones: over the whole screen */
  sheet?: boolean
}) {
  const pct = (w: number) => `${Math.round(w * 100)}%`
  const { green, yellow } = MODEL.scoring.squares
  return (
    <aside className={`desk-panel ${sheet ? 'guide-sheet' : 'desk-right'}`} aria-label="Rules and guide">
      <div className="guide-head">
        <h2>Guide</h2>
        <button className="icon-btn close" onClick={onClose} aria-label="Hide the guide">
          ×
        </button>
      </div>
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

      <h3>How to play</h3>
      <ol className="how">
        <li>
          <b>Scan</b>: while the ball comes – and while it is at your feet – look around: drag on the pitch, hold the dial, or use the arrow keys
        </li>
        <li>
          <b>Remember</b>: the screen goes dark when you have to pass – at the moment the pro passed
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
          <b>Scan {pct(WEIGHTS.scan)}</b>: looking around just before you have to pass, and spotting the best option
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
