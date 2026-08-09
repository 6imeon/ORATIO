import type { ExportFormat } from '@shared/ipc'
import type { SessionMeta, Transcript, TranscriptSegment } from '@shared/types'
import type { NotesDoc } from '../storage/notesDoc'
import { SUMMARY_SECTIONS } from '../ai/AIProvider'

/**
 * Turning a meeting into a file someone else can open.
 *
 * Pure functions over already-loaded data: no file I/O, no Electron, no
 * dialogs. That keeps every format testable against a fixture, which matters
 * because an export is the one operation whose output the user takes somewhere
 * we will never see — a broken .srt is discovered in a video editor a week
 * later, not here.
 *
 * The vault is already plain Markdown and JSON, so exporting is not a rescue
 * from a proprietary store (that is the whole point of the vault). It is for
 * handing a meeting to someone who does not use Oratio.
 */

export type { ExportFormat }

export interface ExportSource {
  meta: SessionMeta
  notes: NotesDoc
  /** Null when the meeting has not been transcribed yet. */
  transcript: Transcript | null
}

interface FormatSpec {
  label: string
  extension: string
  /** True when the format carries the transcript rather than the notes. */
  needsTranscript: boolean
}

/**
 * What each format is, in one place.
 *
 * Drives both the menu and the save dialog's filter list, so a format cannot be
 * offered in one and missing from the other.
 */
export const FORMATS: Record<ExportFormat, FormatSpec> = {
  md: { label: 'Markdown', extension: 'md', needsTranscript: false },
  txt: { label: 'Plain text', extension: 'txt', needsTranscript: false },
  pdf: { label: 'PDF', extension: 'pdf', needsTranscript: false },
  docx: { label: 'Word', extension: 'docx', needsTranscript: false },
  srt: { label: 'Subtitles (SRT)', extension: 'srt', needsTranscript: true },
  vtt: { label: 'WebVTT', extension: 'vtt', needsTranscript: true },
  json: { label: 'Transcript JSON', extension: 'json', needsTranscript: true },
}

/**
 * Who said it, for a human reader.
 *
 * "me"/"them" are the internal track names and are precise but graceless in a
 * document someone else will read. Diarization's `speakerLabel` wins when it
 * exists, because a real name beats a pronoun.
 */
export function speakerName(segment: TranscriptSegment): string {
  if (segment.speakerLabel) return segment.speakerLabel
  return segment.speaker === 'me' ? 'Me' : 'Them'
}

/** `hh:mm:ss` / `mm:ss`, matching the transcript view. */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * `hh:mm:ss,mmm` for SRT, `hh:mm:ss.mmm` for VTT.
 *
 * The separator is the only difference and it is not cosmetic: SRT parsers
 * reject a full stop and VTT parsers reject a comma, so a single shared
 * function with a flag is safer than two that can drift.
 */
function timecode(ms: number, comma: boolean): string {
  const total = Math.max(0, Math.floor(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const frac = total % 1000
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(frac, 3)}`
}

function meetingDate(meta: SessionMeta): string {
  const d = new Date(meta.startedAt)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function durationLabel(meta: SessionMeta): string {
  const min = Math.round(meta.durationSeconds / 60)
  return min < 1 ? 'under a minute' : min === 1 ? '1 minute' : `${min} minutes`
}

/**
 * Markdown: the notes and summary as a standalone document.
 *
 * Not a copy of `notes.md`. That file carries YAML frontmatter and the
 * `<!-- oratio:summary -->` markers, which are load-bearing for round-tripping
 * inside the vault and are noise in a document being sent to someone else. This
 * emits the same content with the machinery removed.
 */
export function toMarkdown(src: ExportSource): string {
  const { meta, notes } = src
  const out: string[] = [`# ${meta.title}`, '', `${meetingDate(meta)} · ${durationLabel(meta)}`, '']

  const userNotes = notes.userNotes.trim()
  if (userNotes) out.push('## My notes', '', userNotes, '')

  for (const section of SUMMARY_SECTIONS) {
    const text = notes.summary[section]?.trim()
    if (text) out.push(`## ${section}`, '', text, '')
  }

  if (notes.provider) {
    out.push(
      '',
      '---',
      '',
      // Provenance travels with the document. A summary forwarded to a
      // colleague should say what wrote it — the claim "this was generated"
      // is only useful if it survives leaving the app.
      `*Summary generated by ${notes.provider}${
        notes.generatedAt ? ` on ${new Date(notes.generatedAt).toLocaleString()}` : ''
      }. Transcribed locally by Oratio.*`,
    )
  }

  return `${out.join('\n').trimEnd()}\n`
}

/**
 * Plain text: the same document with every mark stripped.
 *
 * For pasting into an email or a ticket where Markdown would show as literal
 * asterisks. Headings become uppercase lines because a heading still has to
 * read as a heading once `##` is gone.
 */
export function toPlainText(src: ExportSource): string {
  const { meta, notes } = src
  const out: string[] = [meta.title, `${meetingDate(meta)} · ${durationLabel(meta)}`, '']

  const push = (heading: string, body: string): void => {
    out.push(heading.toUpperCase(), '', stripMarkdown(body), '')
  }

  const userNotes = notes.userNotes.trim()
  if (userNotes) push('My notes', userNotes)

  for (const section of SUMMARY_SECTIONS) {
    const text = notes.summary[section]?.trim()
    if (text) push(section, text)
  }

  return `${out.join('\n').trimEnd()}\n`
}

/**
 * Remove inline Markdown, keeping the words.
 *
 * Only the constructs the summary prompt actually asks for — bold, italic,
 * code, bullets. A general Markdown-to-text conversion would need a parser;
 * this needs to not leave asterisks in an email.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    // Bullets become "• " rather than being dropped: the list structure is
    // information, and a run of unmarked lines reads as one paragraph.
    .replace(/^\s*[-*+]\s+/gm, '• ')
}

/**
 * The transcript as readable text, one turn per paragraph.
 *
 * Used for the transcript half of PDF and Word, and available on its own.
 */
export function transcriptToText(transcript: Transcript): string {
  return transcript.segments
    .map((s) => `[${clock(s.startMs)}] ${speakerName(s)}: ${s.text}`)
    .join('\n')
}

/**
 * SubRip. Sequence number, timecode range, text, blank line.
 *
 * Indices are 1-based and must be contiguous — some players stop at a gap.
 * They are therefore generated from the array position rather than carried
 * from anything upstream.
 */
export function toSrt(transcript: Transcript): string {
  return (
    transcript.segments
      .map((s, i) =>
        [
          String(i + 1),
          `${timecode(s.startMs, true)} --> ${timecode(endOf(s), true)}`,
          `${speakerName(s)}: ${s.text}`,
          '',
        ].join('\n'),
      )
      .join('\n') || ''
  )
}

/** WebVTT. Same cues as SRT, a required header, and full stops in timecodes. */
export function toVtt(transcript: Transcript): string {
  const cues = transcript.segments.map((s) =>
    [
      `${timecode(s.startMs, false)} --> ${timecode(endOf(s), false)}`,
      // `<v Name>` is VTT's voice span. Players that understand it can style
      // per speaker; players that do not render the name inline, which is the
      // same thing SRT gets.
      `<v ${speakerName(s)}>${s.text}`,
      '',
    ].join('\n'),
  )
  return `WEBVTT\n\n${cues.join('\n')}`
}

/**
 * A cue must have positive duration.
 *
 * A zero-length or inverted range is dropped silently by most players, which
 * would lose the line rather than show it misaligned. VAD can produce a
 * segment whose end equals its start on a very short utterance, so this is a
 * real case and not defensive padding.
 */
const MIN_CUE_MS = 40

function endOf(segment: TranscriptSegment): number {
  return Math.max(segment.endMs, segment.startMs + MIN_CUE_MS)
}

/**
 * The transcript exactly as stored.
 *
 * Re-serialised rather than copied byte-for-byte so the export is a normalised
 * document regardless of how the file on disk happens to be formatted.
 */
export function toTranscriptJson(transcript: Transcript): string {
  return `${JSON.stringify(transcript, null, 2)}\n`
}

/**
 * A filename that survives leaving the vault.
 *
 * Session directories are timestamps, which are unambiguous inside the app and
 * meaningless in a Downloads folder. Titles are user text and can contain
 * anything, including path separators and characters Windows rejects — so this
 * runs even though we are macOS-only, because the file's destination may not
 * be.
 */
export function suggestedFilename(meta: SessionMeta, format: ExportFormat): string {
  const date = meta.startedAt.slice(0, 10)
  const title =
    meta.title
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'Meeting'
  return `${date} ${title}.${FORMATS[format].extension}`
}
