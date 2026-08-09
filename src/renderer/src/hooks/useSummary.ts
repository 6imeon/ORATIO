import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SUMMARY_SECTION_NAMES,
  type StoredSummary,
  type SummarySection,
} from '@shared/ipc'

export type SummaryStatus = 'idle' | 'running' | 'error'

export interface SummaryState {
  sections: Partial<Record<SummarySection, string>>
  status: SummaryStatus
  error: string | null
  generatedAt: string | null
  provider: string | null
  /** True once anything has been generated — drives "Reset to my notes". */
  hasSummary: boolean
  summarize: () => void
  cancel: () => void
  reset: () => Promise<void>
}

/**
 * Owns the summary for one session: load, stream, cancel, clear.
 *
 * Streaming state lives here rather than in `MeetingView` because the tokens
 * arrive on a main→renderer event that is not scoped to a component, and a
 * summary must keep filling in while the user scrolls, types, or opens the
 * transcript drawer.
 */
export function useSummary(sessionId: string): SummaryState {
  const [sections, setSections] = useState<Partial<Record<SummarySection, string>>>({})
  const [status, setStatus] = useState<SummaryStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ generatedAt: string | null; provider: string | null }>({
    generatedAt: null,
    provider: null,
  })

  /**
   * Guards every async write below against a session switch.
   *
   * Clicking through the sidebar while a summary streams would otherwise paint
   * one meeting's text into another's notes — the same out-of-order hazard
   * `MeetingView` guards its notes load against, but worse here because the
   * stream keeps arriving for as long as the model runs.
   */
  const active = useRef(sessionId)
  useEffect(() => {
    active.current = sessionId
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    setSections({})
    setStatus('idle')
    setError(null)

    void window.oratio.ai.summary(sessionId).then((stored: StoredSummary) => {
      if (cancelled) return
      setSections(stored.sections)
      setMeta({ generatedAt: stored.generatedAt, provider: stored.provider })
    })

    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    const offToken = window.oratio.on.aiToken((e) => {
      if (e.sessionId !== active.current) return
      setSections((prev) => ({ ...prev, [e.section]: (prev[e.section] ?? '') + e.delta }))
    })

    const offDone = window.oratio.on.aiDone((e) => {
      if (e.sessionId !== active.current) return
      setStatus(e.status === 'failed' ? 'error' : 'idle')
      setError(e.error ?? null)
      // Re-read from disk so the timestamp and provider shown in the UI are
      // the ones actually written into notes.md, not a guess made here.
      if (e.status !== 'failed') {
        void window.oratio.ai.summary(e.sessionId).then((stored) => {
          if (e.sessionId !== active.current) return
          setMeta({ generatedAt: stored.generatedAt, provider: stored.provider })
        })
      }
    })

    return () => {
      offToken()
      offDone()
    }
  }, [])

  const summarize = useCallback(() => {
    setSections({})
    setError(null)
    setStatus('running')
    // Errors arrive twice — as a rejection here and as an AI_DONE event — so
    // this only has to catch the rejection to stop an unhandled promise; the
    // message the user sees comes from the event, which every window gets.
    void window.oratio.ai.summarize(sessionId).catch(() => undefined)
  }, [sessionId])

  const cancel = useCallback(() => {
    void window.oratio.ai.cancel(sessionId)
  }, [sessionId])

  const reset = useCallback(async () => {
    await window.oratio.ai.clearSummary(sessionId)
    setSections({})
    setMeta({ generatedAt: null, provider: null })
    setError(null)
  }, [sessionId])

  return {
    sections,
    status,
    error,
    generatedAt: meta.generatedAt,
    provider: meta.provider,
    hasSummary: SUMMARY_SECTION_NAMES.some((s) => (sections[s] ?? '').trim().length > 0),
    summarize,
    cancel,
    reset,
  }
}
