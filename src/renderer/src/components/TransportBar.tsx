import { useCallback, useEffect, useRef } from 'react'
import { formatClock } from '../lib/turns'
import type { PlaybackHandle } from '../hooks/usePlayback'

/**
 * Transport for transcript playback: play/pause, scrub, skip, speed.
 *
 * Sits above the transcript rather than floating over it. A transcript is read
 * while it plays, so a bar that overlays the text would cover the one thing
 * the user is looking at — and the drawer is already height-constrained.
 *
 * The scrubber is a real <input type="range">, so it is keyboard-operable and
 * announced as a slider without reimplementing any of that. Its units are
 * milliseconds on the shared session clock, which is the same clock the
 * transcript timestamps use.
 */

/** Offered speeds. Beyond 2× speech stops being followable, so it stops here. */
const RATES = [1, 1.25, 1.5, 1.75, 2] as const

const SKIP_MS = 10_000

export function TransportBar({ playback }: { playback: PlaybackHandle }): React.JSX.Element {
  const { playing, positionMs, durationMs, toggle, seek, nudge, step, rate, setRate } = playback
  const barRef = useRef<HTMLDivElement>(null)

  const position = positionMs ?? 0

  const cycleRate = useCallback((): void => {
    const i = RATES.indexOf(rate as (typeof RATES)[number])
    setRate(RATES[(i + 1) % RATES.length] ?? 1)
  }, [rate, setRate])

  /**
   * Space toggles playback, but only when the user is not typing.
   *
   * Notes are the primary surface in this app and the textarea is usually
   * focused, so an unguarded space bar would swallow every space in a
   * sentence. Bound on the window rather than the bar because the whole point
   * is to work while focus is elsewhere.
   */
  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      if (typing) return

      // Arrow keys inside the scrubber are the range input's own seek, and
      // stealing them would make it jump twice as far as the user asked.
      if (target?.getAttribute('type') === 'range') return

      if (e.key === ' ') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        nudge(-SKIP_MS)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        nudge(SKIP_MS)
      }
    },
    [toggle, nudge],
  )

  useKeyboard(onKeyDown)

  return (
    <div
      ref={barRef}
      className="flex shrink-0 items-center gap-2 border-b border-(--color-line) px-5 py-1.5"
    >
      <IconButton
        label="Previous turn"
        onClick={() => step(-1)}
        path="M13 5 7 10l6 5V5Z M6 5h1.5v10H6z"
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--color-ink) text-(--color-surface) hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--color-me) focus-visible:outline-none"
      >
        <svg viewBox="0 0 20 20" className="size-3.5" fill="currentColor" aria-hidden="true">
          {playing ? (
            <path d="M6 4h3v12H6zM11 4h3v12h-3z" />
          ) : (
            // Nudged right by a pixel: a triangle centred on its bounding box
            // reads as left-of-centre inside a circle.
            <path d="M7 4.5v11l9-5.5z" />
          )}
        </svg>
      </button>

      <IconButton
        label="Next turn"
        onClick={() => step(1)}
        path="M7 5l6 5-6 5V5Z M12.5 5H14v10h-1.5z"
      />

      <time className="ml-1 shrink-0 font-mono text-[11px] tabular-nums text-(--color-ink-dim)">
        {formatClock(position)}
      </time>

      <input
        type="range"
        min={0}
        max={Math.max(durationMs, 1)}
        value={Math.min(position, durationMs)}
        step={100}
        onChange={(e) => seek(Number(e.currentTarget.value))}
        aria-label="Seek"
        aria-valuetext={formatClock(position)}
        className="scrubber min-w-0 flex-1"
      />

      <time className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-ink-faint)">
        {formatClock(durationMs)}
      </time>

      <button
        type="button"
        onClick={cycleRate}
        aria-label={`Playback speed ${rate}×`}
        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-(--color-ink-dim) hover:bg-(--color-raised) hover:text-(--color-ink)"
      >
        {rate}×
      </button>

      {/* Skip is bound to ←/→ as well; the buttons make it discoverable. */}
      <div className="flex shrink-0 gap-0.5">
        <IconButton label="Back 10 seconds" onClick={() => nudge(-SKIP_MS)} path={BACK_10} />
        <IconButton label="Forward 10 seconds" onClick={() => nudge(SKIP_MS)} path={FWD_10} />
      </div>
    </div>
  )
}

const BACK_10 =
  'M10 4a6 6 0 1 1-5.65 8h1.6A4.5 4.5 0 1 0 10 5.5V8L6 5.75 10 3.5V4Z'
const FWD_10 = 'M10 4a6 6 0 1 0 5.65 8h-1.6A4.5 4.5 0 1 1 10 5.5V8l4-2.25L10 3.5V4Z'

function IconButton({
  label,
  onClick,
  path,
}: {
  label: string
  onClick: () => void
  path: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 shrink-0 items-center justify-center rounded text-(--color-ink-dim) hover:bg-(--color-raised) hover:text-(--color-ink) focus-visible:ring-2 focus-visible:ring-(--color-me) focus-visible:outline-none"
    >
      <svg viewBox="0 0 20 20" className="size-3.5" fill="currentColor" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  )
}

/**
 * Window-level keydown that always calls the latest handler.
 *
 * Registered once and reading through a ref, rather than re-binding whenever
 * the handler identity changes — it closes over `playing`, which flips on
 * every play and pause.
 */
function useKeyboard(handler: (e: KeyboardEvent) => void): void {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    const fn = (e: KeyboardEvent): void => ref.current(e)
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])
}
