import { useCallback, useEffect, useRef } from 'react'
import { TranscriptView } from './TranscriptView'
import { formatClock, type Turn } from '../lib/turns'
import type { DrawerHandle } from '../hooks/useDrawerState'
import type { MutedRange } from '@shared/types'

interface Props {
  sessionId: string
  /** Pre-merged upstream so the merge happens once per transcript, not once per open. */
  turns: Turn[]
  /** False while the session is still pending or transcribing. */
  transcribed: boolean
  drawer: DrawerHandle
  activeMs: number | null
  onActiveTime: (ms: number | null) => void
  revealTurn: number | null
  /** Passed through to the transcript so it can explain its own gaps. */
  mutedRanges?: MutedRange[]
  /** Save one corrected line. Omitted when the transcript is not editable. */
  onCorrect?: (segmentIndex: number, text: string) => Promise<void>
}

/** Below this the handle would be crushed against the window edge. */
const MIN_PANE_PX = 120

/**
 * How far the pointer must move before a press on the handle counts as a drag
 * rather than a click. Matches the few-pixel slop a trackpad produces during
 * an ordinary click.
 */
const DRAG_THRESHOLD_PX = 3

/**
 * The drawer: transcript pulled up from the bottom, over full-width notes.
 *
 * Layout J (UI.md §3a). Closed it is a single handle, so the app *is* the
 * notebook and we never pay for the transcript when we are not reading it —
 * but the handle is always visible, so the transcript is never hidden. That
 * last part is what Granola got wrong, and "no way to jump back through the
 * meeting" is one of its named complaints.
 */
export function TranscriptDrawer({
  sessionId,
  turns,
  transcribed,
  drawer,
  activeMs,
  onActiveTime,
  revealTurn,
  mutedRanges,
  onCorrect,
}: Props): React.JSX.Element {
  const paneRef = useRef<HTMLDivElement>(null)

  /**
   * Drag to resize.
   *
   * Pointer events with capture rather than window-level mousemove listeners:
   * capture keeps the stream coming when the pointer leaves the handle, which
   * it will on any fast drag, and it delivers a `pointerup` even if the
   * release happens outside the window. The mousemove version silently leaves
   * the drawer stuck to the cursor.
   */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pane = paneRef.current
      if (!pane) return
      // Capture keeps the move stream coming when the pointer leaves the
      // handle, which it will on any fast drag. Not fatal if it is refused —
      // the window-level listeners below are what actually drive the resize.
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // Ignored: an already-released or synthetic pointer id.
      }

      const rect = pane.getBoundingClientRect()
      const originY = e.clientY
      /**
       * A drag does not begin until the pointer has actually moved.
       *
       * Without this every *click* on the handle is a zero-distance drag, and
       * the `pointerup` that ends it snaps and persists a state — which then
       * races the double-click's cycle and silently overwrites it. The handle
       * is both a button and a drag surface, so the two gestures have to be
       * told apart by movement rather than by which one fires first.
       */
      let dragging = false

      const move = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.abs(ev.clientY - originY) < DRAG_THRESHOLD_PX) return
          dragging = true
        }
        const fromBottom = rect.bottom - ev.clientY
        drawer.drag(Math.min(1, Math.max(0, fromBottom / rect.height)))
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        // Only commit if this was a real drag. A plain click leaves the state
        // untouched for the click/double-click handlers to act on.
        if (dragging) drawer.endDrag()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [drawer],
  )

  /**
   * ⌘T.
   *
   * Bound on the window rather than the drawer because the focus is almost
   * always in the notes textarea when this is pressed — that is the whole
   * point of the shortcut. `preventDefault` because the default would reach
   * the browser's own new-tab binding.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        e.preventDefault()
        drawer.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  const open = drawer.fraction > 0.02
  const heightPx = `max(${MIN_PANE_PX}px, ${(drawer.fraction * 100).toFixed(2)}%)`

  return (
    <div ref={paneRef} className="pointer-events-none absolute inset-0 flex flex-col justify-end">
      <section
        aria-label="Transcript"
        style={{ height: open ? heightPx : undefined }}
        className={`pointer-events-auto flex flex-col border-t border-(--color-line) bg-(--color-surface) ${
          // No height transition while dragging: animating toward a target
          // that moves every pointer event makes the drawer lag the cursor,
          // and drag latency is the most perceptible kind there is (UI.md §0).
          drawer.dragging ? '' : 'transition-[height] duration-150 ease-out'
        }`}
      >
        <Handle
          drawer={drawer}
          onPointerDown={onPointerDown}
          turnCount={turns.length}
          activeMs={activeMs}
        />

        {open && (
          <div className="min-h-0 flex-1">
            {transcribed ? (
              <TranscriptView
                sessionId={sessionId}
                turns={turns}
                revealTurn={revealTurn}
                onActiveTime={onActiveTime}
                mutedRanges={mutedRanges}
                {...(onCorrect ? { onCorrect } : {})}
              />
            ) : (
              <p className="px-5 py-4 text-sm text-(--color-ink-dim)">
                Transcribing… this runs locally and takes a moment.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * The handle. Always visible, and always carrying information: turn count
 * while closed, active timestamp while playing (UI.md §3a). A handle that
 * only says "Transcript" wastes the one row that is on screen at all times.
 */
function Handle({
  drawer,
  onPointerDown,
  turnCount,
  activeMs,
}: {
  drawer: DrawerHandle
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  turnCount: number
  activeMs: number | null
}): React.JSX.Element {
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={drawer.cycle}
      /*
       * `onMouseDown` with preventDefault, not onClick, and this is the
       * load-bearing line for "opening must not steal focus from the notes
       * editor" (UI.md §3a): the default mousedown action is what moves focus,
       * so cancelling it leaves the caret mid-sentence in the textarea while
       * the drawer opens underneath. Without this, opening the drawer to check
       * a name costs you your place in the note you were writing.
       */
      onMouseDown={(e) => e.preventDefault()}
      className="flex h-10 shrink-0 cursor-row-resize items-center gap-3 px-5 select-none"
    >
      <div className="h-1 w-8 shrink-0 rounded-full bg-(--color-line)" />

      <button
        type="button"
        /*
         * Deliberately does NOT stopPropagation. The label sits in the middle
         * of the handle, so swallowing the event here would mean double-click
         * to cycle silently does nothing across most of the strip the user
         * would naturally aim at — the gesture would only work on the few
         * pixels of bare handle either side.
         *
         * `detail > 1` is the second click of a double-click: let it through
         * to the handle's cycle rather than toggling as well, or the two
         * gestures fight and the drawer ends up wherever the race lands.
         */
        onMouseDown={(e) => {
          e.preventDefault()
          if (e.detail > 1) return
          drawer.toggle()
        }}
        className="flex items-baseline gap-2 text-xs text-(--color-ink-dim) hover:text-(--color-ink)"
      >
        <span className="font-medium">Transcript</span>
        {activeMs !== null ? (
          <span className="font-mono tabular-nums text-(--color-me)">{formatClock(activeMs)}</span>
        ) : (
          turnCount > 0 && <span className="tabular-nums">{turnCount} turns</span>
        )}
      </button>

      <span className="ml-auto font-mono text-[11px] text-(--color-ink-faint)">⌘T</span>
    </div>
  )
}
