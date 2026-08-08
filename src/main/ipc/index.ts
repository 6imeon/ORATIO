import { ipcMain, dialog, shell, systemPreferences } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { IPC, EVENTS, type PermissionState, type StartRecordingOptions } from '@shared/ipc'
import { MODELS } from '@shared/models'
import type { ModelId, Settings } from '@shared/types'
import type { MacAudioCapture } from '../audio/MacAudioCapture'
import type { RecordingController } from '../recording/RecordingController'
import type { TranscriptionQueue } from '../transcription/TranscriptionQueue'
import type { SearchIndex } from '../storage/searchIndex'
import type { ModelManager } from '../models/ModelManager'
import {
  listSessions,
  readTranscript,
  readMeta,
  readNotes,
  writeNotes,
  deleteSession,
  discardSessionAudio,
  sessionDir,
} from '../storage/vault'
import { loadSettings, saveSettings, setApiKey, hasApiKey } from '../storage/settings'

interface Deps {
  capture: MacAudioCapture
  recording: RecordingController
  queue: TranscriptionQueue
  searchIndex: SearchIndex
  models: ModelManager
  showMainWindow: () => void
  /**
   * Grant the microphone to a WebContents that opened mid-recording, if no
   * other window already holds it. Main owns this decision because only main
   * knows how many windows there are.
   */
  claimMic: (webContentsId: number) => boolean
}

/**
 * All main↔renderer handlers.
 *
 * The renderer has no Node access and no direct filesystem reach — every
 * privileged operation goes through a named channel declared in shared/ipc.ts.
 */
export function registerIpc(deps: Deps): void {
  // -- Recording -----------------------------------------------------------

  /**
   * Start is idempotent from the caller's point of view but not silently so:
   * a second start while recording is a bug in the caller, and returning the
   * running session rather than throwing would hide it. The tray and the
   * window can both reach this, so it has to be explicit about the collision.
   */
  ipcMain.handle(IPC.RECORDING_START, (_e, opts: StartRecordingOptions = {}) =>
    deps.recording.start(opts),
  )

  ipcMain.handle(IPC.RECORDING_STOP, () => deps.recording.stop())

  /**
   * Pull, for a window that opens mid-recording. State is normally pushed on
   * EVENTS.RECORDING_STATE at ~30 Hz, but a renderer that starts late has
   * missed every push so far and would otherwise show "not recording" until
   * the next frame.
   */
  ipcMain.handle(IPC.RECORDING_STATE, () => deps.recording.state())

  /**
   * Answers "should I open the mic?" for a window that appeared mid-recording.
   *
   * False means another window already has it, and this one must stay quiet —
   * two live streams would interleave into one WAV. True means it joins late,
   * which meta.json already expresses through `startOffsetMs`.
   */
  ipcMain.handle(IPC.RECORDING_CLAIM_MIC, (e) => {
    if (!deps.recording.isRecording()) return false
    return deps.claimMic(e.sender.id)
  })

  // -- Sessions ------------------------------------------------------------

  ipcMain.handle(IPC.SESSION_GET, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    return readMeta(sessionDir(settings.vaultPath, sessionId))
  })

  ipcMain.handle(IPC.SESSION_LIST, async () => {
    const settings = await loadSettings()
    return listSessions(settings.vaultPath)
  })

  ipcMain.handle(IPC.SESSION_TRANSCRIPT, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    return readTranscript(sessionDir(settings.vaultPath, sessionId))
  })

  ipcMain.handle(IPC.SESSION_NOTES_GET, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    return readNotes(sessionDir(settings.vaultPath, sessionId))
  })

  ipcMain.handle(IPC.SESSION_NOTES_SET, async (_e, sessionId: string, markdown: string) => {
    const settings = await loadSettings()
    await writeNotes(sessionDir(settings.vaultPath, sessionId), markdown)
  })

  ipcMain.handle(IPC.SESSION_DELETE, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    await deleteSession(sessionDir(settings.vaultPath, sessionId))
    deps.searchIndex.removeSession(sessionId)
  })

  ipcMain.handle(IPC.SESSION_REVEAL, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    shell.showItemInFolder(join(sessionDir(settings.vaultPath, sessionId), 'notes.md'))
  })

  ipcMain.handle(IPC.SESSION_SEARCH, (_e, query: string) => deps.searchIndex.search(query))

  /**
   * Discard a session's audio after the fact.
   *
   * Irreversible, and the renderer is expected to confirm before calling —
   * the transcript is not a substitute for the recording, since ASR is
   * imperfect and a garbled name is only recoverable from the audio.
   */
  ipcMain.handle(IPC.SESSION_DISCARD_AUDIO, async (_e, sessionId: string) => {
    const settings = await loadSettings()
    const dir = sessionDir(settings.vaultPath, sessionId)

    // Refuse while the session is still the only copy. Deleting audio for a
    // session that has not been transcribed destroys the meeting outright.
    if (!existsSync(join(dir, 'transcript.json'))) {
      throw new Error('Cannot discard audio before the session has been transcribed')
    }

    await discardSessionAudio(dir)
    log.info(`[ipc] audio discarded for ${sessionId}`)
  })

  /**
   * Local file URL for a session's audio track.
   *
   * This is what powers click-a-transcript-line-to-hear-it — the single most
   * requested feature missing from the commercial tools, and one they cannot
   * offer because they delete the audio. We keep it, so it costs us nothing.
   */
  ipcMain.handle(
    IPC.SESSION_AUDIO_URL,
    async (_e, sessionId: string, track: 'mic' | 'system') => {
      const settings = await loadSettings()
      const dir = sessionDir(settings.vaultPath, sessionId)
      const file = track === 'mic' ? 'mic.wav' : 'system.wav'
      const path = join(dir, file)

      // Null rather than a URL when the audio is gone — a session recorded
      // with "don't keep audio" has a transcript but no WAVs, and handing the
      // renderer a file:// URL to a deleted file produces a silent, broken
      // <audio> element instead of an explanation.
      if (!existsSync(path)) return null

      return `file://${path}`
    },
  )

  // -- Settings ------------------------------------------------------------

  ipcMain.handle(IPC.SETTINGS_GET, () => loadSettings())

  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<Settings>) => {
    const next = { ...(await loadSettings()), ...patch }
    await saveSettings(next)
    return next
  })

  ipcMain.handle(IPC.SETTINGS_PICK_VAULT, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose where Oratio stores your recordings',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    })
    if (res.canceled || !res.filePaths[0]) return null

    const next = { ...(await loadSettings()), vaultPath: res.filePaths[0] }
    await saveSettings(next)
    return next.vaultPath
  })

  // -- Models --------------------------------------------------------------

  ipcMain.handle(IPC.MODEL_LIST, () => Object.values(MODELS))

  ipcMain.handle(IPC.MODEL_STATES, () => deps.models.list())

  /**
   * Downloads report progress on an event channel rather than resolving with
   * it, so the renderer can show a live bar. The promise still settles on
   * completion or failure — a UI that only listened to events would have no
   * way to distinguish "finished" from "stalled".
   */
  ipcMain.handle(IPC.MODEL_DOWNLOAD, async (e, id: ModelId) => {
    await deps.models.download(id, (state) => {
      // The window can be closed mid-download — this is a menu-bar app and
      // that is normal, not an error. Sending to a destroyed WebContents
      // throws, which would fail the whole download for no reason.
      if (!e.sender.isDestroyed()) e.sender.send(EVENTS.MODEL_PROGRESS, state)
    })
  })

  ipcMain.handle(IPC.MODEL_CANCEL, (_e, id: ModelId) => deps.models.cancel(id))

  ipcMain.handle(IPC.MODEL_DELETE, (_e, id: ModelId) => deps.models.remove(id))

  // -- AI providers --------------------------------------------------------

  ipcMain.handle(IPC.AI_SET_KEY, async (_e, provider: 'anthropic' | 'openai', key: string) => {
    await setApiKey(provider, key)
  })

  ipcMain.handle(IPC.AI_PROVIDERS, async () => {
    const settings = await loadSettings()
    return Promise.all(
      settings.providers.map(async (p) => ({
        ...p,
        hasApiKey: p.id === 'ollama' ? undefined : await hasApiKey(p.id),
      })),
    )
  })

  // -- Permissions ---------------------------------------------------------

  ipcMain.handle(IPC.PERMISSION_CHECK, (): PermissionState => {
    return {
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      // macOS exposes no side-effect-free way to query system-audio TCC
      // state, so this stays 'unknown' until a capture has run and we can
      // infer it from whether the track was silent.
      systemAudio: 'unknown',
    }
  })

  ipcMain.handle(IPC.PERMISSION_REQUEST_MIC, async () => {
    return systemPreferences.askForMediaAccess('microphone')
  })

  log.info('[ipc] handlers registered')
}
