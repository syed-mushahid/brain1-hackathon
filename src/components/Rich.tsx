import type { ReactNode } from 'react'

// Feedback texts name players as "#25" (your teammate) and "red #24" (an opponent).
// <Rich> shows those as the same number circles as on the pitch.
const PLAYER = /(?<![A-Za-z])(?:([Rr])ed )?#(\d+)/g

export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(PLAYER)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const opp = !!m[1]
    out.push(
      <span key={at} className={`pchip ${opp ? 'def' : 'att'}`} role="img" aria-label={`${opp ? 'opponent' : 'teammate'} ${m[2]}`}>
        {m[2]}
      </span>,
    )
    last = at + m[0].length
  }
  out.push(text.slice(last))
  return <>{out}</>
}
