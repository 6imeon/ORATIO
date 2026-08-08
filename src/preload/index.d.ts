import type { OratioApi } from './index'

declare global {
  interface Window {
    /** Injected by the preload script. The renderer's only privileged surface. */
    oratio: OratioApi
  }
}

export {}
