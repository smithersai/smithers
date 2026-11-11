/**
 * The filesystem and process calls `NodeJj`'s repository fences and config
 * inspection make, as one service a test can replace with a faulty one.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import { readFileSync } from "node:fs"
import { readdir, readFile, rename, rmdir, unlink } from "node:fs/promises"

/**
 * The host calls behind a repository fence: claiming and reclaiming lock
 * directories, dating lock owners, and reading a workspace's store pointer.
 * Each one fails as its Node counterpart does, with an errno-coded error.
 *
 * @category models
 * @since 1.0.0
 */
export interface NodeJjHostService {
  /** Reads a UTF-8 file, such as a procfs `stat` record. */
  readonly readFile: (path: string) => Promise<string>
  /** Reads a UTF-8 file synchronously, such as a workspace's `.jj/repo` pointer. */
  readonly readFileSync: (path: string) => string
  readonly rename: (from: string, to: string) => Promise<void>
  readonly readdir: (path: string) => Promise<Array<string>>
  readonly rmdir: (path: string) => Promise<void>
  readonly unlink: (path: string) => Promise<void>
  /** Sends `signal` to `pid`; signal `0` only checks that the process exists. */
  readonly kill: (pid: number, signal: number) => void
}

/**
 * The real Node calls.
 *
 * @category constructors
 * @since 1.0.0
 */
export const nodeHost: NodeJjHostService = {
  readFile: (path) => readFile(path, "utf8"),
  readFileSync: (path) => readFileSync(path, "utf8"),
  rename,
  readdir: (path) => readdir(path),
  rmdir,
  unlink,
  kill: (pid, signal) => {
    process.kill(pid, signal)
  }
}

/**
 * The host calls the current operation's fences use; {@link nodeHost} unless a
 * caller provides another.
 *
 * @category references
 * @since 1.0.0
 */
export const NodeJjHost = Context.Reference<NodeJjHostService>("@smthrs/jj/internal/NodeJjHost", {
  defaultValue: () => nodeHost
})
