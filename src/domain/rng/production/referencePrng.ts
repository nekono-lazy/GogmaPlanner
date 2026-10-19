/**
 * Reference-verified against GARP.lua v0.9.4 (`u32`, `initialize_rng`, and
 * `rng_step`) from WiseHorror/Gogma-Artian-Roll-Planner
 * @ eceb2bd9ca6f4897ec516387acab2ad6beb8b38b.
 */
const INITIAL_X = 0x159a55e5
const INITIAL_Y = 0x1f123bb5
const INITIAL_Z = 0x05491333
const INITIAL_W = 0x05491333
const MIX_CONSTANT = 0x65ac9365

/** Each Domain counter index addresses one ten-step reference RNG block. */
export const REFERENCE_RNG_BLOCK_SIZE = 10

export interface ReferencePrngState {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

export interface ReferenceRngBlock {
  readonly blockIndex: number
  readonly values: readonly number[]
}

/** Normalizes JavaScript bitwise results to the reference uint32 bit pattern. */
export function toUint32(value: number): number {
  return value >>> 0
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

/** One xorshift-family PRNG step from the pinned reference implementation. */
export function nextReferencePrngState(state: ReferencePrngState): ReferencePrngState {
  const t = toUint32(state.x ^ toUint32(state.x << 15))
  const nextW = toUint32(state.w ^ (state.w >>> 21) ^ t ^ (t >>> 4))
  return { x: state.y, y: state.z, z: state.w, w: nextW }
}

/**
 * Reproduces the pinned reference's fixed-state initialization and 100 rounds
 * of seed mixing. No arithmetic in this function is allowed to become a
 * floating-point RNG substitute.
 */
export function initializeReferencePrng(seed: number): ReferencePrngState {
  let seedState = toUint32(seed)
  let state: ReferencePrngState = {
    x: INITIAL_X,
    y: INITIAL_Y,
    z: INITIAL_Z,
    w: INITIAL_W,
  }

  for (let iteration = 1; iteration <= 100; iteration += 1) {
    const mixed = toUint32((MIX_CONSTANT >>> (seedState & 3)) ^ seedState)
    seedState = toUint32(
      toUint32(mixed << 4) ^
        toUint32(mixed << 3) ^
        (mixed >>> 3) ^
        (mixed >>> 4) ^
        mixed,
    )
    const t = toUint32(seedState ^ toUint32(seedState << 15))
    const nextW = toUint32(state.z ^ (state.z >>> 21) ^ t ^ (t >>> 4))
    state = { x: state.x, y: state.y, z: state.z, w: nextW }

    if (iteration < 100) {
      state = { x: state.y, y: state.z, z: state.w, w: state.w }
    }
  }

  return state
}

/** Mutable convenience wrapper; values are the post-step unsigned `w` words. */
export class ReferencePrng {
  private currentState: ReferencePrngState

  constructor(seed: number) {
    this.currentState = initializeReferencePrng(seed)
  }

  get state(): ReferencePrngState {
    return this.currentState
  }

  nextUint32(): number {
    this.currentState = nextReferencePrngState(this.currentState)
    return this.currentState.w
  }

  advance(steps: number): void {
    requireNonNegativeSafeInteger(steps, 'PRNG step count')
    for (let step = 0; step < steps; step += 1) {
      this.nextUint32()
    }
  }
}

/**
 * Returns the ten raw post-step words belonging to a zero-based counter block.
 * Block 0 begins at the initialized state; block 1 starts after ten steps.
 */
export function readReferenceRngBlock(seed: number, blockIndex: number): ReferenceRngBlock {
  requireNonNegativeSafeInteger(blockIndex, 'RNG block index')
  if (blockIndex > Math.floor(Number.MAX_SAFE_INTEGER / REFERENCE_RNG_BLOCK_SIZE)) {
    throw new RangeError('RNG block index is too large')
  }

  const rng = new ReferencePrng(seed)
  rng.advance(blockIndex * REFERENCE_RNG_BLOCK_SIZE)
  const values = Array.from(
    { length: REFERENCE_RNG_BLOCK_SIZE },
    () => rng.nextUint32(),
  )
  return { blockIndex, values }
}
