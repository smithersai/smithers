/**
 * Host process access for `Ownership`, kept in TypeScript because a VibeLang
 * module does not read host globals.
 *
 * @since 1.0.0
 * @private
 */

/**
 * Returns the host `process` object. This known host adapter must not require
 * Node's ambient declarations merely to typecheck a portable consumer of the
 * root entry, so it reads `process` through `globalThis`.
 *
 * @since 1.0.0
 * @private
 */
export const hostProcess = (): { readonly kill: (pid: number, signal: 0) => boolean } =>
  Reflect.get(globalThis, "process")
