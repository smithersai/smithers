import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Persistence, Query } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Layer, Option, Schema, Scope, Semaphore } from "effect"
import { AuthStore } from "../auth/store"
import { VIEWS_SHAPE_ROUTE } from "./contract"
import { ConversationOwners, homeNamed } from "../conversations/owners"
import type { Gated, Source } from "../repo/gate"
import { OPENED, Opened, SHOWING, Showing, View } from "./schema"

// The conversation's views on this tab (docs/features/web-pages.md#the-browser, decision 0004 §8): the views Postgres
// has, synced by Electric and kept on the device, like the messages; and which one this tab shows full screen. The
// conversation reads them beside its messages (src/features/chat/queries.ts); the full-screen route reads `shown`.

/** Where the views sync from: ChatApi's origin, the site's own. A failed request waits `SyncPolicy.defaultPolicy`. */
export interface ViewsConfig {
  readonly origin: string
}

/**
 * The view this tab shows full screen, once the device has it: a `webpage`, a form or a generated view. A `link` card
 * has no full size.
 */
export const shownQuery = (views: Source<View>, showing: Collection.Collection<Showing, string>) =>
  LiveQuery.make((q) =>
    q
      .from({ showing: showing.tanstack })
      .innerJoin({ view: views.tanstack }, ({ showing, view }) => Query.eq(showing.viewId, view.id))
      .where(({ view }) => Query.not(Query.eq(view.template, "link")))
      .select(({ view }) => ({
        id: view.id,
        template: view.template,
        props: view.props,
        title: view.title,
        state: view.state,
        html: view.html,
        interactions: view.interactions,
        revision: view.revision,
      }))
      .findOne()
  )

/** Every view of a conversation on this device: the rows the conversation renders its views from, by id. */
export const rowsQuery = (views: Source<View>) => LiveQuery.make((q) => q.from({ view: views.tanstack }))

/**
 * Branch conversation `conversationId`'s views, each naming it: its shape's rows carry no conversation of their own, and
 * the data gate joins a conversation's rows by it (src/features/conversations/owners.ts).
 */
export const ofConversation = (views: Source<View>, conversationId: string) =>
  LiveQuery.make(
    (q) => q.from({ view: views.tanstack }).select(({ view }) => ({ ...view, conversationId })),
    { getKey: (row) => row.id },
  )

/** Which conversation is the home one, once the session answer names it: its views' shape names none. */
export const HOME = "home"
export const HomeConversation = Schema.Struct({ id: Schema.Literal(HOME), conversationId: Schema.String })
export type HomeConversation = typeof HomeConversation.Type

/**
 * The home conversation's views, each naming the home conversation once this tab knows it (`knowHome`): none before.
 * The join's left side is an expression that is always "home", so every view meets the one row.
 */
export const ofHome = (views: Source<View>, home: Source<HomeConversation>) =>
  LiveQuery.make(
    (q) =>
      q
        .from({ view: views.tanstack })
        .innerJoin({ home: home.tanstack }, ({ view, home }) =>
          Query.eq(Query.coalesce((view as unknown as { readonly home?: string }).home, HOME), home.id))
        .select(({ view, home }) => ({ ...view, conversationId: home.conversationId })),
    { getKey: (row) => row.id },
  )

type Shown<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/**
 * The views' state for one tab:
 * - `views`: the conversation's views in Postgres, synced by Electric and kept on the device; read-only;
 * - `showing`: the view the full-screen route shows, in memory;
 * - `shown`: that view, once the device has it;
 * - `opened`: the repository or issues view this tab opened full screen, and the page it was on, in memory.
 */
export class ViewsStore extends Context.Service<
  ViewsStore,
  {
    readonly views: ElectricCollection.ElectricCollection<View>
    /**
     * The home conversation's views while ConversationOwners attributes the home conversation and its repository may show
     * (decision 0110, the data gate): none before the session answer names the conversation (`knowHome`).
     */
    readonly shownHome: Gated<View>
    /** The home conversation is `conversationId`: what the session answer names. */
    readonly knowHome: (conversationId: string) => Effect.Effect<void>
    readonly showing: Collection.Collection<Showing, string>
    readonly shown: Shown<typeof shownQuery>
    /** Which repository or issues view this tab opened full screen, and from which page (src/features/views/minimize.ts). */
    readonly opened: Collection.Collection<Opened, string>
    /** Where work an action starts runs, closed with the store. */
    readonly scope: Scope.Scope
    /**
     * A branch conversation's views (decision 0013 §1), synced and kept on the device like the home conversation's
     * `views`: opened on first use, then the same collection for as long as the store lives. The feature's own: what
     * shows reads `shownViewsIn`, `shownIn` and `rowsIn`, through the data gate.
     */
    readonly forConversation: (conversationId: string) => Effect.Effect<ElectricCollection.ElectricCollection<View>>
    /**
     * A branch conversation's views while its repository may show (src/features/conversations/owners.ts): none of a
     * conversation the person has no row of, or whose repository refused them. Opens them on first use.
     */
    readonly shownViewsIn: (conversationId: string) => Effect.Effect<Gated<View>>
    /** The view this tab shows full screen from a branch conversation opened before, once the device has it. */
    readonly shownIn: (conversationId: string) => Shown<typeof shownQuery> | undefined
    /** A conversation's views on this device, as a live query: the home conversation's, or a branch's opened before. */
    readonly rowsIn: (conversationId: string | undefined) => Shown<typeof rowsQuery>
  }
>()("@smthrs/mvp/views/ViewsStore") {
  /** The store; its collections cleaned up and its Electric shape closed when the scope closes. */
  static readonly layer = (config: ViewsConfig) =>
    Layer.effect(
      ViewsStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const persistence = yield* Persistence.Persistence
        const owners = yield* ConversationOwners
        const views = yield* ElectricCollection.make<View>({
          id: "views",
          schema: View,
          getKey: (row) => row.id,
          syncMode: "eager",
          persist: { schemaVersion: 5 },
          shape: {
            url: `${config.origin}${VIEWS_SHAPE_ROUTE}`,
            columnMapper: ElectricCollection.snakeCamelMapper(),
            parser: { int8: (value: string) => Number(value) },
          },
        })
        const showing = yield* Collection.local<Showing, string>({
          id: "views-showing",
          schema: Showing,
          getKey: (row) => row.id,
          initialData: [{ id: SHOWING, viewId: null, conversationId: null }],
        })
        const openedFrom = yield* Collection.local<Opened, string>({
          id: "views-opened",
          schema: Opened,
          getKey: (row) => row.id,
          initialData: [{ id: OPENED, viewId: null, template: null, repo: null, returnTo: null }],
        })
        const home = yield* Collection.local<HomeConversation, string>({ id: "views-home", schema: HomeConversation, getKey: (row) => row.id })
        const knowHome = (conversationId: string) => Effect.sync(() => {
          const held = home.tanstack.get(HOME)
          if (held === undefined) home.tanstack.insert({ id: HOME, conversationId })
          else if (held.conversationId !== conversationId) home.tanstack.update(HOME, (draft) => void (draft.conversationId = conversationId))
        })
        // The home conversation's id comes from the session answer (auth `Session` `homeConversationId`): the person's own.
        const auth = yield* Effect.serviceOption(AuthStore)
        if (Option.isSome(auth)) {
          const decide = () => {
            const named = homeNamed(auth.value)
            if (named !== undefined) Effect.runSync(knowHome(named))
          }
          for (const rows of [auth.value.session.tanstack, auth.value.confirmed.tanstack] as const) {
            yield* Effect.acquireRelease(
              Effect.sync(() => (rows as { subscribeChanges: (cb: () => void, o: { includeInitialState: boolean }) => { unsubscribe: () => void } })
                .subscribeChanges(decide, { includeInitialState: true })),
              (subscription) => Effect.sync(() => subscription.unsubscribe()),
            )
          }
        }
        const shownHome = (yield* owners.ofShown(yield* ofHome(views, home), "conversationId")) as unknown as Gated<View>
        const shown = yield* shownQuery(shownHome, showing)
        const rows = yield* rowsQuery(shownHome)
        const rowsBy = new Map<string, Shown<typeof rowsQuery>>()
        const opened = new Map<string, ElectricCollection.ElectricCollection<View>>()
        const shownBy = new Map<string, Shown<typeof shownQuery>>()
        const gatedBy = new Map<string, Gated<View>>()
        // Include query creation and cache publication in the same first-open critical section.
        const opening = yield* Semaphore.make(1)
        const forConversation = (conversationId: string) =>
          Semaphore.withPermits(opening, 1)(Effect.suspend(() => {
            const known = opened.get(conversationId)
            if (known !== undefined) return Effect.succeed(known)
            return ElectricCollection.make<View>({
              id: `views:${conversationId}`,
              schema: View,
              getKey: (row) => row.id,
              syncMode: "eager",
              persist: { schemaVersion: 5 },
              shape: {
                url: `${config.origin}${VIEWS_SHAPE_ROUTE}?conversation=${encodeURIComponent(conversationId)}`,
                columnMapper: ElectricCollection.snakeCamelMapper(),
                parser: { int8: (value: string) => Number(value) },
              },
            }).pipe(
              Scope.provide(scope),
              Effect.provideService(Persistence.Persistence, persistence),
              Effect.tap((collection) =>
                Effect.flatMap(
                  // What shows of a branch conversation's views goes through the data gate: only while its repository
                  // may show.
                  Scope.provide(Effect.gen(function* () {
                    const gated = yield* owners.ofShown(yield* ofConversation(collection, conversationId), "conversationId")
                    const shownViews = gated as unknown as Gated<View>
                    return [yield* shownQuery(shownViews, showing), yield* rowsQuery(shownViews), shownViews] as const
                  }), scope),
                  ([query, all, gated]) =>
                    Effect.sync(() => {
                      opened.set(conversationId, collection)
                      shownBy.set(conversationId, query)
                      rowsBy.set(conversationId, all)
                      gatedBy.set(conversationId, gated)
                    }),
                )
              ),
              Effect.orDie,
            )
          }))
        return ViewsStore.of({
          views,
          shownHome,
          knowHome,
          showing,
          shown,
          opened: openedFrom,
          scope,
          forConversation,
          shownViewsIn: (conversationId) => Effect.map(forConversation(conversationId), () => gatedBy.get(conversationId)!),
          shownIn: (conversationId) => shownBy.get(conversationId),
          rowsIn: (conversationId) => (conversationId === undefined ? undefined : rowsBy.get(conversationId)) ?? rows,
        })
      }),
    )
}
