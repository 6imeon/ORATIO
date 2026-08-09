import { useCallback, useEffect, useState } from 'react'
import type { RunningApp, Settings, ThemePreference } from '@shared/types'
import { ModelPicker } from '../components/ModelPicker'
import { PermissionsPanel } from '../components/PermissionsPanel'
import { ProviderSettings } from '../components/ProviderSettings'

/**
 * Five groups on one screen.
 *
 * Superwhisper's settings are described as "overwhelming" (UI.md §7), so the
 * shape is deliberately flat — no tabs, no sub-pages, no search. Everything
 * Oratio can be configured to do fits in one scroll.
 *
 * Writes go straight through. There is no Save button and no dirty state: each
 * control calls `settings.set` with the one key it owns, and main merges it
 * over the current file. A form that batches changes would need a discard
 * path, and the failure mode of forgetting to press Save is worse than the
 * cost of a write per toggle.
 */
export function SettingsView({
  onClose,
  onThemeChange,
}: {
  onClose: () => void
  /**
   * Reported upward as well as saved, because the theme styles the whole
   * window and this view is unmounted on Done — state kept only here would
   * revert the moment the user closed the screen they set it on.
   */
  onThemeChange?: (theme: ThemePreference) => void
}): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.oratio.settings.get().then(setSettings)
  }, [])

  /**
   * Patch, then adopt what main returns rather than what was sent.
   *
   * Main merges the patch over the file it has, so its reply is the real state
   * — including any key this window never knew about, and any normalisation it
   * applied. Trusting the local optimistic value instead is how two windows
   * open on Settings drift apart.
   */
  const update = useCallback(async (patch: Partial<Settings>): Promise<void> => {
    setError(null)
    try {
      setSettings(await window.oratio.settings.set(patch))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-(--color-ground)">
      <header
        className="flex h-11 shrink-0 items-center gap-3 border-b border-(--color-line) px-5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <h1 className="text-[13px] font-semibold text-(--color-ink)">Settings</h1>
        <button
          type="button"
          onClick={onClose}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="ml-auto rounded-md px-2 py-1 text-xs text-(--color-ink-dim) hover:bg-(--color-raised) hover:text-(--color-ink)"
        >
          Done
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto flex max-w-lg flex-col gap-8">
          {settings === null ? (
            <p className="text-[13px] text-(--color-ink-dim)">Loading…</p>
          ) : (
            <>
              <Group title="Vault" description="Where your recordings, transcripts and notes are written.">
                <VaultRow settings={settings} onChange={setSettings} />
              </Group>

              <Group
                title="Model"
                description="Transcription runs on this Mac using the model you choose here. Downloaded once, then reused."
              >
                <ModelPicker
                  activeModel={settings.activeModel}
                  onSelect={(id) => void update({ activeModel: id })}
                />
              </Group>

              <Group title="Appearance">
                <SegmentedControl
                  label="Theme"
                  value={settings.theme}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                  onChange={(v) => {
                    // Applied immediately, before the write resolves. The whole
                    // point of a theme control is that you can see the result;
                    // waiting on a disk round-trip to repaint would make the
                    // control feel broken on a slow write.
                    onThemeChange?.(v)
                    void update({ theme: v })
                  }}
                  hint="System follows your macOS appearance setting."
                />
              </Group>

              <Group title="Recording">
                <Toggle
                  label="Voice detection"
                  checked={settings.vadEnabled}
                  onChange={(v) => void update({ vadEnabled: v })}
                  hint="Skips silence before transcribing. Leaving it off makes the model invent speech during quiet stretches, and a system audio tap captures a lot of them."
                />
                <Toggle
                  label="Ignore my speakers in the microphone"
                  checked={settings.removeSpeakerBleed}
                  onChange={(v) => void update({ removeSpeakerBleed: v })}
                  hint="Without headphones your microphone also hears the other side, and those words get transcribed as yours. This drops them by comparing the two tracks — it only removes mic audio that is far quieter than the meeting audio at the same moment."
                />
                <Toggle
                  label="Delete audio after transcribing"
                  checked={settings.discardAudioByDefault}
                  onChange={(v) => void update({ discardAudioByDefault: v })}
                  hint="The default for new meetings; each one can still be changed before you record. Keeping audio is what lets you click a line of transcript and hear it."
                />
                <ExcludedApps
                  bundleIds={settings.excludedBundleIds}
                  onChange={(ids) => void update({ excludedBundleIds: ids })}
                />
                <Toggle
                  label="Offer to record when a meeting starts"
                  checked={settings.meetingSuggestions}
                  onChange={(v) => void update({ meetingSuggestions: v })}
                  hint="Notices when Zoom, Teams, Slack or a browser opens the microphone, and asks. It never starts recording on its own, and it does not read your screen or your window titles."
                />
                <Toggle
                  label="Open at login"
                  checked={settings.launchAtLogin}
                  onChange={(v) => void update({ launchAtLogin: v })}
                  hint="Oratio lives in the menu bar, so it needs to be running before a meeting starts to be useful."
                />
              </Group>

              <Group
                title="Summaries"
                description="Optional, and the only part of Oratio that can use a provider."
              >
                <ProviderSettings settings={settings} onChange={(p) => void update(p)} />

                {/*
                  A standing property of the app, not a note attached to
                  whichever provider is selected. It does not change when the
                  provider does, so it does not live inside the choice.
                */}
                <p className="rounded-md bg-(--color-raised) px-3 py-2.5 text-xs leading-relaxed text-(--color-ink-dim)">
                  <strong className="font-semibold text-(--color-ink)">
                    Your audio and transcripts never leave this Mac.
                  </strong>{' '}
                  Recording and transcription are local, always — there is no
                  cloud transcription option and no fallback that uploads audio.
                  A summariser is the one exception, and only ever receives the
                  finished text of a meeting you explicitly ask it to summarise.
                </p>
              </Group>

              <Group title="Permissions">
                <PermissionsPanel />
              </Group>
            </>
          )}

          {error && <p className="text-xs text-(--color-live)">{error}</p>}
        </div>
      </div>
    </div>
  )
}

function VaultRow({
  settings,
  onChange,
}: {
  settings: Settings
  onChange: (s: Settings) => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)

  async function pick(): Promise<void> {
    const path = await window.oratio.settings.pickVault()
    // Null means the user cancelled the dialog, which is not an error and
    // must not clear the existing path.
    if (path) onChange({ ...settings, vaultPath: path })
  }

  async function reveal(): Promise<void> {
    setError(null)
    try {
      await window.oratio.settings.revealVault()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-surface) px-3 py-2.5">
      <p className="font-mono text-xs break-all text-(--color-ink)">{settings.vaultPath}</p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void pick()}
          className="rounded-md bg-(--color-ink) px-2 py-1 text-[11px] font-medium text-(--color-surface) hover:opacity-90"
        >
          Change…
        </button>
        <button
          type="button"
          onClick={() => void reveal()}
          className="rounded-md border border-(--color-line) px-2 py-1 text-[11px] text-(--color-ink-dim) hover:bg-(--color-raised) hover:text-(--color-ink)"
        >
          Reveal in Finder
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-(--color-ink-faint)">
        Plain Markdown and JSON, one folder per meeting. Nothing here needs
        Oratio to read it.
      </p>
      {error && <p className="mt-1 text-[11px] text-(--color-live)">{error}</p>}
    </div>
  )
}

function Group({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-[13px] font-semibold text-(--color-ink)">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-(--color-ink-dim)">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * A small set of mutually exclusive choices, shown all at once.
 *
 * Radio inputs under the hood rather than buttons, so arrow keys move between
 * options and VoiceOver announces the group and the position within it — both
 * of which a row of `<button>`s silently loses. The segmented look is styling
 * over a real radiogroup, not a reimplementation of one.
 */
function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  hint?: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-surface) px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-(--color-ink)">{label}</span>
        <div
          role="radiogroup"
          aria-label={label}
          className="ml-auto flex gap-0.5 rounded-md bg-(--color-raised) p-0.5"
        >
          {options.map((opt) => {
            const selected = opt.value === value
            return (
              <label
                key={opt.value}
                className={`cursor-pointer rounded px-2.5 py-1 text-xs ${
                  selected
                    ? 'bg-(--color-surface) font-medium text-(--color-ink) shadow-sm'
                    : 'text-(--color-ink-dim) hover:text-(--color-ink)'
                }`}
              >
                <input
                  type="radio"
                  name={label}
                  checked={selected}
                  onChange={() => onChange(opt.value)}
                  // Visually hidden, not `display: none` — a hidden input is
                  // removed from the tab order entirely, which would make the
                  // control unreachable by keyboard.
                  className="sr-only"
                />
                {opt.label}
              </label>
            )
          })}
        </div>
      </div>
      {hint && (
        <p className="mt-1.5 text-xs leading-relaxed text-(--color-ink-faint)">{hint}</p>
      )}
    </div>
  )
}

/**
 * Apps whose audio is kept out of the recording.
 *
 * The candidate list is what is *running*, fetched when the picker opens
 * rather than at mount: the moment you reach for this is usually the moment
 * something is making noise, and an app launched since the settings screen
 * opened must appear without a reload.
 *
 * Excluded apps stay listed even when they are not running — the list is a
 * standing preference about future recordings, not a view of what is open now.
 * Dropping Spotify from the UI because it happens to be closed would look like
 * the setting had been forgotten.
 */
function ExcludedApps({
  bundleIds,
  onChange,
}: {
  bundleIds: string[]
  onChange: (ids: string[]) => void
}): React.JSX.Element {
  const [candidates, setCandidates] = useState<RunningApp[] | null>(null)
  const [picking, setPicking] = useState(false)

  /**
   * Display names for apps that are not running, so a closed app reads as
   * "Spotify" rather than as its bundle ID.
   *
   * Seeded with the defaults because those are the two the user never chose
   * and so has never seen named. Anything else falls back to the bundle ID,
   * which is ugly but unambiguous.
   */
  const [names, setNames] = useState<Record<string, string>>({
    'com.spotify.client': 'Spotify',
    'com.apple.Music': 'Music',
  })

  const openPicker = useCallback(async (): Promise<void> => {
    setPicking(true)
    const apps = await window.oratio.settings.runningApps()
    setCandidates(apps)
    // Remember what each bundle ID is called, so it still reads properly after
    // the app is quit.
    setNames((prev) => {
      const next = { ...prev }
      for (const app of apps) next[app.bundleId] = app.name
      return next
    })
  }, [])

  const available = (candidates ?? []).filter((app) => !bundleIds.includes(app.bundleId))

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-(--color-line) bg-(--color-surface) px-3 py-2.5">
      <div>
        <span className="block text-[13px] text-(--color-ink)">Ignore these apps</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-(--color-ink-faint)">
          Their audio is left out of the recording. Music playing during a meeting otherwise ends up
          in the transcript as lyrics. Don&rsquo;t add a meeting app — that would leave you with a
          recording of nothing.
        </span>
      </div>

      {bundleIds.length > 0 && (
        <ul className="flex flex-col gap-1">
          {bundleIds.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between gap-2 rounded-md bg-(--color-raised) px-2 py-1.5"
            >
              <span className="min-w-0 truncate text-xs text-(--color-ink)">{names[id] ?? id}</span>
              <button
                type="button"
                onClick={() => onChange(bundleIds.filter((b) => b !== id))}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-(--color-ink-dim) hover:bg-(--color-surface) hover:text-(--color-ink) focus-visible:ring-2 focus-visible:ring-(--color-me) focus-visible:outline-none"
                aria-label={`Stop ignoring ${names[id] ?? id}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {!picking ? (
        <button
          type="button"
          onClick={() => void openPicker()}
          className="self-start rounded-md border border-(--color-line) px-2 py-1 text-xs text-(--color-ink) hover:bg-(--color-raised) focus-visible:ring-2 focus-visible:ring-(--color-me) focus-visible:outline-none"
        >
          Add an app…
        </button>
      ) : candidates === null ? (
        <p className="text-xs text-(--color-ink-faint)">Looking for open apps…</p>
      ) : available.length === 0 ? (
        <p className="text-xs text-(--color-ink-faint)">
          Nothing else is open. Open the app you want to ignore, then try again.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {available.map((app) => (
            <li key={app.bundleId}>
              <button
                type="button"
                onClick={() => {
                  onChange([...bundleIds, app.bundleId])
                  setPicking(false)
                  setCandidates(null)
                }}
                className="rounded-md border border-(--color-line) px-2 py-1 text-xs text-(--color-ink) hover:bg-(--color-raised) focus-visible:ring-2 focus-visible:ring-(--color-me) focus-visible:outline-none"
              >
                {app.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-baseline gap-2.5 rounded-lg border border-(--color-line) bg-(--color-surface) px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-(--color-me)"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-(--color-ink)">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-xs leading-relaxed text-(--color-ink-faint)">
            {hint}
          </span>
        )}
      </span>
    </label>
  )
}
