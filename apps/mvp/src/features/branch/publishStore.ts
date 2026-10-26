import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Context, Effect, FiberHandle, Layer, Scope, Semaphore } from "effect"
import type { Item, WriteRow } from "../issues/schema"
import { IssuesStore } from "../issues/store"
import { FilesRow } from "../pulls/schema"
import { PUBLICATIONS_SHAPE_ROUTE } from "./contract"
import { PublicationRow, PublishPress } from "./publishSchema"
import type { Current } from "./schema"
import { BranchStore } from "./store"

// Publish and Update branch on this tab (docs/features/branch-publish.md#the-branch-page): the shown branch's
// publication, synced from Postgres by Electric while its page shows it and mirrored into `shown`; this tab's presses;
// the comparisons its Compare read; and, from the issues' store, the person's own Publish and Update writes and the
// pull request's title.

/** Where publications sync from: ChatApi's origin, the site's own. */
export interface PublishConfig {
  readonly origin: string
}

type Branches = Collection.Collection<Current, string>
type QueryOf<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/** The shown branch's publication, once it has one. */
export const publicationQuery = (current: Branches, shown: Collection.Collection<PublicationRow, string>) =>
  LiveQuery.make((q) =>
    q
      .from({ current: current.tanstack })
      .innerJoin({ publication: shown.tanstack }, ({ current, publication }) => Query.eq(current.branchId, publication.branchId))
      .select(({ publication }) => ({
        branchId: publication.branchId,
        repoId: publication.repoId,
        githubRef: publication.githubRef,
        baseRef: publication.baseRef,
        baseSha: publication.baseSha,
        headSha: publication.headSha,
        prNumber: publication.prNumber,
        updateState: publication.updateState,
        syncedSha: publication.syncedSha,
        syncState: publication.syncState,
        syncConflicts: publication.syncConflicts,
        updatedAt: publication.updatedAt,
      }))
      .findOne()
  )

/** The title of the shown branch's pull request, once the device has its row. */
export const pullTitleQuery = (
  current: Branches,
  shown: Collection.Collection<PublicationRow, string>,
  items: ElectricCollection.ElectricCollection<Item>,
) =>
  LiveQuery.make((q) =>
    q
      .from({ current: current.tanstack })
      .innerJoin({ publication: shown.tanstack }, ({ current, publication }) => Query.eq(current.branchId, publication.branchId))
      .innerJoin({ item: items.tanstack }, ({ publication, item }) => Query.eq(publication.repoId, item.repoId))
      .where(({ publication, item }) => Query.and(Query.eq(item.number, publication.prNumber), Query.eq(item.kind, "pull")))
      .select(({ item }) => ({ title: item.title }))
      .findOne()
  )

/** This tab's presses on the shown branch. */
export const pressQuery = (current: Branches, presses: Collection.Collection<PublishPress, string>) =>
  LiveQuery.make((q) =>
    q
      .from({ current: current.tanstack })
      .innerJoin({ press: presses.tanstack }, ({ current, press }) => Query.eq(current.branchId, press.branchId))
      .select(({ press }) => ({
        branchId: press.branchId,
        form: press.form,
        publishing: press.publishing,
        publishWriteId: press.publishWriteId,
        publishRefused: press.publishRefused,
        updating: press.updating,
        updateWriteId: press.updateWriteId,
        updateRefused: press.updateRefused,
        resyncing: press.resyncing,
        resyncWriteId: press.resyncWriteId,
        resyncRefused: press.resyncRefused,
      }))
      .findOne()
  )

/** The person's own Publish, Update branch and Resync writes of the shown branch, whoever started them. */
export const writesQuery = (current: Branches, writes: ElectricCollection.ElectricCollection<WriteRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ current: current.tanstack })
      .innerJoin({ write: writes.tanstack }, ({ current, write }) => Query.eq(current.branchId, write.branchId))
      .where(({ write }) =>
        Query.or(Query.eq(write.op, "branch/publish"), Query.eq(write.op, "branch/update"), Query.eq(write.op, "branch/resync"))
      )
      .select(({ write }) => ({
        id: write.id,
        op: write.op,
        status: write.status,
        failure: write.failure,
        createdAt: write.createdAt,
      }))
  )

/** Every comparison this tab's Compare read, by `<base>...<head>`. */
export const comparisonsQuery = (comparisons: Collection.Collection<FilesRow, string>) =>
  LiveQuery.make((q) => q.from({ comparison: comparisons.tanstack }).select(({ comparison }) => comparison))

/** Publish's and Update branch's state for one tab. */
export class PublishStore extends Context.Service<
  PublishStore,
  {
    /** A branch's publication, synced while this tab has opened it, for as long as the store lives. */
    readonly publications: (branchId: string) => Effect.Effect<ElectricCollection.ElectricCollection<PublicationRow>>
    /** The shown branch's publication, as the page renders it. */
    readonly shown: Collection.Collection<PublicationRow, string>
    readonly presses: Collection.Collection<PublishPress, string>
    readonly comparisons: Collection.Collection<FilesRow, string>
    readonly publication: QueryOf<typeof publicationQuery>
    readonly pullTitle: QueryOf<typeof pullTitleQuery>
    readonly press: QueryOf<typeof pressQuery>
    readonly writes: QueryOf<typeof writesQuery>
    readonly comparisonList: QueryOf<typeof comparisonsQuery>
    /** What keeps `shown` equal to the shown branch's publication: only the latest page's runs. */
    readonly follower: FiberHandle.FiberHandle<void, never>
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/branch/PublishStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. Needs the branch's and the issues' stores. */
  static readonly layer = (config: PublishConfig) =>
    Layer.effect(
      PublishStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const { current } = yield* BranchStore
        const { items, writes } = yield* IssuesStore
        const shown = yield* Collection.local<PublicationRow, string>({
          id: "branch-publication",
          schema: PublicationRow,
          getKey: (row) => row.branchId,
        })
        const presses = yield* Collection.local<PublishPress, string>({
          id: "branch-publish",
          schema: PublishPress,
          getKey: (row) => row.branchId,
        })
        const comparisons = yield* Collection.local<FilesRow, string>({
          id: "branch-compare",
          schema: FilesRow,
          getKey: (row) => row.id,
        })
        const opened = new Map<string, ElectricCollection.ElectricCollection<PublicationRow>>()
        const opening = yield* Semaphore.make(1)
        const open = (branchId: string) =>
          ElectricCollection.make<PublicationRow>({
            id: `publications:${branchId}`,
            schema: PublicationRow,
            getKey: (row) => row.branchId,
            syncMode: "eager",
            shape: {
              url: `${config.origin}${PUBLICATIONS_SHAPE_ROUTE}?branch=${encodeURIComponent(branchId)}`,
              columnMapper: ElectricCollection.snakeCamelMapper(),
            },
          }).pipe(
            Scope.provide(scope),
            Effect.tap((collection) => Effect.sync(() => opened.set(branchId, collection))),
          )
        // One at a time, so two callers asking for one branch at once open it once.
        const publications = (branchId: string) =>
          Semaphore.withPermits(opening, 1)(
            Effect.suspend(() => {
              const known = opened.get(branchId)
              return known !== undefined ? Effect.succeed(known) : open(branchId)
            }),
          )
        return PublishStore.of({
          publications,
          shown,
          presses,
          comparisons,
          publication: yield* publicationQuery(current, shown),
          pullTitle: yield* pullTitleQuery(current, shown, items),
          press: yield* pressQuery(current, presses),
          writes: yield* writesQuery(current, writes),
          comparisonList: yield* comparisonsQuery(comparisons),
          follower: yield* FiberHandle.make<void, never>(),
          scope,
        })
      }),
    )
}
