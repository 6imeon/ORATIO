import log from 'electron-log/main'
import type { ProviderConfig, ProviderId, Settings, Transcript } from '@shared/types'
import { createSectionParser, type AIProvider, type SummarySection } from './AIProvider'
import { OllamaProvider, OLLAMA_DEFAULT_URL } from './OllamaProvider'
import { AnthropicProvider, OpenAIProvider } from './CloudProviders'
import { getApiKey } from '../storage/settings'

/**
 * Builds the provider the settings ask for.
 *
 * Returns null rather than throwing when the provider cannot be used, because
 * "no summariser configured" is a completely normal state for this app — the
 * AI layer is optional and everything else works without it. The caller turns
 * null into a message the user can act on.
 */
export async function resolveProvider(settings: Settings): Promise<AIProvider | null> {
  const id = settings.activeProvider
  if (!id) return null

  const config = settings.providers.find((p) => p.id === id)
  if (!config?.enabled) return null

  return buildProvider(config)
}

async function buildProvider(config: ProviderConfig): Promise<AIProvider | null> {
  switch (config.id) {
    case 'ollama':
      return new OllamaProvider(config.baseUrl ?? OLLAMA_DEFAULT_URL, config.model)
    case 'anthropic': {
      const key = await getApiKey('anthropic')
      return key ? new AnthropicProvider(key, config.model) : null
    }
    case 'openai': {
      const key = await getApiKey('openai')
      return key ? new OpenAIProvider(key, config.model) : null
    }
    default:
      return null
  }
}

/**
 * Pick a provider on first run, preferring the local one.
 *
 * Ollama is auto-detected and selected whenever it is present, because with it
 * the whole app is local — audio, transcript AND summary — and the privacy
 * claim needs no asterisk. A cloud provider is never selected automatically:
 * sending a meeting transcript to a third party is a decision the user makes,
 * not a default they discover afterwards.
 *
 * Returns the settings unchanged when a provider is already chosen, so this
 * can run on every launch without overriding the user.
 */
export async function autoDetectProvider(settings: Settings): Promise<Settings> {
  if (settings.activeProvider !== null) return settings

  const config = settings.providers.find((p) => p.id === 'ollama')
  const ollama = new OllamaProvider(config?.baseUrl ?? OLLAMA_DEFAULT_URL, config?.model)
  if (!(await ollama.isAvailable())) return settings

  log.info('[ai] Ollama detected — selecting it as the summariser')
  return {
    ...settings,
    activeProvider: 'ollama',
    providers: settings.providers.map((p) => (p.id === 'ollama' ? { ...p, enabled: true } : p)),
  }
}

/**
 * True when the provider sends the transcript off this machine.
 *
 * Drives the disclosure in the UI. Stated as a positive property of the
 * provider rather than inferred in the renderer, so a provider added later
 * cannot quietly default to "local" by omission.
 */
export function isCloudProvider(id: ProviderId): boolean {
  return id === 'anthropic' || id === 'openai'
}

export interface SummarizeCallbacks {
  /** A section grew. Called many times per second while streaming. */
  onDelta: (section: SummarySection, delta: string) => void
}

/**
 * Run one summarisation, demultiplexing the token stream into sections.
 *
 * Reports deltas through `onDelta` and accumulates nothing itself: aborting a
 * `fetch` rejects the in-flight read, so this function throws rather than
 * returning on exactly the path where the user cancelled a summary they were
 * watching. A return value would be unreachable there, and the partial text
 * would be lost. The caller accumulates instead, and keeps what arrived.
 *
 * Does no file I/O, so it can be exercised against a fake provider without a
 * vault.
 */
export async function runSummarize(
  provider: AIProvider,
  input: { title: string; transcript: Transcript; userNotes: string },
  cb: SummarizeCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const parser = createSectionParser()

  const apply = (chunks: ReturnType<typeof parser.push>): void => {
    for (const { section, delta } of chunks) cb.onDelta(section, delta)
  }

  for await (const token of provider.summarize(input, signal)) {
    // Checked here as well as passed to the provider: an async generator that
    // ignores its signal would otherwise keep streaming after a cancel, and
    // the user would watch text continue to appear after pressing Stop.
    if (signal.aborted) break
    apply(parser.push(token))
  }
  apply(parser.flush())
}
