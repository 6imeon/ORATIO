import { SUMMARY_SECTION_NAMES } from '@shared/ipc'
import type { SummaryState } from '../hooks/useSummary'

interface Props {
  summary: SummaryState
  /** True when the active provider sends the transcript off this machine. */
  cloud: boolean
  providerLabel: string | null
}

/**
 * The AI summary, rendered under the user's notes in grey.
 *
 * The black-text-is-yours / grey-text-is-AI diff is the one interaction worth
 * copying outright from Granola (UI.md §2): it is well-liked, and it makes the
 * provenance of every sentence visible without a badge, a tooltip, or a mode.
 * Nothing here is editable, which is what keeps that promise honest — if the
 * user could type into this pane, grey would stop meaning "the model wrote
 * this" and the distinction would be worth nothing.
 */
export function SummaryPane({ summary, cloud, providerLabel }: Props): React.JSX.Element | null {
  const { sections, status, error, hasSummary } = summary
  const streaming = status === 'running'

  if (!hasSummary && !streaming && !error) return null

  return (
    <section className="border-t border-(--color-line) px-5 pt-4 pb-8">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold tracking-wide text-(--color-ink-dim) uppercase">
          Summary
        </h2>
        <div className="flex items-center gap-3 text-[11px] text-(--color-ink-faint)">
          {/*
            The provenance line is deliberately always present rather than only
            on hover: where a meeting transcript was sent is not a detail to go
            looking for. "Stayed on this Mac" is the case worth stating out
            loud — it is the product's central claim, and a claim only counts
            if the UI makes it where the user can check it.
          */}
          {providerLabel && (
            <span>
              {cloud ? `Sent to ${providerLabel}` : `${providerLabel} · stayed on this Mac`}
            </span>
          )}
          {summary.generatedAt && !streaming && (
            <time dateTime={summary.generatedAt}>{formatWhen(summary.generatedAt)}</time>
          )}
          {hasSummary && !streaming && (
            <button
              type="button"
              onClick={() => void summary.reset()}
              className="rounded px-1.5 py-0.5 text-(--color-ink-faint) hover:bg-(--color-raised) hover:text-(--color-ink-dim)"
              // Named for what the user gets back, not for what is deleted.
              // Their notes are never at risk here — the two halves of
              // notes.md are separate fields — and the label should say so.
              title="Remove the summary. Your own notes are untouched."
            >
              Reset to my notes
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="mb-3 rounded-md bg-(--color-raised) px-3 py-2 text-[12px] text-(--color-ink-dim)">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-4">
        {SUMMARY_SECTION_NAMES.map((name) => {
          const text = sections[name]?.trim()
          if (!text) return null
          return (
            <article key={name}>
              <h3 className="mb-1 text-[12px] font-semibold text-(--color-ink-dim)">{name}</h3>
              {/*
                whitespace-pre-wrap rather than a Markdown renderer: the model
                emits bullets and bold, and rendering them properly is worth
                doing — but not at the cost of pulling a parser into the
                streaming path, where it would re-parse the whole section on
                every token. Plain text streams smoothly and reads correctly;
                the file on disk is real Markdown either way.
              */}
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-(--color-ink-dim)">
                {text}
              </p>
            </article>
          )
        })}

        {streaming && !hasSummary && (
          <p className="text-[13px] text-(--color-ink-faint)">Reading the transcript…</p>
        )}
      </div>
    </section>
  )
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
