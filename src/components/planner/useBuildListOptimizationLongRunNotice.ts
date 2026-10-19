import { useEffect, useState } from 'react'
import { BUILD_LIST_OPTIMIZATION_LONG_RUN_NOTICE_DELAY_MS } from './buildListOptimizationPresentation'

/** One run of the Build List optimization the running state belongs to (the plan creation press's `runId`, or the requestId). */
export type BuildListOptimizationRunKey = string | number

/**
 * U3 (`docs/PLANNER_SPEC.md` 17.16, `docs/UI_FLOW.md` 10.4): whether the run named `runKey` has been shown as running for 30 s.
 *
 * The count starts when the running state of that run is first shown (this hook's mount, or a new `runKey`) and lives in the screen
 * only: it is never sent to the Worker or the Domain, never stored, and never stops, cancels or changes the calculation. One timer
 * per run: a new `runKey` clears the previous run's timer and starts from zero, and an unmount (the run finished, was cancelled or
 * failed, or the screen was left) clears it, so no timer outlives its run. The flag is keyed by the run, so a previous run's elapsed
 * flag never shows for the next run - not even for the render before the effect replaces the timer.
 */
export function useBuildListOptimizationLongRunNotice(runKey: BuildListOptimizationRunKey): boolean {
  const [elapsedRunKey, setElapsedRunKey] = useState<BuildListOptimizationRunKey | null>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => setElapsedRunKey(runKey), BUILD_LIST_OPTIMIZATION_LONG_RUN_NOTICE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [runKey])
  return elapsedRunKey === runKey
}
