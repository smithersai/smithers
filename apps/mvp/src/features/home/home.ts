import type { Home as HomeDocument } from "@smthrs/views"
import { Context, Effect, Layer, Option } from "effect"
import { runners } from "../../boundary"
import type { RepoClient } from "../repo/api"
import type { RepoStore } from "../repo/store"
import { IssuesStore, type RepoIssues } from "../issues/store"
import { TodosStore } from "../todos/store"
import type { FlowDispatch } from "../../flows/dispatch"
import { open, runAction, view, warm, watch } from "./actions"
import type { HomeClient } from "./api"
import { HomeStore } from "./store"

// A repository's home as a frontend sees it: live queries to read and a plain function to act, with no Effect in
// sight. React renders the queries with `useLiveQuery`, and a repository route's loader calls `open`.

type Store = HomeStore["Service"]
type HomeAudience = HomeDocument.Audience
type Stacks = TodosStore["Service"]

/** What a frontend reads live. */
export interface HomeQueries {
  /** Whose home the page shows, with its declared and curated homes. */
  readonly home: Store["homeState"]["tanstack"]
  /** The files its Markdown blocks read. */
  readonly files: Store["fileState"]["tanstack"]
  /**
   * The live blocks' rows: a repository's issues and pull requests and their sync once `open` opened them for an
   * `issues` block (none before, nor without the issues' store), and this person's runs.
   */
  readonly items: (repoId: string) => RepoIssues["itemRows"]["tanstack"] | Store["noItems"]["tanstack"]
  readonly syncs: (repoId: string) => RepoIssues["syncRows"]["tanstack"] | Store["noSyncs"]["tanstack"]
  readonly runs: Store["runs"]["tanstack"]
  /** A repository's TODOs once `open` opened its stack for a `stack` block; no rows before, nor without the TODOs. */
  readonly stack: (repoId: string) => Stacks["empty"]["todos"]["tanstack"] | Store["noTodos"]["tanstack"]
  /** Whether this person may read each opened stack, as its shape last said; none without the TODOs. */
  readonly stackAccess: Stacks["accessQuery"]["tanstack"] | Store["noAccess"]["tanstack"]
}

/** What a route does. */
export interface HomeActions {
  /** A repository route, once warm: reads `owner/name`'s homes, who the person is on it, and its live rows. Returns at once. */
  readonly open: (owner: string, name: string) => void
  /**
   * A repository route first, on a link's hover or focus and before every navigation: reads `owner/name`'s own home
   * and its files into this tab without showing them. Resolves once read, or after a second.
   */
  readonly warm: (owner: string, name: string) => Promise<void>
  /**
   * An action block's button or key on the routed repository, as `login`: resolves once its flow settles with the page
   * to open (New branch: the new branch's workspace), or nothing when it failed, another repository is open, or it isn't an action the home runs.
   */
  readonly run: (flow: string, login: string | null) => Promise<string | undefined>
  /** The view switcher: shows the routed home as `audience`, the person's own or a lower one (SCOPE-14). */
  readonly view: (audience: HomeAudience) => void
  /**
   * Watches what a button on the page started (`ask`: opening the workspace's composer; `action`: an action and the
   * page it opens): one that rejects is logged as `home.navigate` with its code, never left unhandled.
   */
  readonly watch: (what: "ask" | "action", started: Promise<unknown>) => void
}

export class Home extends Context.Service<Home, { readonly queries: HomeQueries; readonly actions: HomeActions }>()(
  "@smthrs/mvp/home/Home",
) {
  /** Binds the store's queries and the action, which runs with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Home,
    Effect.gen(function* () {
      const store = yield* HomeStore
      const todos = yield* Effect.serviceOption(TodosStore)
      const issues = yield* Effect.serviceOption(IssuesStore)
      const opened = (repoId: string) => (Option.isSome(issues) ? issues.value.opened(repoId) : undefined)
      const context = yield* Effect.context<HomeStore | HomeClient | RepoStore | RepoClient | FlowDispatch>()
      const { runSync: run, runPromise: promise } = runners(context, "home")
      return Home.of({
        queries: {
          home: store.homeState.tanstack,
          files: store.fileState.tanstack,
          items: (repoId) => opened(repoId)?.itemRows.tanstack ?? store.noItems.tanstack,
          syncs: (repoId) => opened(repoId)?.syncRows.tanstack ?? store.noSyncs.tanstack,
          runs: store.runs.tanstack,
          stack: (repoId) =>
            Option.isSome(todos) ? (todos.value.opened(repoId) ?? todos.value.empty).todos.tanstack : store.noTodos.tanstack,
          stackAccess: Option.isSome(todos) ? todos.value.accessQuery.tanstack : store.noAccess.tanstack,
        },
        actions: {
          open: (owner, name) => run(open(owner, name)),
          warm: (owner, name) => promise(warm(owner, name)),
          run: (flow, login) => promise(runAction(flow, login)),
          view: (audience) => run(view(audience)),
          watch: (what, started) => void promise(watch(what, started)),
        },
      })
    }),
  )
}

/** The home layer's value: what frontends get. */
export type HomeView = Home["Service"]
