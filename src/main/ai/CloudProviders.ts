import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  type AIProvider,
  type SummarizeInput,
} from './AIProvider'

/**
 * Cloud providers — bring your own key.
 *
 * There is no Oratio server and no account. The user's key goes straight from
 * the Keychain to the vendor, so there is nothing for this project to operate
 * and nothing to leak. That is the right shape for an open-source tool.
 *
 * These are opt-in and used ONLY for summarisation. Audio and transcription
 * never leave the machine regardless of which provider is selected.
 */

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const

  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'claude-haiku-4-5-20251001',
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0
  }

  async listModels(): Promise<string[]> {
    return ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']
  }

  async *summarize(input: SummarizeInput, signal?: AbortSignal): AsyncIterable<string> {
    const client = new Anthropic({ apiKey: this.apiKey })

    const stream = client.messages.stream(
      {
        model: this.model,
        // The Discussion section is deliberately the longest part of the
        // output, and under-summarising is the dominant failure mode in
        // meeting notes — so the ceiling has to leave room for a thorough
        // record of a long meeting.
        max_tokens: 8192,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(input) }],
      },
      { signal },
    )

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text
      }
    }
  }
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const

  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'gpt-5-mini',
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0
  }

  async listModels(): Promise<string[]> {
    return ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini']
  }

  async *summarize(input: SummarizeInput, signal?: AbortSignal): AsyncIterable<string> {
    yield* streamChatCompletion(
      new OpenAI({ apiKey: this.apiKey }),
      this.model,
      input,
      signal,
    )
  }
}

/** Where OpenRouter's OpenAI-compatible endpoint lives. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * OpenRouter — one key, most models.
 *
 * Worth having as its own entry rather than telling people to point the OpenAI
 * provider at a different base URL: it is the option that lets someone use
 * Gemini, Llama, DeepSeek or a model released next month without this project
 * shipping an SDK for each, and hiding that behind a URL field nobody finds is
 * the same as not having it.
 *
 * The API is OpenAI-compatible, so the streaming path is shared verbatim
 * — a second copy would be a second place for the abort handling to drift.
 * Two things differ and both are real:
 *
 *   1. Models are addressed as `vendor/model` slugs. A bare `gpt-5-mini` is a
 *      404 here, which is why the settings copy shows the slug form.
 *   2. It reads optional `HTTP-Referer` and `X-Title` headers to attribute
 *      traffic on their dashboards. Sending a name is the polite thing to do
 *      and costs nothing; it identifies the app, not the user.
 */
export class OpenRouterProvider implements AIProvider {
  readonly id = 'openrouter' as const

  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'anthropic/claude-haiku-4.5',
    private readonly baseUrl: string = OPENROUTER_BASE_URL,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0
  }

  /**
   * A short, opinionated shortlist rather than the ~300 models OpenRouter
   * offers. The full catalogue is a searchable web page and this is a
   * dropdown in a settings pane; the field stays editable, so anything not
   * listed is still one paste away.
   */
  async listModels(): Promise<string[]> {
    return [
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'meta-llama/llama-4-maverick',
      'deepseek/deepseek-chat-v3.1',
    ]
  }

  async *summarize(input: SummarizeInput, signal?: AbortSignal): AsyncIterable<string> {
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/6imeon/oratio',
        'X-Title': 'Oratio',
      },
    })
    yield* streamChatCompletion(client, this.model, input, signal)
  }
}

/**
 * The OpenAI chat-completions streaming loop, shared by every provider that
 * speaks that dialect.
 *
 * `max_completion_tokens` rather than the deprecated `max_tokens`: the newer
 * models reject the old name outright.
 */
async function* streamChatCompletion(
  client: OpenAI,
  model: string,
  input: SummarizeInput,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const stream = await client.chat.completions.create(
    {
      model,
      stream: true,
      max_completion_tokens: 8192,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    },
    { signal },
  )

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content
    if (token) yield token
  }
}
