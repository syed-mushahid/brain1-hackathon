import type { RoundResult } from '../game/evaluate'

/** What the lines on the pitch mean. With a result: only what that reveal draws (renderer.ts
 *  drawReveal: the brave option and the danger lines are always drawn). Without one (before the pass):
 *  every kind of line. */
export function LineLegend({ result: r }: { result?: RoundResult }) {
  if (!r)
    return (
      <div className="legend-list">
        <span className="lg mine">Your pass</span>
        <span className="lg pro">Pro's pass</span>
        <span className="lg best">Best option</span>
        <span className="lg run">Run to the ball</span>
        <span className="lg run def">Opponent wins it</span>
        <span className="lg loft">Lofted (curved)</span>
        <span className="lg brave">Brave option</span>
        <span className="lg danger">Danger: could cut it out</span>
        <small>The lines appear after your pass.</small>
      </div>
    )
  const brave = !!r.brave
  const danger = r.threats.length > 0
  const items: [string, string][] = [
    ...(r.tap ? ([['mine', 'Your pass']] as [string, string][]) : []),
    ['pro', "Pro's pass"],
    ['best', 'Best option'],
    ...((r.run || r.space?.team || (r.best.alone && r.best.run) || (brave && r.brave?.run) ? [['run', 'Run to the ball']] : []) as [string, string][]),
    ...((r.run?.team === 'def' || r.space?.team === 'def' ? [['run def', 'Opponent wins it']] : []) as [string, string][]),
    ...(((!!r.tap && r.lofted) || r.proLofted || (r.best.alone && r.best.lofted) || (brave && r.brave?.lofted)
      ? [['loft', 'Lofted (curved)']]
      : []) as [string, string][]),
    ...((brave ? [['brave', 'Brave option']] : []) as [string, string][]),
    ...((danger ? [['danger', 'Danger: could cut it out']] : []) as [string, string][]),
  ]
  return (
    <div className="legend-list">
      {items.map(([k, label]) => (
        <span key={k} className={`lg ${k}`}>
          {label}
        </span>
      ))}
    </div>
  )
}
