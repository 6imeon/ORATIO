import { useEffect, useRef, useState } from 'react'
import type { Transcript, TranscriptSegment } from '@shared/types'

interface Props {
  sessionId: string
  transcript: Transcript
}

/**
 * The transcript, with click-to-play.
 *
 * Clicking any line seeks the audio to that moment. This is the feature users
 * most often say is missing from the commercial tools — and one those tools
 * structurally cannot offer, because they delete the audio after
 * transcribing. We keep it on disk, so it costs nothing.
 *
 * Two <audio> elements, one per track, because the tracks are never mixed:
 * a "me" line plays from mic.wav, a "them" line from system.wav.
 *
 * Unless the user asked us not to keep it. A session recorded with
 * `discardAudio` has a transcript and no WAVs, and then playback is disabled
 * and said out loud rather than left as a play button that does nothing.
 */
export function TranscriptView({ sessionId, transcript }: Props): React.JSX.Element {
  const micRef = useRef<HTMLAudioElement>(null)
  const systemRef = useRef<HTMLAudioElement>(null)
  const [urls, setUrls] = useState<{ mic: string | null; system: string | null } | null>(null)
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      const [mic, system] = await Promise.all([
        window.oratio.session.audioUrl(sessionId, 'mic'),
        window.oratio.session.audioUrl(sessionId, 'system'),
      ])
      setUrls({ mic, system })
    })()
  }, [sessionId])

  // Null for both tracks means the audio was discarded — this session was
  // recorded with "don't keep audio", so there is nothing to play and the
  // lines must not pretend to be clickable.
  const hasAudio = Boolean(urls && (urls.mic || urls.system))

  function play(seg: TranscriptSegment, index: number): void {
    if (!hasAudio) return
    const el = seg.speaker === 'me' ? micRef.current : systemRef.current
    const other = seg.speaker === 'me' ? systemRef.current : micRef.current
    if (!el) return

    other?.pause()
    // Timestamps are stored on a shared clock across both tracks, so seeking
    // is a direct conversion with no per-track offset maths here.
    el.currentTime = seg.startMs / 1000
    void el.play()
    setPlayingIndex(index)
  }

  return (
    <div className="flex flex-col gap-1">
      {urls?.mic && (
        <audio ref={micRef} src={urls.mic} preload="metadata" onEnded={() => setPlayingIndex(null)} />
      )}
      {urls?.system && (
        <audio
          ref={systemRef}
          src={urls.system}
          preload="metadata"
          onEnded={() => setPlayingIndex(null)}
        />
      )}

      {urls && !hasAudio && (
        <p className="mb-1 px-2 py-1.5 text-xs text-neutral-500">
          Audio was discarded for this meeting. The transcript is all that was kept.
        </p>
      )}

      {transcript.segments.map((seg, i) => (
        <button
          key={`${seg.startMs}-${i}`}
          onClick={() => play(seg, i)}
          disabled={!hasAudio}
          className={`group flex gap-3 rounded px-2 py-1.5 text-left text-sm transition-colors ${
            hasAudio ? 'hover:bg-neutral-100 dark:hover:bg-neutral-800' : 'cursor-default'
          } ${playingIndex === i ? 'bg-blue-50 dark:bg-blue-950' : ''}`}
        >
          <time className="w-14 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-neutral-400">
            {formatClock(seg.startMs)}
          </time>
          <span
            className={`w-12 shrink-0 pt-0.5 text-xs font-medium ${
              seg.speaker === 'me'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-neutral-500'
            }`}
          >
            {seg.speakerLabel ?? (seg.speaker === 'me' ? 'You' : 'Them')}
          </span>
          <span className="flex-1">{seg.text}</span>
        </button>
      ))}

      {transcript.segments.length === 0 && (
        <p className="px-2 py-4 text-sm text-neutral-500">
          No speech was detected in this recording.
        </p>
      )}
    </div>
  )
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
