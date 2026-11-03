import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import type { Collection as TanStackCollection, LiveQueryCollectionUtils, NonSingleResult } from "@tanstack/db"
import { Effect, Schema, type Stream } from "effect"
import type { RepoRole, Session } from "../auth/schema"
import { repoVisibility } from "./visibility"

// The data gate (decision 0110, 2026-11-03, the data gate). Every repository's rows reach a page only through a live
// query joined to `repo-visible`: one row per repository this tab holds rows of, `show` while `repoVisibility` says
// show. A refusal mark or a session a reached server couldn't verify changes that row, and TanStack DB drops the
// repository's rows from every joined query in the same change, whatever component reads them. A row that names no
// repository joins nothing and never shows.

/**
 * Whether a repository this tab holds rows of may show now, by its id (`github/owner/name`) and its `owner/name`: the
 * rows every store's rows join.
 */
export const Visible = Schema.Struct({ id: Schema.String, repo: Schema.String, show: Schema.Boolean })
export type Visible = typeof Visible.Type

/**
 * Where a row names its repository: `repoId` (`github/owner/name`), `id` for a repository's own row, or `repo`
 * (`owner/name`, lowercase) for a row that names it so.
 */
export type By = "repoId" | "id" | "repo"

/** The repository id a row of `by` names, as `track` takes it. */
const idOf = (row: Record<string, unknown>, by: By): unknown =>
  by === "repo" ? (typeof row.repo === "string" && row.repo !== "" ? `github/${row.repo}`.toLowerCase() : undefined) : row[by]

/** A condition true when any of `conditions` is: one alone, or their `or`. */
export const anyOf = (conditions: ReadonlyArray<ReturnType<typeof Query.eq>>) =>
  conditions.length === 1 ? conditions[0]! : Query.or(...(conditions as [ReturnType<typeof Query.eq>, ReturnType<typeof Query.eq>]))

/** Anything a live query reads from: a collection or another live query. */
export interface Source<A extends object> {
  readonly tanstack: TanStackCollection<A, any, any>
}

/** A row a store keeps of one repository, by its id (`github/owner/name`); none is a row of no known repository. */
export interface Attributed {
  readonly repoId?: string | null | undefined
}

/** The rows of `rows` whose repository may show now: what a store exposes, never `rows` itself. */
export interface Gated<A extends object> {
  readonly tanstack: TanStackCollection<A, string | number, LiveQueryCollectionUtils> & NonSingleResult
  readonly toArray: Effect.Effect<ReadonlyArray<A>>
  readonly preload: LiveQuery.LiveQuery<LiveQuery.AnyQuery>["preload"]
  readonly rows: Stream.Stream<ReadonlyArray<A>>
  readonly changes: LiveQuery.LiveQuery<LiveQuery.AnyQuery>["changes"]
}

/**
 * The visibility of each repository this tab holds rows of, from `roles` (the role rows, with a refusal mark) and
 * `session` (the one session row), and `gate`, which joins a store's rows to it. With `known`, nothing shows until it
 * ends: the device's stored refusals are applied by then.
 */
export const makeVisibility = (
  roles: Source<RepoRole>,
  session: Source<Session>,
  known?: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const visible = yield* Collection.local<Visible, string>({ id: "repo-visible", schema: Visible, getKey: (row) => row.id })
    // Closed until `known` (the device's stored refusal marks are applied): on a cold load, rows restored before the
    // marks would otherwise show a repository this person was refused.
    let open = known === undefined
    // Kept in the change that moves it: each role or session change writes the rows it changes before it returns, so a
    // joined query never reads a row a refusal already hides.
    const decide = (ids: Iterable<string>) => {
      const now = session.tanstack.get("session")
      for (const id of ids) {
        const show = open && (now === undefined || repoVisibility(now, roles.tanstack.get(id)) === "show")
        const held = visible.tanstack.get(id)
        if (held === undefined) visible.tanstack.insert({ id, repo: id.slice("github/".length), show })
        else if (held.show !== show) visible.tanstack.update(id, (draft) => void (draft.show = show))
      }
    }
    const follow = <A extends object>(source: Source<A>, ids: (keys: ReadonlyArray<string | number>) => Iterable<string>) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          source.tanstack.subscribeChanges((changes) => decide(ids(changes.map((change) => change.key))), {
            includeInitialState: true,
          })
        ),
        (subscription) => Effect.sync(() => subscription.unsubscribe()),
      )
    if (known !== undefined) {
      yield* known.pipe(
        Effect.andThen(Effect.sync(() => {
          open = true
          decide([...visible.tanstack.keys()].filter((key): key is string => typeof key === "string"))
        })),
        Effect.forkScoped({ startImmediately: true }),
      )
    }
    // A role row's own repository; any session change, every repository.
    yield* follow(roles, (keys) => keys.filter((key): key is string => typeof key === "string" && visible.tanstack.has(key)))
    yield* follow(session, () => [...visible.tanstack.keys()].filter((key): key is string => typeof key === "string"))
    /** Repository `id` has rows on this tab: it gets a visibility row, synchronously. */
    const track = (id: unknown) => {
      if (typeof id === "string" && id !== "" && !visible.tanstack.has(id)) decide([id])
    }
    /**
     * `rows` as a live query joined to the visibility rows: only the rows of a repository that may show. Each repository
     * a row names (its `repoId`, or its `id` for a repository's own row) gets a visibility row as the row arrives.
     * `also` names rows that are no repository's and show as they are (a run read from this device's own engine); the
     * store that passes it says why. One query, never a union: a row that moves between the two stays one row.
     */
    const gate = <A extends object & Attributed>(
      rows: Source<A>,
      by: By = "repoId",
      also?: (row: Record<string, any>) => ReturnType<typeof Query.eq>,
    ) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            rows.tanstack.subscribeChanges((changes) => {
              for (const change of changes) if (change.type !== "delete") track(idOf(change.value as Record<string, unknown>, by))
            }, { includeInitialState: true })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe()),
        )
        // The row's side is an expression, not the bare field: TanStack DB then never loads `rows` lazily by key, which
        // left a collection still loading (an Electric shape that hadn't answered) holding back every query over it, and
        // rows that arrived after the query was built joined to nothing.
        const on = (row: Record<string, any>, shown: Record<string, any>) =>
          by === "repo" ? Query.eq(Query.coalesce(row.repo, ""), shown.repo) : Query.eq(Query.coalesce(row[by], ""), shown.id)
        const source = rows.tanstack as TanStackCollection<A & { readonly repoId: string }, any, any>
        const query = yield* LiveQuery.make((q) =>
          also === undefined
            ? q
              .from({ row: source })
              .innerJoin({ shown: visible.tanstack }, ({ row, shown }) => on(row, shown))
              .where(({ shown }) => Query.eq(shown.show, true))
              .select(({ row }) => row)
            : q
              .from({ row: source })
              .leftJoin({ shown: visible.tanstack }, ({ row, shown }) => on(row, shown))
              .where(({ row, shown }) => Query.or(also(row), Query.eq(shown?.show, true)))
              .select(({ row }) => row),
          // Each row keeps the key its own collection gives it: a store's `get` by key reads it as before.
          { getKey: (row) => rows.tanstack.getKeyFromItem(row as A) },
        )
        return query as unknown as Gated<A>
      }).pipe(Effect.orDie)
    return { visible, track, gate }
  }).pipe(Effect.orDie)
