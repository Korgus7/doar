import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Core beží v samostatnom utilityProcess (pošta, databáza, export).
          core: resolve(import.meta.dirname, 'src/core/index.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // Preload v sandboxe musí byť CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') }
    },
    plugins: [svelte()]
  }
})
