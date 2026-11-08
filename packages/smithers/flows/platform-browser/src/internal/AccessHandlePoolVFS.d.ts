/**
 * Types for the OPFS VFS `@journeyapps/wa-sqlite` ships without a declaration.
 *
 * The package's `imports` field maps `#access-handle-pool-vfs` to
 * `@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js` and its types
 * to this file, so every program that compiles this package's source, a
 * workspace app included, sees them without declaring the module itself.
 *
 * The pool keeps every SQLite file in one OPFS directory, behind synchronous
 * access handles, so it runs on the synchronous wa-sqlite build and only in a
 * dedicated worker.
 *
 * @since 1.0.0
 */

import type { Vfs } from "./WalBuffer.ts"

/**
 * The access-handle pool VFS, registered as `name`, keeping its files in
 * the OPFS directory `name`.
 *
 * @category models
 * @since 1.0.0
 */
export declare class AccessHandlePoolVFS implements Vfs {
  constructor(name: string, module: unknown)
  jOpen: Vfs["jOpen"]
  jWrite: Vfs["jWrite"]
  jRead: Vfs["jRead"]
  jSync: Vfs["jSync"]
  jFileSize: Vfs["jFileSize"]
  jTruncate: Vfs["jTruncate"]
  jClose: Vfs["jClose"]
  jDelete: Vfs["jDelete"]
  /** Opens the directory and takes a synchronous access handle on every file in it. */
  isReady(): Promise<boolean>
  /** Releases every access handle. */
  close(): Promise<void>
}
