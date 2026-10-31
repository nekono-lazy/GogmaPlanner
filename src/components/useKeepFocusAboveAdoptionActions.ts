import { useEffect, type RefObject } from 'react'

/** The space kept between a focused element of the Preview body and the adoption operations stuck below it. */
const FOCUS_CLEARANCE_PX = 8

/**
 * Keeps keyboard focus clear of the stuck adoption operations (`docs/UI_FLOW.md` 3.1: a fixed UI never hides the focus). When an
 * element of the Preview body gets focus behind them, the page scrolls just enough to show it above them - never past the element's
 * own top. Focus inside the operations, and an element already above them (the operations at their own place at the end of the
 * Preview), moves nothing. Shared by every Preview that sticks its adoption operations (Issue #319, Issue #324).
 */
export function useKeepFocusAboveAdoptionActions(bodyRef: RefObject<HTMLElement | null>, actionsRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const onFocusIn = (event: FocusEvent) => {
      const actions = actionsRef.current
      if (actions === null || !(event.target instanceof Element)) return
      const focused = event.target.getBoundingClientRect()
      const obscured = focused.bottom - actions.getBoundingClientRect().top
      if (obscured <= 0) return
      window.scrollBy({ top: Math.min(obscured + FOCUS_CLEARANCE_PX, Math.max(focused.top, 0)) })
    }
    body.addEventListener('focusin', onFocusIn)
    return () => body.removeEventListener('focusin', onFocusIn)
  }, [bodyRef, actionsRef])
}
