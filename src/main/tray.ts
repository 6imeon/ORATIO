import { Menu, Tray, nativeImage, app, powerMonitor, globalShortcut } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { NativeImage } from 'electron'
import type { Session } from '@shared/types'
import type { RecordingController } from './recording/RecordingController'

/**
 * Menu-bar presence.
 *
 * `LSUIElement` is set, so there is no Dock icon: when the window is closed
 * this is the *only* evidence the app exists, and an always-visible recording
 * state is deliberate. A meeting recorder that hides what it is doing is
 * precisely the design that got other products into trouble.
 *
 * A native `Menu`, never a `BrowserWindow` popover (UI.md §2). AppKit draws
 * this in ~0 ms; a popover needs a live, painted, un-throttled renderer, and
 * Raycast needed WebKit private APIs to make that feel right at a cost of
 * 350–450 MB resident. For five menu items, competing with the ASR worker for
 * memory, that is a bad trade.
 */

/** How the tray describes itself. The third state is the one that matters. */
export type TrayState = 'idle' | 'recording' | 'transcribing'

interface TrayDeps {
  recording: RecordingController
  showMainWindow: () => void
  /** Open the window already showing this session — the tray's Recent list. */
  openSession: (sessionId: string) => void
  /** Open the window on the Settings pane. */
  openSettings: () => void
  /** Most recent sessions, newest first. Read lazily, on menu open. */
  recentSessions: () => Promise<Session[]>
}

/**
 * How many recent sessions the menu offers.
 *
 * Five, because this is a shortcut and not a browser: the window has the full
 * list with search, and a menu long enough to need scrolling has stopped being
 * faster than opening it.
 */
const RECENT_COUNT = 5

/**
 * Start/stop from anywhere.
 *
 * Not a convenience. macOS hides menu-bar extras when the bar is crowded
 * (Apple HIG), so on a notched MacBook the icon can simply not be there — and
 * the rule is that the tray is never the only path to an action. This is the
 * icon's fallback, and it works with no window open.
 */
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+R'

let tray: Tray | null = null
let ticker: NodeJS.Timeout | null = null
let startedAt: number | null = null
let transcribing = 0
let deps: TrayDeps | null = null

/**
 * Icons are built once and reused.
 *
 * `setImage` runs on every state change and, while recording, cannot be the
 * thing that decodes a PNG — but the real reason is correctness: rebuilding
 * meant re-reading from disk, and a path that silently yields an empty image
 * would then fail intermittently rather than immediately.
 */
let iconActive: NativeImage | null = null
let iconIdle: NativeImage | null = null

/**
 * Apple uses 35% opacity for disabled controls, and idle is that kind of
 * state: present, not doing anything. Opacity rather than a second glyph
 * because a template image has no colour to vary — macOS keeps only the alpha
 * channel — so alpha is the only channel state can live in.
 */
const IDLE_OPACITY = 0.35

export function createTray(d: TrayDeps): Tray {
  deps = d

  // Resolved from `app.getAppPath()`, never `__dirname`. Rollup decides which
  // chunk this module lands in — currently out/main/chunks, a level deeper
  // than out/main — so a `__dirname`-relative walk silently changes meaning
  // whenever the bundler regroups the code, and the failure mode is an
  // invisible menu-bar icon rather than an error. getAppPath() is the
  // directory holding package.json in both dev and asar, and resources/ sits
  // directly under it in both.
  const path = join(app.getAppPath(), 'resources', 'trayTemplate.png')
  const active = nativeImage.createFromPath(path)

  // createFromPath does NOT throw on a missing file — it returns an empty
  // image, and an empty tray image on macOS is an invisible menu-bar item. For
  // an app with no Dock icon that means no visible surface at all, so this is
  // worth an explicit check rather than a silent nothing.
  if (active.isEmpty()) {
    log.error('[tray] icon missing or unreadable — the menu bar item will be invisible', { path })
  }

  // Template images carry only alpha; macOS inverts them for light and dark
  // menu bars, and honours Reduce Transparency and the Increase Contrast
  // setting for free. One asset covers every appearance.
  active.setTemplateImage(true)
  iconActive = active
  iconIdle = fade(active, IDLE_OPACITY)

  tray = new Tray(iconIdle)
  tray.setToolTip('Oratio')

  // Without this a double-click fires the menu item twice, and the second fire
  // is a *stop* on the recording the first just started.
  tray.setIgnoreDoubleClickEvents(true)

  // The interval driving the counter does not run while the machine is asleep,
  // so the title is frozen at whatever it said when the lid closed. Elapsed is
  // derived from a Date.now() delta, which survives suspend — only the redraw
  // is missing, so one on wake is the whole fix.
  powerMonitor.on('resume', () => {
    if (startedAt !== null) tray?.setTitle(title())
  })

  // The menu is rebuilt when it opens rather than kept live, because its
  // contents depend on the vault: reading five sessions off disk on every
  // recording tick would be pointless I/O for a menu nobody is looking at.
  tray.on('mouse-down', () => void rebuild())

  registerShortcut()
  void rebuild()
  return tray
}

/**
 * Reduce a template image to a fraction of its opacity.
 *
 * Done by hand on the raw bitmap because nativeImage has no opacity operator.
 * The image stays a template afterwards, so macOS still inverts it per
 * appearance — this scales the alpha the system will then use as a mask.
 */
function fade(image: NativeImage, opacity: number): NativeImage {
  const scales = image.getScaleFactors()
  const faded = nativeImage.createEmpty()

  for (const scale of scales) {
    const size = image.getSize(scale)
    const bitmap = image.toBitmap({ scaleFactor: scale })
    // BGRA, premultiplied — scaling all four channels keeps that invariant,
    // where scaling alpha alone would produce colours brighter than their own
    // alpha and render as fringing.
    for (let i = 0; i < bitmap.length; i++) bitmap[i] = Math.round((bitmap[i] ?? 0) * opacity)
    faded.addRepresentation({ scaleFactor: scale, width: size.width, height: size.height, buffer: bitmap })
  }

  if (faded.isEmpty()) return image
  faded.setTemplateImage(true)
  return faded
}

/** What the tray is doing, in priority order: recording outranks transcribing. */
export function trayState(): TrayState {
  if (startedAt !== null) return 'recording'
  if (transcribing > 0) return 'transcribing'
  return 'idle'
}

/**
 * Build the menu against the vault.
 *
 * Async because the recent list comes off disk. Failing to read it degrades to
 * a menu without a Recent section rather than no menu — losing start/stop
 * because a directory was unreadable would be a much worse trade.
 */
async function rebuild(): Promise<void> {
  if (!tray || !deps) return
  const d = deps
  const state = trayState()
  const isRecording = state === 'recording'

  let recent: Session[] = []
  try {
    recent = (await d.recentSessions()).slice(0, RECENT_COUNT)
  } catch (err) {
    log.warn('[tray] could not read recent sessions', err)
  }

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(d, state, recent)))
  tray.setTitle(title())
  tray.setImage((isRecording ? iconActive : iconIdle) ?? iconActive ?? nativeImage.createEmpty())
  tray.setToolTip(tooltip(state))
}

/**
 * The menu, as a template.
 *
 * Separated from `rebuild` and kept pure because `Tray` is write-only — it has
 * `setImage`, `setContextMenu` and `setToolTip` but no getters for any of
 * them, so what the menu bar is showing cannot be read back from the object.
 * Building the menu as data means it can be asserted against directly rather
 * than only inspected by eye, which is how a menu regresses silently.
 */
function menuTemplate(
  d: TrayDeps,
  state: TrayState,
  recent: readonly Session[],
): Electron.MenuItemConstructorOptions[] {
  const isRecording = state === 'recording'

  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: isRecording ? `Stop recording  ${elapsed()}` : 'Start recording',
      accelerator: TOGGLE_SHORTCUT,
      click: () => void toggle(),
    },
  ]

  // Only while it is true. A permanent "Idle" row would be noise, and the
  // point of this state is that it appears when there is something to say.
  if (state === 'transcribing') {
    items.push({
      label: transcribing === 1 ? 'Transcribing…' : `Transcribing ${transcribing} recordings…`,
      enabled: false,
    })
  }

  if (recent.length > 0) {
    items.push({ type: 'separator' }, { label: 'Recent', enabled: false })
    for (const session of recent.slice(0, RECENT_COUNT)) {
      items.push({
        label: `  ${menuLabel(session)}`,
        click: () => d.openSession(session.id),
      })
    }
  }

  items.push(
    { type: 'separator' },
    { label: 'Open Oratio', accelerator: 'CommandOrControl+O', click: () => d.showMainWindow() },
    { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => d.openSettings() },
    { type: 'separator' },
    { label: 'Quit Oratio', accelerator: 'CommandOrControl+Q', role: 'quit' },
  )

  return items
}

/**
 * A session as one menu row: title, then when it happened.
 *
 * Titles are user-supplied and a long one would stretch the menu across the
 * screen, so it is truncated here rather than by AppKit.
 */
function menuLabel(session: Session): string {
  const title = session.title.length > 32 ? `${session.title.slice(0, 31)}…` : session.title
  const status = session.status === 'ready' ? '' : `  · ${session.status}`
  return `${title}   ${clock(session.startedAt)}${status}`
}

/** Time of day for today's sessions, date for older ones. */
function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function tooltip(state: TrayState): string {
  if (state === 'recording') return `Oratio — recording ${elapsed()}`
  if (state === 'transcribing') return 'Oratio — transcribing'
  return 'Oratio'
}

/** The menu-bar title: the elapsed counter while recording, nothing otherwise. */
function title(): string {
  return startedAt !== null ? ` ${elapsed()}` : ''
}

/**
 * The tray reflects state rather than owning it: this calls the controller and
 * lets its `started`/`stopped` events drive the redraw, so the menu says the
 * same thing whether the recording was toggled from here, the window, or the
 * global shortcut.
 */
async function toggle(): Promise<void> {
  if (!deps) return
  try {
    if (deps.recording.isRecording()) await deps.recording.stop()
    else await deps.recording.start()
  } catch (err) {
    log.error('[tray] could not toggle recording', err)
    // Resync: a failed start leaves the menu claiming a state that never
    // happened.
    void rebuild()
  }
}

/**
 * The global shortcut, which may legitimately fail.
 *
 * `register` returns false when another app already owns the combination —
 * that is not an error we can fix, and it must not take the app down. The tray
 * menu still carries the accelerator label, so the action remains reachable.
 */
function registerShortcut(): void {
  try {
    const ok = globalShortcut.register(TOGGLE_SHORTCUT, () => void toggle())
    if (!ok) {
      log.warn('[tray] global shortcut is taken by another app', { shortcut: TOGGLE_SHORTCUT })
    }
  } catch (err) {
    log.warn('[tray] could not register global shortcut', err)
  }
}

/**
 * Recording started or stopped.
 *
 * The counter is derived from a `Date.now()` delta rather than accumulated
 * ticks: a tick counter loses a second on every dropped tick, and the interval
 * does not fire at all while the machine is asleep. This display is
 * approximate by design — the authoritative duration is the sample count, and
 * meta.json carries that.
 */
export function setRecordingState(active: boolean): void {
  startedAt = active ? Date.now() : null

  if (ticker) {
    clearInterval(ticker)
    ticker = null
  }
  if (active) {
    ticker = setInterval(() => tray?.setTitle(title()), 1000)
    // Nothing else keeps the app alive between ticks, and a timer that lets
    // macOS nap the process would stall the counter mid-meeting.
    ticker.unref?.()
  }
  void rebuild()
}

/**
 * How many recordings are waiting on or going through ASR.
 *
 * A count rather than a boolean because the queue can be several deep after a
 * crash, and "still working" is more honest when it says how much work is
 * left.
 */
export function setTranscribing(count: number): void {
  if (count === transcribing) return
  transcribing = Math.max(0, count)
  void rebuild()
}

function elapsed(): string {
  if (startedAt === null) return '0:00'
  const total = Math.floor((Date.now() - startedAt) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

app.on('will-quit', () => {
  // Global shortcuts are process-wide OS registrations and are not released by
  // the window closing. Left registered they can survive as a dead binding.
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  if (ticker) clearInterval(ticker)
  tray?.destroy()
  tray = null
})
