import { ipcMain, type MessagePortMain } from 'electron'
import log from 'electron-log/main'
import { AUDIO_PORT_CHANNEL, extractPcm, type AudioPortMessage } from '@shared/audioPort'
import type { MacAudioCapture } from './MacAudioCapture'

/**
 * Receives mic PCM from the renderer over a transferred MessagePort.
 *
 * Registered once at startup, not per recording. The renderer opens a fresh
 * port for each session and this replaces the previous one — a page reload
 * mid-recording is otherwise invisible here, and the old port would sit
 * around delivering nothing while the new one is ignored.
 */
export function registerMicPort(capture: MacAudioCapture): void {
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
        capture.pushMicPcm(pcm)
        return
      }

      handleControl(data as AudioPortMessage, capture)
    })

    port.start()
    log.info('[audio] mic port attached')
  })
}

function handleControl(msg: AudioPortMessage, capture: MacAudioCapture): void {
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
