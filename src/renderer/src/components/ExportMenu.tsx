import { useEffect, useRef, useState } from 'react'
import type { ExportFormat } from '@shared/ipc'

interface Props {
  sessionId: string
  /** False before transcription finishes — the subtitle formats need it. */
  hasTranscript: boolean
}

/**
 * What each format is for, in the words of someone deciding.
 *
 * The label is the format; the hint is the reason to pick it. A list of seven
 * extensions is a quiz, and the difference between SRT and VTT is not something
 * anyone should be expected to know to get their notes out.
 */
const CHOICES: {
  format: ExportFormat
  label: string
  hint: string
  needsTranscript: boolean
}[] = [
  { format: 'md', label: 'Markdown', hint: 'For Obsidian, git, anything', needsTranscript: false },
  { format: 'pdf', label: 'PDF', hint: 'Fixed layout, for sending on', needsTranscript: false },
  { format: 'docx', label: 'Word', hint: 'Editable .docx', needsTranscript: false },
  { format: 'txt', label: 'Plain text', hint: 'No formatting, for email', needsTranscript: false },
  { format: 'srt', label: 'Subtitles', hint: '.srt, timed to the audio', needsTranscript: true },
  { format: 'vtt', label: 'WebVTT', hint: '.vtt, for web video', needsTranscript: true },
  { format: 'json', label: 'Transcript JSON', hint: 'Every segment, raw', needsTranscript: true },
]

/**
 * Export this meeting.
 *
 * The vault is already plain Markdown and JSON on disk, so this is not an
 * escape hatch from a proprietary store — that is what the vault is for. It is
 * for handing one meeting to someone who does not use Oratio, in the shape
 * their tools expect.
 *
 * Microsoft Loop is deliberately absent. There is no public API for creating
 * Loop pages — checked against the Graph v1.0 and beta metadata, which declare
 * no page, workspace or component entity — and the `.loop` file is a Fluid
 * Framework container with no published spec, so it cannot be generated
 * offline either. Loop does accept pasted Markdown, which is the one path that
 * works today and needs nothing from us: export Markdown, paste with
 * ⌘⇧V.
 */
export function ExportMenu({ sessionId, hasTranscript }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  /**
   * Include the transcript in the document formats.
   *
   * Off by default: the notes and summary are what a meeting record is for, and
   * a two-hour transcript appended to a one-page summary buries it. Kept as a
   * checkbox rather than as seven more menu rows.
   */
  const [withTranscript, setWithTranscript] = useState(false)

  // Dismiss on an outside click or Escape — the two things every menu on macOS
  // does, and whose absence reads as the menu being stuck.
  useEffect(() => {
    if (!open) return

    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function run(format: ExportFormat): Promise<void> {
    setBusy(format)
    setError(null)
    setDone(false)
    try {
      const path = await window.oratio.session.exportTo({
        sessionId,
        format,
        includeTranscript: withTranscript,
      })
      // Null means the user closed the save dialog, which is not a failure and
      // must not be reported as one.
      if (path) {
        setDone(true)
        setOpen(false)
        setTimeout(() => setDone(false), 2400)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md border border-(--color-line) px-2.5 py-1 text-[11px] text-(--color-ink-dim) hover:bg-(--color-raised)"
      >
        {done ? 'Exported' : 'Export'}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-lg border border-(--color-line) bg-(--color-surface) py-1 shadow-lg"
        >
          {CHOICES.map((choice) => {
            const unavailable = choice.needsTranscript && !hasTranscript
            return (
              <button
                key={choice.format}
                type="button"
                role="menuitem"
                disabled={unavailable || busy !== null}
                onClick={() => void run(choice.format)}
                title={unavailable ? 'Available once this meeting has been transcribed' : undefined}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-(--color-raised) disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="text-[12px] text-(--color-ink)">{choice.label}</span>
                <span className="ml-auto text-[10px] text-(--color-ink-faint)">
                  {busy === choice.format ? 'Saving…' : choice.hint}
                </span>
              </button>
            )
          })}

          <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-(--color-line) px-3 pt-2 pb-1.5">
            <input
              type="checkbox"
              checked={withTranscript}
              onChange={(e) => setWithTranscript(e.target.checked)}
              disabled={!hasTranscript}
              className="size-3 accent-(--color-me)"
            />
            <span className="text-[11px] text-(--color-ink-dim)">
              Include full transcript
            </span>
          </label>

          {error && <p className="px-3 py-1.5 text-[11px] text-(--color-live)">{error}</p>}
        </div>
      )}
    </div>
  )
}
