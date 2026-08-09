import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@shared/types'

/**
 * There is no `vault` step, deliberately.
 *
 * The vault always has a default path under ~/Documents, so it can never be
 * *missing* — only not-yet-confirmed, which is a question, not a blocker. It
 * is therefore shown on the setup screen alongside the download rather than as
 * a gate in front of it: a new user who is happy with the default should not
 * have to answer a modal to reach the same place.
 */
export type FirstRunStep = 'checking' | 'model' | 'done'

interface UseFirstRun {
  step: FirstRunStep
  settings: Settings | null
  /** Re-derive from disk. Call after picking a vault or finishing a download. */
  recheck: () => Promise<void>
  /** Leave setup without finishing it. */
  skip: () => void
}

/**
 * Whether this user can actually get to a transcript yet.
 *
 * Derived from the filesystem on every check rather than stored as a "have we
 * onboarded" flag. A flag lies in exactly the cases that matter: a user who
 * deletes their only model, or moves their vault to a drive that is no longer
 * mounted, has completed onboarding and still cannot record. Deriving it means
 * the setup screen comes back precisely when it is needed again.
 *
 * The order is the order of dependency, not of importance — a model downloads
 * into userData and does not need the vault, but the vault question is one
 * click and the download is minutes, so asking first means the wait happens
 * once the user has nothing left to answer.
 */
export function useFirstRun(): UseFirstRun {
  const [step, setStep] = useState<FirstRunStep>('checking')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [skipped, setSkipped] = useState(false)

  const recheck = useCallback(async (): Promise<void> => {
    const [next, states] = await Promise.all([
      window.oratio.settings.get(),
      window.oratio.models.states(),
    ])
    setSettings(next)

    // "Any model installed", not "the active one". A user who downloaded a
    // different model and switched to it is set up; blocking them because the
    // default is absent would be a setup screen that cannot be dismissed.
    const hasModel = states.some((s) => s.status === 'ready')
    if (!hasModel) {
      setStep('model')
      return
    }
    setStep('done')
  }, [])

  useEffect(() => {
    void recheck()
  }, [recheck])

  return {
    step: skipped ? 'done' : step,
    settings,
    recheck,
    skip: () => setSkipped(true),
  }
}
