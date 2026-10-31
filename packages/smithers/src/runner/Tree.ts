/**
 * An agent's whole process tree, for stopping it.
 *
 * A dead process group proves nothing: agents start their tools in groups and
 * sessions of their own, and a tool can outlive the agent's cancellation. So
 * the runner watches every descendant of the agent while it runs, keyed by pid
 * and start time, and a stop signals each one it saw that still runs as the
 * same process, then checks that none is left.
 *
 * @since 1.0.0
 */

import { Effect } from "effect"
import { execFileSync } from "node:child_process"

/** One process: its parent, whether it is a zombie, and its start time as `ps` prints it. */
interface Entry {
  readonly ppid: number
  readonly zombie: boolean
  readonly started: string
}

/** Every process on the host by pid, or an empty table when `ps` can't answer. */
const table = (): Map<number, Entry> => {
  const entries = new Map<number, Entry>()
  let text: string
  try {
    text = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], {
      env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return entries
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      entries.set(Number(match[1]), { ppid: Number(match[2]), zombie: match[3]!.startsWith("Z"), started: match[4]! })
    }
  }
  return entries
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as { readonly code?: string }).code !== "ESRCH"
  }
}

/**
 * A watched tree: `observe` adds the root's descendants it sees now, `signal`
 * sends a signal to every process it saw that still runs as itself, and
 * `gone` answers whether none of them is left.
 *
 * @category models
 * @since 1.0.0
 */
export interface Tree {
  readonly observe: Effect.Effect<void>
  readonly signal: (signal: NodeJS.Signals) => Effect.Effect<void>
  readonly gone: Effect.Effect<boolean>
}

/**
 * Watches the tree under `root`, the root included.
 *
 * @category constructors
 * @since 1.0.0
 */
export const watch = (root: number): Tree => {
  const seen = new Map<number, string>()
  const observe = Effect.sync(() => {
    const entries = table()
    const rootEntry = entries.get(root)
    if (rootEntry !== undefined) seen.set(root, rootEntry.started)
    let frontier = [root]
    while (frontier.length > 0) {
      const parents = new Set(frontier)
      frontier = []
      for (const [pid, entry] of entries) {
        if (parents.has(entry.ppid) && !seen.has(pid)) {
          seen.set(pid, entry.started)
          frontier.push(pid)
        }
      }
    }
  })
  /** The processes seen that still run as themselves: same pid, same start time, not a zombie. */
  const living = () => {
    const entries = table()
    return [...seen].filter(([pid, started]) => {
      const entry = entries.get(pid)
      return entry !== undefined && entry.started === started && !entry.zombie && alive(pid)
    }).map(([pid]) => pid)
  }
  return {
    observe,
    signal: (signal) =>
      Effect.sync(() => {
        for (const pid of living()) {
          try {
            process.kill(pid, signal)
          } catch {
            // Gone between the read and the signal.
          }
        }
      }),
    gone: Effect.sync(() => living().length === 0)
  }
}

/**
 * Stops a watched tree: `SIGINT` to every process in it, `SIGKILL` to what is
 * left after `graceMs`, and whether nothing was left after `settleMs` more.
 *
 * @category constructors
 * @since 1.0.0
 */
export const stop = (tree: Tree, options: { readonly graceMs: number; readonly settleMs: number }) =>
  Effect.gen(function*() {
    yield* tree.observe
    yield* tree.signal("SIGINT")
    const until = (ms: number) =>
      Effect.gen(function*() {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          if (yield* tree.gone) return true
          yield* Effect.sleep(100)
        }
        return yield* tree.gone
      })
    if (yield* until(options.graceMs)) return true
    yield* tree.signal("SIGKILL")
    return yield* until(options.settleMs)
  })
