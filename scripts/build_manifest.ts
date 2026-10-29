// Writes the moments manifest, <dir>/index.json, from the moment files in <dir> (default
// public/moments). The game reads it at runtime to find the moments, so adding <id>.json (+
// <id>.play.json) files and re-running this is all it takes - no rebuild.
//   npm run manifest [-- <dir>]
// Every file is validated against the data contract; invalid ones are left out with a warning.
import fs from 'node:fs'
import path from 'node:path'
import { validateMoment, validatePlay } from '../src/data/validate'
import type { Manifest, ManifestEntry } from '../src/data/manifest'

const dir = path.resolve(process.argv[2] ?? 'public/moments')
const entries: ManifestEntry[] = []
let skipped = 0
for (const name of fs.readdirSync(dir).sort()) {
  if (!name.endsWith('.json') || name === 'index.json' || name.endsWith('.play.json')) continue
  const file = path.join(dir, name)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.warn(`skipped ${name}: not valid JSON (${e instanceof Error ? e.message : e})`)
    skipped++
    continue
  }
  const v = validateMoment(raw)
  if (!v.ok) {
    console.warn(`skipped ${name}: ${v.problems.slice(0, 3).join('; ')}`)
    skipped++
    continue
  }
  const m = v.value
  if (name !== `${m.id}.json`) {
    console.warn(`skipped ${name}: file name must be ${m.id}.json`)
    skipped++
    continue
  }
  const playFile = path.join(dir, `${m.id}.play.json`)
  let play = false
  if (fs.existsSync(playFile)) {
    const p = validatePlay(JSON.parse(fs.readFileSync(playFile, 'utf8')), m.id)
    if (p.ok) play = true
    else console.warn(`${m.id}.play.json ignored: ${p.problems.slice(0, 3).join('; ')}`)
  }
  entries.push({ id: m.id, match: m.match_id, minute: m.context.minute, size: fs.statSync(file).size, play })
}
const manifest: Manifest = { schema_version: 1, count: entries.length, moments: entries }
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 1) + '\n')
console.log(`${path.relative(process.cwd(), path.join(dir, 'index.json'))}: ${entries.length} moments${skipped ? `, ${skipped} skipped` : ''}`)
