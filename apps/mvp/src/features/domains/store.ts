import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Context, Effect, FiberHandle, Layer, Scope, Semaphore, Stream } from "effect"
import { RepoStore } from "../repo/store"
import { shapeRefusals } from "../issues/source"
import { DOMAINS_SHAPE_ROUTE } from "./contract"
import { listQuery, pageQuery, savesQuery } from "./queries"
import { Domain, DomainSave, DomainsPage } from "./schema"

// Custom domains on this tab (docs/features/domains.md): each repository's domains, synced from Postgres by Electric
// while its Settings page shows them (only a Maintainer's or Admin's shape has rows) and never kept on the device; the
// list the page renders, kept equal to the open repository's; and this tab's writes that haven't landed.

/** Where the domains sync from: ChatApi's origin, the site's own. */
export interface DomainsConfig {
  readonly origin: string
}

/** The one `page` row's key. */
export const PAGE = "page"

type Success<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

export class DomainsStore extends Context.Service<
  DomainsStore,
  {
    readonly page: Collection.Collection<DomainsPage, string>
    readonly pageState: Success<typeof pageQuery>
    /** The open repository's domains, kept by the follower; what renders is `listState`, through the data gate. */
    readonly list: Collection.Collection<Domain, string>
    readonly listState: Success<typeof listQuery>
    /** This tab's writes of a hostname that haven't landed. */
    readonly saves: Collection.Collection<DomainSave, string>
    readonly savesState: Success<typeof savesQuery>
    /** A repository's domains, synced while this tab has opened them, for as long as the store lives. */
    readonly domains: (repoId: string) => Effect.Effect<ElectricCollection.ElectricCollection<Domain>>
    /** What keeps `list` equal to the open repository's: only the latest page's runs. */
    readonly follower: FiberHandle.FiberHandle<void, never>
    /** Where the work an action starts runs. */
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/domains/DomainsStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. */
  static readonly layer = (config: DomainsConfig) =>
    Layer.effect(
      DomainsStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const page = yield* Collection.local<DomainsPage, string>({
          id: "domains-page",
          schema: DomainsPage,
          getKey: (row) => row.id,
          initialData: [{ id: PAGE, owner: "", name: "" }],
        })
        const list = yield* Collection.local<Domain, string>({
          id: "domains-list",
          schema: Domain,
          getKey: (row) => row.hostname,
        })
        const saves = yield* Collection.local<DomainSave, string>({
          id: "domain-saves",
          schema: DomainSave,
          getKey: (row) => row.hostname,
        })
        const opened = new Map<string, ElectricCollection.ElectricCollection<Domain>>()
        const opening = yield* Semaphore.make(1)
        const repos = yield* RepoStore
        const source = yield* ShapeSource.ShapeSource
        // A domains shape's 403 refuses the repository's domains, not the repository (ruling #3): they go from the list.
        const narrow = yield* shapeRefusals(repos, scope)
        // Requests wait while the repository is refused, so an eviction doesn't sync rows back (decision 0110).
        const unrefused = (id: string) => {
          const marked = ShapeSource.gated(source,
            repos.rolesState.rows.pipe(Stream.map((rows) => rows.find((row) => row.id === id)?.refused !== "forbidden"), Stream.changes))
          return narrow.source(marked, id, Effect.suspend(() => opened.get(id)?.evict ?? Effect.void))
        }
        const open = (repoId: string) =>
          ElectricCollection.make<Domain>({
            id: `domains:${repoId}`,
            schema: Domain,
            getKey: (row) => row.hostname,
            syncMode: "eager",
            shape: {
              url: `${config.origin}${DOMAINS_SHAPE_ROUTE}?repo=${encodeURIComponent(repoId)}`,
              columnMapper: ElectricCollection.snakeCamelMapper(),
              parser: { timestamptz: (value: string) => new Date(value).toISOString() },
            },
          }).pipe(
            Effect.provideService(ShapeSource.ShapeSource, unrefused(repoId)),
            Scope.provide(scope),
            Effect.tap((collection) => Effect.sync(() => opened.set(repoId, collection))),
          )
        yield* repos.registerCache(["domains"], (id) => Effect.suspend(() => opened.get(id)?.evict ?? Effect.void))
        // One at a time, so two callers asking for one repository at once open it once.
        const domains = (repoId: string) =>
          Semaphore.withPermits(opening, 1)(
            Effect.suspend(() => {
              const known = opened.get(repoId)
              return known !== undefined ? Effect.succeed(known) : open(repoId)
            }),
          )
        return DomainsStore.of({
          page,
          pageState: yield* pageQuery(page),
          list,
          // Only through the data gate (repo/gate.ts): a refused or unverified repository's domains never show.
          listState: yield* listQuery(yield* repos.gate(list)),
          saves,
          savesState: yield* savesQuery(saves),
          domains,
          follower: yield* FiberHandle.make<void, never>(),
          scope,
        })
      }),
    )
}
