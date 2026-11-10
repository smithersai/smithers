/**
 * The platform code of flows.vibe: the command limit the build wrote in as a global, which a .vibe file does not read.
 */

declare global {
  /** The deployment's `SANDBOX_COMMAND_MAX_SECONDS`, which the build writes in (vite.config.ts); unset where none did. */
  var __SANDBOX_COMMAND_MAX_SECONDS__: number | undefined
}

/**
 * The deployment's `SANDBOX_COMMAND_MAX_SECONDS` as the build wrote it in for
 * `globalThis.__SANDBOX_COMMAND_MAX_SECONDS__` (vite.config.ts), read once at load; `undefined` where no build did.
 */
export const deployedCommandMaxSeconds: number | undefined = globalThis.__SANDBOX_COMMAND_MAX_SECONDS__
