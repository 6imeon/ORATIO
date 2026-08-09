import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'

interface Props {
  session: Session
  /** True when the session still has WAVs on disk — decides whether the
   *  audio-only alternative is worth offering. */
  hasAudio: boolean
  onClose: () => void
  /** Called after the session is gone, so the caller can move the selection. */
  onDeleted: (id: string) => void
}

/**
 * Confirm deleting a meeting, and offer the smaller thing first.
 *
 * "Delete the recording" is ambiguous in a way that matters here: people
 * usually mean *the audio* — the thing that feels sensitive — and not the
 * notes they spent the meeting writing. Offering only the destructive reading
 * of that sentence makes the safe choice invisible, so the audio-only path is
 * presented as a peer rather than buried in Settings.
 *
 * Deliberately not `window.confirm`. It blocks the whole renderer, cannot say
 * what is about to be lost in more than one line, and cannot offer a second
 * action — which is the entire point of this dialog.
 */
export function DeleteSessionDialog({
  session,
  hasAudio,
  onClose,
  onDeleted,
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState<'all' | 'audio' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [audioGone, setAudioGone] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  /*
   * Focus the destructive button but do NOT make it the default action: there
   * is no form here and Enter does not activate it, so the dialog opens with
   * the keyboard already in it without arming a one-keystroke delete.
   * Escape closes, which is the only shortcut worth having.
   */
  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && busy === null) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  async function deleteEverything(): Promise<void> {
    setBusy('all')
    setError(null)
    try {
      await window.oratio.session.remove(session.id)
      // Order matters: the parent unmounts this dialog by clearing the
      // selection, so nothing may touch state after it.
      onDeleted(session.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }

  async function deleteAudioOnly(): Promise<void> {
    setBusy('audio')
    setError(null)
    try {
      await window.oratio.session.discardAudio(session.id)
      setAudioGone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Audio can only be discarded once a transcript exists — main refuses
   * otherwise, and rightly: before that the WAVs are the only copy of the
   * meeting. Saying so up front beats an error message after the click.
   */
  const transcribed = session.status === 'ready'
  const canDiscardAudio = hasAudio && transcribed && !audioGone

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // A click on the backdrop is the macOS way out of a sheet. Guarded while
      // busy so a mis-click cannot orphan an in-flight delete.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && busy === null) onClose()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        className="w-full max-w-sm rounded-xl border border-(--color-line) bg-(--color-surface) p-5 shadow-2xl"
      >
        <h2 id="delete-title" className="text-sm font-semibold text-(--color-ink)">
          Delete “{session.title}”?
        </h2>

        {/*
          Names what is lost rather than asking "are you sure". The list is
          the point: notes and summaries are the part people forget is in
          here, and they are not recoverable from anywhere else.
        */}
        <p className="mt-2 text-[13px] leading-relaxed text-(--color-ink-dim)">
          This removes the audio, transcript, notes and summary from your vault.
          It cannot be undone.
        </p>

        {canDiscardAudio && (
          <div className="mt-3 rounded-lg border border-(--color-line) bg-(--color-raised)/50 p-3">
            <p className="text-[12px] leading-relaxed text-(--color-ink-dim)">
              If it is the recording you want gone, delete just the audio and
              keep the transcript and your notes.
            </p>
            <button
              type="button"
              onClick={() => void deleteAudioOnly()}
              disabled={busy !== null}
              className="mt-2 rounded-md border border-(--color-line) px-2.5 py-1 text-[11px] text-(--color-ink) hover:bg-(--color-raised) disabled:opacity-40"
            >
              {busy === 'audio' ? 'Deleting audio…' : 'Delete audio only'}
            </button>
          </div>
        )}

        {audioGone && (
          <p className="mt-3 text-[12px] text-(--color-ink-dim)">
            Audio deleted. The transcript and your notes are still here.
          </p>
        )}

        {error && <p className="mt-3 text-[12px] text-(--color-live)">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            className="rounded-md border border-(--color-line) px-3 py-1.5 text-[12px] text-(--color-ink-dim) hover:bg-(--color-raised) disabled:opacity-40"
          >
            {audioGone ? 'Done' : 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void deleteEverything()}
            disabled={busy !== null}
            className="rounded-md bg-(--color-live) px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy === 'all' ? 'Deleting…' : 'Delete meeting'}
          </button>
        </div>
      </div>
    </div>
  )
}
