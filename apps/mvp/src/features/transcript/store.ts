import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { RetryPolicy } from "@smthrs/flow"
import { Context, Effect, FiberHandle, Layer, Ref } from "effect"
import { EMPTY, type Folded } from "./fold"
import { Item, PANEL, Panel } from "./schema"

// The Transcript panel on this tab (decision 0134, docs/features/agent-transcripts.md#the-panel): the run it shows and
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
export const itemsQuery = (items: Collection.Collection<Item, string>) =>
  LiveQuery.make((q) => q.from({ item: items.tanstack }).orderBy(({ item }) => item.order))

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
        return TranscriptStore.of({
          origin: config.origin,
          redial: config.redial ?? REDIAL,
          panel,
          panelState: yield* panelQuery(panel),
          items,
          itemsState: yield* itemsQuery(items),
          folded: yield* Ref.make(EMPTY),
          socket: yield* FiberHandle.make<void, never>(),
        })
      }),
    )
}
