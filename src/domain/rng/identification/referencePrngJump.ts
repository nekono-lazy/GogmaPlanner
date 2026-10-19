import {
  nextReferencePrngState,
  type ReferencePrngState,
} from '../production/referencePrng'

const STATE_WORD_BITS = 32
const STATE_WORD_COUNT = 4
const STATE_BIT_COUNT = STATE_WORD_BITS * STATE_WORD_COUNT

/**
 * Images of the 128 input basis bits under a GF(2)-linear state operator.
 * Each output word is stored separately so the representation describes the
 * Production PRNG state shape without duplicating its transition formula.
 */
export interface ReferencePrngJump {
  readonly outputXByInputBit: Uint32Array
  readonly outputYByInputBit: Uint32Array
  readonly outputZByInputBit: Uint32Array
  readonly outputWByInputBit: Uint32Array
}

function createEmptyOperator(): ReferencePrngJump {
  return {
    outputXByInputBit: new Uint32Array(STATE_BIT_COUNT),
    outputYByInputBit: new Uint32Array(STATE_BIT_COUNT),
    outputZByInputBit: new Uint32Array(STATE_BIT_COUNT),
    outputWByInputBit: new Uint32Array(STATE_BIT_COUNT),
  }
}

function setBasisImage(
  operator: ReferencePrngJump,
  inputBit: number,
  image: ReferencePrngState,
): void {
  operator.outputXByInputBit[inputBit] = image.x >>> 0
  operator.outputYByInputBit[inputBit] = image.y >>> 0
  operator.outputZByInputBit[inputBit] = image.z >>> 0
  operator.outputWByInputBit[inputBit] = image.w >>> 0
}

function identityOperator(): ReferencePrngJump {
  const identity = createEmptyOperator()
  for (let inputBit = 0; inputBit < STATE_BIT_COUNT; inputBit += 1) {
    const wordIndex = Math.floor(inputBit / STATE_WORD_BITS)
    const bitPattern = (1 << (inputBit % STATE_WORD_BITS)) >>> 0
    if (wordIndex === 0) identity.outputXByInputBit[inputBit] = bitPattern
    else if (wordIndex === 1) identity.outputYByInputBit[inputBit] = bitPattern
    else if (wordIndex === 2) identity.outputZByInputBit[inputBit] = bitPattern
    else identity.outputWByInputBit[inputBit] = bitPattern
  }
  return identity
}

function basisState(inputBit: number): ReferencePrngState {
  const wordIndex = Math.floor(inputBit / STATE_WORD_BITS)
  const bitPattern = (1 << (inputBit % STATE_WORD_BITS)) >>> 0
  return {
    x: wordIndex === 0 ? bitPattern : 0,
    y: wordIndex === 1 ? bitPattern : 0,
    z: wordIndex === 2 ? bitPattern : 0,
    w: wordIndex === 3 ? bitPattern : 0,
  }
}

/**
 * Constructs T from the images of every basis bit. The Production one-step
 * transition is the sole authority for those images.
 */
function productionTransitionOperator(): ReferencePrngJump {
  const transition = createEmptyOperator()
  for (let inputBit = 0; inputBit < STATE_BIT_COUNT; inputBit += 1) {
    setBasisImage(
      transition,
      inputBit,
      nextReferencePrngState(basisState(inputBit)),
    )
  }
  return transition
}

function applyLinearOperator(
  operator: ReferencePrngJump,
  state: ReferencePrngState,
): ReferencePrngState {
  const inputWords = [state.x >>> 0, state.y >>> 0, state.z >>> 0, state.w >>> 0]
  let outputX = 0
  let outputY = 0
  let outputZ = 0
  let outputW = 0

  for (let wordIndex = 0; wordIndex < STATE_WORD_COUNT; wordIndex += 1) {
    let remainingBits = inputWords[wordIndex]!
    while (remainingBits !== 0) {
      const lowestBit = (remainingBits & -remainingBits) >>> 0
      const bitWithinWord = 31 - Math.clz32(lowestBit)
      const inputBit = wordIndex * STATE_WORD_BITS + bitWithinWord
      outputX = (outputX ^ operator.outputXByInputBit[inputBit]!) >>> 0
      outputY = (outputY ^ operator.outputYByInputBit[inputBit]!) >>> 0
      outputZ = (outputZ ^ operator.outputZByInputBit[inputBit]!) >>> 0
      outputW = (outputW ^ operator.outputWByInputBit[inputBit]!) >>> 0
      remainingBits = (remainingBits & (remainingBits - 1)) >>> 0
    }
  }

  return { x: outputX, y: outputY, z: outputZ, w: outputW }
}

/** Returns the composed operator `after ∘ before`. */
function composeOperators(
  after: ReferencePrngJump,
  before: ReferencePrngJump,
): ReferencePrngJump {
  const composed = createEmptyOperator()
  for (let inputBit = 0; inputBit < STATE_BIT_COUNT; inputBit += 1) {
    setBasisImage(
      composed,
      inputBit,
      applyLinearOperator(after, {
        x: before.outputXByInputBit[inputBit]!,
        y: before.outputYByInputBit[inputBit]!,
        z: before.outputZByInputBit[inputBit]!,
        w: before.outputWByInputBit[inputBit]!,
      }),
    )
  }
  return composed
}

/** Applies a compiled forward advance without mutating the input state. */
export function applyReferencePrngJump(
  jump: ReferencePrngJump,
  state: ReferencePrngState,
): ReferencePrngState {
  return applyLinearOperator(jump, state)
}

/**
 * Compiles T^stepCount by binary exponentiation over GF(2).
 *
 * This is a GogmaArtianPlanner-owned forward-only jump-ahead optimization
 * derived from the GF(2)-linearity of the Production PRNG transition. The
 * one-step transition authority is `nextReferencePrngState()`.
 */
export function compileReferencePrngJump(stepCount: number): ReferencePrngJump {
  if (!Number.isSafeInteger(stepCount) || stepCount < 0) {
    throw new RangeError('Reference PRNG jump step count must be a non-negative safe integer')
  }

  let remaining = stepCount
  let result = identityOperator()
  let power = productionTransitionOperator()
  while (remaining !== 0) {
    if (remaining % 2 === 1) result = composeOperators(power, result)
    remaining = Math.floor(remaining / 2)
    if (remaining !== 0) power = composeOperators(power, power)
  }
  return result
}
