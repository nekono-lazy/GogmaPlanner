import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ReplanTargetSelection } from '../../domain/execution'
import type { ProductionPlanId, TargetWeaponId } from '../../domain/models/publicTypes'

/**
 * A runtime-only request to open the Build List's 「現在地点からの再計画」 with an initial selection (`docs/UI_FLOW.md` 16.5, Issue #276
 * PR-6B): from the proposal after a Build List addition (the Targets taken in) or from the breaking-change warning (the Target left
 * out). It names the Plan the proposal or the warning was about, so the replan is bound to that very Plan and another running Plan is
 * refused by the replan's own identity check (`running_plan_changed`). It never starts a calculation.
 *
 * It travels in the router's navigation state only - never a URL, IndexedDB, AppSettings or Export - and the Build List removes it from
 * the history entry as soon as it reads it, so a reload, back / forward or a later visit never opens the replan again by itself.
 */
export interface RunningPlanReplanOpenRequest {
  planId: ProductionPlanId
  selection: ReplanTargetSelection
}

const NAVIGATION_STATE_KEY = 'runningPlanReplanRequest'

export function runningPlanReplanInclusionRequest(
  planId: ProductionPlanId,
  targetWeaponIds: readonly TargetWeaponId[],
): RunningPlanReplanOpenRequest {
  return { planId, selection: { excludedTargetWeaponIds: [], includedTargetWeaponIds: [...targetWeaponIds] } }
}

export function runningPlanReplanExclusionRequest(planId: ProductionPlanId, targetWeaponId: TargetWeaponId): RunningPlanReplanOpenRequest {
  return { planId, selection: { excludedTargetWeaponIds: [targetWeaponId], includedTargetWeaponIds: [] } }
}

/** The navigation state that carries `request` to the Build List. */
export function runningPlanReplanNavigationState(request: RunningPlanReplanOpenRequest): Record<string, unknown> {
  return {
    [NAVIGATION_STATE_KEY]: {
      planId: request.planId,
      excludedTargetWeaponIds: [...request.selection.excludedTargetWeaponIds],
      includedTargetWeaponIds: [...request.selection.includedTargetWeaponIds],
    },
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '')
}

/**
 * The request a navigation state carries, or null. The state is untrusted (it survives in the browser history), so anything that is
 * not exactly a request shape is no request.
 */
export function readRunningPlanReplanNavigationState(state: unknown): RunningPlanReplanOpenRequest | null {
  if (typeof state !== 'object' || state === null) return null
  const value: unknown = (state as Record<string, unknown>)[NAVIGATION_STATE_KEY]
  if (typeof value !== 'object' || value === null) return null
  const { planId, excludedTargetWeaponIds, includedTargetWeaponIds } = value as Record<string, unknown>
  if (typeof planId !== 'string' || planId === '' || !isStringArray(excludedTargetWeaponIds) || !isStringArray(includedTargetWeaponIds)) {
    return null
  }
  return {
    planId: planId as ProductionPlanId,
    selection: {
      excludedTargetWeaponIds: excludedTargetWeaponIds as TargetWeaponId[],
      includedTargetWeaponIds: includedTargetWeaponIds as TargetWeaponId[],
    },
  }
}

export interface RunningPlanReplanNavigationRequestController {
  /** The request this visit arrived with, until it is taken or dismissed. */
  request: RunningPlanReplanOpenRequest | null
  /** Hands the request over once (null when there is none any more). */
  take(): RunningPlanReplanOpenRequest | null
  dismiss(): void
}

/**
 * The Build List side of the request: read once when the page mounts, and removed from the history entry at once (a replace
 * navigation with no state), whatever happens to it afterwards.
 */
export function useRunningPlanReplanNavigationRequest(): RunningPlanReplanNavigationRequestController {
  const location = useLocation()
  const navigate = useNavigate()
  const [request, setRequest] = useState(() => readRunningPlanReplanNavigationState(location.state))

  useEffect(() => {
    if (readRunningPlanReplanNavigationState(location.state) === null) return
    void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null })
  }, [location, navigate])

  // Handed over at most once, even when an effect that takes it runs twice before the state update lands.
  const takenRef = useRef(false)
  const take = useCallback(() => {
    if (takenRef.current || request === null) return null
    takenRef.current = true
    setRequest(null)
    return request
  }, [request])
  const dismiss = useCallback(() => {
    takenRef.current = true
    setRequest(null)
  }, [])
  return { request, take, dismiss }
}
