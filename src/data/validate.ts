// Validation of moment files against moment.schema.json, run by the game on load and by
// scripts/check_moments.ts. The schema is interpreted directly (the subset of JSON Schema it uses:
// type, const, enum, required, properties, additionalProperties, items, oneOf, $ref, minimum,
// maximum, minItems, maxItems, minLength, pattern), so the JSON file stays the single source of
// truth without shipping a validator library. Checks the schema can't express (pids that exist,
// frame indices in range, one roster for every frame) follow in semanticProblems().
import schemaJson from './moment.schema.json'
import type { MomentData, Play } from '../types'

type Schema = Record<string, unknown>
const SCHEMA = schemaJson as Schema
export const SCHEMA_VERSION = 1

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v

function typeOk(want: string, v: unknown): boolean {
  const t = typeOf(v)
  return want === t || (want === 'number' && t === 'integer')
}

function resolve(ref: string): Schema {
  // only local refs: #/$defs/name
  let node: unknown = SCHEMA
  for (const part of ref.replace(/^#\//, '').split('/')) node = (node as Schema)[part]
  if (!node) throw new Error(`schema: unknown $ref ${ref}`)
  return node as Schema
}

/** Problems with `v` against schema `s` (empty = valid), as "path: message". At most `max` reported. */
function check(s: Schema, v: unknown, path: string, out: string[], max = 20): void {
  if (out.length >= max) return
  if (typeof s.$ref === 'string') return check(resolve(s.$ref), v, path, out, max)
  if ('const' in s && v !== s.const) {
    out.push(`${path}: must be ${JSON.stringify(s.const)}`)
    return
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v as never)) {
    out.push(`${path}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`)
    return
  }
  if (Array.isArray(s.oneOf)) {
    const ok = s.oneOf.filter((sub) => {
      const tmp: string[] = []
      check(sub as Schema, v, path, tmp, 1)
      return tmp.length === 0
    }).length
    if (ok !== 1) {
      // report the closest branch's problems (the one whose type matches), else a summary
      const branch = (s.oneOf as Schema[]).find((b) => b.type === undefined || [b.type].flat().some((t) => typeOk(t as string, v)))
      if (branch) check(branch, v, path, out, max)
      else out.push(`${path}: matches none of the allowed shapes`)
    }
    return
  }
  if (s.type !== undefined) {
    const types = [s.type].flat() as string[]
    if (!types.some((t) => typeOk(t, v))) {
      out.push(`${path}: expected ${types.join(' | ')}, got ${typeOf(v)}`)
      return
    }
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path}: not a finite number`)
    if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${path}: ${v} < minimum ${s.minimum}`)
    if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${path}: ${v} > maximum ${s.maximum}`)
  }
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && v.length < s.minLength) out.push(`${path}: shorter than ${s.minLength}`)
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) out.push(`${path}: "${v}" does not match ${s.pattern}`)
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) out.push(`${path}: fewer than ${s.minItems} items`)
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push(`${path}: more than ${s.maxItems} items`)
    if (s.items) for (let i = 0; i < v.length && out.length < max; i++) check(s.items as Schema, v[i], `${path}[${i}]`, out, max)
  }
  if (typeOf(v) === 'object') {
    const o = v as Record<string, unknown>
    for (const k of (s.required as string[] | undefined) ?? []) if (!(k in o)) out.push(`${path}: missing "${k}"`)
    const props = (s.properties as Record<string, Schema> | undefined) ?? {}
    for (const [k, val] of Object.entries(o)) {
      if (out.length >= max) return
      if (props[k]) check(props[k], val, `${path}.${k}`, out, max)
      else if (s.additionalProperties === false) out.push(`${path}: unknown field "${k}"`)
      else if (typeof s.additionalProperties === 'object') check(s.additionalProperties as Schema, val, `${path}.${k}`, out, max)
    }
  }
}

/** What the schema can't say: indices in range, the pids that matter exist, one roster throughout. */
function semanticProblems(m: MomentData): string[] {
  const out: string[] = []
  const n = m.frames.length
  if (m.reception_frame_index >= n) out.push(`reception_frame_index ${m.reception_frame_index} >= ${n} frames`)
  if (m.pass1_frame_index > m.reception_frame_index) out.push('pass1_frame_index after reception_frame_index')
  const roster = m.frames[0].players.map((p) => p.pid)
  const set = new Set(roster)
  if (set.size !== roster.length) out.push('duplicate pid in frame 0')
  m.frames.forEach((f, i) => {
    if (f.players.length !== roster.length || f.players.some((p) => !set.has(p.pid))) out.push(`frame ${i}: players differ from frame 0`)
  })
  const team = new Map(m.frames[0].players.map((p) => [p.pid, p.team]))
  const need = (what: string, pid: string | null, t?: 'att' | 'def') => {
    if (pid === null) return
    if (!team.has(pid)) out.push(`${what} ${pid} not in the frames`)
    else if (t && team.get(pid) !== t) out.push(`${what} ${pid} is not on the ${t === 'att' ? 'attacking' : 'defending'} team`)
  }
  need('you_pid', m.you_pid, 'att')
  need('passer_pid', m.passer_pid, 'att')
  need('actual.target_pid', m.actual.target_pid, 'att')
  need('actual.intended_pid', m.actual.intended_pid, 'att')
  need('actual.taker.pid', m.actual.taker?.pid ?? null)
  if (m.you_pid === m.passer_pid) out.push('you_pid = passer_pid')
  const att = m.frames[0].players.filter((p) => p.team === 'att').length
  const def = m.frames[0].players.length - att
  if (att < 2 || def < 1) out.push(`too few players (${att} attacking, ${def} defending)`)
  if (m.actual.outcome === 'received' && m.actual.taker && team.get(m.actual.taker.pid) !== 'att')
    out.push('outcome "received" but the taker is an opponent')
  if (m.actual.outcome === 'intercepted' && m.actual.taker && team.get(m.actual.taker.pid) !== 'def')
    out.push('outcome "intercepted" but the taker is a teammate')
  return out
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] }

/** Validate one moment file's parsed JSON. */
export function validateMoment(v: unknown): Checked<MomentData> {
  const problems: string[] = []
  check(SCHEMA, v, '$', problems)
  if (problems.length) return { ok: false, problems }
  const sem = semanticProblems(v as MomentData)
  return sem.length ? { ok: false, problems: sem } : { ok: true, value: v as MomentData }
}

/** Validate one replay file (<id>.play.json) and that it belongs to moment `id`. */
export function validatePlay(v: unknown, id: string): Checked<Play> {
  const problems: string[] = []
  check({ $ref: '#/$defs/play' }, v, '$', problems)
  if (!problems.length && (v as Play).id !== id) problems.push(`play id ${(v as Play).id} != ${id}`)
  return problems.length ? { ok: false, problems } : { ok: true, value: v as Play }
}
