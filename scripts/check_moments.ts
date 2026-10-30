// npm run check [-- <dir | files...>] [--json out.json] [--taps 20] [--max-hold-s 2]
//
// Loads moment files through the real game code (data contract validation, game/facts.ts,
// best.ts, evaluate.ts, explain.ts) and simulates taps: the best option, the pro's pass and
// `--taps` random taps (seeded by the moment id, so runs repeat). Asserts that, for every moment:
//   - the data is sane: the ball is within 2 m of "you" at the reception and at the decision, everyone
//     is on the pitch, the attack goes the right way, the replay file matches (its kick = the decision
//     frame); the pro passed within --max-hold-s (the pipeline's max_hold_s) of receiving;
//   - the best option is not a backward pass into space, and has at least best.minP (60 %) to arrive
//     (a riskier pass is only ever the "Brave option", below it);
//   - "dead heat" / "split second" never appear, and "close race" only between 40 and 60 %;
//   - "Better than the pro!" is never said for a high-risk pass;
//   - the memory line names the teammate who actually received your pass;
//   - a pass that arrives past a defender standing in the lane (a lane block is a chance, not a
//     stop: passModel.laneBlock) says "it got through this time", and so does the pro's completed
//     pass when the model rated it below 50 % or a defender stood in its lane;
//   - outcome = chance: a pass is completed exactly when it is >= 50 % to arrive (again except the
//     pro's real pass);
//   - lofted passes are lofted where the ball height says so (the pro's: measured height, else
//     > loftFrom; yours: a double tap), and a single tap always plays along the ground;
//   - tapping the best option (double-tapping it when it is lofted) gives "the best option";
//   - when the pro's pass is as good as the best (best.ts isProAsGoodAsBest), no tap's result implies
//     he missed it: no separate best arrow or Best column, the pro's column says "= best", every
//     text that mentions the best option (or "The pro played") acknowledges the pro, and the scan tab
//     says the pro chose it.
// Exit code 1 when any moment fails. extract_moments.py runs this on every candidate (--json) and
// only keeps the moments that pass.
import fs from 'node:fs'
import path from 'node:path'
import { validateMoment, validatePlay } from '../src/data/validate'
import type { MomentData, Play } from '../src/types'
import { buildTrack, FPS, PITCH_L, PITCH_W, posAt, toPortrait, idxOf, type Track } from '../src/game/track'
import { findBestPass, findBravePass, isProAsGoodAsBest, rankedPasses, rankValue, scoredOptions } from '../src/game/best'
import { difficultyParts } from '../src/game/difficulty'
import { evaluate, type RoundResult } from '../src/game/evaluate'
import { flight, optionAt, RACE } from '../src/game/space'
import { proLofted } from '../src/game/facts'
import { MODEL } from '../src/game/model.config'
import { hashString, mulberry32 } from '../src/lib/util'

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2)
const opt = (name: string) => {
  const i = argv.indexOf(name)
  if (i < 0) return null
  const v = argv[i + 1]
  argv.splice(i, 2)
  return v
}
const jsonOut = opt('--json')
const nRandom = Number(opt('--taps') ?? 20)
const maxHoldS = Number(opt('--max-hold-s') ?? 2)
const quiet = argv.includes('--quiet')
const targets = argv.filter((a) => a !== '--quiet')
const APP_DIR = path.resolve('public/moments')

function momentFiles(t: string): string[] {
  const p = path.resolve(t)
  if (fs.statSync(p).isDirectory())
    return fs
      .readdirSync(p)
      .filter((n) => n.endsWith('.json') && n !== 'index.json' && !n.endsWith('.play.json'))
      .sort()
      .map((n) => path.join(p, n))
  return [p]
}
const files = (targets.length ? targets : [APP_DIR]).flatMap(momentFiles)

// ------------------------------------------------------------------ helpers
const toData = ([u, v]: [number, number]) => ({ x: +(PITCH_L - v).toFixed(1), y: +(PITCH_W - u).toFixed(1) })
const pct = (p: number | null | undefined) => (p === null || p === undefined ? '–' : `${Math.round(p * 100)}%`)

/** Index of an opponent standing in the lane of a pass from you to `end` at the reception: within
 *  race.reach of the ball's path where it can be reached (off your feet, not over his head, short of
 *  the receiver's own reach). -1 = the lane is clear. */
function standingInLane(tr: Track, end: [number, number], lofted: boolean): number {
  const you = posAt(tr, tr.rec, tr.youIdx)
  const L = Math.hypot(end[0] - you[0], end[1] - you[1])
  if (L < 1e-3) return -1
  const B = flight(L, lofted)
  const reach = MODEL.race.reach
  for (let s = MODEL.flight.startM; s <= L - reach; s += 0.25) {
    if (!B.reachable(s)) continue
    const q = [you[0] + ((end[0] - you[0]) * s) / L, you[1] + ((end[1] - you[1]) * s) / L]
    for (let i = 0; i < tr.n; i++) {
      if (tr.att[i]) continue
      const p = posAt(tr, tr.rec, i)
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= reach) return i
    }
  }
  return -1
}

/** The pass you made in a result: completed? where to, lofted? (null when there was no pass / it was offside) */
function madePass(tr: Track, r: RoundResult): { completed: boolean; end: [number, number]; lofted: boolean; asPro: boolean } | null {
  const you = posAt(tr, tr.rec, tr.youIdx)
  if (r.space) {
    if (r.space.offside || r.space.takerIdx < 0) return null
    // the flight the model used (a ball cut at the line is lofted by the length of your tap)
    return { completed: r.space.team === 'att', end: r.space.end, lofted: r.space.lofted, asPro: !!r.space.asPro }
  }
  if (r.chosenIdx >= 0) {
    if (r.headline === 'Offside!') return null
    const e = posAt(tr, tr.rec, r.chosenIdx)
    return { completed: !r.lost, end: e, lofted: r.lofted, asPro: false }
  }
  return null
}

interface TapReport {
  kind: string
  tap: [number, number]
  headline: string
  p: number | null
  risk: string | null
}

/** Assertions on one tap's result. */
function checkTap(tr: Track, kind: string, tap: [number, number], problems: string[], lofted = false): TapReport {
  const r = evaluate(tr, { tap, scans: [], lofted })
  const tag = `${kind} ${lofted ? 'double-' : ''}tap (${toData(tap).x}, ${toData(tap).y}) "${r.headline}"`
  // the flight you chose is the flight that was played
  if ((r.space || r.chosenIdx >= 0) && r.lofted !== lofted) problems.push(`${tag}: played ${r.lofted ? 'lofted' : 'along the ground'}`)
  const texts = [r.headline, r.detail, r.breakdown.why.title, ...r.breakdown.why.points]
  const all = texts.join(' | ')
  const F = MODEL.feedback
  if (/dead heat|split second/i.test(all)) problems.push(`${tag}: says "dead heat" / "split second"`)
  if (/close race/i.test(all) && (r.p === null || r.p < F.closeRaceLo - 1e-9 || r.p > F.closeRaceHi + 1e-9))
    problems.push(`${tag}: "close race" at ${pct(r.p)} (only ${pct(F.closeRaceLo)}–${pct(F.closeRaceHi)})`)
  if (r.headline === 'Better than the pro!' && r.risk === 'high') problems.push(`${tag}: "Better than the pro!" for a high-risk pass`)
  if (r.headline === 'Brave pass!' && (r.p ?? 1) >= MODEL.best.minP) problems.push(`${tag}: "Brave pass!" at ${pct(r.p)}`)
  // memory names the actual receiver
  if (r.space && r.space.team === 'att' && !r.space.offside) {
    const line = r.breakdown.why.points.find((x) => x.startsWith('Memory:'))
    const want = `#${tr.nums[r.space.takerIdx]}`
    const named = line?.match(/where (#\d+) would be/)?.[1]
    if (line && named !== want) problems.push(`${tag}: memory names ${named}, but ${want} received the pass`)
  }
  // the pro's pass as good as the best: nothing may suggest he missed the best option
  if (isProAsGoodAsBest(tr)) {
    if (!r.proAsGood) problems.push(`${tag}: the result doesn't treat the pro's pass as good as the best`)
    if (r.best.alone) problems.push(`${tag}: draws a separate best arrow although the pro's pass is as good as the best`)
    const implies = /best option|best pass|was open|was better than|was even better|The pro played/i
    const ack = /found it|you and the pro|same as the pro|chose|just as good|as good as|as good a choice|equally good|– the best pass –|= best/i
    const groups: [string, string][] = [
      ['headline/detail', `${r.headline} ${r.detail}`],
      ['Why?', [r.breakdown.why.title, ...r.breakdown.why.points.filter((p) => !p.startsWith('Brave option:'))].join(' | ')],
    ]
    for (const [g, text] of groups)
      if (implies.test(text) && !ack.test(text)) problems.push(`${tag}: ${g} implies the pro missed the best option: "${text.slice(0, 160)}"`)
    if (!/The pro chose/.test(r.breakdown.scan.lines.join(' '))) problems.push(`${tag}: Your scan doesn't say the pro chose the best option`)
    const cols = r.breakdown.why.cols
    if (cols.some((c) => c.tone === 'best')) problems.push(`${tag}: the Why? table has a separate Best column`)
    const proCol = cols.find((c) => c.tone === 'pro') ?? cols.find((c) => /= pro/.test(c.label))
    if (proCol && !/best/i.test(proCol.label)) problems.push(`${tag}: the pro's column "${proCol.label}" isn't labelled as the best`)
  }
  const made = madePass(tr, r)
  if (made && !made.asPro) {
    // outcome = chance to arrive
    if (r.p !== null && made.completed !== r.p >= 0.5)
      problems.push(`${tag}: ${made.completed ? 'completed' : 'lost'} at ${pct(r.p)} to arrive`)
    // past a defender standing in the lane: the text says it got through this time
    if (made.completed) {
      const d = standingInLane(tr, made.end, made.lofted)
      if (d >= 0 && !/got through this time/.test(all))
        problems.push(`${tag}: arrives past red #${tr.nums[d]} standing in the lane without "it got through this time"`)
    }
  }
  return { kind, tap, headline: r.headline, p: r.p, risk: r.risk }
}

interface MomentReport {
  id: string
  file: string
  ok: boolean
  problems: string[]
  difficulty?: string
  parts?: { nClose: number; pressure: number; bestP: number; points: number }
  stats?: {
    best: { pid: string; num: number; intoSpace: boolean; lofted: boolean; direction: string; p: number; value: number; end: { x: number; y: number } }
    brave: { pid: string; intoSpace: boolean; p: number; value: number } | null
    proIsBest: boolean
    /** the pro's pass is as good as the best (within best.asGoodPoints) */
    proAsGood: boolean
    /** the pro's pass valued as a decision (null: no teammate to value it for) */
    proValue: number | null
    /** the pro's pass among the model's ranked options (1 = the best); null when it can't be valued */
    proRank: number | null
    proIntoSpace: boolean
    proLofted: boolean
    outcome: string
    options: number
  }
  taps?: TapReport[]
}

function checkMoment(file: string): MomentReport {
  const rep: MomentReport = { id: path.basename(file, '.json'), file, ok: false, problems: [] }
  const P = rep.problems
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    P.push(`not valid JSON: ${e instanceof Error ? e.message : e}`)
    return rep
  }
  const v = validateMoment(raw)
  if (!v.ok) {
    P.push(...v.problems.map((x) => `schema: ${x}`))
    return rep
  }
  const m: MomentData = v.value
  rep.id = m.id
  if (path.basename(file) !== `${m.id}.json`) P.push(`file name should be ${m.id}.json`)

  // ---- data sanity (what the old pipeline QA checked)
  const rf = m.frames[m.reception_frame_index]
  const you = rf.players.find((p) => p.pid === m.you_pid)!
  const d = Math.hypot(you.x - rf.ball.x, you.y - rf.ball.y)
  if (d > 2) P.push(`ball ${d.toFixed(1)} m from you at the reception (max 2 m)`)
  const df = m.frames[m.decision_frame_index]
  const youD = df.players.find((p) => p.pid === m.you_pid)!
  const dd = Math.hypot(youD.x - df.ball.x, youD.y - df.ball.y)
  if (dd > 2) P.push(`ball ${dd.toFixed(1)} m from you at the decision frame (max 2 m)`)
  // the hold (reception -> the pro's pass) within max_hold_s
  const holdS = (m.decision_frame_index - m.reception_frame_index) / FPS
  if (holdS > maxHoldS + 0.05 || (m.hold_s ?? 0) > maxHoldS) P.push(`the pro held the ball ${Math.max(holdS, m.hold_s ?? 0).toFixed(2)} s (max_hold_s ${maxHoldS})`)
  let play: Play | null = null
  const playFile = file.replace(/\.json$/, '.play.json')
  if (fs.existsSync(playFile)) {
    const pv = validatePlay(JSON.parse(fs.readFileSync(playFile, 'utf8')), m.id)
    if (pv.ok) play = pv.value
    else P.push(...pv.problems.map((x) => `play file: ${x}`))
    if (play && Math.abs(play.kick_index - (m.decision_frame_index - m.reception_frame_index)) > 1e-6)
      P.push(`play file: kick_index ${play.kick_index} is not the decision frame (${m.decision_frame_index - m.reception_frame_index} after the reception)`)
  }
  const off = new Set<string>()
  for (const f of [...m.frames, ...(play?.frames ?? [])])
    for (const p of [...f.players, { pid: 'ball', ...f.ball }])
      if (!(p.x >= -3 && p.x <= PITCH_L + 3 && p.y >= -3 && p.y <= PITCH_W + 3)) off.add(`${p.pid} at t=${f.t}`)
  if (off.size) P.push(`off the pitch: ${[...off].slice(0, 3).join(', ')}${off.size > 3 ? ` (+${off.size - 3})` : ''}`)
  const attMin = Math.min(...rf.players.filter((p) => p.team === 'att').map((p) => p.x))
  const defMax = Math.max(...rf.players.filter((p) => p.team === 'def').map((p) => p.x))
  if (!(attMin < PITCH_L / 2 && PITCH_L / 2 < defMax)) P.push(`attacking direction looks wrong (attackers' deepest x ${attMin}, defenders' deepest x ${defMax})`)

  // ---- the game's model
  const tr = buildTrack(m)
  let best, brave, parts
  try {
    best = findBestPass(tr)
    brave = findBravePass(tr)
    parts = difficultyParts(tr)
  } catch (e) {
    P.push(`model failed: ${e instanceof Error ? e.message : e}`)
    return rep
  }
  const minP = MODEL.best.minP
  if ((best.o.p ?? 1) < minP) P.push(`best option #${best.o.num} has only ${pct(best.o.p)} to arrive (needs ${pct(minP)}; nothing safer exists)`)
  if (best.intoSpace && best.o.direction === 'backward') P.push(`best option is a backward pass into space for #${best.o.num}`)
  if (brave && (brave.o.p ?? 1) >= minP) P.push(`brave option #${brave.o.num} has ${pct(brave.o.p)} to arrive (brave must be below ${pct(minP)})`)

  // ---- lofted where the ball height says so
  const lofted = m.actual.ball_max_z !== undefined ? m.actual.ball_max_z > MODEL.flight.loftedZ : m.actual.length > RACE.loftFrom
  if (proLofted(m) !== lofted) P.push(`pro's pass lofted=${proLofted(m)}, but its ball height says ${lofted}`)
  if (play && m.actual.ball_max_z !== undefined) {
    // frames strictly between the kick and the takeover (10 fps samples of the 25 fps measurement)
    const zs = play.frames.slice(Math.ceil(play.kick_index), Math.floor(play.take_index) + 1).map((f) => f.ball.z ?? 0)
    const top = Math.max(0, ...zs)
    if (top > m.actual.ball_max_z + 0.5) P.push(`replay ball reaches ${top.toFixed(1)} m but ball_max_z is ${m.actual.ball_max_z}`)
  }
  const tk = m.actual.taker
  const takerIdx = tk ? idxOf(tr, tk.pid) : -1
  const proEnd = toPortrait(m.actual.end.x, m.actual.end.y)
  const proIntoSpace =
    m.actual.outcome === 'received' &&
    takerIdx >= 0 &&
    Math.hypot(proEnd[0] - posAt(tr, tr.rec, takerIdx)[0], proEnd[1] - posAt(tr, tr.rec, takerIdx)[1]) >= MODEL.best.samePassM
  const proPid = m.actual.intended_pid ?? m.actual.target_pid
  const proIdx = idxOf(tr, proPid)

  // ---- taps: the best option, the pro's pass, random ones
  const taps: TapReport[] = []
  const bestTap: [number, number] = best.intoSpace ? best.end : posAt(tr, tr.rec, best.idx)
  const rb = evaluate(tr, { tap: bestTap, scans: [], lofted: best.lofted })
  if (rb.best.alone || rb.scores.decision < 98)
    P.push(
      `${best.lofted ? 'double-' : ''}tapping the best option (#${best.o.num}${best.intoSpace ? ' into space' : ''}) gives "${rb.headline}", Decision ${rb.scores.decision}`,
    )
  taps.push(checkTap(tr, 'best', bestTap, P, best.lofted))
  // no tap at all: "too slow", and the pro's pass in its own column (valued with its measured flight)
  const none = evaluate(tr, { tap: null, scans: [] })
  if (none.headline !== 'Too slow!') P.push(`no tap gives "${none.headline}"`)
  const proCol = none.breakdown.why.cols.find((c) => c.tone === 'pro')?.o ?? null
  if (m.actual.outcome === 'received' && proCol) {
    const proTarget: [number, number] = proIntoSpace ? proEnd : posAt(tr, tr.rec, takerIdx >= 0 ? takerIdx : proIdx)
    const laneD = standingInLane(tr, proTarget, lofted)
    const texts = [none.detail, ...none.breakdown.why.points].join(' | ')
    if (((proCol.p ?? 1) < 0.5 || laneD >= 0) && !/got through this time/.test(texts))
      P.push(`pro's completed pass (${pct(proCol.p)}${laneD >= 0 ? `, red #${tr.nums[laneD]} in the lane` : ''}) without "it got through this time"`)
  }
  if (proCol && (proIntoSpace || lofted)) {
    const i = proIntoSpace ? takerIdx : proIdx
    const want = optionAt(tr, i, proIntoSpace ? proEnd : posAt(tr, tr.rec, i), undefined, RACE, lofted).value
    if (Math.abs(proCol.value - want) > 0.05) P.push(`pro's pass valued ${proCol.value}, with its measured flight it is ${want}`)
  }
  const proTap: [number, number] | null = proIntoSpace ? proEnd : proIdx >= 0 ? posAt(tr, tr.rec, proIdx) : null
  if (proTap) taps.push(checkTap(tr, 'pro', proTap, P, lofted))
  const rnd = mulberry32(hashString(`check:${m.id}`))
  const yp = posAt(tr, tr.rec, tr.youIdx)
  const mates = tr.pids.map((_, i) => i).filter((i) => tr.att[i] && i !== tr.youIdx)
  for (let k = 0; k < nRandom; k++) {
    let q: [number, number]
    if (k % 2 === 0) {
      // anywhere within 40 m of you
      const a = rnd() * 2 * Math.PI
      const r = 5 + rnd() * 35
      q = [yp[0] + r * Math.sin(a), yp[1] - r * Math.cos(a)]
    } else {
      // around a teammate: his feet or the space near him
      const p = posAt(tr, tr.rec, mates[Math.floor(rnd() * mates.length)])
      const a = rnd() * 2 * Math.PI
      const r = rnd() * 10
      q = [p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)]
    }
    q = [Math.max(0.5, Math.min(PITCH_W - 0.5, q[0])), Math.max(0.5, Math.min(PITCH_L - 0.5, q[1]))]
    taps.push(checkTap(tr, 'random', q, P, k % 4 === 3)) // every 4th a double tap (lofted)
  }

  rep.ok = P.length === 0
  rep.difficulty = parts.difficulty
  rep.parts = { nClose: parts.nClose, pressure: +parts.pressure.toFixed(1), bestP: +parts.bestP.toFixed(3), points: parts.points }
  rep.stats = {
    best: {
      pid: best.o.pid,
      num: best.o.num,
      intoSpace: best.intoSpace,
      lofted: best.lofted,
      direction: best.o.direction,
      p: +(best.o.p ?? 1).toFixed(3),
      value: best.o.value,
      end: toData(best.end),
    },
    brave: brave ? { pid: brave.o.pid, intoSpace: brave.intoSpace, p: +(brave.o.p ?? 1).toFixed(3), value: brave.o.value } : null,
    proIsBest: rb.proIsBest,
    proAsGood: isProAsGoodAsBest(tr),
    proValue: proCol?.value ?? null,
    proRank: (() => {
      if (!proCol) return null
      const recv = proIntoSpace ? takerIdx : proIdx
      const mine = rankValue({ o: proCol, intoSpace: proIntoSpace })
      return 1 + rankedPasses(tr).filter((c) => c.idx !== recv && rankValue(c) > mine).length
    })(),
    proIntoSpace,
    proLofted: lofted,
    outcome: m.actual.outcome,
    options: scoredOptions(tr).length,
  }
  rep.taps = taps
  return rep
}

// ------------------------------------------------------------------ manifest (the app folder only)
function manifestProblems(dir: string, reports: MomentReport[]): string[] {
  const file = path.join(dir, 'index.json')
  if (!fs.existsSync(file)) return ['public/moments/index.json missing: run npm run manifest']
  const listed = new Set<string>((JSON.parse(fs.readFileSync(file, 'utf8')).moments ?? []).map((e: { id: string }) => e.id))
  const onDisk = new Set(reports.map((r) => r.id))
  const out: string[] = []
  for (const id of listed) if (!onDisk.has(id)) out.push(`manifest lists ${id}, but there is no ${id}.json`)
  for (const id of onDisk) if (!listed.has(id)) out.push(`${id}.json is not in the manifest: run npm run manifest`)
  return out
}

// ------------------------------------------------------------------ run
const t0 = performance.now()
const reports = files.map(checkMoment)
const checkedApp = !targets.length || targets.some((t) => path.resolve(t) === APP_DIR)
const manifest = checkedApp ? manifestProblems(APP_DIR, reports) : []
const ms = performance.now() - t0

const good = reports.filter((r) => r.ok)
const bad = reports.filter((r) => !r.ok)
const count = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {})
const summary = {
  moments: reports.length,
  passed: good.length,
  failed: bad.length,
  taps: reports.reduce((a, r) => a + (r.taps?.length ?? 0), 0),
  difficulty: count(good.map((r) => r.difficulty!)),
  proIsBest: good.filter((r) => r.stats!.proIsBest).length,
  proAsGood: good.filter((r) => r.stats!.proAsGood).length,
  /** the fit target of value.k: the pro's pass within 5 points of the best */
  proWithin5: good.filter((r) => r.stats!.proValue !== null && r.stats!.proValue >= r.stats!.best.value - 5).length,
  proValued: good.filter((r) => r.stats!.proValue !== null).length,
  bestIntoSpace: good.filter((r) => r.stats!.best.intoSpace).length,
  bestLofted: good.filter((r) => r.stats!.best.lofted).length,
  /** the pro's pass is among the model's 3 most valuable different passes */
  proTop3: good.filter((r) => r.stats!.proRank !== null && r.stats!.proRank <= 3).length,
  proIntoSpace: good.filter((r) => r.stats!.proIntoSpace).length,
  proLofted: good.filter((r) => r.stats!.proLofted).length,
  brave: good.filter((r) => r.stats!.brave).length,
  bestDirection: count(good.map((r) => r.stats!.best.direction)),
  manifest,
  seconds: +(ms / 1000).toFixed(1),
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, moments: reports }, null, 1))
if (!quiet) {
  for (const r of bad) {
    console.log(`✗ ${r.id}`)
    for (const p of r.problems) console.log(`    ${p}`)
  }
  for (const p of manifest) console.log(`✗ manifest: ${p}`)
  const n = good.length || 1
  const share = (k: number) => `${k}/${good.length} (${Math.round((100 * k) / n)}%)`
  console.log(
    [
      `${reports.length} moments, ${summary.taps} simulated taps, ${summary.seconds} s`,
      `  passed ${good.length}, failed ${bad.length}${manifest.length ? `, manifest problems ${manifest.length}` : ''}`,
      `  difficulty (game model): ${['easy', 'medium', 'hard'].map((d) => `${d} ${summary.difficulty[d] ?? 0}`).join(' / ')}`,
      `  pro = best (same pass): ${share(summary.proIsBest)}; pro within 5 points of the best: ${summary.proWithin5}/${summary.proValued} (${Math.round((100 * summary.proWithin5) / (summary.proValued || 1))}%)`,
      `  pro's pass as good as the best (shown as the best): ${share(summary.proAsGood)}`,
      `  pro's pass in the model's top 3: ${summary.proTop3}/${summary.proValued} (${Math.round((100 * summary.proTop3) / (summary.proValued || 1))}%)`,
      `  best option into space: ${share(summary.bestIntoSpace)}; lofted: ${share(summary.bestLofted)}; pro's pass into space: ${share(summary.proIntoSpace)}`,
      `  pro's pass lofted: ${share(summary.proLofted)}; brave option shown: ${share(summary.brave)}`,
      `  best direction: ${['forward', 'sideways', 'backward'].map((d) => `${d} ${summary.bestDirection[d] ?? 0}`).join(' / ')}`,
    ].join('\n'),
  )
}
process.exitCode = bad.length || manifest.length ? 1 : 0
