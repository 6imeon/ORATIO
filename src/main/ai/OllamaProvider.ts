import log from 'electron-log/main'
import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  type AIProvider,
  type SummarizeInput,
} from './AIProvider'

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'

/**
 * Ollama — the preferred provider.
 *
 * When Ollama is running locally, the entire app is local: audio, transcript,
 * and summary all stay on the machine, and the privacy claim needs no
 * asterisk. So this provider is auto-detected at startup and selected by
 * default whenever it is present.
 */
export class OllamaProvider implements AIProvider {
  readonly id = 'ollama' as const

  constructor(
    private readonly baseUrl: string = OLLAMA_DEFAULT_URL,
    private readonly model: string = 'qwen3:4b',
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return []
      const body = (await res.json()) as { models?: Array<{ name: string }> }
      return (body.models ?? []).map((m) => m.name)
    } catch (err) {
      log.warn('[ollama] listModels failed', err)
      return []
    }
  }

  async *summarize(input: SummarizeInput, signal?: AbortSignal): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(input) },
        ],
      }),
    })

    if (!res.ok || !res.body) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`)
    }

    // Ollama streams newline-delimited JSON, and a chunk boundary can land
    // mid-line — so hold a buffer and only parse complete lines.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as {
            message?: { content?: string }
            done?: boolean
          }
          const token = parsed.message?.content
          if (token) yield token
        } catch {
          /* skip malformed line rather than aborting the stream */
        }
      }
    }
  }
}
