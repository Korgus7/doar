/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { DoarApi } from '../../shared/ipc'

declare global {
  interface Window {
    doar: DoarApi
  }
}

export {}
