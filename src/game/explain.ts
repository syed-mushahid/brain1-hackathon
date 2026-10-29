// Plain-language breakdown of a round for the results sheet:
//   why one pass was better than another (from the option values in moments.json),
//   what your scanning did, and which real match / players the moment comes from.
import type { Moment, PassOption, Team } from '../types'
import { FPS, idxOf, posAt, type Track } from './track'
import { scanParts } from './scoring'
import type { BestPass } from './best'
import { gap, offsideBy, offsideLineV, OFFSIDE_TOL_M, passRisk, RACE, RISK_HIGH_S, RISK_MEDIUM_S, riskLevel, type Risk, type SpaceOutcome } from './space'
import { lookWord, RECENT_SCAN_S, whereIs, type ScanRecord } from './vision'

export interface CompareCol {
  label: string
  tone: 'mine' | 'pro' | 'best'
  o: PassOption | null
  /** closest opponent to cutting the pass out: text for the table, and how worrying it is */
  risk: { text: string; level: 'low' | 'medium' | 'high' } | null
}

/** The pro's real pass (judged like yours), the best pass, the risks and which passes are the same, from evaluate(). */
export interface PassFacts {
  pro: { o: PassOption; intoSpace: boolean; risk: Risk | null } | null
  mine: Risk | null
  best: BestPass
  proIsBest: boolean
  mineIsBest: boolean
  mineIsPro: boolean
  /** a pass into space: the teammate you aimed for and how far the tap was from where he was heading */
  memory: { num: number; dist: number } | null
}


export interface WhyInfo {
  title: string
  points: string[]
  cols: CompareCol[]
  /** extra footnote (the race model, for a pass into space) */
  note?: string
}

export interface ScanInfo {
  /** seconds of play shown before the ball arrived */
  span: number
  /** pass 1 kicked, seconds before the ball arrived */
  kickBefore: number
  looks: { from: number; to: number; saw: number | null }[]
  lines: string[]
  timing: number
  target: number
}

export interface MatchInfo {
  home: string
  away: string
  score: string
  result: string
  attacking: 'home' | 'away'
  minute: string
  sub: string
  people: { role: string; num: number; name: string; pos: string | null; team: Team }[]
}

export interface Breakdown {
  why: WhyInfo
  scan: ScanInfo
  match: MatchInfo
}

const clip = (x: number) => Math.max(0, Math.min(1, x))
const metres = (x: number) => `${Math.round(Math.abs(x))} m`

/** Points each part of the value formula gives an option (see option_value in extract_moments.py). */
function parts(o: PassOption) {
  return { forward: 50 * clip((o.progress + 10) / 35), lane: 30 * clip(o.lane_open / 5), space: 20 * clip(o.receiver_space / 6) }
}

/** Why pass a beats pass b, most important reason first. Names are noun phrases ("your pass to #8"). */
export function reasons(a: PassOption, aName: string, b: PassOption, bName: string): string[] {
  const out: [number, string][] = []
  if (b.offside && !a.offside) out.push([999, `${bName} went to a player in an offside position`])
  const pa = parts(a)
  const pb = parts(b)
  if (b.lane_open < 2 && a.lane_open >= 2)
    out.push([99, `The lane for ${bName} was almost blocked – a defender was ${b.lane_open} m from the ball’s path`])
  else if (pa.lane - pb.lane >= 3)
    out.push([pa.lane - pb.lane, `${aName} had a clearer lane (${a.lane_open} m vs ${b.lane_open} m to the nearest defender)`])
  if (pa.forward - pb.forward >= 3) out.push([pa.forward - pb.forward, `${aName} went ${metres(a.progress - b.progress)} further forward`])
  if (pa.space - pb.space >= 3)
    out.push([pa.space - pb.space, `${aName} left the receiver more space (${a.receiver_space} m vs ${b.receiver_space} m)`])
  if (b.direction === 'backward' && a.direction !== 'backward' && a.lane_open >= 2)
    out.push([5, `${bName} went backward while a forward pass was on`])
  if (b.dist > 25 && a.dist < b.dist - 5) out.push([4, `${aName} was shorter and safer (${a.dist} m vs ${b.dist} m)`])
  if (out.length === 0) out.push([0, `${aName} scored a little higher overall (${a.value} vs ${b.value})`])
  return out.sort((x, y) => y[0] - x[0]).map((x) => x[1])
}

/** What made an option good on its own. */
function strengths(o: PassOption, name: string): string {
  const fwd = o.progress >= 0 ? `${metres(o.progress)} forward` : `${metres(o.progress)} back`
  return `${name}: ${fwd}, lane ${o.lane_open} m clear, ${o.receiver_space} m of space`
}

export function minuteLabel(m: Moment): string {
  const min = m.context.minute
  if (m.period === 1 && min > 45) return `45+${min - 45}′`
  if (m.period === 2 && min > 90) return `90+${min - 90}′`
  return `${min}′`
}

export function explain(
  tr: Track,
  scans: ScanRecord[],
  chosenIdx: number,
  proLine: string,
  space: SpaceOutcome | null = null,
  facts: PassFacts,
): Breakdown {
  const m = tr.m
  const opt = (pid: string | null) => m.options.find((o) => o.pid === pid) ?? null
  const numOf = (pid: string | null) => {
    const i = idxOf(tr, pid)
    return i >= 0 ? tr.nums[i] : 0
  }
  const B = facts.best
  const best = B.o
  const bestIdx = B.idx
  const pro = facts.pro?.o ?? null
  const proSpace = facts.pro?.intoSpace ?? false
  const mine = chosenIdx >= 0 ? opt(tr.pids[chosenIdx]) : null
  const bestN = `#${best.num}`
  const who = (i: number) => `${tr.att[i] ? '' : 'red '}#${tr.nums[i]}`
  const spaceOpt = space?.option ?? null
  const myOpt = spaceOpt ?? mine
  const { proIsBest, mineIsBest, mineIsPro } = facts
  // passes as noun phrases
  const myName = spaceOpt ? `your through ball to #${spaceOpt.num}` : mine ? `your pass to #${mine.num}` : 'your pass'
  const proName = pro ? `the pro’s ${proSpace ? 'through ball' : 'pass'} to #${pro.num}` : 'the pro’s pass'
  const bestName = B.intoSpace ? `a through ball to ${bestN}` : `a pass to ${bestN}`
  const riskLine = (r: Risk | null, name: string, real: boolean) => {
    const level = r ? riskLevel(r.slack) : 'low'
    if (!r || level === 'low') return null
    return level === 'high'
      ? `High risk: ${who(r.idx)} was close to cutting out ${name}${real ? ' – it got through this time' : ''}`
      : `Some risk: ${who(r.idx)} was near the path of ${name}`
  }

  // ---- why
  let title: string
  let points: string[] = []
  if (space && space.takerIdx < 0) {
    title = 'Your pass went out of play'
    points = ['Nobody could reach it before it crossed the line', strengths(best, bestName)]
  } else if (space && space.team === 'def') {
    const rival = space.rivalIdx >= 0 && Number.isFinite(space.margin) ? space.rivalIdx : -1
    title = `Why ${who(space.takerIdx)} intercepted your pass`
    points = [
      rival >= 0
        ? `${who(space.takerIdx)} got to the ball after ${space.t.toFixed(1)} s – ${gap(space.margin)} before your quickest teammate, ${who(rival)}`
        : `${who(space.takerIdx)} got to the ball after ${space.t.toFixed(1)} s – none of your teammates could reach it`,
      strengths(best, bestName),
    ]
  } else {
    // a completed pass of yours (to feet or into space), or none at all
    if (space && spaceOpt) {
      const rival = space.rivalIdx >= 0 && Number.isFinite(space.margin) ? space.rivalIdx : -1
      points.push(
        space.asPro
          ? `Your tap matched the pro’s pass, so you get what really happened: #${spaceOpt.num} ran onto it`
          : rival >= 0
            ? space.margin < 0.05
              ? `#${spaceOpt.num} beat ${who(rival)} to it by a split second – very risky`
              : `#${spaceOpt.num} reached the ball after ${space.t.toFixed(1)} s – ${gap(space.margin)} before the quickest opponent, ${who(rival)}`
            : `#${spaceOpt.num} reached the ball after ${space.t.toFixed(1)} s – no opponent could get there`,
      )
    }
    if (myOpt && mineIsBest && mineIsPro) {
      title = 'You and the pro both found the best pass'
      points.push(strengths(myOpt, myName))
    } else if (myOpt && mineIsBest && proIsBest && pro) {
      title = 'You and the pro found equally good passes'
      points.push(`Yours: ${reasons(myOpt, myName, pro, proName)[0].replace(/^./, (c) => c.toLowerCase())}`)
      points.push(`The pro’s: ${reasons(pro, proName, myOpt, myName)[0].replace(/^./, (c) => c.toLowerCase())}`)
    } else if (myOpt && mineIsBest) {
      title = pro ? `Why ${myName} beat ${proName}` : 'You found the best pass'
      points.push(...(pro ? reasons(myOpt, myName, pro, proName) : [strengths(myOpt, myName)]))
    } else if (myOpt && proIsBest && pro) {
      title = `Why ${proName} – the best pass – beat ${myName}`
      points.push(...reasons(pro, proName, myOpt, myName))
    } else if (myOpt) {
      title = `Why ${bestName} was better than ${myName}${mineIsPro ? ' (and the pro’s)' : ''}`
      points.push(...reasons(best, bestName, myOpt, myName))
      if (pro && !mineIsPro && myOpt.value > pro.value)
        points.push(`Still, yours beat the pro’s: ${reasons(myOpt, myName, pro, proName)[0].replace(/^./, (c) => c.toLowerCase())}`)
    } else {
      title = proIsBest ? `The pro found the best pass: ${bestName}` : `What ${bestName} offered`
      points.push(strengths(best, bestName))
      if (pro && !proIsBest) points.push(...reasons(best, bestName, pro, proName).slice(0, 2))
    }
  }
  if (facts.memory)
    points.push(
      `Memory: you aimed ${facts.memory.dist.toFixed(1)} m from where #${facts.memory.num} would be when the ball arrived (3 m or closer = full marks)`,
    )
  if (B.intoSpace && !mineIsBest && !proIsBest)
    points.push(`The best pass was into space: #${best.num} could run onto it, ${gap(Math.max(0, B.t))} after the pass`)
  const risks = [space?.asPro ? null : riskLine(facts.mine, myName, false), riskLine(facts.pro?.risk ?? null, proName, true)].filter(
    (x): x is string => x !== null,
  )
  const lineV = offsideLineV(tr)
  const offside = tr.pids
    .map((_, i) => i)
    .filter((i) => tr.att[i] && i !== tr.youIdx && offsideBy(tr, i, lineV) > 0)
    .map((i) => `#${tr.nums[i]} (${(offsideBy(tr, i, lineV) + OFFSIDE_TOL_M).toFixed(1)} m)`)
  if (offside.length)
    risks.push(`Offside when you passed: ${offside.join(', ')} beyond the offside line – a pass to them is a free kick for the opponents`)
  points.push(...risks, proLine)
  const note =
    `Risk = how close the nearest opponent gets to the ball’s path, compared with the pros’ completed passes: high = tighter than the tightest quarter of them (${RISK_HIGH_S} s), medium = up to ${RISK_MEDIUM_S} s, low = more room. ` +
    `It comes from a race model: the ball travels at ${RACE.ballSpeed} m/s (passes over ${RACE.loftFrom} m are lofted and can only be reached as they land); opponents keep running for ${RACE.react} s before they react (your teammates ${RACE.reactMates} s – they expect the pass), then sprint at ${RACE.runSpeed} m/s from where they really were, and control the ball within ${RACE.reach} m. ` +
    `Checked on the 30 real passes: it picks the team that won the ball in 25. Taps aren’t precise: a pass into space is also tried 2.5 m around your tap, and a tap within 5 m of where the pro’s pass was collected gets the real outcome. ` +
    `The best pass can be into space: spots around every onside teammate are tried, and one counts when the receiver wins it by 0.5 s or more, it isn’t high-risk, and it beats the best pass to feet by 3+ points.`

  const riskCell = (r: Risk | null): CompareCol['risk'] => {
    if (!r) return null
    const level = riskLevel(r.slack)
    return { text: level === 'low' ? 'low' : `${level} (#${tr.nums[r.idx]})`, level } // always an opponent
  }
  const bestRisk = riskCell(B.intoSpace ? passRisk(tr, B.end, B.t) : passRisk(tr, posAt(tr, tr.rec, bestIdx)))
  // one column per different pass: yours, the pro's, the best (merged when they are the same)
  const run = (o: PassOption, intoSpace: boolean) => `#${o.num}${intoSpace ? ' (run)' : ''}`
  const cols: CompareCol[] = []
  if (myOpt) {
    const label = `You${mineIsPro ? ' = pro' : ''} ${run(myOpt, !!spaceOpt)}${mineIsBest ? ' · best' : ''}`
    cols.push({ label, tone: 'mine', o: myOpt, risk: riskCell(facts.mine) })
  }
  if (!mineIsPro)
    cols.push({ label: pro ? `Pro ${run(pro, proSpace)}${proIsBest ? ' · best' : ''}` : 'Pro', tone: 'pro', o: pro, risk: riskCell(facts.pro?.risk ?? null) })
  if (!mineIsBest && !proIsBest) cols.push({ label: `Best ${run(best, B.intoSpace)}`, tone: 'best', o: best, risk: bestRisk })

  // ---- scan
  const youIdx = tr.youIdx
  const [yu, yv] = posAt(tr, tr.rec, youIdx)
  const [bu, bv] = posAt(tr, tr.rec, bestIdx)
  const where = whereIs(yu, yv, bu, bv)
  const seen = scans.map((s) => s.sawBestBefore).filter((b): b is number => b !== null)
  const lastSaw = seen.length ? Math.min(...seen) : null
  const lastEnd = scans.length ? Math.min(...scans.map((s) => s.endBefore)) : null
  const lines: string[] = []
  if (scans.length === 0) {
    lines.push('You didn’t look around at all.')
    lines.push(`${bestN} was ${where}. Turn the dial while the ball is on its way to see who is free.`)
  } else if (lastSaw === null) {
    const dirs = [...new Set(scans.map((s) => lookWord(s.dir)))]
    lines.push(`You looked ${dirs.join(' and ')} – but ${bestN} was ${where}, outside every look.`)
    if (lastEnd !== null && lastEnd > RECENT_SCAN_S)
      lines.push(`Your last look ended ${lastEnd.toFixed(1)} s before the ball arrived – too early to count as fresh.`)
  } else if (lastSaw > RECENT_SCAN_S) {
    lines.push(`You last saw ${bestN} ${lastSaw.toFixed(1)} s before the ball arrived.`)
    // what changed after that look
    const fThen = Math.max(0, Math.round(tr.rec - lastSaw * FPS))
    const [tu, tv] = posAt(tr, fThen, bestIdx)
    const moved = Math.hypot(bu - tu, bv - tv)
    const nearestDef = (f: number) => {
      const [pu, pv] = posAt(tr, f, bestIdx)
      let d = Infinity
      for (let i = 0; i < tr.n; i++) {
        if (tr.att[i]) continue
        const [du, dv] = posAt(tr, f, i)
        d = Math.min(d, Math.hypot(du - pu, dv - pv))
      }
      return d
    }
    const dThen = nearestDef(fThen)
    const dNow = nearestDef(tr.rec)
    const changes: string[] = []
    if (moved >= 2) changes.push(`${bestN} moved ${metres(moved)}`)
    if (Math.abs(dNow - dThen) >= 1.5)
      changes.push(
        `the nearest defender went from ${metres(dThen)} to ${metres(dNow)} away (${dNow > dThen ? 'more open' : 'tighter'})`,
      )
    lines.push(
      changes.length
        ? `After that, ${changes.join(' and ')} – your picture was out of date.`
        : 'The picture barely changed after that – but you couldn’t know without checking again.',
    )
    lines.push(`Pros check again in the last ${RECENT_SCAN_S} s, so what they see is fresh when the ball arrives.`)
  } else {
    lines.push(`You saw ${bestN} ${lastSaw.toFixed(1)} s before the ball arrived – a fresh picture.`)
    if (myOpt && !mineIsBest) lines.push(`But you passed to #${myOpt.num} – trust what your scan showed you.`)
  }
  const { timing, target } = scanParts(scans)

  // ---- match
  const c = m.context
  const date = new Date(`${c.date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const people: MatchInfo['people'] = []
  const add = (role: string, pid: string | null) => {
    if (!pid) return
    const prev = people.find((p) => p.role !== 'You' && p.num === numOf(pid) && p.team === (pid[0] === 'A' ? 'att' : 'def'))
    if (prev) {
      prev.role += ` · ${role.toLowerCase()}`
      return
    }
    const n = m.names[pid]
    people.push({ role, num: numOf(pid), name: n?.name ?? 'Unknown', pos: n?.pos ?? null, team: pid[0] === 'A' ? 'att' : 'def' })
  }
  add('You', m.you_pid)
  add('Pass from', m.passer_pid)
  add('Pro passed to', m.actual.intended_pid)
  if (m.actual.outcome === 'intercepted') add('Won the ball', m.actual.taker?.pid ?? null)
  add('Best option', tr.pids[bestIdx])
  if (chosenIdx >= 0) add('Your pick', tr.pids[chosenIdx])
  if (space && space.takerIdx >= 0) add('Got your pass', tr.pids[space.takerIdx])

  return {
    why: { title, points, cols, note },
    scan: {
      span: tr.rec / FPS,
      kickBefore: (tr.rec - tr.pass1) / FPS,
      looks: scans.map((s) => ({ from: s.startBefore, to: s.endBefore, saw: s.sawBestBefore })),
      lines,
      timing,
      target,
    },
    match: {
      home: c.home,
      away: c.away,
      score: c.score,
      result: c.result,
      attacking: c.attacking,
      minute: minuteLabel(m),
      sub: [c.competition, c.season.replace(/^20(\d\d)\/20(\d\d)$/, '20$1/$2'), `Matchday ${c.matchday}`, date, c.stadium]
        .filter(Boolean)
        .join(' · '),
      people,
    },
  }
}
