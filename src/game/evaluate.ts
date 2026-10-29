import type { Team } from '../types'
import { idxOf, posAt, toPortrait, type Track } from './track'
import { explain, type Breakdown } from './explain'
import { findBestPass, findBravePass, SAME_VALUE, samePass, scoredOptions } from './best'
import { RACE } from './space'
import { SLACK_BIAS } from './value'
import { arrivalTime, offsideBy, passKind, offsideLineV, OFFSIDE_TOL_M, spaceMemory, optionAt, passRisk, riskLevel, simulateSpacePass, type Risk, type SpaceOutcome } from './space'
import type { PassOption } from '../types'
import { brainScore, decisionScore, memoryScore, scanScore, spaceMemoryScore, type Scores } from './scoring'
import { RECENT_SCAN_S, whereIs, type ScanRecord } from './vision'

const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase())

/** a pass into space aimed this close to where the pro's completed pass was collected = the pro's pass */
const PRO_SNAP_M = 5
/** aim assist: a pass into space is also tried this far around the tap (fingers aren't precise) */
const AIM_R = 2.5

/** a tap this close to a teammate is a pass to his feet; anywhere else the ball goes where you tapped */
export const SNAP_M = 5

export interface RoundInput {
  tap: [number, number] | null // pitch metres (portrait), null = timed out
  scans: ScanRecord[]
}

export interface RoundResult {
  momentId: string
  chosenIdx: number // -1 = pass into space / timeout
  tap: [number, number] | null
  tapDist: number | null
  bestIdx: number
  /** the best pass (to feet or into space); alone = not the same as yours or the pro's (drawn separately) */
  best: { idx: number; end: [number, number]; run: [number, number][] | null; alone: boolean }
  proEnd: [number, number]
  /** the player who took the pro's pass over and his run to the ball (portrait metres) */
  run: { pts: [number, number][]; team: Team } | null
  /** your pass into space (a tap away from every teammate): who won the race to the ball */
  space: SpaceOutcome | null
  /** offside line (portrait v) when any teammate was beyond it as you passed, else null */
  offsideV: number | null
  /** a pass worth more than the best but below 60 % to arrive (not shown when it's the one you played) */
  brave: { idx: number; end: [number, number]; run: [number, number][] | null; value: number; p: number } | null
  /** your pass to a teammate's feet that the race says is cut out (who took it), else null */
  lost: SpaceOutcome | null
  /** your pass's chance to arrive (expected-value model), null without a pass */
  p: number | null
  /** players the feedback is about: drawn on top, never nudged aside */
  mentioned: number[]
  /** opponents who came close to cutting out your pass or the pro's (drawn as warnings) */
  threats: { idx: number; from: [number, number]; at: [number, number] }[]
  /** the "Why? / Your scan / Match" panels */
  breakdown: Breakdown
  headline: string
  detail: string
  tone: 'great' | 'ok' | 'bad'
  scores: Scores
}

/** Snap a tap to the nearest attacking teammate's TRUE position at reception. */
export function snap(tr: Track, tap: [number, number]): { idx: number; dist: number } {
  let idx = -1
  let dist = Infinity
  for (let i = 0; i < tr.n; i++) {
    if (!tr.att[i] || i === tr.youIdx) continue
    const [u, v] = posAt(tr, tr.rec, i)
    const d = Math.hypot(u - tap[0], v - tap[1])
    if (d < dist) {
      dist = d
      idx = i
    }
  }
  return dist <= SNAP_M ? { idx, dist } : { idx: -1, dist }
}

export function evaluate(tr: Track, input: RoundInput): RoundResult {
  const m = tr.m
  // every option valued by expected value (best.ts / value.ts), not the heuristic in moments.json
  const options = scoredOptions(tr)
  const valueOf = (pid: string | null) => options.find((o) => o.pid === pid)?.value ?? 0
  // the best pass may be to a teammate's feet or into space (best.ts)
  const best = findBestPass(tr)
  const bestIdx = best.idx
  const [yu, yv] = posAt(tr, tr.rec, tr.youIdx)
  const [bu, bv] = posAt(tr, tr.rec, bestIdx)
  const where = whereIs(yu, yv, bu, bv)
  // "through ball" only when he runs on behind the defensive line, else "a pass into space for"
  const describe = (idx: number, end: [number, number], intoSpace: boolean, n = tr.nums[idx]) =>
    !intoSpace ? `#${n}` : passKind(tr, idx, end) === 'through ball' ? `A through ball to #${n}` : `A pass into space for #${n}`
  const bestDesc = describe(bestIdx, best.end, best.intoSpace)
  const brave = findBravePass(tr)
  const proPid = m.actual.intended_pid ?? m.actual.target_pid
  const proIdx = idxOf(tr, proPid)
  const tk = m.actual.taker
  const takerIdx = tk ? idxOf(tr, tk.pid) : -1
  const run =
    tk && takerIdx >= 0
      ? { pts: tk.run.map(([x, y]) => toPortrait(x, y)), team: (tr.att[takerIdx] ? 'att' : 'def') as Team }
      : null
  const runEnd = tk?.run[tk.run.length - 1]
  const ranM = tk && runEnd ? Math.hypot(runEnd[0] - tk.run[0][0], runEnd[1] - tk.run[0][1]) : 0
  const proTo = proIdx >= 0 ? `#${tr.nums[proIdx]}` : null
  const takerNum = takerIdx >= 0 ? tr.nums[takerIdx] : 0
  const proLine =
    m.actual.outcome === 'intercepted' && takerIdx >= 0
      ? proTo
        ? `The pro played ${proTo} – red #${takerNum} intercepted it.`
        : `The pro’s pass was intercepted by red #${takerNum}.`
      : m.actual.outcome === 'out'
        ? `The pro played ${proTo ?? 'it'} – it went out of play.`
        : !proTo
          ? 'The pro’s pass was intercepted.'
          : m.actual.success && ranM >= 6
            ? `The pro played it into space for #${takerNum} to run onto.`
            : `The pro played ${proTo}${m.actual.success ? '' : ' – and lost the ball'}.`

  // The pro's real pass, judged like yours: to a teammate's feet, or into space when the
  // receiver had to run onto it (then it is scored at the spot he collected it, not where he stood).
  const proEnd = toPortrait(m.actual.end.x, m.actual.end.y)
  const proIntoSpace =
    m.actual.outcome === 'received' && takerIdx >= 0 && Math.hypot(proEnd[0] - posAt(tr, tr.rec, takerIdx)[0], proEnd[1] - posAt(tr, tr.rec, takerIdx)[1]) >= 5
  const proOpt: PassOption | null = proIntoSpace ? optionAt(tr, takerIdx, proEnd) : (options.find((o) => o.pid === proPid) ?? null)
  // for "better than the pro": a pro pass that was lost (intercepted / out) is worth nothing
  const proValue = m.actual.outcome === 'received' ? (proOpt?.value ?? 0) : 0
  // risk = the closest an opponent came to cutting the pass out (only for passes that got through)
  const proRisk =
    m.actual.outcome !== 'received' || takerIdx < 0
      ? null
      : proIntoSpace
        ? passRisk(tr, proEnd, arrivalTime(tr, takerIdx, proEnd))
        : passRisk(tr, posAt(tr, tr.rec, takerIdx))

  // Reading a pass into space. Taps aren't precise, so:
  //  - aimed near where the pro's completed pass was collected = you played the pro's pass, and you
  //    get what really happened in the match (receiver, run, value), not the model
  //  - otherwise the ball goes to the tap; if a teammate can't win it there, 8 points AIM_R around
  //    the tap are tried and the best one a teammate wins is used
  const readSpace = (tap: [number, number]): SpaceOutcome => {
    if (m.actual.outcome === 'received' && takerIdx >= 0 && run && Math.hypot(tap[0] - proEnd[0], tap[1] - proEnd[1]) <= PRO_SNAP_M) {
      return {
        end: proEnd,
        takerIdx,
        team: 'att',
        run: run.pts,
        t: arrivalTime(tr, takerIdx, proEnd),
        rivalIdx: proRisk?.idx ?? -1,
        margin: proRisk ? Math.max(0, proRisk.slack) : Infinity,
        option: proOpt ?? optionAt(tr, takerIdx, proEnd),
        asPro: true,
      }
    }
    // aim assist only rescues a pass that would be lost: the ball otherwise goes exactly where you tapped
    const center = simulateSpacePass(tr, tap)
    if (center.option) return center
    let best = center
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      const o = simulateSpacePass(tr, [tap[0] + AIM_R * Math.cos(a), tap[1] + AIM_R * Math.sin(a)])
      if (o.option && (!best.option || o.option.value > best.option.value)) best = o
    }
    return best
  }

  const seen = input.scans.map((s) => s.sawBestBefore).filter((b): b is number => b !== null)
  const hint =
    seen.length === 0
      ? 'you never looked that way'
      : seen.some((b) => b <= RECENT_SCAN_S)
        ? 'you saw it in your scan'
        : `you looked too early – last check ${Math.min(...seen).toFixed(1)} s before the ball came`

  // The ball goes where you tap: close to a teammate = a pass to his feet (memory = how close
  // you tapped), anywhere else = a pass into space (race to the ball). A tap that is closer to
  // where the pro's through ball was collected than to any teammate is the pro's pass.
  const bestValue = best.o.value
  const scan = scanScore(input.scans)
  const lineV = offsideLineV(tr)
  const near = input.tap ? snap(tr, input.tap) : { idx: -1, dist: Infinity }
  const toProEnd = input.tap && proIntoSpace ? Math.hypot(input.tap[0] - proEnd[0], input.tap[1] - proEnd[1]) : Infinity
  const toFeet = near.idx >= 0 && near.dist <= toProEnd
  const space: SpaceOutcome | null = input.tap && !toFeet ? readSpace(input.tap) : null
  const snapped = space ? { idx: -1, dist: Infinity } : near
  // a pass to feet is decided by its own chance to arrive (the same number as its value): below
  // 50 % the opponent who comes closest to cutting it out takes it where he meets the ball
  const feetOpt = snapped.idx >= 0 ? (options.find((o) => o.pid === tr.pids[snapped.idx]) ?? null) : null
  const feetRisk = feetOpt && !feetOpt.offside && (feetOpt.p ?? 1) < 0.5 ? passRisk(tr, posAt(tr, tr.rec, snapped.idx)) : null
  const lost: SpaceOutcome | null = feetRisk
    ? {
        end: feetRisk.at,
        takerIdx: feetRisk.idx,
        team: 'def',
        run: [posAt(tr, tr.rec, feetRisk.idx), feetRisk.at],
        t: Math.hypot(feetRisk.at[0] - posAt(tr, tr.rec, tr.youIdx)[0], feetRisk.at[1] - posAt(tr, tr.rec, tr.youIdx)[1]) / RACE.ballSpeed,
        rivalIdx: snapped.idx,
        margin: -(feetRisk.slack + SLACK_BIAS),
        option: null,
      }
    : null
  const tapDist = snapped.idx >= 0 ? snapped.dist : null
  // an intercepted pass still had its chance: value it as a pass to your quickest teammate there
  // (expected value: P(success) is low, so is the value); out of play / offside = nothing
  const lostTo = space && space.team === 'def' && space.rivalIdx >= 0 && tr.att[space.rivalIdx] ? space.rivalIdx : -1
  const chosenValue =
    snapped.idx >= 0
      ? valueOf(tr.pids[snapped.idx])
      : space?.option
        ? space.option.value
        : lostTo >= 0
          ? optionAt(tr, lostTo, space!.end).value
          : null
  const myRisk: Risk | null = space
    ? space.team === 'att' && !space.offside
      ? passRisk(tr, space.end, space.t)
      : null
    : snapped.idx >= 0
      ? passRisk(tr, posAt(tr, tr.rec, snapped.idx))
      : null
  const threats = [myRisk, proRisk]
    .filter((r): r is Risk => r !== null && riskLevel(r.slack) === 'high')
    .map((r) => ({ idx: r.idx, from: posAt(tr, tr.rec, r.idx), at: r.at }))
  // each pass as (receiver, end point): two passes are the same when those match (best.ts)
  const proPass =
    m.actual.outcome === 'received' && takerIdx >= 0
      ? { idx: takerIdx, end: proEnd }
      : proIdx >= 0
        ? { idx: proIdx, end: posAt(tr, tr.rec, proIdx) }
        : null
  const myPass =
    space && space.team === 'att' && !space.offside
      ? { idx: space.takerIdx, end: space.end }
      : snapped.idx >= 0
        ? { idx: snapped.idx, end: posAt(tr, tr.rec, snapped.idx) }
        : null
  // your pass's chance to arrive (to feet, into space, or the one that was cut out)
  const myOpt: PassOption | null =
    snapped.idx >= 0
      ? (options.find((o) => o.pid === tr.pids[snapped.idx]) ?? null)
      : (space?.option ?? (lostTo >= 0 ? optionAt(tr, lostTo, space!.end) : null))
  const myP = myOpt?.p ?? null
  const mineIsBrave = !!myPass && !!brave && samePass(myPass, brave) && (chosenValue ?? 0) >= best.o.value + 0.5
  // the same pass as the best = same receiver and spot, and (nearly) the same value
  const proIsBest = !!proPass && samePass(proPass, best) && proValue >= best.o.value - SAME_VALUE
  const mineIsBest =
    !!myPass && ((samePass(myPass, best) && (chosenValue ?? 0) >= best.o.value - SAME_VALUE) || (chosenValue ?? 0) >= best.o.value - 0.5)
  const mineIsPro = !!myPass && !!proPass && (samePass(myPass, proPass) || !!space?.asPro)

  const spaceMem = space && input.tap ? spaceMemory(tr, input.tap) : null
  const partial = {
    decision: decisionScore(chosenValue, bestValue),
    scan,
    // a pass into space: how close you aimed to where your teammate was heading
    memory: space && spaceMem ? spaceMemoryScore(spaceMem.dist) : memoryScore(tapDist),
  }
  const base = {
    momentId: m.id,
    chosenIdx: snapped.idx,
    tap: input.tap,
    tapDist,
    bestIdx,
    best: { idx: bestIdx, end: best.end, run: best.run, alone: !proIsBest && !mineIsBest },
    brave: brave && !mineIsBrave ? { idx: brave.idx, end: brave.end, run: brave.run, value: brave.o.value, p: brave.o.p ?? 1 } : null,
    lost,
    p: myP,
    mentioned: [
      tr.youIdx,
      bestIdx,
      snapped.idx,
      takerIdx,
      proIdx,
      space?.takerIdx ?? -1,
      space?.rivalIdx ?? -1,
      lost?.takerIdx ?? -1,
      brave?.idx ?? -1,
      ...threats.map((t) => t.idx),
    ].filter((i, k, a) => i >= 0 && a.indexOf(i) === k),
    proEnd,
    run,
    space,
    offsideV: tr.pids.some((_, i) => tr.att[i] && i !== tr.youIdx && offsideBy(tr, i, lineV) > 0) ? lineV + OFFSIDE_TOL_M : null, // draw the real line, not the noise allowance
    threats,
    scores: { ...partial, brain: brainScore(partial) },
    breakdown: explain(tr, input.scans, snapped.idx, proLine, space, {
      memory: spaceMem && { num: tr.nums[spaceMem.idx], dist: spaceMem.dist },
      pro: proOpt && { o: proOpt, intoSpace: proIntoSpace, risk: proRisk },
      mine: myRisk,
      best,
      proIsBest,
      mineIsBest,
      mineIsPro,
      brave: mineIsBrave ? null : brave,
      myP,
    }),
  }

  const bestLine = `${bestDesc} was open ${where} – ${hint}.`
  const offsideMsg = (i: number) => ({
    ...base,
    headline: 'Offside!',
    detail: `#${tr.nums[i]} was ${(offsideBy(tr, i, lineV) + OFFSIDE_TOL_M).toFixed(1)} m beyond the offside line when you passed – free kick to the opponents. ${bestLine}`,
    tone: 'bad' as const,
  })
  const proFound = proIsBest ? ' The pro found it.' : ''
  if (space?.offside) return offsideMsg(space.takerIdx)
  if (!input.tap) return { ...base, headline: 'Too slow!', detail: bestLine + proFound, tone: 'bad' }
  // what happened to your pass: the race, worded by its chance to arrive (so "close race" ~ 40-60 %)
  const name = (i: number) => `${tr.att[i] ? '' : 'red '}#${tr.nums[i]}`
  const pTxt = myP === null ? '' : ` (${Math.round(myP * 100)}% chance to arrive)`
  let ran = ''
  if (space) {
    const rival = space.rivalIdx >= 0 && Number.isFinite(space.margin) ? name(space.rivalIdx) : null
    if (space.takerIdx < 0)
      return { ...base, headline: 'Out of play', detail: `Nobody could reach your pass before it crossed the line. ${bestLine}${proFound}`, tone: 'bad' }
    if (space.team === 'def')
      return { ...base, headline: 'Intercepted!', detail: `${cap(name(space.takerIdx))} ${raceLost(myP)} your pass${pTxt}. ${bestLine}${proFound}`, tone: 'bad' }
    ran = space.asPro
      ? `#${tr.nums[space.takerIdx]} ran onto it, just like in the real match${myP !== null && myP < 0.5 ? ` – although the model gave it only ${Math.round(myP * 100)}%` : ''}. `
      : `#${tr.nums[space.takerIdx]} ran onto it ${raceWon(myP, rival)}${pTxt}. `
  } else if (options.find((o) => o.pid === tr.pids[snapped.idx])?.offside) return offsideMsg(snapped.idx)
  else if (lost && lost.takerIdx >= 0)
    return { ...base, headline: 'Intercepted!', detail: `${cap(name(lost.takerIdx))} ${raceLost(myP)} your pass to #${tr.nums[snapped.idx]}${pTxt}. ${bestLine}${proFound}`, tone: 'bad' }

  const v = chosenValue ?? 0
  if (mineIsBrave)
    return {
      ...base,
      headline: 'Brave pass!',
      detail: `${ran}Worth more than the safe best option, but only a ${Math.round((myP ?? 0) * 100)}% chance to arrive. ${bestDesc} ${where} was the safer choice.`,
      tone: 'great',
    }
  if (mineIsBest && mineIsPro) return { ...base, headline: 'Same as the pro!', detail: `${ran}And it was the best option. Elite.`, tone: 'great' }
  if (mineIsBest && proIsBest)
    return { ...base, headline: 'As good as the pro!', detail: `${ran}You and the pro found different passes that were equally good.`, tone: 'great' }
  if (mineIsBest) {
    // the main reason it beat the pro's pass (the first point after the race line, for a pass into space)
    const why = proOpt ? base.breakdown.why.points[space ? 1 : 0] : null
    return {
      ...base,
      headline: v > proValue ? 'Better than the pro!' : 'Best option!',
      detail: `${ran}You found the best option. ${why ? `${cap(why)}.` : proLine}`,
      tone: 'great',
    }
  }
  if (mineIsPro)
    return { ...base, headline: 'Same pass as the pro', detail: `${ran}But ${bestDesc.replace(/^A /, 'a ')} ${where} was the best option – ${hint}.`, tone: 'ok' }
  if (v > proValue)
    return { ...base, headline: 'Better than the pro!', detail: `${ran}${bestDesc} ${where} was even better – ${hint}.`, tone: 'great' }
  return {
    ...base,
    headline: space ? (partial.decision >= 75 ? 'Good pass into space' : `#${tr.nums[space.takerIdx]} got there`) : `${bestDesc} ${where} was the best option`,
    detail: `${ran}${space ? `${bestDesc} ${where} was the best option – ${hint}.` : `${cap(hint)}.`}${proIsBest ? ' The pro found it.' : ` ${proLine}`}`,
    tone: space && partial.decision >= 75 ? 'great' : space || partial.decision >= 70 ? 'ok' : 'bad',
  }
}

/** "ran onto it ..." by the chance to arrive: a close race only when it really was close */
function raceWon(p: number | null, rival: string | null): string {
  if (p === null || !rival || p >= 0.85) return 'with time to spare'
  if (p >= 0.6) return `ahead of ${rival}`
  return `in a close race with ${rival}`
}

/** "<opponent> ... your pass" by the chance to arrive */
function raceLost(p: number | null): string {
  return p !== null && p >= 0.4 ? 'won a close race to' : 'got to'
}
