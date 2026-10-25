import { LiveQuery } from "@smthrs/effect-tanstack-db"
import type { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Effect, Layer } from "effect"
import type { FlowDispatch } from "../../flows/dispatch"
import {
  closeRun,
  inspectStep,
  more,
  openList,
  openRun,
  resume,
  retry,
  RunsNavigation,
  scrub,
  select,
  setSteerDraft,
  showInspector,
  showTab,
  steer,
  stop,
  warmList,
} from "./actions"
import type { RepoName, RunTab } from "./schema"
import { RunsStore } from "./store"
import { SteerWrites } from "./writes"

// Runs as a frontend sees them (docs/features/runs.md#the-browser): live queries to read and plain functions to act,
// with no Effect in sight. The routes' loaders call `openList` and `openRun`; the run page renders `page`.

type Store = RunsStore["Service"]

/** What a frontend reads live: the open run with its view, the view alone, and the list. */
export interface RunsQueries {
  readonly page: Store["page"]["tanstack"]
  readonly view: Store["viewRow"]["tanstack"]
  readonly runs: Store["list"]["tanstack"]
  /** Every repository run the device holds (docs/features/actions.md), from when a list opened. */
  readonly repoRuns: Store["repoRunList"]["tanstack"]
  /** This device's steers the outbox holds, and those the route answered (docs/features/runs.md#steering). */
  readonly steerSending: Effect.Success<ReturnType<typeof sendingQuery>>["tanstack"]
  readonly steerSent: Effect.Success<ReturnType<typeof sentQuery>>["tanstack"]
}

/** Every steer the outbox holds. */
const sendingQuery = (writes: SteerWrites["Service"]) => LiveQuery.make((q) => q.from({ row: writes.sending.tanstack }))

/** Every steer the route answered on this tab. */
const sentQuery = (writes: SteerWrites["Service"]) => LiveQuery.make((q) => q.from({ row: writes.sent.tanstack }))

/** What a person does, as plain functions. Each returns at once, or with a promise a route loader awaits. */
export interface RunsActions {
  readonly warmList: () => Promise<void>
  readonly openList: () => Promise<void>
  /** A repository's list's route loader: syncs the repositories' runs, once (docs/features/actions.md). */
  readonly openRepoRuns: (owner: string, name: string) => Promise<void>
  /** Opens `runId`; a repository's run with its `repo`, read on Cloudflare. */
  readonly openRun: (runId: string, repo?: RepoName) => Promise<void>
  /** The run route's `onLeave` for `runId`. */
  readonly rendered: (runId: string) => void
  readonly closeRun: (runId: string) => void
  readonly scrub: (at: number | null) => void
  readonly inspectStep: (stepId: string) => void
  readonly showInspector: (open: boolean) => void
  readonly select: (stepId: string) => void
  readonly showTab: (tab: RunTab) => void
  readonly more: () => void
  readonly stop: () => void
  readonly retry: (version: "pinned" | "current") => void
  readonly resume: () => void
  readonly setSteerDraft: (text: string) => void
  readonly steer: () => void
}

export class Runs extends Context.Service<Runs, { readonly queries: RunsQueries; readonly actions: RunsActions }>()(
  "@smthrs/mvp/runs/Runs",
) {
  /** Binds the store's queries and the actions, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Runs,
    Effect.gen(function* () {
      const store = yield* RunsStore
      const writes = yield* SteerWrites
      const steerSending = yield* sendingQuery(writes)
      const steerSent = yield* sentQuery(writes)
      const context = yield* Effect.context<RunsStore | FlowDispatch | RunsNavigation | BrowserEngine.BrowserEngine>()
      const promise = Effect.runPromiseWith(context)
      const fork = (effect: Effect.Effect<void, never, RunsStore | FlowDispatch | RunsNavigation | BrowserEngine.BrowserEngine>) =>
        void Effect.runForkWith(context)(effect)
      return Runs.of({
        queries: {
          page: store.page.tanstack,
          view: store.viewRow.tanstack,
          runs: store.list.tanstack,
          repoRuns: store.repoRunList.tanstack,
          steerSending: steerSending.tanstack,
          steerSent: steerSent.tanstack,
        },
        actions: {
          warmList: () => promise(warmList),
          openList: () => promise(openList),
          openRepoRuns: (owner, name) => promise(store.openRepoRuns(owner, name)),
          openRun: (runId, repo) => promise(openRun(runId, repo ?? null)),
          rendered: (runId) => fork(store.rendered(runId)),
          closeRun: (runId) => fork(closeRun(runId)),
          scrub: (at) => fork(scrub(at)),
          inspectStep: (stepId) => fork(inspectStep(stepId)),
          showInspector: (open) => fork(showInspector(open)),
          select: (stepId) => fork(select(stepId)),
          showTab: (tab) => fork(showTab(tab)),
          more: () => fork(more),
          stop: () => fork(stop),
          retry: (version) => fork(retry(version)),
          resume: () => fork(resume),
          setSteerDraft: (text) => fork(setSteerDraft(text)),
          steer: () => fork(steer),
        },
      })
    }),
  )
}

/** The runs layer's value: what frontends get. */
export type RunsView = Runs["Service"]
