import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { RetryPolicy } from "@smthrs/flow"
import { Context, Effect, FiberHandle, Layer, Option, Ref } from "effect"
import type { Source } from "../repo/gate"
import { RunsStore } from "../runs/store"
import type { RunPage } from "../runs/schema"
import { EMPTY, type Folded } from "./fold"
import { Item, PANEL, Panel } from "./schema"

// The Transcript panel on this tab (decision 0141, docs/features/agent-transcripts.md#the-panel): the run it shows and
// how its socket stands, and the items folded from the run's events, both local to this tab and never persisted: a
// reload replays the run's transcript from its `RunContent`. The one socket this tab holds is the panel's.

/** Where the socket dials: ChatApi's origin, the site's own; and how it dials again after a drop ({@link REDIAL}). */
export interface TranscriptConfig {
  readonly origin: string
  readonly redial?: RetryPolicy.RetryPolicy
}

/** How the panel dials again after a drop: 1 s doubling to 30 s, giving up after 30 minutes offline. */
export const REDIAL: RetryPolicy.RetryPolicy = RetryPolicy.make({ initialMs: 1000, factor: 2, maxMs: 30_000, expirationMs: 30 * 60_000 })

/** The panel's one row. */
export const panelQuery = (panel: Collection.Collection<Panel, string>) =>
  LiveQuery.make((q) => q.from({ panel: panel.tanstack }).findOne())

/** The panel's items in the order they began. */
export const itemsQuery = (items: Source<Item>) =>
  LiveQuery.make((q) => q.from({ item: items.tanstack }).orderBy(({ item }) => item.order))

/**
 * The items of a run whose read may show (the data gate, `RunsStore.shownPages`, with an inspection): a refused
 * repository's run, one this tab can't attribute, or a page holding no read shows none. Both keys are expressions, so TanStack DB loads neither side lazily (repo/gate.ts).
 */
const shownItemsQuery = (items: Collection.Collection<Item, string>, pages: Source<RunPage>) =>
  LiveQuery.make(
    (q) =>
      q
        .from({ item: items.tanstack })
        .innerJoin({ page: pages.tanstack }, ({ item, page }) =>
          Query.eq(Query.coalesce(item.runId, ""), Query.coalesce(page.id, "")))
        // Only a page that holds its run's read: one with none (loading, or a read that failed, as a late 403 after a
        // refusal writes) shows through the gate unattributed, so it proves nothing (Astra on 19af7eb9).
        .where(({ page }) => Query.not(Query.isNull(page.inspection)))
        .select(({ item }) => item),
    { getKey: (item) => item.id },
  )

/** The panel before it shows a run. */
export const IDLE: Panel = {
  id: PANEL,
  runId: null,
  phase: "idle",
  closed: null,
  events: 0,
  last: 0,
  digest: "",
  verified: null,
  lagMs: null,
}

/** The transcript's state for one tab. */
export class TranscriptStore extends Context.Service<
  TranscriptStore,
  {
    readonly origin: string
    readonly redial: RetryPolicy.RetryPolicy
    readonly panel: Collection.Collection<Panel, string>
    readonly panelState: Effect.Success<ReturnType<typeof panelQuery>>
    /** The items folded from the run's events: the store's own. What shows reads `itemsState`, through the data gate. */
    readonly items: Collection.Collection<Item, string>
    readonly itemsState: Effect.Success<ReturnType<typeof itemsQuery>>
    /** What folding remembers between frames, for the run the panel shows. */
    readonly folded: Ref.Ref<Folded>
    /** The socket's fiber: only the latest watch keeps it. */
    readonly socket: FiberHandle.FiberHandle<void, never>
  }
>()("@smthrs/mvp/transcript/TranscriptStore") {
  /** The store; its collections cleaned up and its socket closed when the scope closes. */
  static readonly layer = (config: TranscriptConfig) =>
    Layer.effect(
      TranscriptStore,
      Effect.gen(function* () {
        const panel = yield* Collection.local<Panel, string>({
          id: "transcript-panel",
          schema: Panel,
          getKey: (row) => row.id,
          initialData: [IDLE],
        })
        const items = yield* Collection.local<Item, string>({ id: "transcript-items", schema: Item, getKey: (row) => row.id })
        // A tab without the runs' store (a test's) has no run to attribute an item to, so it shows them as they are.
        const runs = yield* Effect.serviceOption(RunsStore)
        const shown: Source<Item> = Option.isSome(runs)
          ? (yield* shownItemsQuery(items, runs.value.shownPages as unknown as Source<RunPage>)) as unknown as Source<Item>
          : items
        return TranscriptStore.of({
          origin: config.origin,
          redial: config.redial ?? REDIAL,
          panel,
          panelState: yield* panelQuery(panel),
          items,
          itemsState: yield* itemsQuery(shown),
          folded: yield* Ref.make(EMPTY),
          socket: yield* FiberHandle.make<void, never>(),
        })
      }),
    )
}
