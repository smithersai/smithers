/**
 * An in-memory world for the driver: an inbox, a CI, fix agents and a target
 * branch, with the ground truth of which trees really pass.
 *
 * The services are real implementations of the driver's contracts over this
 * world, not mocks: CI computes each check's verdict from the tree it was
 * given, the target enforces its compare-and-swap, and every command that
 * changed something is logged. `failNext` and `failCall` make a service
 * unavailable, which is how tests inject faults.
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Answer, Config, Ending, Finished, FixBrief, Job, Letter, Part, Tree } from "../../src/index.ts"
import { Ci, Endings, Fixer, Inbox, sameTree, Target, Unavailable } from "../../src/index.ts"

type Service = "inbox" | "ci" | "fixer" | "target" | "endings"

/** What decides the world's behaviour. */
export interface Script {
  /** The checks that fail on any tree holding this revision of this change. */
  readonly failing?: (part: Part) => ReadonlyArray<number>
  /** What the fix agent for a change's attempt answers; `undefined` leaves it working until `answer` is called. */
  readonly fix?: (brief: FixBrief) => Answer | undefined
  /** Whether CI finishes every check as soon as a run starts. Default true. */
  readonly auto?: boolean
  /** How long each check takes. Default 10. */
  readonly duration?: (check: number) => number
}

interface RunRecord {
  job: Job
  /** The whole tree the job tests: the parts settled when it was named, then the job's tree. */
  tree: Tree
  /** The checks not yet released, in the order CI started them. */
  waiting: Array<number>
  finished: Array<Finished>
  lost: boolean
  stopped: boolean
}

/** The world, its services and what tests read from it. */
export interface World {
  readonly layer: Layer.Layer<Inbox | Ci | Fixer | Target | Endings>
  /** Only the inbox, the fix agents and the record, for tests whose CI and target are real. */
  readonly people: Layer.Layer<Inbox | Fixer | Endings>
  /** The record of endings, oldest first. */
  readonly endings: Array<Ending>
  /** Every command that changed something, in order. */
  readonly log: Array<string>
  /** Every tree the target has been on, in order, starting empty. Whole trees, settled parts included. */
  readonly targets: Array<Tree>
  /** The whole trees the queue itself moved the target onto. */
  readonly pushed: Array<Tree>
  /** How many parts the queue has told the target are settled. */
  readonly settled: () => number
  readonly send: (letter: Letter) => void
  readonly enqueue: (id: number, priority?: number) => void
  readonly withdraw: (id: number) => void
  readonly close: () => void
  /** Releases the next `count` checks of a run (manual CI). */
  readonly finish: (run: number, count?: number) => void
  /** Makes CI lose a run. */
  readonly lose: (run: number) => void
  /** Records a fix agent's answer (manual fixer). */
  readonly answer: (id: number, attempt: number, answer: Answer) => void
  /** Makes the next `times` calls to a service fail as unavailable. */
  readonly failNext: (service: Service, times: number) => void
  /** Makes the `n`th service call from now (0 is the next) fail as unavailable. */
  readonly failCall: (n: number) => void
  /** How many service calls have been made. */
  readonly calls: () => number
  /** Someone other than the queue puts a commit on the target. */
  readonly foreign: (id: number) => void
  /** Rewrites the target's history. */
  readonly rewrite: (tree: Tree) => void
  /** Whether every required check really passes on the tree. */
  readonly passes: (tree: Tree) => boolean
  /** The runs CI has, by id. */
  readonly runs: ReadonlyMap<number, RunRecord>
  /** The briefs fix agents were given, newest last. */
  readonly briefs: Array<FixBrief>
  /** Every change id handed in through the inbox and every commit someone else put on the target. */
  readonly known: () => ReadonlyArray<number>
}

/**
 * Where every change is, by id: how the ones that ended ended (from the
 * record, and from `ended`, the endings a round returned that are not in the
 * record yet), and the status of the ones the queue still holds.
 */
export const statusesOf = (
  world: { readonly endings: ReadonlyArray<Ending> },
  at: {
    readonly state: {
      readonly changes: ReadonlyArray<{ readonly id: number; readonly status: { readonly _tag: string } }>
    }
    readonly ended?: ReadonlyArray<Ending>
  }
): Readonly<Record<number, string>> =>
  Object.fromEntries([
    ...[...world.endings, ...(at.ended ?? [])].map((ending) => [ending.id, ending.status._tag]),
    ...at.state.changes.map((change) => [change.id, change.status._tag])
  ])

/**
 * The whole tree a position stands for: the parts the queue has settled, read
 * from the target, then the tree its state holds.
 */
export const wholeTree = (
  world: { readonly targets: ReadonlyArray<Tree> },
  at: { readonly state: { readonly main: Tree }; readonly settled: number }
): Tree => [...world.targets.at(-1)!.slice(0, at.settled), ...at.state.main]

/** Builds a world for a queue config. */
export const makeWorld = (config: Config, script: Script = {}): World => {
  const letters: Array<Letter> = []
  const runs = new Map<number, RunRecord>()
  const answers = new Map<string, Answer>()
  const working = new Map<string, string>()
  const briefs: Array<FixBrief> = []
  const log: Array<string> = []
  const targets: Array<Tree> = [[]]
  const pushed: Array<Tree> = []
  const recorded: Array<Ending> = []
  const foreigners: Array<number> = []
  const faults: Record<Service, number> = { inbox: 0, ci: 0, fixer: 0, target: 0, endings: 0 }
  let calls = 0
  let failAt = -1
  let settled = 0
  /** The parts the queue has settled, as they were on the target when it settled them. */
  let behind: Tree = []
  let waiters: Array<() => void> = []

  const bump = (): void => {
    const woken = waiters
    waiters = []
    for (const wake of woken) wake()
  }
  const changed = Effect.promise(() => new Promise<void>((resolve) => waiters.push(resolve)))
  const until = (ready: () => boolean): Effect.Effect<void> =>
    Effect.suspend(() => ready() ? Effect.void : Effect.flatMap(changed, () => until(ready)))

  /** Runs one service call, unless a fault is injected for it. */
  const call = <A>(service: Service, body: () => A): Effect.Effect<A, Unavailable> =>
    Effect.suspend(() => {
      const index = calls++
      if (faults[service] > 0 || index === failAt) {
        if (faults[service] > 0) faults[service] -= 1
        return Effect.fail(new Unavailable({ service, detail: "injected fault" }))
      }
      return Effect.succeed(body())
    })

  const failing = (entry: Part): ReadonlyArray<number> => script.failing?.(entry) ?? []
  const verdict = (tree: Tree, check: number) => tree.some((entry) => failing(entry).includes(check)) ? "fail" : "pass"
  const release = (record: RunRecord, count: number): void => {
    for (let left = count; left > 0 && record.waiting.length > 0; left--) {
      const check = record.waiting.shift()!
      record.finished.push({
        check,
        verdict: verdict(record.tree, check),
        duration: script.duration?.(check) ?? 10
      })
    }
  }
  const key = (id: number, attempt: number): string => `${id}#${attempt}`
  const current = (): Tree => targets[targets.length - 1]!
  /** The target's tree as the queue is told it: from the settled parts on. */
  const spoken = (): Tree => current().slice(settled)
  /** Whether the target still starts with the settled parts. A rewritten history may not. */
  const descends = (): boolean =>
    current().length >= behind.length && sameTree(current().slice(0, behind.length), behind)
  const rewritten = () => new Unavailable({ service: "target", detail: "the target's history was rewritten" })
  const show = (tree: Tree): string => tree.map((entry) => `${entry.id}.${entry.rev}`).join(",")

  const inbox = Inbox.of({
    since: (cursor) => call("inbox", () => letters.slice(cursor)),
    wait: (cursor) => until(() => letters.length > cursor)
  })

  const ci = Ci.of({
    reconcile: (jobs) =>
      call("ci", () => {
        for (const job of jobs) {
          if (runs.has(job.run)) continue
          log.push(`ci.start ${job.run}`)
          const record: RunRecord = {
            job,
            tree: [...current().slice(0, job.from), ...job.tree],
            waiting: [...job.checks],
            finished: [],
            lost: false,
            stopped: false
          }
          runs.set(job.run, record)
          if (script.auto ?? true) release(record, record.waiting.length)
        }
        for (const [id, record] of runs) {
          if (record.stopped || jobs.some((job) => job.run === id)) continue
          record.stopped = true
          log.push(`ci.stop ${id}`)
        }
        bump()
      }),
    progress: (run) =>
      call("ci", () => {
        const record = runs.get(run)
        if (record === undefined) return { _tag: "running", finished: [] } as const
        return record.lost ? { _tag: "lost" } as const : { _tag: "running", finished: [...record.finished] } as const
      }),
    wait: (seen) =>
      until(() =>
        seen.some((entry) => {
          const record = runs.get(entry.run)
          return record !== undefined && (record.lost || record.finished.length > entry.finished)
        })
      )
  })

  const fixer = Fixer.of({
    reconcile: (wanted) =>
      call("fixer", () => {
        for (const brief of wanted) {
          const id = key(brief.id, brief.attempt)
          const failures = brief.failures.join("+")
          if (working.get(id) === failures) continue
          working.set(id, failures)
          log.push(`fixer.brief ${id} failures=${failures}`)
          briefs.push(brief)
          if (answers.has(id)) continue
          const scripted = script.fix?.(brief)
          if (scripted !== undefined) answers.set(id, scripted)
        }
        for (const id of [...working.keys()]) {
          if (wanted.some((brief) => key(brief.id, brief.attempt) === id)) continue
          working.delete(id)
          log.push(`fixer.stop ${id}`)
        }
        bump()
      }),
    answer: (id, attempt) => call("fixer", () => answers.get(key(id, attempt))),
    wait: (pending) => until(() => pending.some((entry) => answers.has(key(entry.id, entry.attempt))))
  })

  const target = Target.of({
    settle: (count) =>
      Effect.flatMap(call("target", () => count <= current().length && descends()), (possible) => {
        if (!possible) return Effect.fail(rewritten())
        if (count > settled) {
          settled = count
          behind = current().slice(0, count)
        }
        return Effect.void
      }),
    tip: Effect.flatMap(
      call("target", descends),
      (still) => still ? Effect.succeed(spoken()) : Effect.fail(rewritten())
    ),
    advance: (from, to) =>
      call("target", () => {
        if (!sameTree(spoken(), from)) return
        const whole = [...current().slice(0, settled), ...to]
        log.push(`target.advance ${show(current())} -> ${show(whole)}`)
        targets.push(whole)
        pushed.push(whole)
        bump()
      }),
    wait: (tree) => until(() => !sameTree(spoken(), tree))
  })

  const endings = Endings.of({
    record: (given) =>
      call("endings", () => {
        for (const ending of given) {
          if (recorded.some((held) => held.id === ending.id)) continue
          recorded.push(ending)
        }
      })
  })

  const send = (letter: Letter): void => {
    letters.push(letter)
    bump()
  }

  return {
    layer: Layer.mergeAll(
      Layer.succeed(Inbox, inbox),
      Layer.succeed(Ci, ci),
      Layer.succeed(Fixer, fixer),
      Layer.succeed(Target, target),
      Layer.succeed(Endings, endings)
    ),
    people: Layer.mergeAll(Layer.succeed(Inbox, inbox), Layer.succeed(Fixer, fixer), Layer.succeed(Endings, endings)),
    endings: recorded,
    log,
    targets,
    pushed,
    settled: () => settled,
    send,
    enqueue: (id, priority = 0) => send({ _tag: "event", event: { _tag: "enqueue", id, priority } }),
    withdraw: (id) => send({ _tag: "event", event: { _tag: "withdraw", id } }),
    close: () => send({ _tag: "close" }),
    finish: (run, count = 1) => {
      release(runs.get(run)!, count)
      bump()
    },
    lose: (run) => {
      runs.get(run)!.lost = true
      bump()
    },
    answer: (id, attempt, given) => {
      answers.set(key(id, attempt), given)
      bump()
    },
    failNext: (service, times) => {
      faults[service] = times
    },
    failCall: (n) => {
      failAt = calls + n
    },
    calls: () => calls,
    foreign: (id) => {
      foreigners.push(id)
      targets.push([...current(), { id, rev: 0 }])
      bump()
    },
    known: () => [
      ...new Set([
        ...letters.flatMap((letter) =>
          letter._tag === "event" && letter.event._tag === "enqueue" ? [letter.event.id] : []
        ),
        ...foreigners
      ])
    ],
    rewrite: (tree) => {
      targets.push(tree)
      bump()
    },
    passes: (tree) => config.required.every((check) => verdict(tree, check) === "pass"),
    runs,
    briefs
  }
}
