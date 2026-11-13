/**
 * Trusted, bounded Windows process identity query.
 * @since 1.0.0
 */

import { spawnSync } from "node:child_process"
import { parse } from "node:path"
import type { StartTime, SystemOptions } from "../ProcessReaper.ts"
import { packageRoot, resolveDefaultExecutable } from "./AtomicFileSystemExecutable.ts"
import { usableExecutable } from "./AtomicFileSystemTransport.ts"
const psTimeoutMs = 5000
/**
 * Builds the creation-time probe over trusted native operations.
 * @private
 * @since 1.0.0
 */
export const windowsIdentity = (
  options?: Pick<SystemOptions, "processExecutable">,
  native = {
    spawnSync,
    resolveDefaultExecutable,
    usableExecutable,
    configuredExecutable: () => process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  }
) =>
(pid: number): StartTime => {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0xffff_ffff) return { _tag: "unavailable" }
  try {
    const configured = options?.processExecutable ?? native.configuredExecutable()
    const executable = configured === undefined
      ? native.resolveDefaultExecutable(packageRoot, undefined)
      : native.usableExecutable(configured, undefined)
    const result = native.spawnSync(executable, ["--process-info", String(pid)], {
      cwd: parse(process.execPath).root,
      env: {},
      encoding: "utf8",
      timeout: psTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4096
    })
    if (result.error !== undefined || result.signal !== null || result.status !== 0) return { _tag: "unavailable" }
    const value = JSON.parse(result.stdout) as { readonly status?: unknown; readonly startedAtMs?: unknown } | null
    if (value?.status === "gone") return { _tag: "gone" }
    return value?.status === "started" && typeof value.startedAtMs === "number" &&
        Number.isSafeInteger(value.startedAtMs) && value.startedAtMs >= 0
      ? { _tag: "started", startedAtMs: value.startedAtMs }
      : { _tag: "unavailable" }
  } catch {
    return { _tag: "unavailable" }
  }
}
