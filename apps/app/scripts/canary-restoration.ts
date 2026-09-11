export class RestorationFailure extends Error {
  readonly recovery: string
  readonly originalFailure: unknown

  constructor(message: string, recovery: string, originalFailure: unknown) {
    super(`RESTORATION FAILED: ${message}. RECOVERY REQUIRED: ${recovery}`)
    this.name = "RestorationFailure"
    this.recovery = recovery
    this.originalFailure = originalFailure
  }
}

/**
 * Run a live-state probe and do not release its outcome until restoration has
 * succeeded and the restored state has been independently re-read.
 */
export const withVerifiedRestoration = async <T>(
  work: () => Promise<T>,
  restore: () => Promise<void>,
  verify: () => Promise<void>,
  recovery: string
): Promise<T> => {
  let value: T | undefined
  let originalFailure: unknown
  try {
    value = await work()
  } catch (error) {
    originalFailure = error
  }

  try {
    await restore()
    await verify()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RestorationFailure(message, recovery, originalFailure)
  }

  if (originalFailure !== undefined) throw originalFailure
  return value as T
}
