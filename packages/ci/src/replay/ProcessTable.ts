/**
 * What the machine says about its processes, read into one shape on every
 * system: which process started which, and how much CPU each has used. A
 * replay reads it to tell a step that works from a step that waits for
 * something that will never come.
 *
 * @since 0.1.0
 */

/**
 * One process. `cpuMs` is the CPU time it has used, with the time of the
 * children it has waited for where the system counts that. Where the system
 * gives the two apart, `ownMs` is the time of the process itself and
 * `waitedMs` that of the children it has waited for, and `started` is when
 * the process started, in the system's own count: with the process id it
 * names one process, where an id alone is used again.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProcessEntry {
  readonly pid: number
  readonly parent: number
  readonly cpuMs: number
  readonly ownMs?: number | undefined
  readonly waitedMs?: number | undefined
  readonly started?: number | undefined
}

/**
 * A process and everything under it. `leaves` are the processes with no
 * child: what a stuck tree is waiting in. All are empty when the process is
 * gone.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProcessTree {
  readonly cpuMs: number
  readonly pids: ReadonlyArray<number>
  readonly leaves: ReadonlyArray<number>
}

/** Linux counts CPU time in hundredths of a second for every program. */
const msPerTick = 10

/**
 * One line of `/proc/<pid>/stat`. The program's name stands in parentheses
 * and may hold spaces, so the fields are counted from its end: the parent is
 * the second after it, the twelfth to fifteenth are the CPU time of the
 * process and of the children it waited for, and the twentieth is when it
 * started.
 *
 * @throws {never}
 * @category parsing
 * @since 0.1.0
 */
export const fromStat = (text: string): ProcessEntry | undefined => {
  const end = text.lastIndexOf(")")
  if (end === -1) return undefined
  const fields = text.slice(end + 2).trim().split(" ")
  const [pid, parent, started, ...ticks] = [
    text.slice(0, text.indexOf(" ")),
    fields[1],
    fields[19],
    ...fields.slice(11, 15)
  ]
    .map(Number)
  if (ticks.length !== 4 || ![pid, parent, started, ...ticks].every(Number.isInteger)) return undefined
  const [user, system, waitedUser, waitedSystem] = ticks as [number, number, number, number]
  return {
    pid: pid as number,
    parent: parent as number,
    cpuMs: (user + system + waitedUser + waitedSystem) * msPerTick,
    ownMs: (user + system) * msPerTick,
    waitedMs: (waitedUser + waitedSystem) * msPerTick,
    started: started as number
  }
}

/** `[[dd-]hh:]mm:ss[.cc]`, as `ps` prints CPU time. */
const psTime = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)(?:[.,](\d+))?$/

const millisOf = (time: string): number | undefined => {
  const found = psTime.exec(time)
  if (found === null) return undefined
  const [days, hours, minutes, seconds] = found.slice(1, 5).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number
  ]
  const fraction = Number(`0.${found[5] ?? 0}`)
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds + fraction) * 1000
}

/**
 * What `ps -axo pid=,ppid=,time=` prints. A line it cannot read is left out.
 *
 * @throws {never}
 * @category parsing
 * @since 0.1.0
 */
export const fromPs = (text: string): ReadonlyArray<ProcessEntry> =>
  text.split("\n").flatMap((line) => {
    const [pid, parent, time] = line.trim().split(/\s+/)
    const cpuMs = time === undefined ? undefined : millisOf(time)
    return cpuMs === undefined ? [] : [{ pid: Number(pid), parent: Number(parent), cpuMs }]
  })

/**
 * The tree under `root`.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const treeOf = (entries: ReadonlyArray<ProcessEntry>, root: number): ProcessTree => {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const children = new Map<number, Array<number>>()
  for (const entry of entries) children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry.pid])
  const pids: Array<number> = []
  const leaves: Array<number> = []
  let cpuMs = 0
  const waiting = byPid.has(root) ? [root] : []
  const seen = new Set(waiting)
  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    pids.push(next)
    cpuMs += (byPid.get(next) as ProcessEntry).cpuMs
    const below = (children.get(next) ?? []).filter((pid) => !seen.has(pid))
    if (below.length === 0) leaves.push(next)
    for (const pid of below) {
      seen.add(pid)
      waiting.push(pid)
    }
  }
  return { cpuMs, pids, leaves }
}

/** The clock's grain: one tick of CPU time is the least that can be seen. */
const leastCpuMs = msPerTick

/**
 * How much CPU counts as work over `elapsedMs`: one hundredth of one core. A
 * program that waits still wakes now and then, and that stays below this.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const workOver = (elapsedMs: number): number => Math.max(leastCpuMs, elapsedMs / 100)
