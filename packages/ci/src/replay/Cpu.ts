/**
 * How much CPU time a step used: every process under the one the replay
 * started, added up from what the machine says while they run.
 *
 * A step's CPU time does not reach the program that started it. A jail keeps
 * it, a process that outlives its parent takes it elsewhere, and only the
 * time of children a process waited for is handed up. So the processes are
 * read while the step runs, and each is counted for itself.
 *
 * @since 0.1.0
 */

import type { ProcessEntry } from "./ProcessTable.ts"

/** What is known of one process: the most it was seen to have used, and who started it. */
interface Seen {
  /** The CPU time of the process itself. */
  own: number
  /** The time of the children it had waited for when it was first seen. */
  readonly first: number
  /** The most time of children it waited for that was seen. */
  waited: number
  /** Its parent when it was last seen, when that is a process of the tree. */
  parent: string | undefined
  /** Whether the last reading still held it. */
  alive: boolean
}

/**
 * The CPU time of one process tree, kept over readings of the machine's
 * processes.
 *
 * @category models
 * @since 0.1.0
 */
export interface CpuMeter {
  /** The process the tree starts at. */
  readonly root: number
  /** Every process the tree was seen to hold, by process id and start time. */
  readonly seen: Map<string, Seen>
}

/**
 * A meter for the tree under `root`, with nothing read.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const meterOf = (root: number): CpuMeter => ({ root, seen: new Map() })

/** A process id is used again in time; with its start time it names one process. */
const keyOf = (entry: ProcessEntry): string => `${entry.pid}:${entry.started ?? 0}`

/** The CPU time of a process itself: where the system gives no such number, all it gives. */
const ownOf = (entry: ProcessEntry): number => entry.ownMs ?? entry.cpuMs

/**
 * Takes one reading of the machine's processes into `meter`. A process of the
 * tree that is new brings the time of the children it has already waited
 * for; one seen before keeps the most it was seen to have used; one that is
 * gone keeps what it had.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const observe = (meter: CpuMeter, entries: ReadonlyArray<ProcessEntry>): void => {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const children = new Map<number, Array<ProcessEntry>>()
  for (const entry of entries) children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry])
  const here = new Set<string>()
  const start = byPid.get(meter.root)
  const waiting: Array<readonly [ProcessEntry, string | undefined]> = start === undefined ? [] : [[start, undefined]]
  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    const [entry, parent] = next
    const key = keyOf(entry)
    // A table where a process is its own ancestor is walked once.
    if (here.has(key)) continue
    here.add(key)
    const waited = entry.waitedMs ?? 0
    const known = meter.seen.get(key)
    if (known === undefined) meter.seen.set(key, { own: ownOf(entry), first: waited, waited, parent, alive: true })
    else {
      known.own = Math.max(known.own, ownOf(entry))
      known.waited = Math.max(known.waited, waited)
      known.parent = parent
    }
    for (const child of children.get(entry.pid) ?? []) waiting.push([child, key])
  }
  for (const [key, known] of meter.seen) known.alive = here.has(key)
}

/**
 * The CPU time the tree has used, in milliseconds, as far as it was seen:
 * each process's own time, the time of the children it had waited for when
 * it was first seen, and what it waited for since that nothing seen accounts
 * for. That last part is the time of children too short-lived to be read, and
 * of what a child used after it was last read.
 *
 * A process that ends hands its time, and all it waited for, to the process
 * that waits for it. So what a process waited for is first set against
 * everything already counted under each child of it that is gone: the child,
 * and every process under the child that is gone too. A grandchild that was
 * read, and whose time then came up through a parent that ended between two
 * readings, is so counted once.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const cpuMsOf = (meter: CpuMeter): number => {
  // The processes that are gone, by the process they were last seen under.
  const gone = new Map<string, Array<string>>()
  for (const [key, known] of meter.seen) {
    if (known.alive || known.parent === undefined) continue
    gone.set(known.parent, [...(gone.get(known.parent) ?? []), key])
  }
  // What is counted for a process alone, and for it with everything gone under it.
  const alone = new Map<string, number>()
  const whole = new Map<string, number>()
  const count = (key: string): number => {
    const known = meter.seen.get(key) as Seen
    const under = (gone.get(key) ?? []).reduce((total, child) => total + count(child), 0)
    const unseen = Math.max(0, known.waited - known.first - under)
    alone.set(key, known.own + known.first + unseen)
    whole.set(key, known.own + known.first + unseen + under)
    return whole.get(key) as number
  }
  let total = 0
  for (const key of meter.seen.keys()) {
    if (!alone.has(key)) count(key)
    total += alone.get(key) as number
  }
  return total
}

/**
 * The CPU time of the steps of one run, added up as each ends. `seen` says
 * whether any of them could be read.
 *
 * @category models
 * @since 0.1.0
 */
export interface CpuBucket {
  ms: number
  seen: boolean
}

/**
 * Starts counting the tree under a process, and gives what is called when
 * that process has ended.
 *
 * @category models
 * @since 0.1.0
 */
export type Count = (pid: number) => () => void

/**
 * Counts nothing.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const uncounted: Count = () => () => undefined

/**
 * Adds what one step was seen to use to its run's bucket. A step whose
 * processes could not be read adds nothing.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const addTo = (bucket: CpuBucket, ms: number | undefined): void => {
  if (ms === undefined) return
  bucket.ms += ms
  bucket.seen = true
}

/**
 * What a run's steps used, or `undefined` when none of them could be read.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const usedBy = (bucket: CpuBucket): number | undefined => bucket.seen ? bucket.ms : undefined
