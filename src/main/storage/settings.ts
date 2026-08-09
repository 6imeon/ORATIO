import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
import { app, safeStorage } from 'electron'
import log from 'electron-log/main'
import type { ProviderConfig, ProviderId, Settings } from '@shared/types'
import { DEFAULT_MODEL } from '@shared/models'

/**
 * Settings live in userData/settings.json. API keys do NOT — they are
 * encrypted with Electron's safeStorage, which is backed by the macOS
 * Keychain, and stored separately so a settings file can be shared or
 * committed without leaking credentials.
 */

const settingsPath = () => join(app.getPath('userData'), 'settings.json')
const secretsPath = () => join(app.getPath('userData'), 'secrets.bin')

export function defaultSettings(): Settings {
  return {
    // Default vault sits beside the user's other documents rather than
    // buried in Application Support — these are the user's files, and they
    // should be able to find them without being told where to look.
    vaultPath: join(app.getPath('home'), 'Documents', 'Oratio'),
    activeModel: DEFAULT_MODEL,
    // Follow macOS unless told otherwise. An app that picks its own appearance
    // on first launch is an app that looks broken next to everything else on
    // the screen.
    theme: 'system',
    vadEnabled: true,
    // On by default: recording through speakers is the common case for a
    // laptop, and the failure it fixes — being transcribed saying what the
    // other person said — is one users cannot diagnose for themselves.
    removeSpeakerBleed: true,
    discardAudioByDefault: false,
    /**
     * Music players, because they are the common case and the one users would
     * never think to configure: you put music on, forget it, and the transcript
     * comes back with song lyrics attributed to the other participant.
     *
     * Meeting apps are deliberately absent — excluding one would silently
     * record nothing of the meeting, which is the failure this feature exists
     * to avoid causing.
     */
    excludedBundleIds: ['com.spotify.client', 'com.apple.Music'],
    // On by default. It only ever offers — see the Settings copy and the
    // suggest-never-auto-start note in meetingDetector.ts.
    meetingSuggestions: true,
    launchAtLogin: false,
    providers: [
      { id: 'ollama', enabled: true, model: 'qwen3:4b', baseUrl: 'http://127.0.0.1:11434' },
      { id: 'anthropic', enabled: false, model: 'claude-haiku-4-5-20251001' },
      { id: 'openai', enabled: false, model: 'gpt-5-mini' },
      // OpenRouter addresses models as vendor/model slugs, so the default
      // carries the vendor prefix — a bare name is a 404 on their API.
      {
        id: 'openrouter',
        enabled: false,
        model: 'anthropic/claude-haiku-4.5',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    ],
    activeProvider: null,
  }
}

export async function loadSettings(): Promise<Settings> {
  let settings: Settings
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    // Merge over defaults so a settings file written by an older version
    // never leaves new keys undefined.
    const saved = JSON.parse(raw) as Partial<Settings>
    settings = { ...defaultSettings(), ...saved, providers: mergeProviders(saved.providers) }

    /**
     * Persist a provider-list migration immediately.
     *
     * Without this the merge is correct but invisible on disk: settings.json
     * is only written when the user changes something, so a file that predates
     * a new provider keeps describing the old world indefinitely. That gap is
     * confusing to anyone inspecting the file, and it means the migration is
     * re-derived on every single load rather than once.
     *
     * Compared by id, not by deep equality — the goal is to catch a provider
     * appearing or disappearing, not to rewrite the file whenever a default
     * model string changes underneath a user who has their own.
     */
    const before = (saved.providers ?? []).map((p) => p?.id).join(',')
    const after = settings.providers.map((p) => p.id).join(',')
    if (before !== after) {
      log.info('[settings] provider list migrated', { before, after })
      // Deliberately not awaited: this is housekeeping, and a failure to write
      // must not stop the app loading. The in-memory value is already correct.
      void saveSettings(settings).catch((err) =>
        log.warn('[settings] could not persist provider migration', err),
      )
    }
  } catch {
    settings = defaultSettings()
  }

  // Escape hatch for verification harnesses and the phase 10 soak test, which
  // must never write into the user's real vault. Env-only and deliberately
  // undocumented in the UI — it is a testing affordance, not a feature.
  //
  // Must be absolute. `join()` resolves a relative path against cwd, which in
  // dev is the repo root — a harness that set `ORATIO_VAULT=test` scattered
  // session folders through the working tree, and they looked enough like real
  // recordings to be worth double-checking before deletion. Reject rather than
  // resolve: a relative value here is always a mistake in the caller.
  const override = process.env['ORATIO_VAULT']
  if (override) {
    if (isAbsolute(override)) settings = { ...settings, vaultPath: override }
    else log.warn('[settings] ignoring relative ORATIO_VAULT', { override })
  }

  return settings
}

/**
 * Reconcile the saved provider list against the built-in one.
 *
 * A spread merge only fills in missing TOP-LEVEL keys. `providers` is an array
 * and every saved file already has one, so it was taken wholesale — which meant
 * a provider added in a later version was invisible to everyone who had ever
 * opened the app. OpenRouter shipped and simply did not appear; the only way to
 * see it was to delete settings.json.
 *
 * Merged per id, in the built-in order:
 *   - a provider the user has configured keeps their model, URL and enabled
 *     flag, because those are their choices and an upgrade must not reset them
 *   - a provider they have never seen is added from defaults
 *   - a provider WE no longer ship is dropped, so a removed integration does
 *     not linger in the UI as an option that cannot work
 *
 * Order comes from the defaults rather than the saved file, so the list reads
 * the same on every Mac and a new entry appears where it was designed to.
 */
function mergeProviders(saved: ProviderConfig[] | undefined): ProviderConfig[] {
  const builtIn = defaultSettings().providers
  if (!Array.isArray(saved)) return builtIn

  return builtIn.map((base) => {
    const match = saved.find((p) => p?.id === base.id)
    return match ? { ...base, ...match } : base
  })
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// API keys — Keychain-backed
// ---------------------------------------------------------------------------

type SecretStore = Partial<Record<ProviderId, string>>

async function readSecrets(): Promise<SecretStore> {
  if (!existsSync(secretsPath())) return {}
  try {
    const blob = await readFile(secretsPath())
    if (!safeStorage.isEncryptionAvailable()) return {}
    return JSON.parse(safeStorage.decryptString(blob)) as SecretStore
  } catch (err) {
    log.warn('[settings] could not read secrets', err)
    return {}
  }
}

async function writeSecrets(store: SecretStore): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this system')
  }
  await mkdir(dirname(secretsPath()), { recursive: true })
  await writeFile(secretsPath(), safeStorage.encryptString(JSON.stringify(store)))
}

export async function setApiKey(provider: ProviderId, key: string): Promise<void> {
  const store = await readSecrets()
  if (key) store[provider] = key
  else delete store[provider]
  await writeSecrets(store)
}

export async function getApiKey(provider: ProviderId): Promise<string | null> {
  return (await readSecrets())[provider] ?? null
}

/** Presence check for the UI — never returns the key itself to the renderer. */
export async function hasApiKey(provider: ProviderId): Promise<boolean> {
  return Boolean((await readSecrets())[provider])
}
