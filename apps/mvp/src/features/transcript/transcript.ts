import { Context, Effect, Layer } from "effect"
import type { HttpClient } from "effect/http"
import { runners } from "../../boundary"
import { watch } from "./actions"
import { TranscriptStore, type TranscriptConfig } from "./store"

// The Transcript panel as a frontend sees it (decision 0134, docs/features/agent-transcripts.md#the-panel): live
// queries to read and one plain function to act. A run page calls `watch` with its run while it shows one.

type Store = TranscriptStore["Service"]

export interface TranscriptQueries {
  /** The panel: the run it shows and how its socket stands. */
  readonly panel: Store["panelState"]["tanstack"]
  /** What it shows, in the order it began. */
  readonly items: Store["itemsState"]["tanstack"]
}

export interface TranscriptActions {
  /** Shows run `runId`'s transcript, live; `null` lets go of it. Showing the run it shows changes nothing. */
  readonly watch: (runId: string | null) => void
}

export class Transcript extends Context.Service<
  Transcript,
  { readonly queries: TranscriptQueries; readonly actions: TranscriptActions }
>()("@smthrs/mvp/transcript/Transcript") {
  /** Binds frontend actions to the injected Effect services. */
  static readonly make = Effect.gen(function* () {
    const store = yield* TranscriptStore
    const context = yield* Effect.context<TranscriptStore | HttpClient.HttpClient>()
    const { runSync } = runners(context, "transcript")
    return Transcript.of({
      queries: { panel: store.panelState.tanstack, items: store.itemsState.tanstack },
      actions: { watch: (runId) => runSync(watch(runId)) },
    })
  })

  /** The panel's store, query and actions for frontends, with the services this layer was built with. */
  static readonly layer = (config: TranscriptConfig) =>
    Layer.effect(Transcript, Transcript.make).pipe(Layer.provideMerge(TranscriptStore.layer(config)))
}

/** The transcript layer's value: what frontends get. */
export type TranscriptView = Transcript["Service"]
