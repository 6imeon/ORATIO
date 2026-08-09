import { execFile, spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import log from 'electron-log/main'

const run = promisify(execFile)

/**
 * Notice that a meeting started.
 *
 * `IsRunningInput` on a Core Audio process object answers "is this app using
 * the microphone right now", which is the distinction that matters: "Zoom is
 * open" is not "you are in a call". It also covers Meet and Slack huddles for
 * free, because it does not care which app it is — only that something with a
 * recognisable identity started listening.
 *
 * SUGGEST, NEVER AUTO-START. Nothing here begins a recording. The asymmetry is
 * the whole argument: a missed prompt costs one click, and an unwanted
 * auto-record puts a private conversation on disk. No detection is reliable
 * enough to be trusted unsupervised, and this one demonstrably is not — see
 * the CoreSpeech note below.
 *
 * Deliberately NOT window titles and NOT Accessibility. `kCGWindowName` has
 * been gated behind Screen Recording since 10.15, Sequoia re-prompts for that
 * grant periodically, and it is why MacWhisper's meeting detection is absent
 * from its App Store build. Reading it would re-introduce exactly the
 * permission we avoided by choosing AudioTee over `desktopCapturer`.
 *
 * Enumeration itself needs no TCC permission and raises no prompt — verified on
 * this machine, and re-verified after adding the flags: 24 process objects with
 * bundle IDs and live input/output state, no dialog. Only creating a *tap*
 * needs the grant.
 */

/** One app currently holding the microphone open. */
export interface MicUser {
  pid: number
  /** Empty for a plain executable — `afplay` has no bundle ID while audible. */
  bundleId: string
  /** Bundle ID, or the executable name when there is no bundle. */
  name: string
}

interface DetectorDeps {
  /** True while Oratio is recording — suppresses every suggestion. */
  isRecording: () => boolean
  /** False turns detection off entirely, including the probe process. */
  enabled: () => boolean
  /** A meeting app just started using the microphone. */
  onMeetingStarted: (app: MicUser) => void
  /** Every recognised app stopped — ends the dismissal for that call. */
  onMeetingEnded: () => void
}

/**
 * Apps whose microphone use means "a call is happening".
 *
 * Matched as prefixes so helper processes come along without being enumerated:
 * Chrome's audio arrives on `com.google.Chrome.helper`, and Teams ships under
 * two entirely different bundle IDs depending on which generation is installed.
 *
 * Browsers are here because Meet, Whereby and Teams-on-web have no app of their
 * own. It costs a false positive on a browser tab playing a video *with the
 * microphone open*, which is a much narrower case than it first sounds —
 * playback alone sets IsRunningOutput, not IsRunningInput.
 */
const MEETING_APPS: readonly string[] = [
  'us.zoom.xos',
  'com.microsoft.teams', // covers com.microsoft.teams2 by prefix
  'com.tinyspeck.slackmacgap',
  'com.hnc.Discord',
  'com.webex',
  'Cisco-Systems.Spark',
  'com.google.Chrome',
  'com.apple.Safari',
  'org.mozilla.firefox',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'company.thebrowser.Browser', // Arc
  'com.apple.FaceTime',
  'com.skype.skype',
  'com.readdle.spark', // Spark video
]

/**
 * Zoom's in-call helper.
 *
 * The one high-confidence signal available: `CptHost` exists only during a
 * call, where the main Zoom process is running whenever the app is open. Used
 * to label the suggestion, not to gate it — Zoom's audio does not necessarily
 * come from this process.
 */
const ZOOM_CALL_HELPER = 'CptHost'

/**
 * Apple's speech agent, which must never trigger a suggestion.
 *
 * `com.apple.CoreSpeech` holds the microphone in brief bursts on an otherwise
 * idle machine — "Hey Siri" waking and going back to sleep. Observed reading
 * IsRunningInput=1 in isolated samples with nothing running, then clearing on
 * its own. It is a system agent, not an app, so it would never match
 * MEETING_APPS; this list exists to document the observation rather than to do
 * work, because a future loosening of the matching rule would otherwise
 * resurrect it as a phantom meeting on every idle machine.
 */
const NEVER_SUGGEST: readonly string[] = [
  'com.apple.CoreSpeech',
  'com.apple.assistantd',
  'com.apple.SiriNCService',
  'com.apple.controlcenter',
  'com.apple.avconferenced',
  'com.apple.accessibility.heard',
]

/**
 * How long an app must hold the microphone before it counts as a meeting.
 *
 * Two consecutive scans, so roughly 1–2 s. A single scan is not enough:
 * momentary microphone acquisition is normal — an app probing the device, a
 * notification sound's echo-cancellation setup — and a suggestion that appears
 * and vanishes is worse than none, because the user learns to ignore the tray.
 */
const CONFIRM_SCANS = 2

/**
 * How long to wait before restarting a probe that died.
 *
 * Backs off so a probe that cannot run at all — wrong architecture, missing
 * from the bundle — costs a line in the log every few seconds rather than a
 * spawn loop that pins a core.
 */
const RESTART_DELAY_MS = 5_000
const RESTART_DELAY_MAX_MS = 60_000

/** The watch process: no stdin (nothing to say to it), both outputs piped. */
type Probe = ChildProcessByStdio<null, Readable, Readable>

/** One line of watch output: pid, input flag, output flag, bundle ID. */
function parseLine(line: string): { pid: number; input: boolean; bundleId: string } | null {
  const [pidRaw, inputRaw, , bundleRaw] = line.split('\t')
  const pid = Number.parseInt(pidRaw ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return { pid, input: inputRaw === '1', bundleId: (bundleRaw ?? '').trim() }
}

/**
 * Which meeting app this bundle ID belongs to, or null.
 *
 * Returns the matched *prefix* rather than a boolean, and that is what
 * identifies the app everywhere below. Keying on the raw bundle ID instead is
 * wrong, and wrong in a way that only shows up on the apps that matter most: a
 * Chrome call arrives on `com.google.Chrome` AND two `com.google.Chrome.helper`
 * objects, which are three different strings for one meeting and would fire
 * three suggestions. Collapsing to the prefix makes it one.
 */
function meetingApp(bundleId: string): string | null {
  if (!bundleId) return null
  if (NEVER_SUGGEST.some((id) => bundleId === id)) return null
  return MEETING_APPS.find((id) => bundleId === id || bundleId.startsWith(`${id}.`)) ?? null
}

export class MeetingDetector {
  readonly #deps: DetectorDeps
  #probe: Probe | null = null
  #restart: NodeJS.Timeout | null = null
  #restartDelay = RESTART_DELAY_MS
  #stopped = false

  /** Partial line left over from the last chunk — a scan can span reads. */
  #buffer = ''
  /** Rows accumulated since the last scan boundary. */
  #scan: { pid: number; input: boolean; bundleId: string }[] = []

  /** Consecutive scans each bundle ID has held the microphone. */
  #streak = new Map<string, number>()
  /** Bundle ID we have already suggested or been dismissed for, this call. */
  #active: string | null = null
  #dismissed = false

  constructor(deps: DetectorDeps) {
    this.#deps = deps
  }

  start(): void {
    this.#stopped = false
    if (!this.#deps.enabled()) return
    this.#spawn()
  }

  stop(): void {
    this.#stopped = true
    if (this.#restart) {
      clearTimeout(this.#restart)
      this.#restart = null
    }
    this.#probe?.kill()
    this.#probe = null
    this.#reset()
  }

  /**
   * Re-read the enabled setting.
   *
   * Turning detection off kills the probe rather than merely ignoring it: a
   * user who switches this off should be able to see in Activity Monitor that
   * nothing is watching the microphone, which is a reasonable thing to want
   * from a local-first recorder.
   */
  refresh(): void {
    if (this.#deps.enabled()) {
      if (!this.#probe && !this.#restart) this.start()
    } else {
      this.stop()
      this.#stopped = false
    }
  }

  /** The user dismissed the suggestion — stay silent for the rest of this call. */
  dismiss(): void {
    this.#dismissed = true
  }

  #spawn(): void {
    /*
     * Resolved from `app.getAppPath()`, never from `__dirname`: rollup owns
     * `out/main/` and moves modules into `chunks/` when a second entry point
     * imports them, which silently shifts every relative walk by a level
     * (CLAUDE.md build rule 5).
     */
    const appPath = app.getAppPath()
    const binary = appPath.endsWith('.asar')
      ? join(`${appPath}.unpacked`, 'resources', 'audio-processes')
      : join(appPath, 'resources', 'audio-processes')

    let probe: Probe
    try {
      probe = spawn(binary, ['--watch'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      log.warn('[detect] could not start the audio probe', err)
      this.#scheduleRestart()
      return
    }
    this.#probe = probe

    probe.stdout.setEncoding('utf8')
    probe.stdout.on('data', (chunk: string) => this.#consume(chunk))
    probe.stderr.setEncoding('utf8')
    probe.stderr.on('data', (chunk: string) => log.warn('[detect] probe stderr', chunk.trim()))

    // An unhandled 'error' event on a ChildProcess is thrown by Node and would
    // take the main process down with it — the same trap that crashed the
    // exclusion retry in phase 11.
    probe.on('error', (err) => {
      log.warn('[detect] audio probe failed', err)
    })

    probe.on('exit', (code, signal) => {
      if (this.#probe === probe) this.#probe = null
      if (this.#stopped) return
      log.warn('[detect] audio probe exited', { code, signal })
      this.#scheduleRestart()
    })

    // A successful spawn resets the backoff, so an occasional crash recovers
    // promptly while a permanently broken binary still backs off.
    this.#restartDelay = RESTART_DELAY_MS
  }

  #scheduleRestart(): void {
    if (this.#stopped || this.#restart) return
    const delay = this.#restartDelay
    this.#restartDelay = Math.min(this.#restartDelay * 2, RESTART_DELAY_MAX_MS)
    this.#restart = setTimeout(() => {
      this.#restart = null
      if (!this.#stopped && this.#deps.enabled()) this.#spawn()
    }, delay)
    this.#restart.unref?.()
  }

  /**
   * Feed raw probe output in.
   *
   * A blank line ends a scan. Splitting on it rather than counting rows is what
   * lets "nothing is using the microphone" be distinguishable from "the probe
   * stopped talking" — the first is an empty scan, the second is no scan.
   */
  #consume(chunk: string): void {
    this.#buffer += chunk
    const lines = this.#buffer.split('\n')
    // The last element is whatever came after the final newline: either an
    // empty string, or a partial row to carry into the next chunk.
    this.#buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line === '') {
        this.#evaluate(this.#scan)
        this.#scan = []
        continue
      }
      const row = parseLine(line)
      if (row) this.#scan.push(row)
    }
  }

  #evaluate(scan: { pid: number; input: boolean; bundleId: string }[]): void {
    /*
     * Keyed by the matched app rather than the raw bundle ID, because one app
     * is several objects with several *different* IDs: a Chrome call listens on
     * `com.google.Chrome` and two `com.google.Chrome.helper` objects at once.
     * Deduplicating by bundle ID leaves those as separate meetings — verified,
     * it produced two suggestions for one call.
     */
    const listening: { pid: number; app: string }[] = []
    for (const row of scan) {
      if (!row.input) continue
      const app = meetingApp(row.bundleId)
      if (app) listening.push({ pid: row.pid, app })
    }

    const apps = new Set(listening.map((row) => row.app))

    // Streaks are kept per app rather than per PID: an app can hand the
    // microphone between helper processes mid-call, which would restart a
    // per-PID streak and delay or lose the suggestion.
    for (const app of this.#streak.keys()) {
      if (!apps.has(app)) this.#streak.delete(app)
    }

    if (apps.size === 0) {
      // Everything stopped: this call is over, so a future one may suggest
      // again even if this one was dismissed.
      if (this.#active !== null) {
        this.#active = null
        this.#dismissed = false
        this.#deps.onMeetingEnded()
      }
      return
    }

    for (const app of apps) {
      const streak = (this.#streak.get(app) ?? 0) + 1
      this.#streak.set(app, streak)

      if (streak < CONFIRM_SCANS) continue
      if (this.#active === app) continue

      this.#active = app
      if (this.#dismissed) continue
      // Suppressed while recording rather than not detected, so `#active` is
      // still tracked and the call's end is still noticed.
      if (this.#deps.isRecording()) continue

      const row = listening.find((r) => r.app === app)
      if (!row) continue
      void this.#describe(row.pid, app).then((name) => {
        this.#deps.onMeetingStarted({ pid: row.pid, bundleId: app, name })
      })
    }
  }

  /**
   * A human-readable name for the app holding the microphone.
   *
   * Falls back to the executable name because a bundle ID is not guaranteed:
   * plain executables have none. Zoom is special-cased on its in-call helper,
   * which is the only unambiguous "you are in a call" signal macOS offers.
   */
  async #describe(pid: number, bundleId: string): Promise<string> {
    if (bundleId.startsWith('us.zoom')) {
      try {
        await run('pgrep', ['-x', ZOOM_CALL_HELPER], { timeout: 1_000 })
        return 'Zoom'
      } catch {
        // No CptHost: Zoom has the microphone but is not obviously in a call.
      }
    }
    if (bundleId) return bundleId
    try {
      const { stdout } = await run('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 1_000 })
      const path = stdout.trim()
      return path.split('/').pop() || `pid ${pid}`
    } catch {
      return `pid ${pid}`
    }
  }

  #reset(): void {
    this.#buffer = ''
    this.#scan = []
    this.#streak.clear()
    this.#active = null
    this.#dismissed = false
  }
}
