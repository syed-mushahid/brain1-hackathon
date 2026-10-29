// Plain-language breakdown of a round for the results sheet:
//   why one pass was better than another (from the game's option values),
//   what your scanning did, and which real match / players the moment comes from.
import type { MomentData, PassOption, Team } from '../types'
import { FPS, idxOf, posAt, toPortrait, type Track } from './track'
import { scanParts } from './scoring'
import { scoredOptions, SEARCH, type BestPass } from './best'
import { toPoints, VALUE } from './value'
import { offsideBy, offsideLineV, passKind, passRisk, RACE, riskLevel, type Risk, type SpaceOutcome } from './space'
import { MODEL } from './model.config'
import { lookWord, RECENT_SCAN_S, whereIs, type ScanRecord } from './vision'

export interface CompareCol {
  label: string
  tone: 'mine' | 'pro' | 'best' | 'brave'
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
  /** a pass worth more than the best but below 60 % to arrive (null if none, or if you played it) */
  brave: BestPass | null
  /** your pass's chance to arrive */
  myP: number | null
  /** your pass to a teammate's feet, valued with your flight (a lofted one differs from the ground option) */
  feet?: PassOption | null
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

const metres = (x: number) => `${Math.round(Math.abs(x))} m`

const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase())
const pct = (p: number) => `${Math.round(p * 100)}%`
const goalPct = (epv: number) => `${(epv * 100).toFixed(1)}%`

/**
 * Why pass a beats pass b, most important reason first, in the terms of the expected-value model
 * (value.ts): how likely it is to arrive, and how dangerous the spot is. Names are noun phrases
 * ("your pass to #8").
 */
export function reasons(a: PassOption, aName: string, b: PassOption, bName: string): string[] {
  const out: [number, string][] = []
  if (b.offside && !a.offside) out.push([999, `${bName} went to a player in an offside position`])
  const pa = a.p ?? 1
  const pb = b.p ?? 1
  const ea = a.epv ?? 0
  const eb = b.epv ?? 0
  if (pa - pb >= 0.05) out.push([(pa - pb) * 100, `${aName} was safer: ${pct(pa)} vs ${pct(pb)} chance to reach a teammate`])
  if (ea - eb >= 0.003)
    out.push([(ea - eb) * 1500, `${aName} put the ball in a more dangerous spot: ${goalPct(ea)} vs ${goalPct(eb)} of attacks from there end in a goal`])
  if (out.length === 0)
    out.push([0, a.value >= b.value ? `${aName} scored a little higher overall (${Math.round(a.value)} vs ${Math.round(b.value)})` : `${aName} and ${bName} were about as good`])
  const list = out.sort((x, y) => y[0] - x[0]).map((x) => x[1])
  // be honest about the price: a better pass can still be the riskier one
  if (pb - pa >= 0.05) list.push(`Trade-off: ${aName} was riskier – ${pct(pa)} vs ${pct(pb)} chance to reach a teammate`)
  return list
}

/** What made an option good on its own. */
function strengths(o: PassOption, name: string): string {
  const fwd = o.progress >= 0 ? `${metres(o.progress)} forward` : `${metres(o.progress)} back`
  return `${name}: ${pct(o.p ?? 1)} chance to arrive, ${fwd}, ${goalPct(o.epv ?? 0)} of attacks from there end in a goal`
}

export function minuteLabel(m: MomentData): string {
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
  const opt = (pid: string | null) => scoredOptions(tr).find((o) => o.pid === pid) ?? null
  const numOf = (pid: string | null) => {
    const i = idxOf(tr, pid)
    return i >= 0 ? tr.nums[i] : 0
  }
  const B = facts.best
  const best = B.o
  const bestIdx = B.idx
  const pro = facts.pro?.o ?? null
  const proSpace = facts.pro?.intoSpace ?? false
  const mine = chosenIdx >= 0 ? (facts.feet ?? opt(tr.pids[chosenIdx])) : null
  const bestN = `#${best.num}`
  const who = (i: number) => `${tr.att[i] ? '' : 'red '}#${tr.nums[i]}`
  const spaceOpt = space?.option ?? null
  const myOpt = spaceOpt ?? mine
  const { proIsBest, mineIsBest, mineIsPro } = facts
  // passes as noun phrases
  // "through ball" only when the receiver runs on behind the defensive line, else "pass into space"
  const kindName = (whose: string, idx: number, end: [number, number], intoSpace: boolean, n: number, lofted = false) => {
    const lo = lofted ? 'lofted ' : ''
    return !intoSpace
      ? `${whose} ${lo}pass to #${n}`
      : passKind(tr, idx, end) === 'through ball'
        ? `${whose} ${lo}through ball to #${n}`
        : `${whose} ${lo}pass into space for #${n}`
  }
  const proEnd = toPortrait(m.actual.end.x, m.actual.end.y)
  const myName =
    space && spaceOpt
      ? kindName('your', space.takerIdx, space.end, true, spaceOpt.num, space.lofted)
      : mine
        ? kindName('your', chosenIdx, posAt(tr, tr.rec, chosenIdx), false, mine.num, !!mine.lofted)
        : 'your pass'
  const proName = pro ? kindName('the pro’s', idxOf(tr, pro.pid), proEnd, proSpace, pro.num, !!pro.lofted) : 'the pro’s pass'
  const bestName = kindName('a', bestIdx, B.end, B.intoSpace, best.num, B.lofted)
  const Bv = facts.brave
  const braveName = Bv ? kindName('a', Bv.idx, Bv.end, Bv.intoSpace, Bv.o.num, Bv.lofted) : ''
  const pTxt = (p: number | null | undefined) => (p === null || p === undefined ? '' : ` (${Math.round(p * 100)}% chance to arrive)`)
  const riskLine = (r: Risk | null, name: string, real: boolean) => {
    // a defender standing in the lane only reduces the chance: a completed pass got past him
    if (r?.lane) return `${cap(who(r.idx))} was standing in the lane of ${name} – it got through this time`
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
        ? `${who(space.takerIdx)} got to the ball before your quickest teammate, ${who(rival)}${pTxt(facts.myP)}`
        : `${who(space.takerIdx)} got to the ball – none of your teammates could reach it`,
      strengths(best, bestName),
    ]
  } else {
    // a completed pass of yours (to feet or into space), or none at all
    if (space && spaceOpt) {
      const rival = space.rivalIdx >= 0 && Number.isFinite(space.margin) ? space.rivalIdx : -1
      points.push(
        space.asPro
          ? `Your tap matched the pro’s pass, so you get what really happened: #${spaceOpt.num} ran onto it`
          : rival >= 0 && (spaceOpt.p ?? 1) < MODEL.feedback.closeRaceHi
            ? `#${spaceOpt.num} beat ${who(rival)} to it in a close race${pTxt(spaceOpt.p)}`
            : rival >= 0
              ? `#${spaceOpt.num} reached the ball after ${space.t.toFixed(1)} s, ahead of the quickest opponent, ${who(rival)}${pTxt(spaceOpt.p)}`
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
    } else if (myOpt && mineIsBest && pro && pro.value > myOpt.value + 0.5) {
      // the pro's pass into space was worth more, but not by the margin a pass into space needs
      title = `${cap(proName)} was worth a little more`
      points.push(...reasons(pro, proName, myOpt, myName))
      points.push(`A pass into space only counts as the best option when it’s worth ${SEARCH.spaceGain}+ more than the best pass to feet – it is harder to time`)
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
      `Memory: you aimed ${facts.memory.dist.toFixed(1)} m from where #${facts.memory.num} would be when the ball arrived (${MODEL.scoring.spaceMemory.perfectM} m or closer = full marks)`,
    )
  if (B.intoSpace && !mineIsBest && !proIsBest)
    points.push(`The best was ${bestName}: #${best.num} could run onto it ${B.t.toFixed(1)} s after the pass${pTxt(best.p)}`)
  if (Bv)
    points.push(
      `Brave option: ${braveName} was worth more (${Math.round(Bv.o.value)} vs ${Math.round(best.value)}) but had only a ${Math.round((Bv.o.p ?? 0) * 100)}% chance to arrive – the best option needs ${Math.round(MODEL.best.minP * 100)}%+`,
    )
  const risks = [space?.asPro ? null : riskLine(facts.mine, myName, false), riskLine(facts.pro?.risk ?? null, proName, true)].filter(
    (x): x is string => x !== null,
  )
  const lineV = offsideLineV(tr)
  const offside = tr.pids
    .map((_, i) => i)
    .filter((i) => tr.att[i] && i !== tr.youIdx && offsideBy(tr, i, lineV) > 0)
    .map((i) => `#${tr.nums[i]} (${(offsideBy(tr, i, lineV) + MODEL.geometry.offsideTolM).toFixed(1)} m)`)
  if (offside.length)
    risks.push(`Offside when you passed: ${offside.join(', ')} beyond the offside line – a pass to them is a free kick for the opponents`)
  points.push(...risks, proLine)
  const note =
    `Pass value = expected value: P(it arrives) × (gain in goal chance) − P(it’s lost) × the opponents’ goal chance from that spot, with a lost ball counting ${VALUE.k}× (risk aversion, fitted on the pros’ choices), on a 0–100 scale (${Math.round(toPoints(0))} = no change). ` +
    `P comes from a race model, Spearman-style (2017): the ball rolls at ${RACE.ballSpeed} m/s (a double-tap lofts it in a ${MODEL.flight.loftAngleDeg}° arc: it can only be reached where it is low, and needs ${MODEL.flight.controlS} s to control); opponents keep running for ${RACE.react} s before they react (your teammates ${RACE.reactMates} s), then sprint at ${RACE.runSpeed} m/s; the margin becomes a probability with a logistic curve fitted on 991 real Bundesliga passes. ` +
    `Goal chances: Expected Possession Value grid by Laurie Shaw (LaurieOnTracking, MIT licence). ` +
    `Risk = how close the nearest opponent gets to the ball’s path, compared with the pros’ completed passes. ` +
    `Taps aren’t precise: a pass into space is also tried ${MODEL.taps.aimR} m around your tap, and a tap within ${MODEL.taps.proSnapM} m of where the pro’s pass was collected gets the real outcome. ` +
    `The best pass can be into space: spots around every onside teammate are tried.`

  const riskCell = (r: Risk | null): CompareCol['risk'] => {
    if (!r) return null
    const level = riskLevel(r.slack)
    return { text: level === 'low' ? 'low' : `${level} (#${tr.nums[r.idx]})`, level } // always an opponent
  }
  const bestRisk = riskCell(
    B.intoSpace ? passRisk(tr, B.end, B.t, RACE, B.lofted) : passRisk(tr, posAt(tr, tr.rec, bestIdx), undefined, RACE, B.lofted),
  )
  // one column per different pass: yours, the pro's, the best (merged when they are the same)
  const run = (o: PassOption, intoSpace: boolean) => {
    const tags = [intoSpace ? 'run' : '', o.lofted ? 'lofted' : ''].filter(Boolean)
    return `#${o.num}${tags.length ? ` (${tags.join(', ')})` : ''}`
  }
  const cols: CompareCol[] = []
  if (myOpt) {
    const label = `You${mineIsPro ? ' = pro' : ''} ${run(myOpt, !!spaceOpt)}${mineIsBest ? ' · best' : ''}`
    cols.push({ label, tone: 'mine', o: myOpt, risk: riskCell(facts.mine) })
  }
  if (!mineIsPro)
    cols.push({ label: pro ? `Pro ${run(pro, proSpace)}${proIsBest ? ' · best' : ''}` : 'Pro', tone: 'pro', o: pro, risk: riskCell(facts.pro?.risk ?? null) })
  if (!mineIsBest && !proIsBest) cols.push({ label: `Best ${run(best, B.intoSpace)}`, tone: 'best', o: best, risk: bestRisk })
  if (Bv)
    cols.push({
      label: `Brave ${run(Bv.o, Bv.intoSpace)}`,
      tone: 'brave',
      o: Bv.o,
      risk: riskCell(
        Bv.intoSpace ? passRisk(tr, Bv.end, Bv.t, RACE, Bv.lofted) : passRisk(tr, posAt(tr, tr.rec, Bv.idx), undefined, RACE, Bv.lofted),
      ),
    })

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
