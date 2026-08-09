import { useCallback, useEffect, useState } from 'react'
import type { ModelId, ModelInfo, ModelState } from '@shared/types'

export interface ModelRow extends ModelInfo {
  state: ModelState
}

interface UseModels {
  rows: ModelRow[]
  /** Null until the first load resolves, so the UI can distinguish empty from pending. */
  loaded: boolean
  error: string | null
  download: (id: ModelId) => Promise<void>
  cancel: (id: ModelId) => Promise<void>
  remove: (id: ModelId) => Promise<void>
}

/**
 * The catalogue joined to what is actually on disk.
 *
 * Two sources, deliberately: `models.list()` is static metadata and
 * `models.states()` changes as things download. Joining them here means the
 * picker cannot show a size for one model and a status for another.
 *
 * Progress arrives on an event channel rather than by polling. That is not an
 * optimisation — a 636 MB download over a slow connection is minutes long, and
 * a progress bar that only advances when React happens to re-render is the
 * "most likely thing to fail with no feedback" that ARCHITECTURE §4.4 warns
 * about.
 */
export function useModels(): UseModels {
  const [catalogue, setCatalogue] = useState<ModelInfo[]>([])
  const [states, setStates] = useState<Record<string, ModelState>>({})
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStates = useCallback(async (): Promise<void> => {
    const list = await window.oratio.models.states()
    setStates(Object.fromEntries(list.map((s) => [s.id, s])))
  }, [])

  useEffect(() => {
    void (async () => {
      const [list] = await Promise.all([window.oratio.models.list(), refreshStates()])
      setCatalogue(list)
      setLoaded(true)
    })()
  }, [refreshStates])

  useEffect(() => {
    // Merge rather than replace: this event carries one model's state, and
    // replacing the map would blank every other row on each progress tick.
    return window.oratio.on.modelProgress((s) => {
      setStates((prev) => ({ ...prev, [s.id]: s }))
    })
  }, [])

  const download = useCallback(
    async (id: ModelId): Promise<void> => {
      setError(null)
      try {
        await window.oratio.models.download(id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        // Re-read from disk regardless of outcome. The progress events describe
        // what the download *reported*; this describes what is actually
        // installed, and a failure part-way through leaves the two disagreeing.
        await refreshStates()
      }
    },
    [refreshStates],
  )

  const cancel = useCallback(
    async (id: ModelId): Promise<void> => {
      await window.oratio.models.cancel(id)
      await refreshStates()
    },
    [refreshStates],
  )

  const remove = useCallback(
    async (id: ModelId): Promise<void> => {
      setError(null)
      try {
        await window.oratio.models.remove(id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        await refreshStates()
      }
    },
    [refreshStates],
  )

  const rows: ModelRow[] = catalogue.map((info) => ({
    ...info,
    state: states[info.id] ?? { id: info.id, status: 'not-downloaded', progress: 0 },
  }))

  return { rows, loaded, error, download, cancel, remove }
}
