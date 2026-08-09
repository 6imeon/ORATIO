import type { ModelId } from '@shared/types'
import { MODEL_INSTALLED_BYTES, formatSize } from '@shared/models'
import { useModels, type ModelRow } from '../hooks/useModels'

interface Props {
  activeModel: ModelId
  onSelect: (id: ModelId) => void
}

/**
 * The four models, with real numbers.
 *
 * Sizes come from `models.ts`, where they are measured tarball sizes rather
 * than estimates, and both figures are shown: the download and what it costs
 * on disk afterwards. For the Whisper builds those differ by hundreds of
 * megabytes — small.en downloads 636 MB and settles at 358 MB once the fp32
 * weights are pruned — and showing only one of them would mislead in whichever
 * direction it was picked.
 */
export function ModelPicker({ activeModel, onSelect }: Props): React.JSX.Element {
  const { rows, loaded, error, download, cancel, remove } = useModels()

  if (!loaded) {
    return <p className="text-[13px] text-(--color-ink-dim)">Loading models…</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <ModelCard
          key={row.id}
          row={row}
          active={row.id === activeModel}
          onSelect={() => onSelect(row.id)}
          onDownload={() => void download(row.id)}
          onCancel={() => void cancel(row.id)}
          onRemove={() => void remove(row.id)}
        />
      ))}
      {error && <p className="text-xs text-(--color-live)">{error}</p>}
    </div>
  )
}

function ModelCard({
  row,
  active,
  onSelect,
  onDownload,
  onCancel,
  onRemove,
}: {
  row: ModelRow
  active: boolean
  onSelect: () => void
  onDownload: () => void
  onCancel: () => void
  onRemove: () => void
}): React.JSX.Element {
  const ready = row.state.status === 'ready'
  const downloading = row.state.status === 'downloading'

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        active
          ? 'border-(--color-me) bg-(--color-raised)'
          : 'border-(--color-line) bg-(--color-surface)'
      }`}
    >
      <div className="flex items-baseline gap-2">
        {/*
          Selecting a model is only offered once it is on disk. A radio that
          could be set to something absent would make the recording path fail
          later, far from the click that caused it.
        */}
        <button
          type="button"
          onClick={onSelect}
          disabled={!ready || active}
          className="text-[13px] font-medium text-(--color-ink) disabled:cursor-default"
        >
          {row.label}
        </button>

        {active && (
          <span className="rounded-sm bg-(--color-me) px-1.5 py-px text-[10px] font-medium text-white">
            In use
          </span>
        )}
        {row.recommended && !active && (
          <span className="text-[10px] text-(--color-ink-faint)">Recommended</span>
        )}

        <span className="ml-auto font-mono text-[11px] text-(--color-ink-faint) tabular-nums">
          {ready ? `${formatSize(MODEL_INSTALLED_BYTES[row.id])} on disk` : formatSize(row.sizeBytes)}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-(--color-ink-dim)">{row.description}</p>

      {downloading && (
        <div className="mt-2">
          <div className="h-1 overflow-hidden rounded-full bg-(--color-raised)">
            <div
              className="h-full rounded-full bg-(--color-me) transition-[width]"
              style={{ width: `${Math.round(row.state.progress * 100)}%` }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2">
            {/* Past 90% the bar is verifying and unpacking, not downloading —
                see FirstRunView for why the distinction is worth making. */}
            <span className="font-mono text-[11px] text-(--color-ink-faint) tabular-nums">
              {Math.round(row.state.progress * 100)}%
              {row.state.progress >= 0.9 && ' — unpacking'}
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="ml-auto text-[11px] text-(--color-ink-dim) hover:text-(--color-ink)"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/*
        A failed download says why and offers the retry in the same place. This
        is the most likely thing to fail on first run (ARCHITECTURE §4.4), and
        it is also the first thing a new user does — an error with no way
        forward here reads as the product being broken.
      */}
      {row.state.status === 'failed' && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-(--color-live)">
            {row.state.error ?? 'Download failed.'}
          </span>
          <button
            type="button"
            onClick={onDownload}
            className="ml-auto rounded-md bg-(--color-ink) px-2 py-1 text-[11px] font-medium text-(--color-surface) hover:opacity-90"
          >
            Try again
          </button>
        </div>
      )}

      {!downloading && row.state.status !== 'failed' && (
        <div className="mt-2 flex items-center gap-3">
          {ready ? (
            <>
              {!active && (
                <button
                  type="button"
                  onClick={onSelect}
                  className="rounded-md bg-(--color-ink) px-2 py-1 text-[11px] font-medium text-(--color-surface) hover:opacity-90"
                >
                  Use this model
                </button>
              )}
              {/*
                The model in use cannot be deleted. Doing so would leave the
                next recording with nothing to transcribe with, and the failure
                would surface after a meeting rather than here.
              */}
              <button
                type="button"
                onClick={onRemove}
                disabled={active}
                title={active ? 'Switch to another model before deleting this one' : undefined}
                className="ml-auto text-[11px] text-(--color-ink-dim) hover:text-(--color-live) disabled:cursor-default disabled:text-(--color-ink-faint) disabled:hover:text-(--color-ink-faint)"
              >
                Delete
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onDownload}
              className="rounded-md bg-(--color-ink) px-2 py-1 text-[11px] font-medium text-(--color-surface) hover:opacity-90"
            >
              Download
            </button>
          )}
        </div>
      )}
    </div>
  )
}
