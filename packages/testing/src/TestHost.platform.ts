/**
 * The platform code of TestHost.vibe, which a .vibe file does not import as a value (EK4402): the real-time
 * delay of a scripted command.
 *
 * @since 1.0.0-rc.16
 */

/**
 * Resolves after `ms` milliseconds of real time. The scripted command stub
 * implements a foreign promise-returning interface (`JustBashLike`), so there
 * is no Effect fiber to sleep on `Clock`; the delay only makes a scripted
 * command observably slow to its caller.
 *
 * @category platform
 * @since 1.0.0-rc.16
 * @throws {never}
 */
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
