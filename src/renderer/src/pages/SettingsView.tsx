import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'

/**
 * Settings — the read-only half.
 *
 * Phase 9 makes these editable and adds the model picker, provider keys and
 * first-run flow. What matters now is that the tray's Settings item and ⌘,
 * lead somewhere that tells the truth: this reads the real settings file, so
 * the values shown are the values in use. A menu item that opens a panel of
 * placeholder text would be worse than one that is absent.
 */
export function SettingsView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void window.oratio.settings.get().then(setSettings)
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
        <div className="mx-auto max-w-lg">
          {settings === null ? (
            <p className="text-[13px] text-(--color-ink-dim)">Loading…</p>
          ) : (
            <dl className="space-y-0">
              <Row label="Vault" value={settings.vaultPath} mono />
              <Row label="Model" value={settings.activeModel} />
              <Row
                label="Voice detection"
                value={settings.vadEnabled ? 'On' : 'Off'}
                hint="Runs before transcription. Whisper-family models hallucinate on silence, and a system tap captures a lot of it."
              />
              <Row
                label="Keep audio"
                value={settings.discardAudioByDefault ? 'Discard after transcribing' : 'Keep'}
              />
              <Row
                label="Summarisation"
                value={providerLabel(settings.activeProvider)}
                hint={providerHint(settings.activeProvider)}
              />
            </dl>
          )}

          {/*
            Stated as a standing property of the app, not as a note attached to
            the current provider — the guarantee does not change when the
            provider does, and burying it in a hint would make it read as a
            caveat rather than the design. Phase 9 adds the key fields below
            this; the sentence stays wherever they land.
          */}
          <p className="mt-6 rounded-md bg-(--color-raised) px-3 py-2.5 text-xs leading-relaxed text-(--color-ink-dim)">
            <strong className="font-semibold text-(--color-ink)">
              Your audio and transcripts never leave this Mac.
            </strong>{' '}
            Recording and transcription are local, always — there is no cloud
            transcription option and no fallback that uploads audio. A
            summariser is the one exception, and only ever receives the
            finished text of a meeting you explicitly ask it to summarise.
          </p>

          <p className="mt-8 border-t border-(--color-line) pt-4 text-xs leading-relaxed text-(--color-ink-faint)">
            These are read-only for now — editing arrives with the model picker
            and first-run setup.
          </p>
        </div>
      </div>
    </div>
  )
}

function providerLabel(id: Settings['activeProvider']): string {
  switch (id) {
    case 'ollama':
      return 'Ollama (local)'
    case 'anthropic':
      return 'Anthropic'
    case 'openai':
      return 'OpenAI'
    default:
      return 'Off'
  }
}

/**
 * Says where a meeting's text goes, in the same words for every provider.
 *
 * "Local" and "leaves this Mac" are the only two answers that matter, and the
 * user should not have to know that Ollama is a local server to work out which
 * one they are getting.
 */
function providerHint(id: Settings['activeProvider']): string {
  switch (id) {
    case 'ollama':
      return 'Runs on this Mac. Nothing is sent anywhere.'
    case 'anthropic':
    case 'openai':
      return 'Summaries only. The transcript of a meeting you summarise is sent to this provider over the network; audio never is.'
    default:
      return 'No summariser configured. Everything else works without one.'
  }
}

function Row({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string
  value: string
  hint?: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="border-b border-(--color-line) py-3 last:border-b-0">
      <div className="flex items-baseline gap-4">
        <dt className="w-36 shrink-0 text-[13px] text-(--color-ink-dim)">{label}</dt>
        <dd
          className={`min-w-0 flex-1 text-[13px] text-(--color-ink) ${mono ? 'font-mono text-xs break-all' : ''}`}
        >
          {value}
        </dd>
      </div>
      {hint && <p className="mt-1.5 ml-40 text-xs leading-relaxed text-(--color-ink-faint)">{hint}</p>}
    </div>
  )
}
