import { ipcMain, type MessagePortMain } from 'electron'
import log from 'electron-log/main'
import { AUDIO_PORT_CHANNEL, extractPcm, type AudioPortMessage } from '@shared/audioPort'
import type { AudioCapture } from './AudioCapture'

/**
 * Receives mic PCM from the renderer over a transferred MessagePort.
 *
 * Registered once at startup, not per recording. The renderer opens a fresh
 * port for each session and this replaces the previous one — a page reload
 * mid-recording is otherwise invisible here, and the old port would sit
 * around delivering nothing while the new one is ignored.
 *
 * `isMuted` gates the mic here rather than in the renderer or the capture
 * implementation, for three separate reasons:
 *
 * - **The renderer cannot be trusted with it.** A muted mic that stops at the
 *   worklet would un-mute itself on a page reload, and a menu-bar app can be
 *   recording with no window at all.
 * - **It is not a platform concept.** Gating inside `MacAudioCapture` would
 *   have to be re-implemented, identically, in every future capture backend.
 * - **It must cut ASR too, not just the file.** `pushMicPcm` both writes the
 *   WAV and emits `pcm` for streaming transcription, so a gate downstream of
 *   it would leave Oratio transcribing words the user believes it did not
 *   hear. That is the failure this feature exists to prevent.
 */
export function registerMicPort(capture: AudioCapture, isMuted: () => boolean): void {
  let active: MessagePortMain | null = null

  ipcMain.on(AUDIO_PORT_CHANNEL, (e) => {
    const port = e.ports[0]
    if (!port) {
      log.warn('[audio] mic port message arrived with no port attached')
      return
    }

    // A reload leaves the old port orphaned rather than closed, so drop it
    // explicitly. Two live ports would interleave two mic streams into one
    // WAV, which is silently wrong rather than loudly broken.
    if (active) {
      log.info('[audio] replacing existing mic port')
      active.close()
    }
    active = port

    port.on('message', (msg) => {
      const data = msg.data as unknown

      const pcm = extractPcm(data)
      if (pcm) {
        /*
          Muted writes zeroes of the SAME LENGTH, never nothing.

          Dropping the buffer would shorten mic.wav while system.wav kept
          running, so every timestamp after the first mute would be wrong by
          the total muted duration — and the two-track speaker attribution
          that is the whole product depends on the tracks staying
          sample-aligned.

          `markDiscontinuity()` is likewise the wrong tool here, and it is the
          obvious-looking one: it announces a gap the merged timeline must
          then *close*. Nothing is missing from a muted stretch. The time
          passed, the other side kept talking, and the mic track has to
          account for exactly that many samples of the user saying nothing.
        */
        capture.pushMicPcm(isMuted() ? new Float32Array(pcm.length) : pcm)
        return
      }

      handleControl(data as AudioPortMessage, capture)
    })

    port.start()
    log.info('[audio] mic port attached')
  })
}

function handleControl(msg: AudioPortMessage, capture: AudioCapture): void {
  switch (msg?.type) {
    case 'hello':
      log.info('[audio] mic stream opened', { deviceRate: msg.deviceRate })
      break

    case 'rate-change':
      // Recorded rather than merely logged: it marks a discontinuity in the
      // mic track, and the few hundred ms lost to rebuilding the graph is a
      // real gap that the merged timeline has to account for.
      log.warn('[audio] mic device changed sample rate mid-session', msg)
      capture.noteMicDiscontinuity()
      break

    case 'end':
      log.info('[audio] mic stream ended')
      capture.noteMicEnded()
      break
  }
}
