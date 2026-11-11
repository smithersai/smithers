import { Host } from "@smthrs/plugin"
import { Effect, Stream } from "effect"

// The queue's tab (decision 0022, slice 1; decision 0017's `needs-you`, renamed): everything that waits on you, one
// item at a time, oldest first. It reads the core's `core/waits` and keeps a cursor on it, moved by the view's local
// events `next` and `previous` (`j`, `k`). Wherever the cursor rests, it tells the host through `select`, so the host's
// action strip acts on that item. It never answers: answering is `run/answer`, person-only, which only the strip sends.
// Its only wiring is its manifest (../plugin.json) and `PluginHost`.

/** One open wait, as `core/waits` has it. */
export interface Wait {
  readonly runId: string
  readonly version: number
  readonly execution: string
  readonly kind: "question" | "approval"
  readonly prompt: string
  readonly options: ReadonlyArray<string>
  readonly question: boolean
  readonly approval: boolean
  readonly createdAt: string
  /** The repository the wait is about, `github/<owner>/<name>`; empty when it names none. */
  readonly repoId: string
}

/** Where the queue stands: the item shown, its place (0 first), how many wait, and the item's repository. */
export interface Current {
  readonly item: Wait | undefined
  readonly index: number
  readonly total: number
  /** `<owner>/<name>` of the item's repository, when it names one: who asks may be any repository's agent. */
  readonly repository?: string
}

/** A repository's id as a person reads it: `github/acme/widgets` as `acme/widgets`; nothing for none. */
export const repositoryOf = (repoId: string): string | undefined =>
  repoId.startsWith("github/") ? repoId.slice("github/".length) : undefined

/** The queue's view. */
export const VIEW = "queue/queue"

/** Where the cursor moves to: `index` kept inside `total` items, `0` when there are none. */
export const clamp = (index: number, total: number): number => Math.max(0, Math.min(index, total - 1))

/**
 * Where the cursor goes when the waits change: it stays on its item, or, when that one left (answered here or on
 * another device), on the item that took its place.
 */
export const follow = (rows: ReadonlyArray<{ readonly runId: string }>, runId: string | undefined, index: number): number => {
  const at = rows.findIndex((row) => row.runId === runId)
  return at === -1 ? index : at
}

/** One value, live: what it is now, and a way to hear it changed. */
export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

/** What the queue's components read and do. */
export interface QueueTab {
  readonly queries: { readonly waits: Host.Live<Wait>; readonly current: Watched<Current> }
  readonly actions: { readonly open: () => void }
}

/** The tab: built by the host in the plugin's scope on first use. */
export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  const run = Effect.runForkWith(yield* Effect.context<never>())
  const waits = yield* host.query<Wait>("core/waits")
  let runId: string | undefined
  let current: Current = { item: undefined, index: 0, total: 0 }
  const listeners = new Set<() => void>()

  /** Puts the cursor at `index` of the waits now, tells the host what it selected, and says the queue changed. */
  const settle = (index: number) => {
    const rows = waits.current()
    const at = clamp(index, rows.length)
    const item = rows[at]
    const moved = item?.runId !== runId
    runId = item?.runId
    const repository = item === undefined ? undefined : repositoryOf(item.repoId)
    current = { item, index: at, total: rows.length, ...(repository === undefined ? {} : { repository }) }
    if (moved && item !== undefined) run(host.select({ query: "core/waits", key: item.runId }).pipe(Effect.ignore))
    for (const listener of listeners) listener()
  }

  const stop = waits.subscribe(() => settle(follow(waits.current(), runId, current.index)))
  yield* Effect.addFinalizer(() => Effect.sync(stop))
  settle(0)

  yield* host.events(VIEW).pipe(
    Stream.runForEach(({ name }) => Effect.sync(() => settle(current.index + (name === "next" ? 1 : -1)))),
    Effect.forkScoped({ startImmediately: true }),
  )

  return {
    queries: {
      waits,
      current: {
        current: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
    },
    actions: { open: () => void run(host.open(VIEW)) },
  } satisfies QueueTab
})
