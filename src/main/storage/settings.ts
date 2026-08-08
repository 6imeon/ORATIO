import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { app, safeStorage } from 'electron'
import log from 'electron-log/main'
import type { ProviderId, Settings } from '@shared/types'
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
    vadEnabled: true,
    discardAudioByDefault: false,
    launchAtLogin: false,
    providers: [
      { id: 'ollama', enabled: true, model: 'qwen3:4b', baseUrl: 'http://127.0.0.1:11434' },
      { id: 'anthropic', enabled: false, model: 'claude-haiku-4-5-20251001' },
      { id: 'openai', enabled: false, model: 'gpt-5-mini' },
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
    settings = { ...defaultSettings(), ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    settings = defaultSettings()
  }

  // Escape hatch for verification harnesses and the phase 10 soak test, which
  // must never write into the user's real vault. Env-only and deliberately
  // undocumented in the UI — it is a testing affordance, not a feature.
  const override = process.env['ORATIO_VAULT']
  if (override) settings = { ...settings, vaultPath: override }

  return settings
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
