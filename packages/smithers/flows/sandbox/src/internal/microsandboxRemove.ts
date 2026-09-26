/**
 * Removes one Microsandbox machine, gracefully first and by force after.
 *
 * @since 0.1.0
 */

/** The destroy half of a vendor machine or lifecycle handle. */
interface Destroyable {
  destroy(options: { readonly timeoutMs: number; readonly force?: boolean }): Promise<void>
}

const isNotFound = (cause: unknown): boolean => Reflect.get(Object(cause), "code") === "sandboxNotFound"

/**
 * Stops and removes a machine. The first attempt lets the guest shut down
 * gracefully within `timeoutMs`; when it fails for any reason but the machine
 * already being gone, a second attempt passes `force` and skips the graceful
 * shutdown. A forced attempt that finds nothing means the first one removed
 * the machine after all. A machine missing before the first attempt is the
 * caller's to judge, so that rejection passes through unchanged.
 *
 * @category constructors
 * @since 0.1.0
 */
export const removeMachine = async (machine: Destroyable, timeoutMs: number): Promise<void> => {
  try {
    await machine.destroy({ timeoutMs })
  } catch (graceful) {
    if (isNotFound(graceful)) throw graceful
    try {
      await machine.destroy({ timeoutMs, force: true })
    } catch (forced) {
      if (!isNotFound(forced)) throw forced
    }
  }
}
