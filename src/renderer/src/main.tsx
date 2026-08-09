import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { MicHost } from './MicHost'
import './styles.css'

/**
 * Two entry points into the same bundle.
 *
 * A recording started from the tray with no window open still needs a renderer,
 * because `getUserMedia` only exists in one. Main creates an invisible window
 * for that and marks it with `?michost`, and this is where the two paths
 * diverge: the mic host mounts the microphone and nothing else.
 *
 * Same bundle rather than a second HTML entry so the preload bridge, the
 * worklet URL and the build config stay singular — a second entry point is
 * exactly the kind of thing that works in dev and resolves to the wrong path
 * once rollup regroups the chunks.
 */
const isMicHost = new URLSearchParams(window.location.search).has('michost')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isMicHost ? <MicHost /> : <App />}</StrictMode>,
)
