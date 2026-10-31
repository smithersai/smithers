/**
 * What the runner says about its machine with each claim, for the host's
 * fleet view: its version, the one-minute load average, and the free disk
 * where its checkouts live ({@link AgentRunner.Machine}).
 *
 * @since 1.0.0
 */

import type * as AgentRunner from "@smthrs/agent/AgentRunner"
import { statfsSync } from "node:fs"
import { loadavg } from "node:os"
import { packageVersion } from "../Version.ts"
import type * as Config from "./Config.ts"

/**
 * The machine's facts now. A fact the machine can't read now is left out,
 * which the host shows as unknown.
 *
 * @category constructors
 * @since 1.0.0
 */
export const facts = (config: Pick<Config.Checked, "stateDir">): AgentRunner.Machine => {
  const load1 = Math.round(loadavg()[0]! * 100) / 100
  let diskFreeGb: number | undefined
  try {
    const disk = statfsSync(config.stateDir)
    diskFreeGb = Math.round((disk.bavail * disk.bsize) / 1e7) / 100
  } catch {
    // The state directory isn't there yet: the first job makes it.
  }
  return {
    version: packageVersion.slice(0, 64),
    ...(Number.isFinite(load1) && load1 >= 0 ? { load1 } : {}),
    ...(diskFreeGb === undefined ? {} : { diskFreeGb })
  }
}
