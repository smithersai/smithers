import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { signedInShapeSource } from "../auth/source"
import { AuthStore } from "../auth/store"
import { BranchStore } from "../branch/store"
import type { Gated, Source } from "../repo/gate"
import { repoId } from "../repo/contract"
import { RepoStore } from "../repo/store"
import { MY_CONVERSATIONS_SHAPE_ROUTE } from "./contract"
import { Mine } from "./schema"

// Which repository each of the person's conversations is of (decision 0110, 2026-11-03, the data gate): the person's
// `conversation_people` rows, synced by Electric and kept on the device. A conversation's rows (its messages, its views,
// its runs' waits) name no repository of their own; they show only while the conversation's repository may, through
// `ofShown`. The home conversation is the person's own: it shows by the id the session answer names (auth `Session`
// `homeConversationId`), with or without its row. A verified branch-opening cache also identifies its repository. With neither receipt, a conversation shows nothing. Below
// every store that keeps a conversation's rows, and below the conversations' list (store.ts), which reads `mine`.

/**
 * A conversation of the person's and its repository (`github/owner/name`). `home` marks the person's home conversation,
 * as the session answer names it: theirs by who they are, so it shows with no repository's say.
 */
export const OwnedRow = Schema.Struct({ conversationId: Schema.String, repoId: Schema.String, home: Schema.Boolean })
export type Owned = typeof OwnedRow.Type

/**
 * The home conversation the session answer names; until this load's answer, the one the last confirmed answer named, so
 * a reload offline still shows it. Signed out, or an answer that names none: no home.
 */
export const homeNamed = (auth: AuthStore["Service"]): string | undefined => {
  const session = auth.session.tanstack.get("session")
  if (session?.status === "signed_in" || session?.status === "signed_out") return session.homeConversationId
  return auth.confirmed.tanstack.get("session")?.homeConversationId
}

export class ConversationOwners extends Context.Service<
  ConversationOwners,
  {
    /** The rows as they sync: the conversations feature's own, never shown as they are. */
    readonly mine: ElectricCollection.ElectricCollection<Mine>
    /** The person's conversations whose repository may show now. */
    readonly shown: Gated<Owned>
    /**
     * The rows of `rows` whose conversation (`field`) is one of `shown`: what a store exposes of a conversation's rows,
     * never `rows` itself. A row of no known conversation never shows.
     */
    readonly ofShown: <A extends object>(rows: Source<A>, field: keyof A & string) => Effect.Effect<Gated<A>, never, Scope.Scope>
  }
>()("@smthrs/mvp/conversations/ConversationOwners") {
  static readonly layer = (config: { readonly origin: string }) =>
    Layer.effect(
      ConversationOwners,
      Effect.gen(function* () {
        const repos = yield* RepoStore
        const mine = yield* ElectricCollection.make<Mine>({
          id: "my-conversations",
          schema: Mine,
          getKey: (row) => row.conversationId,
          syncMode: "eager",
          persist: { schemaVersion: 1 },
          shape: {
            url: `${config.origin}${MY_CONVERSATIONS_SHAPE_ROUTE}`,
            columnMapper: ElectricCollection.snakeCamelMapper(),
          },
        }).pipe(Effect.provideService(ShapeSource.ShapeSource, signedInShapeSource(yield* ShapeSource.ShapeSource, yield* AuthStore)))
        // Each conversation's repository, kept in the change that syncs its row: a plain collection, so the joins below
        // read collections only, never another live query.
        const owned = yield* Collection.local<Owned, string>({ id: "conversation-owners", schema: OwnedRow, getKey: (row) => row.conversationId })
        const auth = yield* AuthStore
        // Each conversation's row, as its repository and whether it is home say; none once neither does.
        const branches = (yield* BranchStore).conversations
        // A successful branch/track response already proves the conversation's repository, before Electric catches up.
        // This existing device cache stores only that relation, never an access grant; the same repo gate still applies.
        const branchOwners = new Map<string, Map<string, string>>()
        const branchIds = new Map<string, string>()
        let homeId: string | undefined
        const keep = (id: string) => {
          const synced = mine.tanstack.get(id)
          const cached = new Set(branchOwners.get(id)?.values())
          const repository = synced !== undefined && synced.owner !== "" && synced.repo !== ""
            ? repoId(synced.owner, synced.repo)
            : cached.size === 1 ? [...cached][0]! : ""
          const home = id === homeId
          repos.track(repository)
          const held = owned.tanstack.get(id)
          if (synced === undefined && cached.size === 0 && !home) {
            if (held !== undefined) owned.tanstack.delete(id)
          } else if (held === undefined) owned.tanstack.insert({ conversationId: id, repoId: repository, home })
          else if (held.repoId !== repository || held.home !== home) {
            owned.tanstack.update(id, (draft) => {
              draft.repoId = repository
              draft.home = home
            })
          }
        }
        const follow = (subscribe: () => { readonly unsubscribe: () => void }) =>
          Effect.acquireRelease(Effect.sync(subscribe), (subscription) => Effect.sync(() => subscription.unsubscribe()))
        yield* follow(() => branches.tanstack.subscribeChanges((changes) => {
          const touched = new Set<string>()
          for (const change of changes) {
            const route = String(change.key)
            const previous = branchIds.get(route)
            if (previous !== undefined) {
              const held = branchOwners.get(previous)!
              held.delete(route)
              if (held.size === 0) branchOwners.delete(previous)
              branchIds.delete(route)
              touched.add(previous)
            }
            const row = branches.tanstack.get(route)
            const [owner, repo, ref] = route.split("/")
            if (row !== undefined && owner && repo && ref) {
              branchIds.set(route, row.conversationId)
              const held = branchOwners.get(row.conversationId) ?? new Map<string, string>()
              held.set(route, repoId(owner, repo))
              branchOwners.set(row.conversationId, held)
              touched.add(row.conversationId)
            }
          }
          for (const id of touched) keep(id)
        }, { includeInitialState: true }))
        yield* follow(() =>
          mine.tanstack.subscribeChanges((changes) => {
            for (const change of changes) keep(String(change.key))
          }, { includeInitialState: true })
        )
        const decideHome = () => {
          const next = homeNamed(auth)
          if (next === homeId) return
          const before = homeId
          homeId = next
          if (before !== undefined) keep(before)
          if (next !== undefined) keep(next)
        }
        yield* follow(() => auth.session.tanstack.subscribeChanges(decideHome, { includeInitialState: true }))
        yield* follow(() => auth.confirmed.tanstack.subscribeChanges(decideHome, { includeInitialState: true }))
        const shown = yield* repos.gate(owned, "repoId", (row) => Query.eq(row.home, true))
        const ofShown = <A extends object>(rows: Source<A>, field: keyof A & string) =>
          LiveQuery.make((q) =>
            q
              .from({ row: rows.tanstack as unknown as Source<{ readonly conversation: string }>["tanstack"] })
              .innerJoin({ owner: owned.tanstack }, ({ row, owner }) =>
                // An expression, not the bare field: TanStack DB then never loads `rows` lazily by key, which left rows
                // that arrived before their owner's row joined to nothing (repo/gate.ts).
                Query.eq(Query.coalesce((row as unknown as Record<string, typeof row.conversation>)[field]!, ""), owner.conversationId))
              .leftJoin({ visible: repos.visible.tanstack }, ({ owner, visible }) => Query.eq(owner.repoId, visible.id))
              // One query, never a union: a conversation that becomes home, or stops being, moves within it.
              .where(({ owner, visible }) => Query.or(Query.eq(owner.home, true), Query.eq(visible?.show, true)))
              .select(({ row }) => row),
            // Each row keeps the key its own collection gives it.
            { getKey: (row) => rows.tanstack.getKeyFromItem(row as unknown as A) },
          ).pipe(Effect.orDie, Effect.map((query) => query as unknown as Gated<A>))
        return ConversationOwners.of({ mine, shown, ofShown })
      }),
    )
}
