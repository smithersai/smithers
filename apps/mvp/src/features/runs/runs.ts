import { RunSteers } from "./steers"
import { LiveQuery } from "@smthrs/effect-tanstack-db"
import type { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import {
  chooseRepoFlow,
  closeRepoRuns,
  closeRun,
  inspectStep,
  more,
  openList,
  openRepoRuns,
  openRun,
  reloadRepoFlow,
  resume,
  retry,
  retryFailed,
  retryFrom,
  runRepoFlow,
  RunsNavigation,
  scrub,
  select,
  setRunRef,
  setSteerDraft,
  showInspector,
  showTab,
  steer,
  stop,
  warmList,
  warmRepoRuns,
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
  /** The run the list shows opened in place, with its read. */
  readonly expandedPage: Store["expandedPage"]["tanstack"]
  readonly view: Store["viewRow"]["tanstack"]
  readonly runs: Store["list"]["tanstack"]
  /** The runs on Cloudflare this person may read, as the list last read them. */
  readonly cloudRuns: Store["cloudList"]["tanstack"]
  /** Every repository run the device holds (docs/features/actions.md), from when a list opened. */
  readonly repoRuns: Store["repoRunList"]["tanstack"]
  /** The repositories whose runs have loaded: a list of none says so only then. */
  readonly repoRunsLoaded: Store["repoRunsLoaded"]["tanstack"]
  /** The runs page's Run form (docs/features/actions.md#running-a-flow-by-hand). */
  readonly form: Store["formRow"]["tanstack"]
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
  /** The list's route loader; `open` is the run shown opened in place. */
  readonly openList: (open?: string) => Promise<void>
  /** A repository's list's route warm, a link's preload: syncs its runs, once, and leaves the Run form as it is. */
  readonly warmRepoRuns: (owner: string, name: string) => Promise<void>
  /**
   * A repository's list's route open, a navigation's: reads the flows a person runs by hand into the Run form, and
   * syncs the repository's runs, once (docs/features/actions.md).
   */
  readonly openRepoRuns: (owner: string, name: string) => Promise<void>
  readonly chooseRepoFlow: (flow: string) => void
  readonly runRepoFlow: (values: Readonly<Record<string, string | number | boolean>>) => void
  readonly setRunRef: (ref: string) => void
  readonly reloadRepoFlow: () => void
  /** The runs page's `onLeave`. */
  readonly closeRepoRuns: () => void
  /** Retry failed on the open repository's run: only its jobs that didn't pass. */
  readonly retryFailed: () => void
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
  /** Retry from here on the open run's step `step`, the engine's node id. */
  readonly retryFrom: (step: string) => void
  readonly resume: () => void
  readonly setSteerDraft: (text: string) => void
  readonly steer: () => Promise<void>
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
      const context = yield* Effect.context<RunsStore | FlowDispatch | RunsNavigation | BrowserEngine.BrowserEngine | RunSteers | SteerWrites>()
      const { runPromise: promise, runFork } = runners(context, "runs")
      const fork = (effect: Effect.Effect<void, never, RunsStore | FlowDispatch | RunsNavigation | BrowserEngine.BrowserEngine>) =>
        void runFork(effect)
      return Runs.of({
        queries: {
          page: store.page.tanstack,
          expandedPage: store.expandedPage.tanstack,
          view: store.viewRow.tanstack,
          runs: store.list.tanstack,
          cloudRuns: store.cloudList.tanstack,
          repoRuns: store.repoRunList.tanstack,
          repoRunsLoaded: store.repoRunsLoaded.tanstack,
          form: store.formRow.tanstack,
          steerSending: steerSending.tanstack,
          steerSent: steerSent.tanstack,
        },
        actions: {
          warmList: () => promise(warmList),
          openList: (open) => promise(openList(open)),
          warmRepoRuns: (owner, name) => promise(warmRepoRuns({ owner, name })),
          openRepoRuns: (owner, name) => promise(openRepoRuns({ owner, name })),
          chooseRepoFlow: (flow) => fork(chooseRepoFlow(flow)),
          runRepoFlow: (values) => fork(runRepoFlow(values)),
          setRunRef: (ref) => fork(setRunRef(ref)),
          reloadRepoFlow: () => fork(reloadRepoFlow),
          closeRepoRuns: () => fork(closeRepoRuns),
          retryFailed: () => fork(retryFailed),
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
          retryFrom: (step) => fork(retryFrom(step)),
          resume: () => fork(resume),
          setSteerDraft: (text) => fork(setSteerDraft(text)),
          steer: () => promise(steer),
        },
      })
    }),
  )
}

/** The runs layer's value: what frontends get. */
export type RunsView = Runs["Service"]
