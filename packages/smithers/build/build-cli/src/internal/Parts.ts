/**
 * What a run spent its time on, part by part.
 *
 * A target's duration is one number. When a run costs more than the command
 * it wraps, that number cannot say where the time went: making the machine,
 * holding stored records against the checkout, the command itself, reading
 * what it read, keeping what it left, or storing the record. Each of those is
 * a part, timed on the wall clock and on the CPU clock, and written beside
 * the target's result in the run record.
 *
 * CPU time is this process's own plus that of every process it has waited
 * for. It is exact for a part while no other target runs beside it; with
 * several targets at once a part also holds what the others used meanwhile.
 *
 * @since 1.0.0
 */

import * as NodeFs from "node:fs"
import type { Parts } from "../Executor.ts"

/** Linux reports process times in ticks of a hundredth of a second, whatever the kernel's own tick is. */
const tickMs = 10

/**
 * The CPU time of every process this one has waited for, and of the
 * processes those waited for, read from the text of `/proc/self/stat`.
 * `undefined` when the text is not that file's.
 *
 * @category measuring
 * @since 1.0.0
 */
export const waitedCpuMs = (stat: string): number | undefined => {
  // The second field is the program's name in parentheses, and may itself hold spaces and parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  // Fields 16 and 17 of the file, `cutime` and `cstime`; the slice starts at field 3.
  const ticks = Number(fields[13]) + Number(fields[14])
  return Number.isFinite(ticks) && fields.length > 14 ? ticks * tickMs : undefined
}

/**
 * Reads the host's clocks.
 *
 * @category models
 * @since 1.0.0
 */
export interface Clocks {
  /** Milliseconds since this process started. */
  readonly now: () => number
  /** The CPU time this process and the processes it waited for have used, or nothing where that cannot be read. */
  readonly cpu: () => number | undefined
}

/**
 * Clocks that read this process: the wall clock since it started, its own CPU
 * time from Node, and that of the processes it waited for from `stat`, which
 * gives the text of `/proc/self/stat`. Where `stat` fails or gives another
 * text, as on every system but Linux, there is no CPU time.
 *
 * @category constructors
 * @since 1.0.0
 */
export const clocksOf = (stat: () => string): Clocks => ({
  now: () => performance.now(),
  cpu: () => {
    let waited: number | undefined
    try {
      waited = waitedCpuMs(stat())
    } catch {
      return undefined
    }
    if (waited === undefined) return undefined
    const own = process.cpuUsage()
    return waited + (own.user + own.system) / 1000
  }
})

/**
 * The clocks of this process.
 *
 * @category constructors
 * @since 1.0.0
 */
export const hostClocks: Clocks = clocksOf(() => NodeFs.readFileSync("/proc/self/stat", "utf8"))

/**
 * The parts of one run: of each target by its label, and of the run itself.
 *
 * @category models
 * @since 1.0.0
 */
export interface Ledger {
  /** Adds time to a part of a target, or of the run when `label` is undefined. */
  readonly spend: (label: string | undefined, part: string, ms: number, cpuMs?: number | undefined) => void
  /** Starts timing a part; the function it returns adds the time since. */
  readonly begin: (label: string | undefined, part: string) => () => void
  /** What a target spent, or the run when `label` is undefined; nothing when no part was timed. */
  readonly of: (label: string | undefined) => Parts | undefined
}

const round = (ms: number): number => Math.round(ms * 10) / 10

/**
 * A ledger that reads `clocks`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ledger = (clocks: Clocks = hostClocks): Ledger => {
  const wall = new Map<string | undefined, Record<string, number>>()
  const cpu = new Map<string | undefined, Record<string, number>>()
  const add = (
    into: Map<string | undefined, Record<string, number>>,
    label: string | undefined,
    part: string,
    ms: number
  ) => {
    const held = into.get(label) ?? {}
    held[part] = (held[part] ?? 0) + ms
    into.set(label, held)
  }
  const spend: Ledger["spend"] = (label, part, ms, cpuMs) => {
    add(wall, label, part, ms)
    if (cpuMs !== undefined) add(cpu, label, part, cpuMs)
  }
  return {
    spend,
    begin: (label, part) => {
      const began = clocks.now()
      const used = clocks.cpu()
      return () => {
        const now = clocks.cpu()
        spend(label, part, clocks.now() - began, used === undefined || now === undefined ? undefined : now - used)
      }
    },
    of: (label) => {
      const ms = wall.get(label)
      if (ms === undefined) return undefined
      const used = cpu.get(label)
      const rounded = (spent: Record<string, number>): Readonly<Record<string, number>> =>
        Object.fromEntries(Object.entries(spent).map(([part, value]) => [part, round(value)]))
      return { ms: rounded(ms), ...(used === undefined ? {} : { cpuMs: rounded(used) }) }
    }
  }
}

let command: { readonly at: number; readonly cpu: number | undefined } | undefined
let taken = false

/**
 * Says that the command line has been read and the command is about to load
 * its workspace: everything before this moment is the start of the program.
 * The first call counts.
 *
 * @category measuring
 * @since 1.0.0
 */
export const commandBegan = (clocks: Clocks = hostClocks): void => {
  command ??= { at: clocks.now(), cpu: clocks.cpu() }
}

/**
 * What the program spent before its first run began, for that run's ledger:
 * `start` up to {@link commandBegan}, and `plan` from there to now, which
 * holds loading the workspace and deciding what to run. Only the first run of
 * a process is given them, and only in a program that called
 * {@link commandBegan}; `forget` makes the next call the first again.
 *
 * @category measuring
 * @since 1.0.0
 */
export const beforeRun = (into: Ledger, clocks: Clocks = hostClocks, forget = false): void => {
  if (forget) taken = false
  if (command === undefined || taken) return
  taken = true
  const cpu = clocks.cpu()
  into.spend(undefined, "start", command.at, command.cpu)
  into.spend(
    undefined,
    "plan",
    clocks.now() - command.at,
    cpu === undefined || command.cpu === undefined ? undefined : cpu - command.cpu
  )
}
