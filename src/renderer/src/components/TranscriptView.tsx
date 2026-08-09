import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatClock, type Turn } from '../lib/turns'
import { computeBalance } from '../lib/balance'
import { formatDuration, placeMutedMarkers } from '../lib/mutedMarkers'
import { usePlayback } from '../hooks/usePlayback'
import { TransportBar } from './TransportBar'
import type { MutedRange } from '@shared/types'

interface Props {
  sessionId: string
  /**
   * Already merged into speaker turns by the caller, so a two-hour transcript
   * is folded once rather than on every open of the drawer (UI.md §4).
   */
  turns: Turn[]
  /**
   * Turn to scroll to when the drawer opens. The drawer is a *targeted*
   * reveal, not a dumb toggle — that is the mitigation that makes layout J's
   * one real cost (notes and transcript not both full size) acceptable
   * (UI.md §3a).
   */
  revealTurn?: number | null
  /** Active timestamp, so the collapsed handle can show it while playing. */
  onActiveTime?: (ms: number | null) => void
  /**
   * Stretches where the user muted their own microphone. Rendered inline so a
   * gap in the transcript reads as a deliberate mute rather than a failure —
   * see `placeMutedMarkers`.
   */
  mutedRanges?: MutedRange[]
  /**
   * Save one corrected line. Absent when the transcript is not editable, which
   * hides the edit affordance rather than showing one that fails.
   */
  onCorrect?: (segmentIndex: number, text: string) => Promise<void>
}

/**
 * The transcript, as speaker turns with click-to-play.
 *
 * Clicking any line seeks the audio to that moment — the feature users most
 * often say is missing from the commercial tools, and one Granola
 * structurally cannot offer because it keeps no audio at all.
 *
 * Two <audio> elements, one per track, played TOGETHER and mixed by the
 * browser — so the meeting is heard as it happened, including the overlaps.
 * The files are never modified and attribution never depends on this; see
 * `usePlayback` for why single-track playback was wrong.
 */
export function TranscriptView({
  sessionId,
  turns,
  revealTurn,
  onActiveTime,
  mutedRanges,
  onCorrect,
}: Props): React.JSX.Element {
  const micRef = useRef<HTMLAudioElement>(null)
  const systemRef = useRef<HTMLAudioElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [urls, setUrls] = useState<{ mic: string | null; system: string | null } | null>(null)

  /**
   * Row DOM nodes, for the highlight path below. A ref map rather than state
   * because writing it must not re-render.
   */
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const activeRef = useRef(-1)

  useEffect(() => {
    void (async () => {
      const [mic, system] = await Promise.all([
        window.oratio.session.audioUrl(sessionId, 'mic'),
        window.oratio.session.audioUrl(sessionId, 'system'),
      ])
      setUrls({ mic, system })
    })()
  }, [sessionId])

  /**
   * Level-match the two tracks, once per session.
   *
   * The system track is a digital tap near full scale and the mic is an acoustic
   * capture, so mixing them raw buries the near-end speaker — measured at 18-27
   * dB apart depending on the microphone, and the gap is device-dependent, so
   * this is derived per session rather than fixed.
   *
   * ## Why `element.volume` and not a WebAudio gain graph
   *
   * Boosting the quiet track would be the better correction — it keeps the mix
   * at a normal listening level instead of pulling everything down to meet the
   * mic. It needs WebAudio, because `volume` is capped at 1.0 and can only
   * attenuate.
   *
   * That was built and **it silences playback**. `createMediaElementSource`
   * reroutes an element into the graph permanently, and in this renderer the
   * audio then never reaches the output: measured with both elements at
   * `readyState: 4`, unmuted, `volume: 1`, no media error, and the context
   * `running` with unity gain — every observable healthy, and no sound. The
   * cause was not identified; what is recorded here is that the approach does
   * not work in this environment, so that it is not attempted again blind.
   *
   * So the loud track is attenuated instead. The cost is real and known: the
   * whole mix sits at the quieter track's level (about -46 dBFS on a headset
   * recording), so the user turns their system volume up. Audible and quiet
   * beats balanced and silent.
   */
  useEffect(() => {
    if (!urls?.mic || !urls.system) return
    let cancelled = false

    void (async () => {
      const ctx = new AudioContext()
      try {
        const [mic, system] = await Promise.all(
          [urls.mic, urls.system].map(async (url) =>
            ctx.decodeAudioData(await (await fetch(url!)).arrayBuffer()),
          ),
        )
        if (cancelled) return

        const balance = computeBalance(mic ?? null, system ?? null)
        if (micRef.current) micRef.current.volume = balance.mic
        if (systemRef.current) systemRef.current.volume = balance.system
      } catch {
        // Leave both at full volume — an unbalanced mix beats no audio, and a
        // decode failure must not take the transcript view down with it.
        if (micRef.current) micRef.current.volume = 1
        if (systemRef.current) systemRef.current.volume = 1
      } finally {
        // Only ever used to read samples, never for playback, so it is closed
        // immediately rather than holding an audio unit open.
        void ctx.close()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [urls])

  /**
   * All transport state lives in the hook: one playhead on the shared session
   * clock, two elements taking turns being the one that runs. This view owns
   * only the rendering of it.
   */
  const playback = usePlayback(turns, urls, micRef, systemRef)

  // Null for both tracks means the audio was discarded — this session was
  // recorded with "don't keep audio", so there is nothing to play and the
  // lines must not pretend to be clickable.
  const hasAudio = playback.available

  /**
   * Move the highlight.
   *
   * This is the Vibe crash class in the exact place it bites: `timeupdate`
   * fires up to 66×/s, and doing this through React state would put
   * reconciliation on that path. Four separate Vibe issues are titled "UI
   * crashes with a removeChild DOM error" from mutating the tree here
   * instead (UI.md §1).
   *
   * So this only ever adds and removes a class on an already-rendered node.
   * It never inserts, never removes, never reorders. Adding and removing
   * nodes stays React's job exclusively.
   */
  const setActive = useCallback(
    (index: number) => {
      if (index === activeRef.current) return

      rowRefs.current.get(activeRef.current)?.classList.remove('turn-active')
      const node = rowRefs.current.get(index)
      node?.classList.add('turn-active')
      activeRef.current = index

      // Only on *change*, never on every tick, and `nearest` so a turn already
      // on screen doesn't yank the view while the user is reading it.
      node?.scrollIntoView({ block: 'nearest' })
      onActiveTime?.(index >= 0 ? (turns[index]?.startMs ?? null) : null)
    },
    [turns, onActiveTime],
  )

  /**
   * Mirror the hook's active turn onto the DOM.
   *
   * The hook computes the index (binary search, off `timeupdate`); this moves
   * the class. Keeping the two separate is what keeps React reconciliation off
   * a path that fires 66×/s — see `setActive` above.
   */
  useEffect(() => {
    setActive(playback.activeIndex)
  }, [playback.activeIndex, setActive])

  /**
   * Clicking a line plays from it — unless it is the line already playing, in
   * which case it pauses. Clicking the playing line and having it jump back to
   * its own start is the behaviour that made pausing impossible before.
   *
   * Read through a ref rather than closed over directly: `playback` gets a new
   * identity on every `timeupdate`, so a plain dependency here would hand
   * every row a fresh `onPlay` 66×/s and re-render the entire transcript.
   * The ref keeps `play` stable for the life of the view.
   */
  const playbackRef = useRef(playback)
  playbackRef.current = playback

  /**
   * Where the muted stretches fall in the turn list.
   *
   * Memoised on the two inputs rather than computed inline: this renders
   * inside the same list as the turns, and the transcript re-renders on every
   * play/pause. A scan per range per render would put avoidable work on a path
   * UI.md §4 already asks to keep clear.
   */
  const markers = useMemo(() => placeMutedMarkers(turns, mutedRanges), [turns, mutedRanges])

  /** Markers grouped by the turn they precede, so the render loop is one pass. */
  const markersBefore = useMemo(() => {
    const map = new Map<number, typeof markers>()
    for (const m of markers) {
      const at = map.get(m.beforeTurn)
      if (at) at.push(m)
      else map.set(m.beforeTurn, [m])
    }
    return map
  }, [markers])

  const play = useCallback((turn: Turn): void => {
    const p = playbackRef.current
    if (!p.available) return
    if (p.playing && p.activeIndex === turn.index) p.pause()
    else p.playTurn(turn)
  }, [])

  /**
   * Same stability problem as `register`, and the same fix: the callback handed
   * to every memoised row must not change identity, so the prop is read through
   * a ref rather than closed over.
   */
  const correctRef = useRef(onCorrect)
  correctRef.current = onCorrect

  const correct = useCallback(async (segmentIndex: number, text: string): Promise<void> => {
    await correctRef.current?.(segmentIndex, text)
  }, [])

  /**
   * Row registration, stable for the life of the view.
   *
   * `TurnRow` is memoised, so every prop it receives has to keep its identity
   * across renders or the memo does nothing — an inline `register` closure
   * per row would defeat it on the very first re-render.
   */
  const register = useCallback((index: number, node: HTMLElement | null): void => {
    if (node) rowRefs.current.set(index, node)
    else rowRefs.current.delete(index)
  }, [])

  // Targeted reveal. Runs after paint so the row exists; `center` rather than
  // `nearest` because arriving here means the user asked to be taken
  // somewhere, and landing at the very edge of the viewport doesn't read as
  // an answer.
  useEffect(() => {
    if (revealTurn == null) return
    const node = rowRefs.current.get(revealTurn)
    node?.scrollIntoView({ block: 'center' })
    setActive(revealTurn)
  }, [revealTurn, setActive])

  return (
    <div className="flex h-full flex-col">
      {urls?.mic && (
        <audio
          ref={micRef}
          src={urls.mic}
          /* Both tracks play together, so both must be buffered before the
             first play — "metadata" leaves the second one stalling audibly at
             the start. These are local files, so there is no bandwidth cost. */
          preload="auto"
          onTimeUpdate={(e) => playback.onTimeUpdate('mic', e.currentTarget)}
          onEnded={() => playback.onEnded('mic')}
        />
      )}
      {urls?.system && (
        <audio
          ref={systemRef}
          src={urls.system}
          /* Both tracks play together, so both must be buffered before the
             first play — "metadata" leaves the second one stalling audibly at
             the start. These are local files, so there is no bandwidth cost. */
          preload="auto"
          onTimeUpdate={(e) => playback.onTimeUpdate('system', e.currentTarget)}
          onEnded={() => playback.onEnded('system')}
        />
      )}

      {hasAudio && turns.length > 0 && <TransportBar playback={playback} />}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3">
        {urls && !hasAudio && (
          <p className="mb-2 text-xs text-(--color-ink-faint)">
            Audio was deleted after transcribing. The transcript is what was kept.
          </p>
        )}

        {turns.map((turn) => (
          <Fragment key={turn.index}>
            {markersBefore.get(turn.index)?.map((m) => (
              <MutedMarkerRow key={`muted-${m.startMs}`} marker={m} />
            ))}
            <TurnRow
              turn={turn}
              hasAudio={hasAudio}
              onPlay={play}
              register={register}
              onCorrect={correct}
              editable={onCorrect !== undefined}
            />
          </Fragment>
        ))}

        {/* A mute that ran past the last turn — including one still open when
            the recording stopped — has nothing to sit before. */}
        {markersBefore.get(turns.length)?.map((m) => (
          <MutedMarkerRow key={`muted-${m.startMs}`} marker={m} />
        ))}

        {turns.length === 0 && markers.length === 0 && (
          <p className="py-4 text-sm text-(--color-ink-dim)">
            No speech was detected in this recording.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * One turn, as a paragraph with a hanging indent.
 *
 * Not a chat bubble. Granola uses grey-left/green-right bubbles, which maps
 * neatly onto our two tracks — but the same review called the result "a
 * one-sided WhatsApp", and bubbles halve horizontal text density, which over
 * two hours is a great deal of scrolling for no information gained (UI.md §4).
 *
 * A <div> with an explicit click handler rather than a <button>: a button
 * containing a paragraph of prose fights text selection, and selecting across
 * the whole transcript is one of the four things we do that Granola doesn't.
 * Keyboard access is restored with role/tabIndex/Enter rather than given up.
 */
/**
 * "You were muted here."
 *
 * The reader half of P2. A muted stretch produces no segments, so without this
 * the transcript is silently missing the user — and a deliberate mute looks
 * exactly like a microphone that stopped working. That ambiguity is the thing
 * mute was built to remove; closing it live (the meter reads `muted`, the menu
 * bar says `Muted`) is no help a week later when the transcript is all that is
 * left.
 *
 * Deliberately not clickable, even though the audio exists and is seekable.
 * The whole point of the stretch is that there is nothing of the user in it,
 * and offering to play it invites the reading that Oratio kept something.
 * (The other track *is* in there and is reachable from the turns either side.)
 *
 * Not memoised: there is at most a handful of these, and they take no props
 * that change.
 */
function MutedMarkerRow({
  marker,
}: {
  marker: { startMs: number; endMs: number }
}): React.JSX.Element {
  return (
    <div className="my-1 flex items-center gap-2.5 px-2 py-1.5" role="note">
      <span className="h-px flex-1 bg-(--color-line)" />
      <span className="flex items-center gap-1.5 text-[11px] text-(--color-ink-faint)">
        <MutedMarkerIcon />
        <span>
          Your microphone was muted for {formatDuration(marker.endMs - marker.startMs)}
        </span>
        <time className="font-mono tabular-nums">{formatClock(marker.startMs)}</time>
      </span>
      <span className="h-px flex-1 bg-(--color-line)" />
    </div>
  )
}

function MutedMarkerIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M3 3l18 18" />
    </svg>
  )
}

const TurnRow = memo(function TurnRow({
  turn,
  hasAudio,
  onPlay,
  register,
  onCorrect,
  editable,
}: {
  turn: Turn
  hasAudio: boolean
  onPlay: (t: Turn) => void
  register: (index: number, node: HTMLElement | null) => void
  onCorrect: (segmentIndex: number, text: string) => Promise<void>
  editable: boolean
}): React.JSX.Element {
  const mine = turn.speaker === 'me'
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <TurnEditor
        turn={turn}
        onCorrect={onCorrect}
        onDone={() => setEditing(false)}
        register={register}
      />
    )
  }

  const corrected = turn.segments.some((s) => s.corrected)

  return (
    <div
      ref={(node) => register(turn.index, node)}
      // `mousedown`, not click: the action is not cancellable, and acting on
      // press rather than release saves ~50 ms of perceived latency — VS
      // Code's measurement (UI.md §9).
      onMouseDown={() => onPlay(turn)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPlay(turn)
        }
      }}
      role={hasAudio ? 'button' : undefined}
      tabIndex={hasAudio ? 0 : undefined}
      /*
       * Deliberately static — "Play from 2:14" rather than flipping to
       * "Pause". A label that tracked playback would have to be a prop, and a
       * prop that changes on every play/pause re-renders every row in the
       * transcript, which is exactly the cost `content-visibility` is here to
       * avoid. The transport bar carries the live play/pause state instead.
       */
      aria-label={hasAudio ? `Play from ${formatClock(turn.startMs)}` : undefined}
      // `turn` carries content-visibility; see styles.css.
      className={`turn group -mx-2 rounded-md px-2 py-2 transition-colors focus-visible:ring-2 focus-visible:ring-(--color-me) focus-visible:outline-none ${
        hasAudio ? 'cursor-pointer hover:bg-(--color-raised)' : ''
      }`}
    >
      <p className="mb-0.5 flex items-baseline gap-2">
        <span
          className={`text-xs font-semibold ${mine ? 'text-(--color-me)' : 'text-(--color-them)'}`}
        >
          {turn.speakerLabel ?? (mine ? 'You' : 'Them')}
        </span>
        {/*
          One timestamp per turn, at the handoff — not one per ASR segment.
          W3C: timestamps "only when useful"; the useful moment is the change
          of speaker (UI.md §4).
        */}
        <time className="font-mono text-[11px] tabular-nums text-(--color-ink-faint)">
          {formatClock(turn.startMs)}
        </time>
        {/*
          Provenance, not decoration. UI.md §86 treats "which words are the
          machine's and which are yours" as load-bearing, and an edited
          transcript that looks identical to machine output quietly launders
          one into the other.
        */}
        {corrected && (
          <span
            className="text-[10px] text-(--color-ink-faint)"
            title="You edited this line"
          >
            edited
          </span>
        )}
        {/*
          Stops the mousedown from reaching the row, which would seek the audio
          instead of opening the editor.
        */}
        {editable && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setEditing(true)}
            className="ml-auto text-[11px] text-(--color-ink-faint) opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-(--color-ink) focus-visible:outline-none"
          >
            Edit
          </button>
        )}
      </p>
      {/*
        Hanging indent: the speaker label sits proud and the prose aligns in a
        single column, so the eye tracks one left edge down a long transcript.
      */}
      <p className="pl-3 text-[13px] leading-relaxed text-(--color-ink)">{turn.text}</p>
    </div>
  )
})

/**
 * Editing one turn — one field per ASR segment, not one for the paragraph.
 *
 * This is the shape the data forces rather than a UI preference. A turn is
 * several segments merged for reading (see `mergeTurns`); a correction is
 * per-segment, because that is what carries `startMs`/`endMs`. One field for
 * the whole paragraph would have to split the user's text back across those
 * segments to save it, and any split that isn't exactly where the model put the
 * boundary silently moves words onto the wrong timestamp — click-to-play then
 * seeks to the wrong moment, which is the feature this transcript exists for.
 *
 * Splitting, merging and re-timing segments are all explicitly out of scope
 * (docs/PRIVACY.md §4.1). Fixing the words is not.
 */
function TurnEditor({
  turn,
  onCorrect,
  onDone,
  register,
}: {
  turn: Turn
  onCorrect: (segmentIndex: number, text: string) => Promise<void>
  onDone: () => void
  register: (index: number, node: HTMLElement | null) => void
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<string[]>(() => turn.segments.map((s) => s.text))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = drafts.some((d, i) => d !== turn.segments[i]?.text)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      // Sequential, not Promise.all: each write is a read-modify-write of the
      // same corrections.json, so concurrent saves would drop all but one.
      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i]
        const seg = turn.segments[i]
        if (draft === undefined || seg === undefined || draft === seg.text) continue
        await onCorrect(turn.firstSegment + i, draft)
      }
      onDone()
    } catch (err) {
      // Kept open with the text intact — the user typed it, and closing the
      // editor on a failed save is the one way to actually lose it.
      setError(err instanceof Error ? err.message : 'Could not save that edit.')
      setSaving(false)
    }
  }

  return (
    <div
      ref={(node) => register(turn.index, node)}
      className="turn -mx-2 rounded-md bg-(--color-raised) px-2 py-2"
    >
      <p className="mb-1 flex items-baseline gap-2">
        <span
          className={`text-xs font-semibold ${
            turn.speaker === 'me' ? 'text-(--color-me)' : 'text-(--color-them)'
          }`}
        >
          {turn.speakerLabel ?? (turn.speaker === 'me' ? 'You' : 'Them')}
        </span>
        <time className="font-mono text-[11px] tabular-nums text-(--color-ink-faint)">
          {formatClock(turn.startMs)}
        </time>
      </p>

      <div className="flex flex-col gap-1 pl-3">
        {turn.segments.map((seg, i) => (
          <textarea
            key={`${seg.startMs}-${i}`}
            value={drafts[i] ?? ''}
            autoFocus={i === 0}
            rows={1}
            onChange={(e) => {
              setDrafts((prev) => prev.map((d, j) => (j === i ? e.target.value : d)))
              // Grow with the text: a fixed height hides the end of a long
              // line, which is where ASR errors cluster.
              e.target.style.height = 'auto'
              e.target.style.height = `${e.target.scrollHeight}px`
            }}
            onKeyDown={(e) => {
              // Enter saves; Shift+Enter is a newline. Escape abandons.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void save()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                onDone()
              }
            }}
            className="w-full resize-none rounded border border-(--color-line) bg-(--color-bg) px-1.5 py-1 text-[13px] leading-relaxed text-(--color-ink) focus-visible:border-(--color-me) focus-visible:outline-none"
          />
        ))}
      </div>

      {/* Same treatment as SummaryPane's errors — the app has no danger token,
          and inventing one for a single message would fork the palette. */}
      {error && <p className="mt-1 pl-3 text-[11px] text-(--color-ink-dim)">{error}</p>}

      <div className="mt-1.5 flex items-center gap-2 pl-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="rounded bg-(--color-me) px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded px-2 py-1 text-[11px] text-(--color-ink-dim) hover:text-(--color-ink)"
        >
          Cancel
        </button>
        {turn.segments.some((s) => s.corrected) && (
          <button
            type="button"
            onClick={() => {
              // Revert to the machine's wording. `upsertCorrection` treats an
              // edit equal to `was` as a removal, so this deletes the
              // correction rather than storing a redundant one.
              setDrafts(turn.segments.map((s) => s.originalText ?? s.text))
            }}
            className="ml-auto text-[11px] text-(--color-ink-faint) hover:text-(--color-ink)"
          >
            Revert to original
          </button>
        )}
      </div>
    </div>
  )
}
