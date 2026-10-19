import { useCallback, useEffect, useRef, useState } from 'react'
import type { PersistentReidentificationReminder } from '../../services/execution/persistentReidentificationReminderService'

/**
 * The load state of the persistent re-identification reminder
 * (`docs/PLANNER_SPEC.md` 16.15). A failed read is its own state and is never
 * shown as "nothing to re-identify".
 */
export type PersistentReidentificationReminderState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; reminder: PersistentReidentificationReminder }

/**
 * Loads the reminder once on mount and again on `reload()` (after an RNG Setup
 * save or an Identification adoption, whose provenance change may resolve or
 * re-open it). Only the latest load lands; a superseded or unmounted one is
 * dropped. During a reload the previous result stays shown until the new one
 * arrives. Nothing here is persisted.
 */
export function usePersistentReidentificationReminder(
  load: (() => Promise<PersistentReidentificationReminder>) | undefined,
): { state: PersistentReidentificationReminderState; reload: () => void } {
  const [state, setState] = useState<PersistentReidentificationReminderState>({ status: 'loading' })
  const generation = useRef(0)

  const reload = useCallback(() => {
    if (!load) return
    const current = ++generation.current
    void load()
      .then((reminder) => {
        if (generation.current === current) setState({ status: 'ready', reminder })
      })
      .catch(() => {
        if (generation.current === current) setState({ status: 'error' })
      })
  }, [load])

  useEffect(() => {
    reload()
    return () => {
      generation.current += 1
    }
  }, [reload])

  return { state, reload }
}
