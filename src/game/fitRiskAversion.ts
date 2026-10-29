// Fits the risk aversion k of value.ts on the pros' real choices. Not part of the app: run it in the
// browser console of the dev server:
//   const f = await import('/src/game/fitRiskAversion.ts')
//   console.table(await f.fitRiskAversion())
// For every k it re-derives the 0-100 scale (2nd / 98th percentile of the EV of all passes to feet and
// all searched spots), then measures how often the pro's real pass is within 5 points of the best.
// The pro's pass is valued as a decision (its expected value), whatever happened to it.
import { buildTrack, idxOf, PITCH_L, PITCH_W, posAt, toPortrait } from './track'
import { findBestPass, findBravePass, scoredOptions, SEARCH } from './best'
import { optionAt, RACE, simulateSpacePass } from './space'
import { VALUE } from './value'
import { proLofted } from './facts'
import { loadMoments } from '../data/load'

export interface KFit {
  k: number
  spaceGain: number
  runCone: string
  lo: number
  hi: number
  proWithin5: string
  spaceBest: number
  forward: number
  sideways: number
  backward: number
  brave: number
  bestPMedian: number
}

export async function fitRiskAversion(
  ks = [1, 2, 3, 4, 6],
  gains = [2, 5, 8, 12],
  /** half-angles of the run cone (degrees), null = all round */
  cones: (number | null)[] = [null, 60],
  /** value the pro's passes with their measured flight (lofted above 1.8 m), or all as ground passes */
  measuredLoft = true,
): Promise<KFit[]> {
  const data = { moments: await loadMoments() }
  const keep = { ...VALUE }
  const keepSearch = { ...SEARCH }
  const rows: KFit[] = []
  for (const k of ks)
  for (const gain of gains)
  for (const cone of cones) {
    VALUE.k = k
    SEARCH.spaceGain = gain
    SEARCH.runConeDeg = cone
    // 1. the display scale for this k
    const evs: number[] = []
    for (const m of data.moments) {
      const tr = buildTrack(m)
      for (const o of scoredOptions(tr)) if (!o.offside && o.ev !== undefined) evs.push(o.ev)
      for (let i = 0; i < tr.n; i++) {
        if (!tr.att[i] || i === tr.youIdx) continue
        const p = posAt(tr, tr.rec, i)
        for (const r of [4, 8, 12])
          for (let a = 0; a < 8; a++) {
            const q: [number, number] = [p[0] + r * Math.cos((a * Math.PI) / 4), p[1] + r * Math.sin((a * Math.PI) / 4)]
            if (q[0] < 1 || q[0] > PITCH_W - 1 || q[1] < 1 || q[1] > PITCH_L - 1) continue
            const o = simulateSpacePass(tr, q)
            if (o.option?.ev !== undefined) evs.push(o.option.ev)
          }
      }
    }
    evs.sort((a, b) => a - b)
    VALUE.lo = evs[Math.floor(0.02 * (evs.length - 1))]
    VALUE.hi = evs[Math.floor(0.98 * (evs.length - 1))]
    // 2. the stats, on fresh tracks (the caches hold values for the previous k)
    let near = 0
    let pros = 0
    let spaceBest = 0
    let brave = 0
    const dir = { forward: 0, sideways: 0, backward: 0 }
    const ps: number[] = []
    for (const m of data.moments) {
      const tr = buildTrack(m)
      const b = findBestPass(tr)
      if (b.intoSpace) spaceBest++
      if (findBravePass(tr)) brave++
      dir[b.o.direction]++
      ps.push(b.o.p ?? 1)
      // the pro's pass as a decision: where he actually played it (or to the teammate he aimed at)
      let v: number | null = null
      const tk = m.actual.taker
      if (m.actual.outcome === 'received' && tk) {
        const i = idxOf(tr, tk.pid)
        const end = toPortrait(m.actual.end.x, m.actual.end.y)
        const at = posAt(tr, tr.rec, i)
        const loft = measuredLoft ? proLofted(m) : false
        v =
          Math.hypot(end[0] - at[0], end[1] - at[1]) >= SEARCH.samePassM
            ? optionAt(tr, i, end, undefined, RACE, loft).value
            : loft
              ? optionAt(tr, i, at, undefined, RACE, true).value
              : (scoredOptions(tr).find((o) => o.pid === tk.pid)?.value ?? null)
      } else if (m.actual.intended_pid) {
        const i = idxOf(tr, m.actual.intended_pid)
        v =
          measuredLoft && proLofted(m)
            ? optionAt(tr, i, posAt(tr, tr.rec, i), undefined, RACE, true).value
            : (scoredOptions(tr).find((o) => o.pid === m.actual.intended_pid)?.value ?? null)
      }
      if (v === null) continue
      pros++
      if (v >= b.o.value - 5) near++
    }
    ps.sort((a, b) => a - b)
    rows.push({
      k,
      spaceGain: gain,
      runCone: cone === null ? 'all round' : `±${cone}°`,
      lo: +VALUE.lo.toFixed(4),
      hi: +VALUE.hi.toFixed(4),
      proWithin5: `${near}/${pros} (${Math.round((100 * near) / pros)}%)`,
      spaceBest,
      ...dir,
      brave,
      bestPMedian: +ps[Math.floor(ps.length / 2)].toFixed(2),
    })
  }
  Object.assign(VALUE, keep)
  Object.assign(SEARCH, keepSearch)
  return rows
}
