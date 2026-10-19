/** REFramework Lua normalizes its raw unsigned seed with this modulus. */
export const BASE_SEED_MODULUS = 100_000_000n

/** The raw REFramework seed API accepts an unsigned 64-bit value only. */
export const UINT64_MAX = (1n << 64n) - 1n

/**
 * Converts a raw unsigned 64-bit seed to the reference predictor's safe
 * decimal range. BigInt is required before modulo so no 64-bit precision is
 * lost at the JavaScript Number boundary.
 */
export function normalizeBaseSeed(rawSeed: bigint): number {
  if (rawSeed < 0n || rawSeed > UINT64_MAX) {
    throw new RangeError('Raw base seed must be an unsigned 64-bit integer')
  }

  return Number(rawSeed % BASE_SEED_MODULUS)
}
