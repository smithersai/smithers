import { Context, Data, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { Clipboard } from "../../clipboard"
import type { FlowDispatch } from "../../flows/dispatch"
import { add, copy, open, refresh, remove } from "./actions"
import { type DomainsConfig, DomainsStore } from "./store"

// Custom domains as a frontend sees them (docs/features/domains.md): live queries to read and plain functions to act,
// with no Effect in sight.

type Store = DomainsStore["Service"]

/** What a frontend reads live. */
export interface DomainsQueries {
  /** The repository the Settings page shows. */
  readonly page: Store["pageState"]["tanstack"]
  /** Its domains, by hostname. */
  readonly domains: Store["listState"]["tanstack"]
  /** This tab's writes that haven't landed. */
  readonly saves: Store["savesState"]["tanstack"]
}

/** What a Maintainer does, as plain functions. Each returns at once but `open` and `copy`. */
export interface DomainsActions {
  /** Shows repository `owner/name`'s domains: the route's loader calls it. */
  readonly open: (owner: string, name: string) => Promise<void>
  readonly add: (hostname: string) => void
  readonly refresh: (hostname: string) => void
  readonly remove: (hostname: string) => void
  /** Copies a record's value; rejects when the clipboard refused, so the button says so. */
  readonly copy: (text: string) => Promise<void>
}

/** The clipboard refused the copy. */
class NotCopied extends Data.TaggedError("NotCopied") {}

export class Domains extends Context.Service<
  Domains,
  { readonly queries: DomainsQueries; readonly actions: DomainsActions }
>()("@smthrs/mvp/domains/Domains") {
  /** Binds the store's queries and actions for frontends, with the services this layer was built with. */
  static readonly layer = (config: DomainsConfig) =>
    Layer.effect(
      Domains,
      Effect.gen(function* () {
        const store = yield* DomainsStore
        const context = yield* Effect.context<DomainsStore | FlowDispatch | Clipboard>()
        const { runSync: run, runPromise: promise } = runners(context, "domains")
        return Domains.of({
          queries: { page: store.pageState.tanstack, domains: store.listState.tanstack, saves: store.savesState.tanstack },
          actions: {
            open: (owner, name) => promise(open(owner, name)),
            add: (hostname) => run(add(hostname)),
            refresh: (hostname) => run(refresh(hostname)),
            remove: (hostname) => run(remove(hostname)),
            copy: (text) => promise(Effect.flatMap(copy(text), (copied) => (copied ? Effect.void : Effect.fail(new NotCopied())))),
          },
        })
      }),
    ).pipe(Layer.provideMerge(DomainsStore.layer(config)))
}

/** The domains layer's value: what frontends get. */
export type DomainsView = Domains["Service"]
