import { useEffect, useState } from 'react'
import type { ModelState, Settings } from '@shared/types'
import { MODELS, DEFAULT_MODEL, formatSize } from '@shared/models'

interface Props {
  settings: Settings | null
  /** Re-derive readiness from disk; moves past this screen once a model exists. */
  onReady: () => Promise<void>
  onSkip: () => void
}

/**
 * First run does exactly one thing.
 *
 * "I had no idea where the live transcript was, why the notes were empty" is a
 * named first-run complaint (UI.md §7, verified against tldv and Granola), and
 * the cause is a setup flow that explains the whole product before letting
 * anyone use it. This screen therefore has a single action — get the default
 * model onto the disk — and everything else is deferred to Settings.
 *
 * The download is the substance of it. Per ARCHITECTURE §4.4 it is both the
 * first thing a new user experiences and the most likely thing to fail, so it
 * gets a real percentage, a real error, and a retry in place. A spinner would
 * be indistinguishable from a hang for the several minutes this takes.
 */
export function FirstRunView({ settings, onReady, onSkip }: Props): React.JSX.Element {
  const [state, setState] = useState<ModelState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const model = MODELS[DEFAULT_MODEL]

  useEffect(() => {
    return window.oratio.on.modelProgress((s) => {
      if (s.id === DEFAULT_MODEL) setState(s)
    })
  }, [])

  async function download(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.oratio.models.download(DEFAULT_MODEL)
      await onReady()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function changeVault(): Promise<void> {
    await window.oratio.settings.pickVault()
    await onReady()
  }

  const downloading = busy && state?.status === 'downloading'
  const percent = Math.round((state?.progress ?? 0) * 100)

  return (
    <div className="flex h-screen items-center justify-center bg-(--color-ground) p-8">
      <div className="w-full max-w-md">
        <h1 className="text-lg font-semibold text-(--color-ink)">Set up Oratio</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-(--color-ink-dim)">
          Oratio transcribes your meetings on this Mac. It needs to download a
          speech model once — after that it works offline, and nothing you
          record is ever uploaded.
        </p>

        <div className="mt-6 rounded-lg border border-(--color-line) bg-(--color-surface) px-4 py-3.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-(--color-ink)">{model.label} model</span>
            <span className="ml-auto font-mono text-[11px] text-(--color-ink-faint) tabular-nums">
              {formatSize(model.sizeBytes)}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-(--color-ink-dim)">{model.description}</p>

          {downloading ? (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-(--color-raised)">
                <div
                  className="h-full rounded-full bg-(--color-me) transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center">
                {/*
                  The last tenth is not download time — ModelManager reserves
                  0.9–1.0 for checksum verification and bzip2 extraction, which
                  take several seconds and report no byte progress. Saying
                  "downloading" through that stretch describes the wrong thing
                  at exactly the point the bar stops moving, which is when a
                  user starts wondering whether it has hung.
                */}
                <span className="font-mono text-[11px] text-(--color-ink-faint) tabular-nums">
                  {percent}% — {percent < 90 ? 'downloading' : 'verifying and unpacking'}
                </span>
                <button
                  type="button"
                  onClick={() => void window.oratio.models.cancel(DEFAULT_MODEL)}
                  className="ml-auto text-[11px] text-(--color-ink-dim) hover:text-(--color-ink)"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void download()}
              disabled={busy}
              className="mt-3 w-full rounded-lg bg-(--color-ink) px-4 py-2 text-[13px] font-medium text-(--color-surface) hover:opacity-90 disabled:opacity-50"
            >
              {error ? 'Try again' : busy ? 'Starting…' : 'Download and continue'}
            </button>
          )}

          {error && <p className="mt-2 text-xs leading-relaxed text-(--color-live)">{error}</p>}
        </div>

        {/*
          Secondary, and below the primary action. The default vault is fine
          for most people, and putting the folder question first would make a
          one-click setup into a two-decision one.
        */}
        {settings && (
          <div className="mt-4 flex items-baseline gap-2">
            <span className="shrink-0 text-xs text-(--color-ink-dim)">Saving meetings to</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--color-ink-faint)">
              {settings.vaultPath}
            </span>
            <button
              type="button"
              onClick={() => void changeVault()}
              className="shrink-0 text-[11px] text-(--color-ink-dim) underline hover:text-(--color-ink)"
            >
              Change
            </button>
          </div>
        )}

        {/*
          Dismissible. A user who wants to look around before committing to a
          250 MB download should be able to, and the record button explains
          what is missing if they try to use it.
        */}
        <button
          type="button"
          onClick={onSkip}
          className="mt-6 text-xs text-(--color-ink-faint) hover:text-(--color-ink-dim)"
        >
          Skip for now
        </button>
      </div>
    </div>
  )
}
