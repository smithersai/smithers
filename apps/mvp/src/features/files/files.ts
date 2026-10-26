import type { FileTabsFocusEvent } from "@smthrs/ui"
import { runners } from "../../boundary"
import { Context, Effect, Layer, Metric } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { closeTab, FilesPage, openTab } from "./actions"
import { fileFocus } from "./metrics"
import { FilesStore } from "./store"

// File tabs as a frontend sees them: a live query to read and plain functions to act. React renders the query with
// `useLiveQuery` and calls the actions from the strip; it holds no state and runs no Effect.

type Store = FilesStore["Service"]

/** What a frontend reads: this device's open files, in the order they opened. */
export interface FilesQueries {
  readonly tabs: Store["all"]["tanstack"]
}

/** What a person does on the strip: open a tab's file, or close it. Each resolves once its flow has run. */
export interface FilesActions {
  readonly recordFocus: (event: FileTabsFocusEvent) => void
  readonly open: (path: string) => Promise<void>
  readonly close: (path: string) => Promise<void>
}

export class Files extends Context.Service<Files, { readonly queries: FilesQueries; readonly actions: FilesActions }>()(
  "@smthrs/mvp/files/Files",
) {
  /**
   * Binds the store's query and the strip's actions for frontends. Each action runs with the services this layer was
   * built with (`runners`, src/boundary.ts); a dispatch that fails is already logged and counted, so it resolves all the
   * same.
   */
  static readonly layer = Layer.effect(
    Files,
    Effect.gen(function* () {
      const store = yield* FilesStore
      const { runPromise: run } = runners(yield* Effect.context<FilesStore | FilesPage | FlowDispatch>(), "files")
      const { runSync: record } = runners(yield* Effect.context<never>(), "files")
      return Files.of({
        queries: { tabs: store.all.tanstack },
        actions: {
          recordFocus: (event) => record(Effect.logInfo("files.focus").pipe(
            Effect.annotateLogs(event),
            Effect.andThen(Metric.update(Metric.withAttributes(fileFocus, event), 1)),
            Effect.withSpan("files.focus", { attributes: event }),
          )),
          open: (path) => run(openTab(path)),
          close: (path) => run(closeTab(path)),
        },
      })
    }),
  )
}

/** The file tabs layer's value: what frontends get. */
export type FilesView = Files["Service"]
