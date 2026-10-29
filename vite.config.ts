import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// moments.json and plays.json live in the project root (written by extract_moments.py).
// Serve them in dev and copy them into the build, so there is a single source of truth.
// plays.json (the rest of each play, for the replays) is only fetched when a replay is watched.
const DATA_FILES = ['moments.json', 'plays.json']

function momentsJson(): Plugin {
  return {
    name: 'moments-json',
    configureServer(server) {
      for (const name of DATA_FILES) {
        const file = fileURLToPath(new URL(`./${name}`, import.meta.url))
        server.middlewares.use(`/${name}`, (_req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(fs.readFileSync(file))
        })
      }
    },
    generateBundle() {
      for (const name of DATA_FILES)
        this.emitFile({ type: 'asset', fileName: name, source: fs.readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url))) })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), momentsJson()],
  server: { host: true, watch: { ignored: ['**/RawData/**', '**/cache/**', '**/previews/**'] } },
  // the lazy 3D chunk (three.js + R3F) is ~1 MB minified by design; the 2D entry stays small
  build: { chunkSizeWarningLimit: 1100 },
})
