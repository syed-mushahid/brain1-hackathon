import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// moments.json lives in the project root (written by extract_moments.py).
// Serve it in dev and copy it into the build, so there is a single source of truth.
const MOMENTS = fileURLToPath(new URL('./moments.json', import.meta.url))

function momentsJson(): Plugin {
  return {
    name: 'moments-json',
    configureServer(server) {
      server.middlewares.use('/moments.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(fs.readFileSync(MOMENTS))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'moments.json', source: fs.readFileSync(MOMENTS) })
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
