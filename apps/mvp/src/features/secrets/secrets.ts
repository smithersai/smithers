import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { cancel, open, put, remove, startDelete, startRotate, warm } from "./actions"
import { SecretsClient } from "./api"
import { SecretsStore } from "./store"

// Secrets as a frontend sees them (docs/features/secrets.md#the-secrets-page): live queries to read and plain functions
// to act, with no Effect in sight. React renders the queries with `useLiveQuery`, and the route's `beforeLoad` calls
// `open`. A value passes through `add` or `rotate` once, into its request, and is kept nowhere.

type Store = SecretsStore["Service"]

/** What a frontend reads live. */
export interface SecretsQueries {
  /** What the route shows, and the row whose Rotate or Delete is open. */
  readonly view: Store["viewState"]["tanstack"]
  /** Each form's last write: on its way, or why it failed. */
  readonly forms: Store["formList"]["tanstack"]
  /** Repository `repoId`'s secrets by name once a route opened them; no rows before. */
  readonly list: (repoId: string) => Store["empty"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface SecretsActions {
  /** What the route calls on a navigation: resolves once the repository's list is open. */
  readonly open: (owner: string, name: string) => Promise<void>
  /** What the route calls on a link's hover or focus. */
  readonly warm: (owner: string, name: string) => Promise<void>
  /** Add: sets `secret` to `value` on the hosts typed. Whether it was sent. */
  readonly add: (secret: string, value: string, hosts: string) => boolean
  /** Save on a row's Rotate: a new value, and the hosts typed. Whether it was sent. */
  readonly rotate: (secret: string, value: string, hosts: string) => boolean
  /** Delete secret on a row's confirmation. Whether it was sent. */
  readonly remove: (secret: string) => boolean
  readonly startRotate: (secret: string) => void
  readonly startDelete: (secret: string) => void
  readonly cancel: () => void
}

export class Secrets extends Context.Service<Secrets, { readonly queries: SecretsQueries; readonly actions: SecretsActions }>()(
  "@smthrs/mvp/secrets/Secrets",
) {
  /** Binds the store's queries and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const store = yield* SecretsStore
      const context = yield* Effect.context<SecretsStore | SecretsClient>()
      const { runSync: run, runPromise: runAsync } = runners(context, "secrets")
      return Secrets.of({
        queries: {
          view: store.viewState.tanstack,
          forms: store.formList.tanstack,
          list: (repoId) => (store.opened(repoId) ?? store.empty).tanstack,
        },
        actions: {
          open: (owner, name) => runAsync(open(owner, name)),
          warm: (owner, name) => runAsync(warm(owner, name)),
          add: (secret, value, hosts) => run(put("add", secret, value, hosts)),
          rotate: (secret, value, hosts) => run(put("rotate", secret, value, hosts)),
          remove: (secret) => run(remove(secret)),
          startRotate: (secret) => run(startRotate(secret)),
          startDelete: (secret) => run(startDelete(secret)),
          cancel: () => run(cancel),
        },
      })
    }),
  )
}

/** The secrets layer's value: what frontends get. */
export type SecretsLayer = Secrets["Service"]
