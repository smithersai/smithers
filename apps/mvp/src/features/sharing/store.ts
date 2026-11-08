import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Context, Effect, FiberHandle, Layer, Scope, Semaphore } from "effect"
import { SHARES_SHAPE_ROUTE } from "../branch/contract"
import { DIALOG, Dialog, ShareRow } from "./schema"

// Sharing on this tab (docs/features/branch-workspace.md#sharing): each branch's permission list, synced from Postgres
// by Electric while its owner's dialog shows it (only the owner's shape has rows); the list the dialog renders, kept
// equal to the open branch's; and the dialog itself.

/** Where the lists sync from: ChatApi's origin, the site's own. */
export interface SharingConfig {
  readonly origin: string
}

/** The dialog this tab shows. */
export const dialogQuery = (dialog: Collection.Collection<Dialog, string>) =>
  LiveQuery.make((q) => q.from({ dialog: dialog.tanstack }).findOne())

/** The open branch's permission list, oldest grant first. */
export const sharesQuery = (list: Collection.Collection<ShareRow, string>) =>
  LiveQuery.make((q) => q.from({ share: list.tanstack }).orderBy(({ share }) => share.createdAt))

/** Sharing's state for one tab. */
export class SharingStore extends Context.Service<
  SharingStore,
  {
    readonly origin: string
    readonly dialog: Collection.Collection<Dialog, string>
    readonly dialogState: Effect.Success<ReturnType<typeof dialogQuery>>
    /** The open branch's permission list, as the dialog renders it. */
    readonly list: Collection.Collection<ShareRow, string>
    readonly listState: Effect.Success<ReturnType<typeof sharesQuery>>
    /** A branch's permission list, synced while this tab has opened it, for as long as the store lives. */
    readonly shares: (branchId: string) => Effect.Effect<ElectricCollection.ElectricCollection<ShareRow>>
    /** What keeps `list` equal to the open branch's: only the latest dialog's runs. */
    readonly follower: FiberHandle.FiberHandle<void, never>
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/sharing/SharingStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. */
  static readonly layer = (config: SharingConfig) =>
    Layer.effect(
      SharingStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const dialog = yield* Collection.local<Dialog, string>({
          id: "share-dialog",
          schema: Dialog,
          getKey: (row) => row.id,
          initialData: [{ id: DIALOG, open: false, branchId: null, error: null, pending: [] }],
        })
        const list = yield* Collection.local<ShareRow, string>({
          id: "share-list",
          schema: ShareRow,
          getKey: (row) => row.grantee,
        })
        const opened = new Map<string, ElectricCollection.ElectricCollection<ShareRow>>()
        const opening = yield* Semaphore.make(1)
        const open = (branchId: string) =>
          ElectricCollection.make<ShareRow>({
            id: `shares:${branchId}`,
            schema: ShareRow,
            getKey: (row) => row.grantee,
            syncMode: "eager",
            shape: {
              url: `${config.origin}${SHARES_SHAPE_ROUTE}?branch=${encodeURIComponent(branchId)}`,
              columnMapper: ElectricCollection.snakeCamelMapper(),
            },
          }).pipe(
            Scope.provide(scope),
            Effect.tap((collection) => Effect.sync(() => opened.set(branchId, collection))),
          )
        // One at a time, so two callers asking for one branch at once open it once.
        const shares = (branchId: string) =>
          Semaphore.withPermits(opening, 1)(
            Effect.suspend(() => {
              const known = opened.get(branchId)
              return known !== undefined ? Effect.succeed(known) : open(branchId)
            }),
          )
        return SharingStore.of({
          origin: config.origin,
          dialog,
          dialogState: yield* dialogQuery(dialog),
          list,
          listState: yield* sharesQuery(list),
          shares,
          follower: yield* FiberHandle.make<void, never>(),
          scope,
        })
      }),
    )
}
