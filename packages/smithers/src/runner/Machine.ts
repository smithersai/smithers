/**
 * What the runner reads of its machine, to admit jobs by it, and says about
 * it with each claim, for the host's fleet view: its version, the one-minute
 * load average, the free disk where its checkouts live, and why it holds back
 * ({@link AgentRunner.Machine}).
 *
 * @since 1.0.0
 */

import type * as AgentRunner from "@smthrs/agent/AgentRunner"
import { statfsSync } from "node:fs"
import { availableParallelism, loadavg } from "node:os"
import { packageVersion } from "../Version.ts"
import type * as Config from "./Config.vibe"

/**
 * What the runner reads of its machine before each claim: its CPUs, the
 * one-minute load average and the free disk in gigabytes where its checkouts
 * live. A fact it couldn't read is left out.
 *
 * @category models
 * @since 1.0.0
 */
export interface Reading {
  readonly cpus: number
  readonly load1?: number | undefined
  readonly diskFreeGb?: number | undefined
}

/**
 * The machine now.
 *
 * @category constructors
 * @since 1.0.0
 */
export const read = (config: Pick<Config.Checked, "stateDir">): Reading => {
  const load1 = loadavg()[0]!
  let diskFreeGb: number | undefined
  try {
    const disk = statfsSync(config.stateDir)
    diskFreeGb = (disk.bavail * disk.bsize) / 1e9
  } catch {
    // The state directory isn't there yet: the first job makes it.
  }
  return {
    cpus: availableParallelism(),
    ...(Number.isFinite(load1) && load1 >= 0 ? { load1 } : {}),
    ...(diskFreeGb === undefined ? {} : { diskFreeGb })
  }
}

/**
 * The facts a claim carries for `reading`, and why the runner holds back
 * when it does (`Admission.ts`). The host shows a fact left out as unknown.
 *
 * @category constructors
 * @since 1.0.0
 */
export const facts = (reading: Reading, held?: string): AgentRunner.Machine => ({
  version: packageVersion.slice(0, 64),
  ...(reading.load1 === undefined ? {} : { load1: Math.round(reading.load1 * 100) / 100 }),
  ...(reading.diskFreeGb === undefined ? {} : { diskFreeGb: Math.round(reading.diskFreeGb * 100) / 100 }),
  ...(held === undefined ? {} : { held })
})
