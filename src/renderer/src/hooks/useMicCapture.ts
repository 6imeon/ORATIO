import { useEffect, useRef } from 'react'
import { startMicStream, type MicStreamHandle } from '../audio/micStream'

/**
 * Runs the microphone on main's instruction.
 *
 * Mounted once, for the lifetime of the window. Deliberately not tied to the
 * record button: main owns recording, because the tray can start a meeting
 * with no window open and closing the window must not end one. This hook only
 * answers the question main cannot answer itself — `getUserMedia` lives in the
 * renderer, and its permission prompt is bound to a WebContents.
 *
 * `onError` surfaces a denied mic prompt, which is a normal outcome rather
 * than a crash: the system track keeps recording and the meeting is still
 * captured, minus your own voice.
 */
export function useMicCapture(onError?: (err: Error) => void): void {
  const handle = useRef<MicStreamHandle | null>(null)
  /**
   * Guards against a start arriving while the previous stream is still
   * tearing down — two live streams would push interleaved PCM down one port
   * and produce a WAV that is silently wrong rather than loudly broken.
   */
  const busy = useRef(false)

  // Kept in a ref so the effect below never re-subscribes when the callback
  // identity changes, which would drop mic commands during a re-render.
  const errorRef = useRef(onError)
  errorRef.current = onError

  useEffect(() => {
    let cancelled = false

    async function start(): Promise<void> {
      if (busy.current || handle.current) return
      busy.current = true
      try {
        const h = await startMicStream({
          onError: (err) => errorRef.current?.(err),
        })
        // The window could have been torn down while the permission prompt
        // was up — leaving the stream running would keep the orange mic
        // indicator lit with nothing listening.
        if (cancelled) {
          await h.stop()
          return
        }
        handle.current = h
      } catch (err) {
        errorRef.current?.(err instanceof Error ? err : new Error(String(err)))
      } finally {
        busy.current = false
      }
    }

    async function stop(): Promise<void> {
      const h = handle.current
      handle.current = null
      if (!h) return
      try {
        await h.stop()
      } catch (err) {
        errorRef.current?.(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const offStart = window.oratio.on.micStart(() => void start())
    const offStop = window.oratio.on.micStop(() => void stop())

    // A window opened mid-recording missed the MIC_START it would have been
    // sent, so it asks. Main answers, rather than this window deciding for
    // itself: only one window may hold the mic, and only main knows whether
    // another already does.
    void window.oratio.recording.claimMic().then((granted) => {
      if (granted && !cancelled) void start()
    })

    return () => {
      cancelled = true
      offStart()
      offStop()
      void stop()
    }
  }, [])
}
