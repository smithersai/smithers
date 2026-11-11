// The platform code of vm.vibe: the Microsandbox binary's location and environment, the host's identity and
// processes, and the plain checks that refuse bad sizing, which a .vibe file does not reach or throw directly.
import type { MicrosandboxSandbox } from "@smthrs/sandbox"
import * as Microsandbox from "microsandbox"
import { existsSync, readdirSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Every microVM runs at a lower CPU priority than this host: under 32 busy
 * guests a host that misses its 19 s run-lease heartbeat parks the whole sweep
 * (#3328). The SDK runs whatever binary `MSB_PATH` names, so it names
 * `msb-nice.sh`, which execs the bundled `msb` under `nice`. An operator's own
 * `MSB_PATH` is left alone.
 */
export const niceWrapper = fileURLToPath(new URL("./msb-nice.sh", import.meta.url))

/** Points the SDK at the niced bundled `msb`; throws when the bundled binary or its firmware is missing. */
export const configureMachine = (sdk: MicrosandboxSandbox.Sdk): void => {
  if (sdk !== Microsandbox || process.env.MSB_PATH !== undefined) return
  // The SDK's platform package sits beside it, as Node resolution finds it.
  const sdkRoot = fileURLToPath(new URL("..", import.meta.resolve("microsandbox")))
  const platform = join(dirname(sdkRoot), "@superradcompany", `microsandbox-${process.platform}-${process.arch}`)
  const bundled = join(platform, "bin", "msb")
  if (!existsSync(bundled)) throw new Error(`issue-sweep vm: no bundled msb at ${bundled}`)
  // msb looks for libkrunfw beside the binary MSB_PATH names, which is now the wrapper.
  const krunfw = readdirSync(join(platform, "lib")).find((name) => name.startsWith("libkrunfw."))
  if (krunfw === undefined) throw new Error(`issue-sweep vm: no libkrunfw in ${platform}/lib`)
  process.env.ISSUE_SWEEP_MSB = bundled
  process.env.MSB_LIBKRUNFW_PATH ??= join(platform, "lib", krunfw)
  process.env.MSB_PATH = niceWrapper
}

/**
 * `<host>:<pid>`: this process as a machine's holder.
 * @throws {never}
 */
export function defaultHolder(): string {
  return `${hostname()}:${process.pid}`
}

/**
 * Whether this process runs on Bun.
 * @throws {never}
 */
export function runningOnBun(): boolean {
  return process.versions.bun !== undefined
}

/**
 * Whether `<host>:<pid>` names a live process on this host.
 * @throws {never}
 */
export function holderAlive(holder: string): boolean {
  const [host, pid] = holder.split(":")
  if (host !== hostname()) return true
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The sizing options the checks below read. */
export interface Sizing {
  readonly agentsPerVm?: number | undefined
  readonly maxAgents?: number | undefined
  readonly maxVms?: number | undefined
  readonly bootConcurrency?: number | undefined
  readonly memoryBaseMib?: number | undefined
  readonly memoryPerAgentMib?: number | undefined
  readonly memoryMib?: number | undefined
  readonly cpus?: number | undefined
  readonly cpusPerAgent?: number | undefined
  readonly maxCpus?: number | undefined
}

/** Validate before provisioning; a bad capacity must never become an infinite wait. */
export const sizing = (options: Sizing = {}) => {
  for (
    const key of [
      "agentsPerVm",
      "maxAgents",
      "maxVms",
      "bootConcurrency",
      "memoryBaseMib",
      "memoryPerAgentMib",
      "memoryMib",
      "cpus",
      "cpusPerAgent",
      "maxCpus"
    ] as const
  ) {
    const value = options[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`${key} must be a positive integer`)
    }
  }
  const agentsPerVm = options.agentsPerVm ?? 1
  const memoryPerAgentMib = options.memoryPerAgentMib ?? 3072
  if (!Number.isSafeInteger((options.maxVms ?? 24) * agentsPerVm)) {
    throw new RangeError("maxVms * agentsPerVm must be a safe integer")
  }
  const requiredMemoryMib = (options.memoryBaseMib ?? 1024) + agentsPerVm * memoryPerAgentMib
  const memoryMib = options.memoryMib ?? (options.memoryBaseMib ?? 1024) + agentsPerVm * memoryPerAgentMib
  if (!Number.isSafeInteger(requiredMemoryMib * 1024 ** 2) || !Number.isSafeInteger(memoryMib * 1024 ** 2)) {
    throw new RangeError("memoryMib allocation and agent ceilings must have safe integer byte sizes")
  }
  if (agentsPerVm > 1 && memoryMib < requiredMemoryMib) {
    throw new RangeError("memoryMib must cover shared memory plus every agent's ceiling")
  }
  return {
    agentsPerVm,
    memoryPerAgentMib,
    memoryMib,
    cpus: options.cpus ?? Math.min(options.maxCpus ?? 8, 1 + agentsPerVm * (options.cpusPerAgent ?? 1))
  }
}

/** Durable jobs run one agent per machine; any other `agentsPerVm` is refused before anything boots. */
export const assertSingleAgent = (options: Sizing): void => {
  if ((options.agentsPerVm ?? 1) !== 1) throw new RangeError("durable jobs require agentsPerVm = 1")
}

/**
 * One process-wide instance per `what`, built once by `build` and shared by every caller that asks with the
 * same capacity `key`. Conflicting sizing in one host is refused.
 */
const shared = new Map<string, { readonly key: string; readonly value: unknown }>()
export const sharedInstance = <T>(what: string, key: string, build: () => T): T => {
  const existing = shared.get(what)
  if (existing !== undefined && existing.key !== key) {
    throw new Error(`issue-sweep ${what} already uses different capacity options`)
  }
  if (existing !== undefined) return existing.value as T
  const value = build()
  shared.set(what, { key, value })
  return value
}
