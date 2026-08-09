import { useCallback, useEffect, useState } from 'react'
import type { KeyedProviderId, ProviderConfig, ProviderId, Settings } from '@shared/types'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

const LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

const DETAILS: Record<ProviderId, string> = {
  ollama: 'Runs on this Mac. Nothing is sent anywhere.',
  anthropic:
    'Sends the meeting text to this provider over the network when you ask for a summary.',
  openai:
    'Sends the meeting text to this provider over the network when you ask for a summary.',
  // Named explicitly because the routing is the point of using it — and
  // because "one key, many vendors" also means the text can end up at a
  // company the user did not individually choose. Better said out loud here
  // than discovered later.
  openrouter:
    'One key for many vendors. Sends the meeting text to OpenRouter, which forwards it to whichever model you pick.',
}

/**
 * Which summariser to use, and its credentials.
 *
 * Keys never round-trip. `AI_PROVIDERS` returns `hasApiKey` — a boolean — and
 * the key itself is written once through `safeStorage` into the Keychain and
 * read only in main when a request is actually made. So the field below is
 * always empty on load even when a key is saved: there is nothing to
 * prefill it with, by design, and the saved state is shown as a word instead.
 */
export function ProviderSettings({ settings, onChange }: Props): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    setProviders(await window.oratio.ai.providers())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const active = settings.activeProvider

  /**
   * Selecting a provider enables it.
   *
   * `enabled` has no control of its own — this screen is the only place a
   * provider is chosen, so the two flags were able to disagree: picking a
   * provider set `activeProvider` while `enabled` stayed false, and
   * `resolveProvider` returns null for a disabled config. The result was a
   * Summarise button greyed out with the provider visibly selected and nothing
   * explaining why. Choosing something IS the intent to use it, so the two are
   * set together and cannot drift apart.
   */
  const selectProvider = (id: ProviderId): void => {
    onChange({
      activeProvider: id,
      providers: settings.providers.map((p) => (p.id === id ? { ...p, enabled: true } : p)),
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Choice
          label="Off"
          detail="No summaries. Recording, transcription and search all work without one."
          selected={active === null}
          onSelect={() => onChange({ activeProvider: null })}
        />

        {providers.map((p) => (
          <Choice
            key={p.id}
            label={LABELS[p.id]}
            detail={DETAILS[p.id]}
            selected={active === p.id}
            onSelect={() => selectProvider(p.id)}
          >
            <ProviderDetail
              config={p}
              settings={settings}
              onChange={onChange}
              onSaved={() => void refresh()}
            />
          </Choice>
        ))}
      </div>
    </div>
  )
}

function ProviderDetail({
  config,
  settings,
  onChange,
  onSaved,
}: {
  config: ProviderConfig
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onSaved: () => void
}): React.JSX.Element {
  const patchProvider = (patch: Partial<ProviderConfig>): void => {
    onChange({
      providers: settings.providers.map((p) => (p.id === config.id ? { ...p, ...patch } : p)),
    })
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-(--color-line) pt-2">
      <Field label="Model">
        <input
          type="text"
          defaultValue={config.model}
          onBlur={(e) => patchProvider({ model: e.target.value.trim() })}
          spellCheck={false}
          className="w-full rounded-md border border-(--color-line) bg-(--color-ground) px-2 py-1 font-mono text-xs text-(--color-ink)"
        />
        {/*
          OpenRouter needs the vendor prefix and rejects a bare model name, so
          the format is shown rather than left to be discovered through a 404
          at the moment the user asks for their first summary.
        */}
        {config.id === 'openrouter' && (
          <p className="mt-1 text-[11px] text-(--color-ink-faint)">
            Use a <span className="font-mono">vendor/model</span> slug, e.g.{' '}
            <span className="font-mono">anthropic/claude-sonnet-5</span>. The full list is on
            openrouter.ai/models.
          </p>
        )}
      </Field>

      {config.id === 'ollama' ? (
        <Field label="Server">
          <input
            type="text"
            defaultValue={config.baseUrl ?? ''}
            onBlur={(e) => patchProvider({ baseUrl: e.target.value.trim() })}
            spellCheck={false}
            className="w-full rounded-md border border-(--color-line) bg-(--color-ground) px-2 py-1 font-mono text-xs text-(--color-ink)"
          />
        </Field>
      ) : (
        <ApiKeyField provider={config.id} saved={config.hasApiKey === true} onSaved={onSaved} />
      )}
    </div>
  )
}

/**
 * Write-only. There is no read path for a saved key, here or in the bridge.
 */
function ApiKeyField({
  provider,
  saved,
  onSaved,
}: {
  provider: KeyedProviderId
  saved: boolean
  onSaved: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.oratio.ai.setKey(provider, next)
      setValue('')
      onSaved()
    } catch (err) {
      // safeStorage can genuinely be unavailable — a login keychain that is
      // locked, or a system without one. Failing loudly beats storing the key
      // in plaintext or pretending the save worked.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field label="API key">
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={saved ? 'Saved in your Keychain' : 'Paste your key'}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-(--color-line) bg-(--color-ground) px-2 py-1 font-mono text-xs text-(--color-ink) placeholder:text-(--color-ink-faint)"
        />
        <button
          type="button"
          onClick={() => void save(value)}
          disabled={busy || value.length === 0}
          className="shrink-0 rounded-md bg-(--color-ink) px-2 py-1 text-[11px] font-medium text-(--color-surface) hover:opacity-90 disabled:opacity-40"
        >
          Save
        </button>
        {saved && (
          <button
            type="button"
            onClick={() => void save('')}
            disabled={busy}
            className="shrink-0 text-[11px] text-(--color-ink-dim) hover:text-(--color-live)"
          >
            Remove
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-(--color-ink-faint)">
        {saved
          ? 'Stored in the macOS Keychain. It is never shown again and never sent to this window.'
          : 'Stored in the macOS Keychain, not in the settings file.'}
      </p>
      {error && <p className="mt-1 text-[11px] text-(--color-live)">{error}</p>}
    </Field>
  )
}

function Choice({
  label,
  detail,
  selected,
  onSelect,
  children,
}: {
  label: string
  detail: string
  selected: boolean
  onSelect: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        selected
          ? 'border-(--color-me) bg-(--color-raised)'
          : 'border-(--color-line) bg-(--color-surface)'
      }`}
    >
      <label className="flex cursor-pointer items-baseline gap-2">
        <input
          type="radio"
          checked={selected}
          onChange={onSelect}
          className="mt-1 size-3.5 shrink-0 accent-(--color-me)"
        />
        <span className="text-[13px] font-medium text-(--color-ink)">{label}</span>
        <span className="text-xs leading-relaxed text-(--color-ink-dim)">{detail}</span>
      </label>
      {selected && children}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <span className="mb-1 block text-[11px] text-(--color-ink-dim)">{label}</span>
      {children}
    </div>
  )
}
