/**
 * Bounded, explicit-column POSIX process probes for real-process tests.
 *
 * Kept on its own subpath because browser test hosts cannot load child_process.
 * @since 1.0.0
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process"

/**
 * Supported POSIX process-table columns.
 * @category models
 * @since 1.0.0
 */
export type Column = "pid" | "ppid" | "pgid" | "stat" | "comm" | "args" | "rss" | "lstart"

/**
 * Explicit columns and an optional single-process selection.
 * @category models
 * @since 1.0.0
 */
export interface Query {
  readonly columns: readonly [Column, ...Array<Column>]
  readonly pid?: number
  readonly timeoutMs?: number
}

/**
 * The process boundary, injectable for buffer and failure regressions.
 * @category models
 * @since 1.0.0
 */
export type Spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnSyncOptionsWithStringEncoding
) => SpawnSyncReturns<string>

/**
 * Queries only the requested columns, with a 64 MiB ceiling for busy hosts.
 * Prefer `comm` for executable names; script-marker containment probes need
 * `args` because an interpreted script's executable name is its interpreter.
 * A missing selected pid returns empty text. Probe failures always throw, so
 * an overflow or permission failure cannot masquerade as successful cleanup.
 * @category getters
 * @since 1.0.0
 */
export const query = ({ columns, pid, timeoutMs }: Query, spawn: Spawn = spawnSync): string => {
  const result = spawn("ps", [
    ...(pid === undefined ? ["-A"] : ["-p", String(pid)]),
    "-ww",
    "-o",
    columns.map((column) => `${column}=`).join(",")
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
  })
  if (result.error !== undefined) throw result.error
  if (result.status === 0 && result.stdout.trim() !== "") return result.stdout
  if (pid !== undefined && result.status === 1 && result.stdout.trim() === "") return result.stdout
  throw new Error(`ps failed (${result.status}): ${result.stderr}`)
}
