import { useEffect } from 'react'
import { useMicCapture } from './hooks/useMicCapture'

/**
 * The microphone, with no user interface at all.
 *
 * Mounted in the invisible window main creates when a recording starts with
 * nothing open — the tray path, which for a menu-bar app is the normal one.
 * Before this existed those meetings captured system audio only: the mic track
 * came back empty and the user's own voice was simply missing from the
 * transcript, reported nowhere but the log.
 *
 * Deliberately not `App`. Rendering the full UI into a window nobody can see
 * would run the session list, the first-run check and the whole React tree for
 * no reason, and — worse — a hidden window sitting on the same IPC subscriptions
 * as a real one is how two windows end up disagreeing about which is in charge.
 * This mounts exactly one hook and renders nothing.
 */
export function MicHost(): React.JSX.Element | null {
  useEffect(() => {
    // Errors have nowhere to go on screen here, so they go to the main log via
    // the same channel every other renderer error uses. A denied mic prompt is
    // the realistic case, and it must not be silent: it is the difference
    // between a meeting with one voice and a meeting with two.
    document.title = 'Oratio microphone'
  }, [])

  useMicCapture((err) => {
    console.error('[michost] microphone failed', err)
  })

  return null
}
