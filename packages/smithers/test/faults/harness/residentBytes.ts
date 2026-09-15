/**
 * The resident set of another process.
 *
 * A gateway case runs the control plane as its own operating-system process, so
 * `process.memoryUsage()` inside the test measures the client and can never see
 * a subscriber queue or a retained history growing in the server. The size that
 * belongs to a pid is asked of the operating system instead.
 *
 * @since 1.0.0
 */
import * as ProcessTable from "../../../../testing/src/ProcessTable.ts"

/**
 * Resident bytes for `pid`.
 *
 * `ps` reports kibibytes, which is what every platform this tier runs on
 * agrees about; the conversion happens here so a case compares bytes with a
 * budget written in bytes.
 *
 * @since 1.0.0
 * @category getters
 */
export const residentBytes = async (pid: number): Promise<number> => {
  const stdout = ProcessTable.query({ pid, columns: ["rss"] })
  const kibibytes = Number.parseInt(stdout.trim(), 10)
  if (!Number.isFinite(kibibytes)) {
    throw new Error(`ps reported no resident set for pid ${pid}: ${JSON.stringify(stdout)}`)
  }
  return kibibytes * 1024
}
