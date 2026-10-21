/**
 * Environment-variable tuning knobs read by several startup phases. Pure:
 * an unset, non-numeric or non-positive value means "use the default".
 */
export function positiveEnvMs(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function positiveEnvInteger(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * A count where 0 is meaningful (keep none). `unlimited` or `infinity` (any
 * case) removes the cap; anything that is not a whole number is rejected.
 */
export function nonNegativeEnvCount(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  if (/^(?:unlimited|infinity)$/i.test(raw)) return Number.POSITIVE_INFINITY
  if (!/^\d+$/.test(raw)) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Reads one tuning variable with `parse`. A value that is set but rejected
 * is reported through `onInvalid`, so a typo does not silently fall back to
 * the default.
 */
export function readTuningEnv<T>(
  name: string,
  parse: (name: string) => T | undefined,
  onInvalid: (name: string) => void
): T | undefined {
  const value = parse(name)
  if (value === undefined && process.env[name]?.trim()) onInvalid(name)
  return value
}
