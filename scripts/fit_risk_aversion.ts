// npm run fit -- <k> [<k> ...]: runs game/fitRiskAversion.ts from node on the moments in public/moments
// (the game's spaceGain and runCone kept) and prints, for every k, its display scale (lo / hi) and how
// often the pros' passes come within 5 points of the best. Copy the chosen k, lo, hi into model.config.ts.
import fs from 'node:fs'
import { MODEL } from '../src/game/model.config'

// the fit loads moments the way the game does (fetch ./moments/...): serve them from public/
globalThis.fetch = (async (u: string | URL | Request) => {
  const body = fs.readFileSync(`public/${String(u).replace(/^\.\//, '')}`, 'utf8')
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const { fitRiskAversion } = await import('../src/game/fitRiskAversion')
const ks = process.argv.slice(2).map(Number).filter(Number.isFinite)
const rows = await fitRiskAversion(ks.length ? ks : [MODEL.value.k], [MODEL.best.spaceGain], [MODEL.best.runConeDeg])
console.table(rows)
