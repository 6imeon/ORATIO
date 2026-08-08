import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * `externalizeDeps` keeps node_modules out of the bundle.
 *
 * `include: ['electron']` is load-bearing: electron lives in devDependencies,
 * which is NOT externalized by default. Bundled, the built main process tries
 * to *launch* Electron rather than run inside it, and dies with "Electron
 * failed to install correctly".
 *
 * Native modules (better-sqlite3, sherpa-onnx-node) must stay external too —
 * bundling breaks their .node binding resolution at runtime.
 */
const externalizeDeps = { include: ['electron'] }

/**
 * Belt and braces: mark `electron` external at the rollup level too.
 * externalizeDeps alone does not reliably cover devDependencies, and a
 * bundled `electron` produces a main process that cannot start at all.
 */
const ELECTRON_EXTERNAL = [
  /^electron$/,
  /^electron\//,
  // Native addons must be required from node_modules at runtime. Bundled,
  // better-sqlite3 resolves its .node binary relative to the OUTPUT file and
  // fails with "Cannot find module out/build/Release/better_sqlite3.node".
  /^better-sqlite3$/,
  /^sherpa-onnx/,
  /^audiotee$/,
]

export default defineConfig({
  main: {
    build: {
      externalizeDeps,
      // CommonJS: `electron` is a CJS module, so an ESM main process cannot
      // named-import BrowserWindow et al. ("does not provide an export
      // named 'BrowserWindow'"). Native addons are CJS-only too.
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        external: ELECTRON_EXTERNAL,
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
  },

  preload: {
    build: {
      externalizeDeps,
      // Preload must be CJS too — it requires `electron`, and with
      // sandbox:false the preload context expects CommonJS.
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        external: ELECTRON_EXTERNAL,
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
  },

  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
  },
})
