import type { ProviderId, Transcript } from '@shared/types'

export interface SummarizeInput {
  title: string
  transcript: Transcript
  /**
   * What the user typed during the meeting.
   *
   * This is the whole mechanic: the user's sparse notes STEER the summary
   * rather than the model generating from scratch. Write "pricing concerns"
   * and the summary pulls every pricing exchange out of the transcript.
   * Write nothing and you get a generic summary. It is the single reason
   * people prefer Granola's output, and there is nothing proprietary in it.
   */
  userNotes: string
}

export interface AIProvider {
  readonly id: ProviderId
  /** True when the provider is actually usable — key present, server up. */
  isAvailable(): Promise<boolean>
  listModels(): Promise<string[]>
  summarize(input: SummarizeInput, signal?: AbortSignal): AsyncIterable<string>
}

/**
 * The AI layer is strictly optional.
 *
 * Recording, transcription, and search never touch it. With no provider
 * configured the app is fully functional and completely offline — only
 * summaries are missing. Transcription is local ALWAYS; it is never routed
 * through a provider, whatever the settings say.
 */
export const SYSTEM_PROMPT = `You are a meeting notes assistant. You are given a transcript and the user's own rough notes from the meeting.

The user's notes are the outline. Follow them: expand each point using evidence from the transcript, keeping their emphasis and ordering. Where their notes are sparse or absent, fall back to summarising what actually mattered.

Rules:
- Use only what the transcript supports. Never invent decisions, numbers, or commitments.
- "me" is the user; "them" is everyone else on the call.
- Attribute action items to an owner where the transcript makes it clear, and say when it does not.
- Prefer short sections and bullets over prose.
- Output plain Markdown with no preamble.`

export function buildUserPrompt(input: SummarizeInput): string {
  const transcript = input.transcript.segments
    .map((s) => `[${formatClock(s.startMs)}] ${s.speaker}: ${s.text}`)
    .join('\n')

  return [
    `# Meeting: ${input.title}`,
    '',
    '## The user\'s notes',
    input.userNotes.trim() || '(none — summarise what mattered)',
    '',
    '## Transcript',
    transcript,
  ].join('\n')
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
