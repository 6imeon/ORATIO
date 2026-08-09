import { EventEmitter } from 'node:events'
import { join, basename } from 'node:path'
import { powerMonitor, powerSaveBlocker } from 'electron'
import log from 'electron-log/main'
import type { SessionMeta, RecordingState, TrackMeta, MutedRange } from '@shared/types'
import type { StartRecordingOptions, StartRecordingResult } from '@shared/ipc'
import { TARGET_SAMPLE_RATE, type AudioCapture, type CaptureResult } from '../audio/AudioCapture'
import { createSessionDir, writeMeta, FILES } from '../storage/vault'
import { loadSettings } from '../storage/settings'
import { writeCaptureHealth } from '../storage/captureHealth'

/**
 * Owns a recording from start to meta.json.
 *
 * This is the piece that makes the app work: capture, storage and
 * transcription all existed before it, and nothing joined them.
 *
 * It lives in main rather than the renderer for two reasons that are really
 * one — the window is optional. Oratio is a menu-bar app (LSUIElement), so the
 * tray must be able to start a meeting with no window open, and closing the
 * window mid-meeting must not end it. The renderer therefore does not *drive*
 * recording; it is asked to open its microphone and reports back. The mic has
 * to be there because `getUserMedia` is the only mic API Electron exposes
 * without a second native dependency, and its permission prompt is bound to a
 * WebContents.
 */

/**
 * How often `RECORDING_STATE` is pushed to the renderer.
 *
 * UI.md §0: level meters read as smooth from about 30 Hz, and every event is
 * two floats rather than a buffer — the audio itself never crosses this
 * channel. Peaks are accumulated between ticks instead of sampled, so a
 * transient is never missed by landing between them.
 */
const STATE_PUSH_INTERVAL_MS = 33

export interface RecordingControllerDeps {
  capture: AudioCapture
  /** Called with the finished session directory, to enqueue transcription. */
  onSessionComplete: (dir: string) => void
  /** Push a state frame to every live renderer. */
  broadcastState: (state: RecordingState) => void
  /** Ask the renderer to open/close its mic. Returns false if no window exists. */
  requestMic: (start: boolean) => boolean
  /**
   * Whether a usable ASR model is installed.
   *
   * A precondition of recording rather than of transcription, even though it
   * is transcription that needs it. Without this check a new user — or anyone
   * who deleted their model — records a full meeting successfully and is told
   * only afterwards that nothing can be done with it. The audio is not lost,
   * but the failure arrives an hour late and at a moment when it cannot be
   * acted on. Refusing at the start is the only point where the answer is
   * still useful.
   */
  hasModel: () => Promise<boolean>
  /**
   * Publish the current app-exclusion list, read from settings at start().
   *
   * The controller is the only place settings are loaded on the recording path,
   * so it is the only place that knows the list is stale. Kept as a callback
   * rather than having the capture read settings itself, so the platform
   * implementation stays free of storage concerns.
   */
  onExcludedBundleIds?: (bundleIds: string[]) => void
}

export class RecordingController extends EventEmitter {
  #deps: RecordingControllerDeps

  #sessionId: string | null = null
  #dir: string | null = null
  #startedAt: Date | null = null
  #title = ''
  #discardAudio = false

  /**
   * Whether the microphone is muted right now.
   *
   * Owned here rather than in the renderer because the tray must be able to
   * mute with no window open — the same reason recording itself lives in main.
   * A renderer-owned flag would also be lost on reload, silently un-muting
   * someone mid-meeting.
   */
  #muted = false

  /**
   * Muted stretches, as [startMs, endMs] from the session start, plus the
   * open one if we are muted right now.
   *
   * Kept so the transcript can say "you were muted here" rather than showing
   * an unexplained silence, which otherwise looks like a capture failure —
   * the one thing this app must never be ambiguous about.
   */
  #mutedRanges: MutedRange[] = []
  #mutedSince: number | null = null

  /**
   * Held while recording so macOS does not suspend the app. Explicitly
   * `prevent-app-suspension`, never `prevent-display-sleep`: we have no reason
   * to keep the user's screen awake through a meeting, and doing so would be
   * both rude and a battery cost. The display may sleep; the process may not.
   */
  #blockerId: number | null = null

  #ticker: ReturnType<typeof setInterval> | null = null
  /** Peak since the last state push, per track. Reset on each push. */
  #micPeak = 0
  #systemPeak = 0

  /** Set when a track reports digital silence, so stop() can say so. */
  #deadTracks = new Set<'mic' | 'system'>()

  #onLevel = (track: 'mic' | 'system', peak: number): void => {
    // Max rather than last: a state push every 33 ms would otherwise sample
    // roughly one buffer in three and under-report every transient.
    if (track === 'mic') this.#micPeak = Math.max(this.#micPeak, peak)
    else this.#systemPeak = Math.max(this.#systemPeak, peak)
  }

  #onDead = (track: 'mic' | 'system'): void => {
    /*
      A muted microphone is silent on purpose.

      The liveness check reads a cumulative peak, so muting from the start of a
      recording leaves it at exactly zero and looks identical to the
      silent-success failure it exists to catch. Reporting a dead mic to
      someone who muted it themselves would teach them to distrust a warning
      that is right every other time.

      Filtered here rather than in the capture: mute is not a platform concept,
      and this is the only object that knows both facts.
    */
    if (track === 'mic' && (this.#muted || this.#mutedRanges.length > 0)) {
      log.info('[recording] ignoring dead-mic report — the microphone was muted')
      return
    }

    this.#deadTracks.add(track)
    log.warn(`[recording] ${track} track is silent — capture is probably not permitted`)
    this.emit('dead', track)
  }

  #onCaptureError = (err: Error): void => {
    log.error('[recording] capture error', err)
    this.emit('error', err)
  }

  #onSuspend = (): void => {
    if (!this.#sessionId) return
    // Recorded at the instant it happens because it cannot be recovered
    // afterwards: the event loop is about to freeze, and no sample count
    // taken later can reveal where the hole was.
    this.#deps.capture.noteSuspend()
  }

  #onResume = (): void => {
    if (!this.#sessionId) return
    log.info('[recording] resumed from suspend')
    this.emit('resumed')
  }

  constructor(deps: RecordingControllerDeps) {
    super()
    this.#deps = deps

    powerMonitor.on('suspend', this.#onSuspend)
    powerMonitor.on('resume', this.#onResume)
  }

  isRecording(): boolean {
    return this.#sessionId !== null
  }

  isMuted(): boolean {
    return this.#muted
  }

  /**
   * Mute or unmute the microphone.
   *
   * Returns the resulting state so callers do not have to guess, and pushes
   * immediately rather than waiting for the next 33 ms tick: mute is a direct
   * response to a deliberate action, and the UI confirming it a frame late
   * reads as the click not registering.
   *
   * Muting outside a recording is meaningless, not an error — the tray item
   * and the shortcut both exist when nothing is being recorded.
   */
  setMuted(muted: boolean): boolean {
    if (!this.isRecording() || muted === this.#muted) return this.#muted

    this.#muted = muted

    if (muted) {
      this.#mutedSince = this.#elapsedMs()
    } else if (this.#mutedSince !== null) {
      this.#mutedRanges.push({ startMs: this.#mutedSince, endMs: this.#elapsedMs() })
      this.#mutedSince = null
    }

    log.info('[recording] microphone', muted ? 'muted' : 'unmuted')
    this.#push()
    this.emit('muted', muted)
    return this.#muted
  }

  state(): RecordingState {
    return {
      active: this.isRecording(),
      sessionId: this.#sessionId,
      startedAt: this.#startedAt?.toISOString() ?? null,
      elapsedSeconds: this.#elapsedSeconds(),
      micLevel: this.#micPeak,
      systemLevel: this.#systemPeak,
      muted: this.#muted,
    }
  }

  /**
   * Milliseconds since the recording started, for mute range boundaries.
   *
   * Wall clock, matching `#elapsedSeconds` and the UI timer rather than the
   * sample count. The two disagree only across a suspend, and a suspend
   * already marks a discontinuity that invalidates the timeline either side —
   * so a mute range that spans one is approximate no matter which clock is
   * used, and this is the clock the user was watching when they pressed it.
   */
  #elapsedMs(): number {
    if (!this.#startedAt) return 0
    return Date.now() - this.#startedAt.getTime()
  }

  /**
   * Elapsed time for the UI only.
   *
   * Wall clock is correct *here* and wrong for the recording: this is what a
   * person watching the timer expects to see, including time lost to a
   * suspend. The duration written to meta.json comes from the sample count
   * instead, which is the only figure that matches the audio.
   */
  #elapsedSeconds(): number {
    if (!this.#startedAt) return 0
    return Math.floor((Date.now() - this.#startedAt.getTime()) / 1000)
  }

  async start(opts: StartRecordingOptions = {}): Promise<StartRecordingResult> {
    if (this.#sessionId) throw new Error('Already recording')

    // Checked here, before a directory exists, so a refusal leaves nothing
    // behind. The message is what the user sees on the record button.
    if (!(await this.#deps.hasModel())) {
      throw new Error(
        'No speech model is installed yet. Open Settings to download one — it only has to happen once.',
      )
    }

    const settings = await loadSettings()

    // Before capture.start(), which resolves these to PIDs as it spawns.
    this.#deps.onExcludedBundleIds?.(settings.excludedBundleIds)

    const startedAt = new Date()
    const dir = await createSessionDir(settings.vaultPath, startedAt)

    this.#dir = dir
    this.#sessionId = basename(dir)
    this.#startedAt = startedAt
    this.#title = opts.title?.trim() || defaultTitle(startedAt)
    this.#discardAudio = opts.discardAudio ?? settings.discardAudioByDefault
    this.#deadTracks.clear()
    this.#micPeak = 0
    this.#systemPeak = 0

    this.#deps.capture.on('level', this.#onLevel)
    this.#deps.capture.on('dead', this.#onDead)
    this.#deps.capture.on('error', this.#onCaptureError)

    try {
      await this.#deps.capture.start({
        micPath: join(dir, FILES.mic),
        systemPath: join(dir, FILES.system),
      })
    } catch (err) {
      // Leave nothing half-started: the session dir has no meta.json yet, so
      // it is invisible to listSessions and to the queue, but the listeners
      // and the id must not survive a failed start.
      this.#detach()
      this.#reset()
      throw err
    }

    // Only after capture is actually running — a blocker held by a session
    // that failed to start would never be released.
    this.#blockerId = powerSaveBlocker.start('prevent-app-suspension')

    // The renderer opens the mic and pushes PCM over the port registered at
    // startup. No window means no mic: system audio still records, and stop()
    // reports the mic track as empty rather than pretending otherwise.
    if (!this.#deps.requestMic(true)) {
      log.warn('[recording] no window available — recording system audio only')
    }

    this.#ticker = setInterval(() => this.#push(), STATE_PUSH_INTERVAL_MS)
    this.#push()

    log.info('[recording] started', {
      sessionId: this.#sessionId,
      discardAudio: this.#discardAudio,
    })

    this.emit('started', this.state())
    return { sessionId: this.#sessionId, startedAt: startedAt.toISOString() }
  }

  /**
   * Stop, finalize both WAVs, and write meta.json.
   *
   * Writing meta.json is the last step and the only one that matters to
   * anything else: its presence is what marks the session complete and what
   * makes it visible to the queue. The filesystem is the queue, so a crash
   * before this point leaves a directory the next launch simply ignores —
   * there is no half-enqueued state to repair.
   */
  async stop(): Promise<SessionMeta | null> {
    if (!this.#sessionId || !this.#dir || !this.#startedAt) return null

    const dir = this.#dir
    const sessionId = this.#sessionId
    const startedAt = this.#startedAt

    // Ask the renderer to close the mic and flush the worklet's tail before
    // the writers close, so the last words of a meeting are not the ones lost.
    this.#deps.requestMic(false)
    await this.#waitForMicDrain()

    if (this.#ticker) {
      clearInterval(this.#ticker)
      this.#ticker = null
    }

    let result: CaptureResult
    try {
      result = await this.#deps.capture.stop()
    } finally {
      this.#detach()
      if (this.#blockerId !== null) {
        powerSaveBlocker.stop(this.#blockerId)
        this.#blockerId = null
      }
    }

    // Stopping while muted leaves a range still open; close it at the end of
    // the recording so the last stretch is not lost from meta.json.
    const mutedRanges = [...this.#mutedRanges]
    if (this.#mutedSince !== null) {
      mutedRanges.push({ startMs: this.#mutedSince, endMs: this.#elapsedMs() })
    }

    const meta = buildMeta({
      id: sessionId,
      title: this.#title,
      startedAt,
      endedAt: new Date(),
      result,
      discardAudio: this.#discardAudio,
      mutedRanges,
    })

    await writeMeta(dir, meta)

    /**
     * The only moment this evidence exists.
     *
     * macOS cannot be asked whether system-audio capture is permitted, so the
     * Settings panel infers it from whether a completed track carried any
     * signal at all. That is knowable here and nowhere else — `#reset()` below
     * clears the peaks, and the next launch has no recording to look at. Not
     * awaited into the critical path: it is diagnostic, and a failure to
     * record it must not affect the meeting that just saved successfully.
     */
    void writeCaptureHealth({
      observedAt: new Date().toISOString(),
      micPeak: result.mic.peak,
      systemPeak: result.system.peak,
    })

    log.info('[recording] stopped', {
      sessionId,
      durationSeconds: meta.durationSeconds,
      tracks: meta.tracks.map((t) => t.file),
      micPeak: result.mic.peak,
      systemPeak: result.system.peak,
      silent: [...this.#deadTracks],
    })

    this.#reset()
    this.#push()

    // Enqueue only once meta.json is on disk — enqueueing earlier would race
    // the queue against the file it reads first.
    this.#deps.onSessionComplete(dir)
    this.emit('stopped', meta)

    return meta
  }

  /**
   * Give the renderer a moment to flush.
   *
   * `MicRecorder.stop()` posts `stop` to the worklet, waits for the tail, then
   * closes the port — all in the renderer, asynchronously, with no reply
   * channel back to here. This is a bounded wait rather than a handshake
   * because the failure it guards against is losing ~40 ms of audio, and a
   * handshake that can hang would be a worse trade: a wedged renderer must
   * never be able to prevent a meeting from being saved.
   */
  async #waitForMicDrain(): Promise<void> {
    await new Promise((r) => setTimeout(r, MIC_DRAIN_MS))
  }

  #push(): void {
    this.#deps.broadcastState(this.state())
    this.#micPeak = 0
    this.#systemPeak = 0
  }

  #detach(): void {
    this.#deps.capture.off('level', this.#onLevel)
    this.#deps.capture.off('dead', this.#onDead)
    this.#deps.capture.off('error', this.#onCaptureError)
  }

  #reset(): void {
    this.#sessionId = null
    this.#dir = null
    this.#startedAt = null
    this.#micPeak = 0
    this.#systemPeak = 0
    // Mute must never outlive the recording it was set on. Leaving it true
    // would silently record the *next* meeting with no microphone, which is
    // the single worst bug this feature could have.
    this.#muted = false
    this.#mutedSince = null
    this.#mutedRanges = []
  }

  /**
   * Stop cleanly on quit.
   *
   * Without this, quitting mid-meeting leaves a directory with two WAVs and no
   * meta.json — which the queue is right to ignore, so the recording would be
   * silently orphaned. `before-quit` gives us the chance to write it.
   */
  async shutdown(): Promise<void> {
    powerMonitor.off('suspend', this.#onSuspend)
    powerMonitor.off('resume', this.#onResume)
    if (this.isRecording()) {
      try {
        await this.stop()
      } catch (err) {
        log.error('[recording] failed to finalize on quit', err)
      }
    }
  }
}

/**
 * How long to wait for the renderer to flush its worklet after being asked to
 * stop. `MicRecorder.stop()` itself waits 60 ms for the tail; this allows for
 * that plus the IPC hop and a scheduling delay on a busy machine.
 */
const MIC_DRAIN_MS = 250

function defaultTitle(date: Date): string {
  // A real title comes from the user or, later, from summarisation. Until
  // then the date is more useful than "Untitled" and sorts sensibly in Finder.
  return date.toLocaleString(undefined, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Build meta.json from what the tracks actually produced.
 *
 * Two things here are load-bearing:
 *
 * **Duration comes from the sample count**, never from the wall clock. An OS
 * suspend freezes the event loop, so a meeting that lost ninety seconds to
 * sleep has a wall-clock duration ninety seconds longer than its audio. Every
 * transcript timestamp is derived from sample positions, so a wall-clock
 * duration would put the end of the file past the end of the meeting.
 *
 * **`startOffsetMs` is measured between the two first buffers.** The mic and
 * the system tap never begin on the same instant — different subsystems,
 * different startup costs — and the merged transcript drifts by exactly that
 * difference if it is assumed to be zero. The earlier track anchors the
 * session clock at 0 and the later one carries the gap.
 */
export function buildMeta(opts: {
  id: string
  title: string
  startedAt: Date
  endedAt: Date
  result: CaptureResult
  discardAudio: boolean
  mutedRanges?: MutedRange[]
}): SessionMeta {
  const { mic, system } = opts.result

  // Only tracks that captured something. An empty WAV would otherwise be
  // handed to VAD, which is a waste at best and a hallucination source at
  // worst — and a session recorded with no window has no mic track at all.
  const present = [
    { track: mic, file: FILES.mic, speaker: 'me' as const },
    { track: system, file: FILES.system, speaker: 'them' as const },
  ].filter((t) => t.track.samples > 0)

  const firsts = present
    .map((t) => t.track.firstBufferAt)
    .filter((t): t is number => t !== null)
  const anchor = firsts.length > 0 ? Math.min(...firsts) : opts.startedAt.getTime()

  const tracks: TrackMeta[] = present.map((t) => ({
    file: t.file,
    speaker: t.speaker,
    startOffsetMs: Math.max(0, Math.round((t.track.firstBufferAt ?? anchor) - anchor)),
  }))

  const durationSeconds = Math.round(
    Math.max(mic.samples, system.samples) / TARGET_SAMPLE_RATE,
  )

  return {
    id: opts.id,
    title: opts.title,
    startedAt: opts.startedAt.toISOString(),
    endedAt: opts.endedAt.toISOString(),
    durationSeconds,
    tracks,
    ...(opts.discardAudio ? { discardAudio: true } : {}),
    // Omitted entirely when nothing was muted, so the overwhelmingly common
    // meta.json is unchanged and older files stay valid without migration.
    ...(opts.mutedRanges?.length ? { mutedRanges: opts.mutedRanges } : {}),
  }
}
