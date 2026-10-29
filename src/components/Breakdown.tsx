import type { Breakdown, ScanInfo, WhyInfo, MatchInfo } from '../game/explain'
import { Rich, tidy } from './Rich'
import { RECENT_SCAN_S } from '../game/vision'
import type { PassOption } from '../types'

export type Tab = 'why' | 'scan' | 'match'

export function BreakdownPanel({ tab, b }: { tab: Tab; b: Breakdown }) {
  return (
    <div className="sheet-panel" role="tabpanel">
      {tab === 'why' && <Why w={b.why} />}
      {tab === 'scan' && <Scan s={b.scan} />}
      {tab === 'match' && <Match m={b.match} />}
    </div>
  )
}

const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x))} m`

/** Table rows: label, cell text, number used to mark the best cell (higher = better), or null = no marking. */
const ROWS: [string, (o: PassOption) => string, ((o: PassOption) => number) | null][] = [
  ['Pass value', (o) => String(Math.round(o.value)), (o) => o.value],
  ['Chance to arrive', (o) => `${Math.round((o.p ?? 1) * 100)}%`, (o) => o.p ?? 1],
  ['Goal chance there', (o) => `${((o.epv ?? 0) * 100).toFixed(1)}%`, (o) => o.epv ?? 0],
  ['Forward', (o) => signed(o.progress), (o) => o.progress],
  ['Distance', (o) => `${Math.round(o.dist)} m`, null],
]

function Why({ w }: { w: WhyInfo }) {
  const opts = w.cols.map((c) => c.o).filter((o): o is PassOption => o !== null)
  return (
    <>
      <div className="panel-title">
        <Rich text={w.title} />
      </div>
      <ul className="points">
        {w.points.map((p) => (
          <li key={p}>
            <Rich text={p.replace(/\.$/, '').replace(/^./, (c) => c.toUpperCase())} />
          </li>
        ))}
      </ul>
      <table className="compare">
        <thead>
          <tr>
            <th />
            {w.cols.map((c) => (
              <th key={c.label} className={c.tone}>
                <Rich text={c.label} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([label, text, score]) => {
            const top = score && opts.length > 1 ? Math.max(...opts.map(score)) : null
            return (
              <tr key={label}>
                <th>{label}</th>
                {w.cols.map((c) => (
                  <td key={c.label} className={c.o && top !== null && score!(c.o) === top ? 'top' : ''}>
                    {c.o ? text(c.o) : '–'}
                  </td>
                ))}
              </tr>
            )
          })}
          <tr>
            <th>Risk</th>
            {w.cols.map((c) => (
              <td key={c.label} className={c.risk ? `risk-${c.risk.level}` : ''}>
                <Rich text={c.risk?.text.replace(/\(#/, '(red #') ?? '–'} />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {w.note && (
        <details className="how-scoring">
          <summary>ⓘ How scoring works</summary>
          <div className="fine">
            <Rich text={w.note} />
          </div>
        </details>
      )}
    </>
  )
}

function Scan({ s }: { s: ScanInfo }) {
  const pct = (before: number) => `${Math.max(0, Math.min(100, (1 - before / s.span) * 100))}%`
  return (
    <>
      <div className="tl" aria-label="Your looks before the ball arrived">
        <div className="tl-track">
          <div className="tl-fresh" style={{ left: pct(RECENT_SCAN_S) }} />
          <div className="tl-kick" style={{ left: pct(s.kickBefore) }} />
          {s.looks.map((l, i) => (
            <div
              key={i}
              className="tl-look"
              style={{ left: pct(l.from), width: `max(3px, ${((l.from - l.to) / s.span) * 100}%)` }}
            />
          ))}
          {s.looks.map((l, i) => l.saw !== null && <div key={`s${i}`} className="tl-saw" style={{ left: pct(l.saw) }} />)}
        </div>
        <div className="tl-labels">
          <span style={{ left: pct(s.kickBefore) }}>pass to you</span>
          <span className="end">ball arrives</span>
        </div>
      </div>
      <div className="tl-key">
        <span className="k look">your looks</span>
        <span className="k saw">best option in view</span>
        <span className="k fresh">last {RECENT_SCAN_S} s</span>
      </div>
      <ul className="points">
        {s.lines.map((l) => (
          <li key={l}>
            <Rich text={l} />
          </li>
        ))}
      </ul>
      <div className="fine">
        Scan {s.timing + s.target} = timing {s.timing}/60 (looking in the last {RECENT_SCAN_S} s) + best option seen{' '}
        {s.target}/40.
      </div>
    </>
  )
}

function Match({ m }: { m: MatchInfo }) {
  return (
    <>
      <div className="scoreline">
        <span className={m.attacking === 'home' ? 'us' : ''}>{m.home}</span>
        <b>{m.score}</b>
        <span className={m.attacking === 'away' ? 'us' : ''}>{m.away}</span>
      </div>
      <div className="fine center">
        {m.minute} · score at the time · final {m.result}
      </div>
      <div className="fine center">{tidy(m.sub)}</div>
      <ul className="people">
        {m.people.map((p) => (
          <li key={p.role}>
            <span className="role">{p.role}</span>
            <span className={`pnum ${p.team}`}>{p.num}</span>
            <span className="pname">
              {tidy(p.name)}
              {p.pos && <small> {p.pos}</small>}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
