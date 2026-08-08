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
    const client = new OpenAI({ apiKey: this.apiKey })

    const stream = await client.chat.completions.create(
      {
        model: this.model,
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
}
