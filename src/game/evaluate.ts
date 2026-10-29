import { idxOf, posAt, toPortrait, type Track } from './track'
import { brainScore, decisionScore, memoryScore, scanScore, type Scores } from './scoring'
import { RECENT_SCAN_S, whereIs, type ScanRecord } from './vision'

export const SNAP_M = 12 // a tap further than this from every teammate is a miss

export interface RoundInput {
  tap: [number, number] | null // pitch metres (portrait), null = timed out
  scans: ScanRecord[]
}

export interface RoundResult {
  momentId: string
  chosenIdx: number // -1 = miss / timeout
  tap: [number, number] | null
  tapDist: number | null
  bestIdx: number
  proEnd: [number, number]
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
  const valueOf = (pid: string | null) => m.options.find((o) => o.pid === pid)?.value ?? 0
  const bestIdx = idxOf(tr, m.best_option_pid)
  const bestNum = tr.nums[bestIdx]
  const [yu, yv] = posAt(tr, tr.rec, tr.youIdx)
  const [bu, bv] = posAt(tr, tr.rec, bestIdx)
  const where = whereIs(yu, yv, bu, bv)
  const proPid = m.actual.intended_pid ?? m.actual.target_pid
  const proIdx = idxOf(tr, proPid)
  const proLine =
    proIdx >= 0
      ? `The pro played #${tr.nums[proIdx]}${m.actual.success ? '' : ' – and lost the ball'}.`
      : 'The pro’s pass was intercepted.'

  const seen = input.scans.map((s) => s.sawBestBefore).filter((b): b is number => b !== null)
  const hint =
    seen.length === 0
      ? 'you never looked that way'
      : seen.some((b) => b <= RECENT_SCAN_S)
        ? 'you saw it in your scan'
        : 'you looked too early'

  const snapped = input.tap ? snap(tr, input.tap) : { idx: -1, dist: Infinity }
  const tapDist = snapped.idx >= 0 ? snapped.dist : null
  const partial = {
    decision: decisionScore(snapped.idx >= 0 ? valueOf(tr.pids[snapped.idx]) : null, valueOf(m.best_option_pid)),
    scan: scanScore(input.scans),
    memory: memoryScore(tapDist),
  }
  const base = {
    momentId: m.id,
    chosenIdx: snapped.idx,
    tap: input.tap,
    tapDist,
    bestIdx,
    proEnd: toPortrait(m.actual.end.x, m.actual.end.y),
    scores: { ...partial, brain: brainScore(partial) },
  }

  if (snapped.idx < 0) {
    return {
      ...base,
      headline: input.tap ? 'No teammate there' : 'Too slow!',
      detail: `#${bestNum} was open ${where} – ${hint}.`,
      tone: 'bad',
    }
  }
  const chosenPid = tr.pids[snapped.idx]
  const isBest = chosenPid === m.best_option_pid
  const isPro = chosenPid === proPid
  if (isBest && isPro) return { ...base, headline: 'Same as the pro!', detail: 'And it was the best option. Elite.', tone: 'great' }
  if (isBest) return { ...base, headline: 'Better than the pro!', detail: `You found the best option. ${proLine}`, tone: 'great' }
  if (valueOf(chosenPid) > valueOf(proPid))
    return { ...base, headline: 'Better than the pro!', detail: `#${bestNum} ${where} was even better – ${hint}.`, tone: 'great' }
  if (isPro)
    return { ...base, headline: 'Same as the pro', detail: `But #${bestNum} ${where} was the best option – ${hint}.`, tone: 'ok' }
  return {
    ...base,
    headline: `#${bestNum} was open ${where}`,
    detail: `${hint[0].toUpperCase()}${hint.slice(1)}. ${proLine}`,
    tone: 'bad',
  }
}
