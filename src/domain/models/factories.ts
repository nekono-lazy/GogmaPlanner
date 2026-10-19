import type {
  AppSettings,
  OwnedWeaponId,
  ISODateTimeString,
  RngState,
  TargetWeaponId,
} from './common'
import type {
  OwnedGogmaArtianWeapon,
  OwnedNormalArtianWeapon,
  OwnedWeapon,
  TargetWeapon,
} from './entities'
import {
  APP_SETTINGS_SCHEMA_VERSION,
  recommendedCandidateSearchDefaults,
  RNG_STATE_SCHEMA_VERSION,
} from './common'

// `executionInProgress` is Execution-owned: a newly registered weapon is never
// being produced, so the factory always starts it at null.
type CreateOwnedWeaponInputFor<T extends OwnedWeapon> = Omit<
  T,
  'isProtected' | 'executionInProgress' | 'createdAt' | 'updatedAt'
> & { isProtected?: boolean }

export type CreateOwnedWeaponInput =
  | CreateOwnedWeaponInputFor<OwnedNormalArtianWeapon>
  | CreateOwnedWeaponInputFor<OwnedGogmaArtianWeapon>

// The lifecycle fields are not user input: a new Target is always active and
// carries no completion metadata.
export type CreateTargetWeaponInput = Omit<
  TargetWeapon,
  | 'priority'
  | 'preferredOwnedWeaponId'
  | 'lifecycleStatus'
  | 'completedAt'
  | 'completedByProductionPlanId'
  | 'createdAt'
  | 'updatedAt'
> & {
  priority?: TargetWeapon['priority']
  preferredOwnedWeaponId?: TargetWeapon['preferredOwnedWeaponId']
}

function currentIsoTime(): ISODateTimeString {
  return new Date().toISOString()
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}

export function createOwnedWeaponId(createId: () => string = randomId): OwnedWeaponId {
  return createId() as OwnedWeaponId
}

export function createTargetWeaponId(createId: () => string = randomId): TargetWeaponId {
  return createId() as TargetWeaponId
}

export function createInitialRngState(
  now: ISODateTimeString = currentIsoTime(),
): RngState {
  return {
    id: 'current',
    schemaVersion: RNG_STATE_SCHEMA_VERSION,
    baseSeed: { value: null, isConfirmed: false, source: null },
    gogmaCounter: { value: null, isConfirmed: false, source: null },
    skillCounter: { value: null, isConfirmed: false, source: null },
    counterGate: { value: null, isConfirmed: false, source: null },
    notes: null,
    lastIdentifiedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function createOwnedWeapon(
  input: CreateOwnedWeaponInput,
  now: ISODateTimeString = currentIsoTime(),
): OwnedWeapon {
  if (input.kind === 'normal') {
    return {
      ...input,
      isProtected: input.isProtected ?? false,
      executionInProgress: null,
      createdAt: now,
      updatedAt: now,
    }
  }
  return {
    ...input,
    isProtected: input.isProtected ?? input.status === 'ideal',
    executionInProgress: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function createTargetWeapon(
  input: CreateTargetWeaponInput,
  now: ISODateTimeString = currentIsoTime(),
): TargetWeapon {
  return {
    ...input,
    priority: input.priority ?? 3,
    preferredOwnedWeaponId: input.preferredOwnedWeaponId ?? null,
    lifecycleStatus: 'active',
    completedAt: null,
    completedByProductionPlanId: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function createDefaultAppSettings(
  now: ISODateTimeString = currentIsoTime(),
): AppSettings {
  return {
    id: 'settings',
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    debugMode: false,
    resultPageSize: 50,
    defaultSearchLimit: 5000,
    candidateSearchDefaults: { ...recommendedCandidateSearchDefaults },
    createdAt: now,
    updatedAt: now,
  }
}
