import type { Team } from '../types'
import { idxOf, posAt, toPortrait, type Track } from './track'
import { explain, type Breakdown } from './explain'
import { asGoodAsBest, findBestPass, findBravePass, isProAsGoodAsBest, proPassOf, samePass, scoredOptions } from './best'
import { RACE } from './space'
import { proLofted } from './facts'
import { MODEL } from './model.config'
import { flight } from './space'
import { arrivalTime, offsideBy, passKind, offsideLineV, spaceMemory, optionAt, passRisk, riskLevel, simulateSpacePass, type Risk, type SpaceOutcome } from './space'
import type { PassOption } from '../types'
import { brainScore, decisionScore, memoryScore, scanScore, spaceMemoryScore, type Scores } from './scoring'
import { RECENT_SCAN_S, whereIs, type ScanRecord } from './vision'

const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase())

// Tap reading (MODEL.taps): snapM = a tap this close to a teammate is a pass to his feet, anywhere else
// the ball goes where you tapped; proSnapM = a pass into space aimed this close to where the pro's
// completed pass was collected is the pro's pass; aimR = aim assist radius (fingers aren't precise).

export interface RoundInput {
  tap: [number, number] | null // pitch metres (portrait), null = timed out
  scans: ScanRecord[]
  /** a double tap: the pass is lofted (default: along the ground) */
  lofted?: boolean
}

export interface RoundResult {
  momentId: string
  chosenIdx: number // -1 = pass into space / timeout
  tap: [number, number] | null
  tapDist: number | null
  bestIdx: number
  /** the best pass (to feet or into space); alone = neither yours nor the pro's is as good (drawn
   *  separately); ring = where the dashed "best" ring goes (on your pass or the pro's when as good) */
  best: { idx: number; end: [number, number]; run: [number, number][] | null; alone: boolean; lofted: boolean; ring: [number, number] }
  /** your pass was lofted (a double tap) */
  lofted: boolean
  /** the pro's real pass was lofted (measured height) */
  proLofted: boolean
  /** your pass is as good as the best option (within best.asGoodPoints) */
  mineIsBest: boolean
  /** your pass is the pro's pass (same receiver and spot) - for the player's statistics */
  mineIsPro: boolean
  /** the pro's pass is as good as the best option (best.ts isProAsGoodAsBest) */
  proAsGood: boolean
  proEnd: [number, number]
  /** the player who took the pro's pass over and his run to the ball (portrait metres) */
  run: { pts: [number, number][]; team: Team } | null
  /** your pass into space (a tap away from every teammate): who won the race to the ball */
  space: SpaceOutcome | null
  /** offside line (portrait v) when any teammate was beyond it as you passed, else null */
  offsideV: number | null
  /** a pass worth more than the best but below 60 % to arrive (not shown when it's the one you played) */
  brave: { idx: number; end: [number, number]; run: [number, number][] | null; value: number; p: number; lofted: boolean } | null
  /** your pass to a teammate's feet that the race says is cut out (who took it), else null */
  lost: SpaceOutcome | null
  /** your pass's chance to arrive (expected-value model), null without a pass */
  p: number | null
  /** how close an opponent came to cutting out your pass (space.ts riskLevel), null without a completed pass */
  risk: 'low' | 'medium' | 'high' | null
  /** the pro's real pass is the best option (same receiver and spot, about the same value) */
  proIsBest: boolean
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
  return dist <= MODEL.taps.snapM ? { idx, dist } : { idx: -1, dist }
}

export function evaluate(tr: Track, input: RoundInput): RoundResult {
  const r = evaluateRound(tr, input)
  // the best option was a lofted ball and you played yours along the ground: say how to loft it
  if (input.tap && !input.lofted && r.best.lofted && !r.mineIsBest) r.detail += ' Tip: double-tap to play a lofted pass.'
  return r
}

function evaluateRound(tr: Track, input: RoundInput): RoundResult {
  const m = tr.m
  const lofted = !!input.lofted
  // every option valued by expected value (best.ts / value.ts)
  const options = scoredOptions(tr)
  /** a pass to teammate idx's feet with your flight: the ground options, or the same pass lofted */
  const feetOption = (idx: number): PassOption | null => {
    const o = options.find((x) => x.pid === tr.pids[idx]) ?? null
    if (!o || !lofted) return o
    const lo = optionAt(tr, idx, posAt(tr, tr.rec, idx), undefined, RACE, true)
    return { ...lo, offside: o.offside, value: o.offside ? 0 : lo.value }
  }
  // the best pass may be to a teammate's feet or into space (best.ts)
  const best = findBestPass(tr)
  const bestIdx = best.idx
  const [yu, yv] = posAt(tr, tr.rec, tr.youIdx)
  const [bu, bv] = posAt(tr, tr.rec, bestIdx)
  const where = whereIs(yu, yv, bu, bv)
  // "through ball" only when he runs on behind the defensive line, else "a pass into space for"
  const describe = (idx: number, end: [number, number], intoSpace: boolean, loft: boolean, n = tr.nums[idx]) =>
    !intoSpace
      ? loft
        ? `A lofted pass to #${n}`
        : `#${n}`
      : passKind(tr, idx, end) === 'through ball'
        ? `A ${loft ? 'lofted ' : ''}through ball to #${n}`
        : `A ${loft ? 'lofted ' : ''}pass into space for #${n}`
  const bestDesc = describe(bestIdx, best.end, best.intoSpace, best.lofted)
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
  let proLine =
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
            : `The pro played ${proTo}${m.actual.outcome === 'received' ? '' : ' – and lost the ball'}.` // tracking, not the event flag

  // The pro's real pass, judged like yours (best.ts proPassOf): to a teammate's feet, or into space
  // when the receiver had to run onto it, with its measured flight
  const proEnd = toPortrait(m.actual.end.x, m.actual.end.y)
  const PP = proPassOf(tr)
  const proIntoSpace = !!PP?.intoSpace
  const proLoft = proLofted(m)
  const proOpt: PassOption | null = PP?.o ?? null
  // for "better than the pro": a pro pass that was lost (intercepted / out) is worth nothing
  const proValue = m.actual.outcome === 'received' ? (proOpt?.value ?? 0) : 0
  // risk = the closest an opponent came to cutting the pass out (only for passes that got through)
  const proRisk =
    m.actual.outcome !== 'received' || takerIdx < 0
      ? null
      : proIntoSpace
        ? passRisk(tr, proEnd, arrivalTime(tr, takerIdx, proEnd, RACE, proLoft), RACE, proLoft)
        : passRisk(tr, posAt(tr, tr.rec, takerIdx), undefined, RACE, proLoft)
  // the pro's pass arrived although the model rated it risky: say it got through this time
  const proP = proOpt?.p ?? 1
  if (m.actual.outcome === 'received' && proRisk?.lane)
    proLine = `${proLine.replace(/\.$/, '')} – ${tr.att[proRisk.idx] ? '' : 'red '}#${tr.nums[proRisk.idx]} was standing in the lane, but it got through this time.`
  else if (m.actual.outcome === 'received' && proP < 0.5)
    proLine = `${proLine.replace(/\.$/, '')} – the model gave it only ${Math.round(proP * 100)}%, but it got through this time.`

  // Reading a pass into space. Taps aren't precise, so:
  //  - aimed near where the pro's completed pass was collected = you played the pro's pass, and you
  //    get what really happened in the match (receiver, run, value), not the model
  //  - otherwise the ball goes to the tap; if a teammate can't win it there, 8 points taps.aimR around
  //    the tap are tried and the best one a teammate wins is used
  const readSpace = (tap: [number, number]): SpaceOutcome => {
    // the pro's pass = his spot AND his flight (a lofted ball needs a double tap)
    if (
      m.actual.outcome === 'received' &&
      takerIdx >= 0 &&
      run &&
      lofted === proLoft &&
      Math.hypot(tap[0] - proEnd[0], tap[1] - proEnd[1]) <= MODEL.taps.proSnapM
    ) {
      return {
        end: proEnd,
        takerIdx,
        team: 'att',
        run: run.pts,
        t: arrivalTime(tr, takerIdx, proEnd, RACE, proLoft),
        rivalIdx: proRisk?.idx ?? -1,
        margin: proRisk ? Math.max(0, proRisk.slack) : Infinity,
        option: proOpt ?? optionAt(tr, takerIdx, proEnd),
        asPro: true,
        lofted: proLoft,
      }
    }
    // aim assist only rescues a pass that would be lost: the ball otherwise goes exactly where you tapped
    const center = simulateSpacePass(tr, tap, RACE, lofted)
    if (center.option) return center
    let best = center
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      const o = simulateSpacePass(tr, [tap[0] + MODEL.taps.aimR * Math.cos(a), tap[1] + MODEL.taps.aimR * Math.sin(a)], RACE, lofted)
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
  const feetOpt = snapped.idx >= 0 ? feetOption(snapped.idx) : null
  const feetRisk =
    feetOpt && !feetOpt.offside && (feetOpt.p ?? 1) < 0.5 ? passRisk(tr, posAt(tr, tr.rec, snapped.idx), undefined, RACE, lofted) : null
  const lost: SpaceOutcome | null = feetRisk
    ? {
        end: feetRisk.at,
        takerIdx: feetRisk.idx,
        team: 'def',
        run: [posAt(tr, tr.rec, feetRisk.idx), feetRisk.at],
        t: flight(Math.hypot(posAt(tr, tr.rec, snapped.idx)[0] - yu, posAt(tr, tr.rec, snapped.idx)[1] - yv), lofted).t(
          Math.hypot(feetRisk.at[0] - yu, feetRisk.at[1] - yv),
        ),
        rivalIdx: snapped.idx,
        margin: -(feetRisk.slack + MODEL.passModel.bias),
        option: null,
        lofted,
      }
    : null
  const tapDist = snapped.idx >= 0 ? snapped.dist : null
  // an intercepted pass still had its chance: value it as a pass to your quickest teammate there
  // (expected value: P(success) is low, so is the value); out of play / offside = nothing
  const lostTo = space && space.team === 'def' && space.rivalIdx >= 0 && tr.att[space.rivalIdx] ? space.rivalIdx : -1
  const chosenValue =
    snapped.idx >= 0
      ? (feetOpt?.value ?? 0)
      : space?.option
        ? space.option.value
        : lostTo >= 0
          ? (space!.aimed?.value ?? 0)
          : null
  const myRisk: Risk | null = space
    ? space.team === 'att' && !space.offside
      ? passRisk(tr, space.end, space.t, RACE, space.lofted)
      : null
    : snapped.idx >= 0
      ? passRisk(tr, posAt(tr, tr.rec, snapped.idx), undefined, RACE, lofted)
      : null
  const threats = [myRisk, proRisk]
    .filter((r): r is Risk => r !== null && riskLevel(r.slack) === 'high')
    .map((r) => ({ idx: r.idx, from: posAt(tr, tr.rec, r.idx), at: r.at }))
  // each pass as (receiver, end point): two passes are the same when those match (best.ts)
  const proPass = PP && { idx: PP.idx, end: PP.end, lofted: PP.lofted }
  const myPass =
    space && space.team === 'att' && !space.offside
      ? { idx: space.takerIdx, end: space.end, lofted: space.lofted }
      : snapped.idx >= 0
        ? { idx: snapped.idx, end: posAt(tr, tr.rec, snapped.idx), lofted }
        : null
  // your pass's chance to arrive (to feet, into space, or the one that was cut out)
  const myOpt: PassOption | null =
    snapped.idx >= 0 ? feetOpt : (space?.option ?? (lostTo >= 0 ? (space!.aimed ?? null) : null))
  const myP = myOpt?.p ?? null
  // the brave option: worth more than the best, and as risky as it said (below best.minP to arrive)
  const mineIsBrave =
    !!myPass && !!brave && samePass(myPass, brave) && (chosenValue ?? 0) >= best.o.value + 0.5 && (myP ?? 1) < MODEL.best.minP
  // the same pass as the best = same receiver and spot, and (nearly) the same value
  const proIsBest = !!proPass && samePass(proPass, best) && proValue >= best.o.value - MODEL.best.sameValue
  // as good as the best (best.asGoodPoints), however it was played: shown as the best option
  const proAsGood = isProAsGoodAsBest(tr)
  const mineIsBest = !!myPass && !lost && asGoodAsBest(tr, chosenValue)
  const mineShownBest = mineIsBest && !mineIsBrave // a brave pass keeps the safer best beside it
  const mineIsPro = !!myPass && !!proPass && (samePass(myPass, proPass) || !!space?.asPro)

  // memory: against the teammate who got your pass (or the one it was meant for, if it was cut out)
  const receiver = space ? (space.team === 'att' ? space.takerIdx : lostTo) : -1
  const spaceMem = space && input.tap ? spaceMemory(tr, input.tap, receiver) : null
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
    best: {
      idx: bestIdx,
      end: best.end,
      run: best.run,
      alone: !proAsGood && !mineShownBest,
      lofted: best.lofted,
      ring: mineShownBest && myPass ? myPass.end : proAsGood && PP ? PP.ring : best.end,
    },
    brave:
      brave && !mineIsBrave ? { idx: brave.idx, end: brave.end, run: brave.run, value: brave.o.value, p: brave.o.p ?? 1, lofted: brave.lofted } : null,
    lofted: space ? space.lofted : lofted,
    proLofted: proLoft,
    mineIsBest,
    mineIsPro,
    proAsGood,
    lost,
    p: myP,
    risk: myRisk ? riskLevel(myRisk.slack) : null,
    proIsBest,
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
    offsideV: tr.pids.some((_, i) => tr.att[i] && i !== tr.youIdx && offsideBy(tr, i, lineV) > 0) ? lineV + MODEL.geometry.offsideTolM : null, // draw the real line, not the noise allowance
    threats,
    scores: { ...partial, brain: brainScore(partial) },
    breakdown: explain(tr, input.scans, snapped.idx, proAsGood ? `${proLine.replace(/\.$/, '')} – ${proIsBest ? 'the best option: the pro found it' : 'as good a choice as the best option'}.` : proLine, space, {
      memory: spaceMem && { num: tr.nums[spaceMem.idx], dist: spaceMem.dist },
      pro: proOpt && { o: proOpt, intoSpace: proIntoSpace, risk: proRisk },
      mine: myRisk,
      best,
      proIsBest,
      proAsGood,
      mineIsBest,
      mineIsPro,
      brave: mineIsBrave ? null : brave,
      myP,
      feet: feetOpt,
    }),
  }

  const bestLine = `${bestDesc} was open ${where} – ${hint}.`
  const offsideMsg = (i: number) => ({
    ...base,
    headline: 'Offside!',
    detail: `#${tr.nums[i]} was ${(offsideBy(tr, i, lineV) + MODEL.geometry.offsideTolM).toFixed(1)} m beyond the offside line when you passed – free kick to the opponents. ${bestLine}${proFound}`,
    tone: 'bad' as const,
  })
  // the pro's pass as good as the best: never word it as if he missed the best option
  const proNum = PP ? `#${tr.nums[PP.idx]}` : ''
  const delivery = () => {
    const d: string[] = []
    if (PP!.lofted !== best.lofted) d.push(PP!.lofted ? 'lofted' : 'along the ground')
    if (PP!.intoSpace !== best.intoSpace) d.push(PP!.intoSpace ? 'into space' : 'to his feet')
    return d.length ? d.join(', ') : 'to a different spot'
  }
  const proNote =
    !proAsGood || !PP
      ? ''
      : m.actual.outcome !== 'received'
        ? ` The pro’s choice, ${proNum}, was just as good – but this time it was cut out.`
        : proIsBest
          ? ' The pro found it.'
          : PP.idx === bestIdx
            ? ` The pro played it to ${proNum} too (${delivery()}), just as good.`
            : ` The pro’s pass to ${proNum} was just as good.`
  const proFound = proNote
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
      ? `#${tr.nums[space.takerIdx]} ran onto it, just like in the real match${myP !== null && myP < 0.5 ? ` – the model gave it only ${Math.round(myP * 100)}%, but it got through this time` : ''}. `
      : `#${tr.nums[space.takerIdx]} ran onto it ${raceWon(myP, rival)}${pTxt}. `
  } else if (feetOpt?.offside) return offsideMsg(snapped.idx)
  else if (lost && lost.takerIdx >= 0)
    return { ...base, headline: 'Intercepted!', detail: `${cap(name(lost.takerIdx))} ${raceLost(myP)} your pass to #${tr.nums[snapped.idx]}${pTxt}. ${bestLine}${proFound}`, tone: 'bad' }

  // your pass arrived past a defender standing in the lane (a lane block is a chance, not a stop)
  if (myRisk?.lane && !space?.asPro) ran += `${cap(name(myRisk.idx))} was standing in the lane – it got through this time. `
  const v = chosenValue ?? 0
  // a high-risk pass (an opponent nearly cut it out) is never praised as better than the pro
  const risky = base.risk === 'high' && myRisk ? `, but ${name(myRisk.idx)} nearly cut it out` : ''
  if (mineIsBrave)
    return {
      ...base,
      headline: 'Brave pass!',
      detail: `${ran}Worth more than the safe best option, but only a ${Math.round((myP ?? 0) * 100)}% chance to arrive. ${bestDesc} ${where} was the safer choice.${proNote}`,
      tone: 'great',
    }
  if (mineIsBest && mineIsPro) return { ...base, headline: 'Same as the pro!', detail: `${ran}And it was the best option. Elite.`, tone: 'great' }
  if (mineIsBest && proAsGood)
    return {
      ...base,
      headline: 'As good as the pro!',
      detail:
        myPass && PP && myPass.idx === PP.idx
          ? `${ran}You and the pro both found ${proNum} – he played it ${PP.lofted ? 'lofted ' : ''}${PP.intoSpace ? 'into space' : 'to his feet'}, just as good.`
          : `${ran}You and the pro found different passes that were equally good.`,
      tone: 'great',
    }
  if (mineIsBest) {
    // the main reason it beat the pro's pass (the first point after the race line, for a pass into space)
    const why = proOpt ? base.breakdown.why.points[space ? 1 : 0] : null
    const proMore = proValue > v + 0.5 // the pro's pass into space was worth more, but not enough to be "the best"
    return {
      ...base,
      headline: v > proValue && !risky ? 'Better than the pro!' : 'Best option!',
      detail: risky
        ? `${ran}You found the best option${risky} – the safest good pass there was.`
        : proMore
        ? `${ran}You found the best option. The pro’s riskier ${proIntoSpace ? passKind(tr, takerIdx, proEnd) : 'pass'} was worth a little more (${Math.round(proValue)} vs ${Math.round(v)}).`
        : `${ran}You found the best option. ${why ? `${cap(why)}.` : proLine}`,
      tone: 'great',
    }
  }
  if (mineIsPro)
    return { ...base, headline: 'Same pass as the pro', detail: `${ran}But ${bestDesc.replace(/^A /, 'a ')} ${where} was the best option – ${hint}.${proNote}`, tone: 'ok' }
  if (v > proValue && risky)
    return { ...base, headline: 'Risky pass', detail: `${ran}Worth more than the pro’s on paper${risky}. ${bestDesc} ${where} was the best option – ${hint}.${proNote}`, tone: 'ok' }
  if (v > proValue)
    return { ...base, headline: 'Better than the pro!', detail: `${ran}${bestDesc} ${where} was even better – ${hint}.${proNote}`, tone: 'great' }
  return {
    ...base,
    headline: space ? (partial.decision >= MODEL.feedback.goodDecision ? 'Good pass into space' : `#${tr.nums[space.takerIdx]} got there`) : `${bestDesc} ${where} was the best option`,
    detail: `${ran}${space ? `${bestDesc} ${where} was the best option – ${hint}.` : `${cap(hint)}.`}${proAsGood ? proNote : ` ${proLine}`}`,
    tone: space && partial.decision >= MODEL.feedback.goodDecision ? 'great' : space || partial.decision >= MODEL.feedback.okDecision ? 'ok' : 'bad',
  }
}

/** "ran onto it ..." by the chance to arrive: a close race only when it really was close (MODEL.feedback) */
function raceWon(p: number | null, rival: string | null): string {
  const F = MODEL.feedback
  if (p === null || !rival || p >= F.comfortableP) return 'with time to spare'
  if (p >= F.closeRaceHi) return `ahead of ${rival}`
  return `in a close race with ${rival}`
}

/** "<opponent> ... your pass" by the chance to arrive */
function raceLost(p: number | null): string {
  return p !== null && p >= MODEL.feedback.closeRaceLo ? 'won a close race to' : 'got to'
}
