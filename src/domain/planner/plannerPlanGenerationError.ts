/** A Plan generation inconsistency: an internal contract failure, never a Draft. */
export class PlannerPlanGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlannerPlanGenerationError'
  }
}
