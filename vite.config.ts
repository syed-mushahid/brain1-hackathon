import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The moments are plain files in public/moments (<id>.json, <id>.play.json and the index.json
// manifest, written by extract_moments.py / npm run manifest). Vite serves public/ in dev and copies
// it into dist/ as-is, and the game reads the manifest at runtime: adding moments needs no rebuild.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: true, watch: { ignored: ['**/RawData/**', '**/cache/**', '**/previews/**'] } },
  // the lazy 3D chunk (three.js + R3F) is ~1 MB minified by design; the 2D entry stays small
  build: { chunkSizeWarningLimit: 1100 },
})
