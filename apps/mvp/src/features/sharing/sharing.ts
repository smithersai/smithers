import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import type { ShareAccess } from "../branch/contract"
import { add, closeDialog, openDialog, set } from "./actions"
import { type SharingConfig, SharingStore } from "./store"

// Sharing as a frontend sees it (docs/features/branch-workspace.md#sharing): live queries to read and plain functions to
// act, with no Effect in sight.

type Store = SharingStore["Service"]

export interface SharingQueries {
  /** The share dialog on this tab. */
  readonly dialog: Store["dialogState"]["tanstack"]
  /** The open branch's permission list. */
  readonly shares: Store["listState"]["tanstack"]
}

export interface SharingActions {
  readonly open: (branchId: string) => Promise<void>
  readonly close: () => Promise<void>
  /** Shares the branch with the person `login`, to `access`. */
  readonly add: (login: string, access: ShareAccess) => Promise<void>
  /** Changes what `grantee` (a person's id, or `repository`) may do, `null` to remove them. */
  readonly set: (grantee: string, access: ShareAccess | null) => Promise<void>
}

export class Sharing extends Context.Service<
  Sharing,
  { readonly origin: string; readonly queries: SharingQueries; readonly actions: SharingActions }
>()("@smthrs/mvp/sharing/Sharing") {
  /** Binds the store's queries and actions for frontends, with the services this layer was built with. */
  static readonly layer = (config: SharingConfig) =>
    Layer.effect(
      Sharing,
      Effect.gen(function* () {
        const store = yield* SharingStore
        const { runPromise: run } = runners(yield* Effect.context<SharingStore | FlowDispatch>(), "sharing")
        return Sharing.of({
          origin: store.origin,
          queries: { dialog: store.dialogState.tanstack, shares: store.listState.tanstack },
          actions: {
            open: (branchId) => run(openDialog(branchId)),
            close: () => run(closeDialog),
            add: (login, access) => run(Effect.asVoid(add(login, access))),
            set: (grantee, access) => run(Effect.asVoid(set(grantee, access))),
          },
        })
      }),
    ).pipe(Layer.provideMerge(SharingStore.layer(config)))
}

/** The sharing layer's value: what frontends get. */
export type SharingView = Sharing["Service"]
