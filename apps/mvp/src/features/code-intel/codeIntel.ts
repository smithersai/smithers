import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import type { RepoClient } from "../repo/api"
import { RepoStore } from "../repo/store"
import { follow, hover, keyAction, problem, select, definition, targetOf, togglePane, type Token, type KeyModifiers } from "./actions"
import { CODE_INTEL } from "./rows"
import type { LanguageServers } from "./session"
import { CodeIntelStore } from "./store"

// Code intelligence as a frontend sees it: one live query to read and plain functions to act, with no Effect in sight
// (docs/features/code-intelligence.md). It follows the repository view's routed file on its own: when the view shows
// a TypeScript or JavaScript file at a commit, the file opens in that commit's language server.

type Store = CodeIntelStore["Service"]

/** What a frontend reads live: the one row. */
export interface CodeIntelQueries {
  readonly state: Store["query"]["tanstack"]
}

/** What a person does. Each returns at once; the answers land in the row. */
export interface CodeIntelActions {
  /** The pointer rested on a token. */
  readonly rest: (token: Token) => void
  /** An arrow key moved the cursor to a token. */
  readonly move: (token: Token) => void
  /** A click on a token. */
  readonly select: (token: Token) => void
  /** ⌘-click or Ctrl-click on a token. */
  readonly activate: (token: Token) => void
  /** A key while the code has focus; `true` when it was the view's, so the caller keeps it from the page. */
  readonly key: (key: string, shift: boolean, modifiers?: KeyModifiers) => boolean
  /** The toolbar's problem count: the next problem. */
  readonly nextProblem: () => void
  /** The toolbar's Symbols button, or the pane's Close. */
  readonly togglePane: () => void
}

export class CodeIntel extends Context.Service<
  CodeIntel,
  { readonly queries: CodeIntelQueries; readonly actions: CodeIntelActions }
>()("@smthrs/mvp/code-intel/CodeIntel") {
  /**
   * Follows the routed file and binds the actions, each forked into the store's scope with the services this layer was
   * built with (`runners`, src/boundary.ts). `key` decides synchronously, so a DOM listener can keep a key from the page.
   */
  static readonly layer = Layer.effect(
    CodeIntel,
    Effect.gen(function* () {
      const store = yield* CodeIntelStore
      const repo = yield* RepoStore
      const { runSync: run } = runners(
        yield* Effect.context<CodeIntelStore | RepoStore | RepoClient | LanguageServers | FlowDispatch>(),
        "code-intel",
      )
      const background = (effect: Effect.Effect<void, never, CodeIntelStore | RepoClient | LanguageServers | FlowDispatch>) =>
        run(Effect.asVoid(Effect.forkIn(effect, store.scope)))
      yield* Stream.zipLatest(repo.treeState.rows, repo.viewState.rows).pipe(
        Stream.map(([trees, views]) => targetOf(trees[0], views[0]?.repository?.defaultBranch ?? null)),
        Stream.changesWith((left, right) =>
          // Late repository metadata doesn't change this file or its definition URLs
          // (blob links always carry their revision). Reloading would erase an active lookup.
          left?.owner === right?.owner && left?.name === right?.name && left?.sha === right?.sha && left?.path === right?.path && left?.revision === right?.revision
        ),
        Stream.runForEach(follow),
        Effect.forkIn(store.scope),
      )
      return CodeIntel.of({
        queries: { state: store.query.tanstack },
        actions: {
          rest: (token) => background(hover(token, false)),
          move: (token) => background(hover(token, true)),
          select: (token) => background(select(token)),
          activate: (token) => background(definition(token)),
          key: (key, shift, modifiers) => {
            const row = Option.getOrThrow(run(store.state.get(CODE_INTEL)))
            const action = keyAction(row, key, shift, modifiers, run(Ref.get(store.hovering)))
            if (action === undefined) return false
            background(action)
            return true
          },
          nextProblem: () => background(problem(1)),
          togglePane: () => background(togglePane),
        },
      })
    }),
  )
}

/** The code intelligence layer's value: what frontends get. */
export type CodeIntelView = CodeIntel["Service"]
