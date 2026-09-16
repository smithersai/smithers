import { shouldReplayTutorial } from "./onboarding/resume"
import { Effect } from "effect"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import { createAgentSeat } from "./chain/ChainRuntime"
import { nativeOpenExternal, nativeRepositories, nativeShellAvailable } from "./native/NativeBridge"
import { createAppFetch } from "./runtime/LocalSession"
import { openRequestedRepo, requestedRepo, withoutRepoParam } from "./RepoLink"
import { createBrowserFrameHistory } from "./runtime/FrameHistory"
import { createRuntime, warmBootstrap, unavailableAgent, unavailableRepositories } from "./runtime/Runtime"
import { createAppController } from "./state/AppController"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { canPaintTutorialBeforeIdentity, loadControllerBootInputs } from "./ControllerBootMemo"
import { createTurnEraser } from "./runtime/TurnErasure"

const promiseEffect = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new Error(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`)
  })

/*
 * Browser-only boot. Promise-shaped factories enter the Effect program at
 * this boundary.
 *
 * The local app's chat is the HTTP agent against the local origin
 * (LOCAL-APP.md). The in-page chain runtime is NOT bound: it spends a model
 * through the login-gated /api/model/stream, which the local origin does not
 * serve, so binding it would route every anonymous turn to a dead seam.
 */
/** How the one boot runs; AppMount.tsx sets it before the first render. */
export interface ControllerBootOptions {
  /** Keep the address bar on the entry URL (runtime/FrameHistory.ts `keepUrl`). */
  readonly keepUrl?: boolean
  readonly mode?: "onboarding" | "repo"
}

const bootProgram = (options: ControllerBootOptions = {}) =>
  Effect.gen(function*() {
    // Read the entry URL before the controller exists: creating it installs the
    // frame history, which writes the first history entry within the first
    // frame, long before identity has loaded.
    const requested = yield* Effect.sync(() => requestedRepo(window.location))
    // The entry URL's query, read before frame history rewrites the address bar: the OAuth and
    // GitHub App setup-URL returns ride on it, and by the end of boot it is gone.
    const entrySearch = yield* Effect.sync(() => window.location.search)
    const entryPathname = yield* Effect.sync(() => window.location.pathname)
    const http = yield* Effect.sync(() => createAppFetch())
    const bootstrapRead = warmBootstrap(http)
    const { bootstrap, store } = yield* promiseEffect("prepare runtime and persisted state", () =>
      loadControllerBootInputs(() => bootstrapRead, () => createAppStore(undefined, {
        seedWiki: bootstrapRead.then(bootstrap => bootstrap.host !== "cloud", () => true), eraseTurn: createTurnEraser(http)
      })))
    const runtime = yield* Effect.sync(() => createRuntime({
      bootstrap,
      http,
      nativeRepositories,
      ...(nativeShellAvailable ? { nativeOpenExternal } : {})
    }))
    const agent = yield* Effect.sync(() => createAgentSeat(runtime.backend.agent ?? unavailableAgent()))
    const controller = yield* Effect.sync(() =>
      createAppController(
        store,
        runtime.backend.repositories ?? unavailableRepositories,
        agent,
        {
          fetchImpl: runtime.http,
          bootstrap: runtime.bootstrap,
          repositoryApp: requested ?? undefined,
          frameHistory: createBrowserFrameHistory(window, { keepUrl: options.keepUrl === true }),
          // The next-step recommender (state/Recommend.ts) is opt-in here, the one real composition root.
          recommender: { enabled: true },
          ...(runtime.shell.kind === "native" ? { openExternal: runtime.shell.openExternal } : {})
        }
      )
    )

    // Start Here and ?tutorial are explicit entries, including after a finished playthrough.
    if (shouldReplayTutorial(options.mode, entrySearch, store.session().guide, entryPathname)) {
      yield* promiseEffect("replay introduction", () => controller.guideAct("restart"))
    }
    if (!hasCapability(bootstrap, "identity")) {
      yield* promiseEffect("record unavailable identity", () => controller.adoptSession({
        state: "unavailable",
        login: null,
        allowlisted: false,
        admin: false
      }))
    } else if (bootstrap.host === "local" || canPaintTutorialBeforeIdentity({
      mode: options.mode,
      step: store.session().guide?.step,
      finished: store.session().guide?.finished,
      hasTranscript: store.collections.cards.size > 0 || store.collections.messages.size > 0,
      identityState: store.collections.identitySessions.get("identity")?.state,
      identityLogin: store.collections.identitySessions.get("identity")?.login,
      accountOwnerLogin: store.collections.identitySessions.get("identity")?.accountOwnerLogin,
    })) {
      /*
       * The local host never gates on sign-in (LOCAL-APP.md), and this read
       * rides the remote identity seam through the local proxy — a slow or
       * captive network held the whole boot on the session shell for as long
       * as the upstream took. It runs beside the other inventory loads, never
       * on the paint path: identity "unknown" is a first-class state the app
       * already renders, and the answer lands in the store whenever it comes.
       * A fresh anonymous tutorial is likewise public practice content: its
       * real controls need not wait on identity. Retained content/account
       * ownership and progressed tutorials keep the cloud identity barrier.
       */
      yield* Effect.sync(() => void controller.loadSession())
    } else {
      /*
       * The cloud host gates the transcript on the signed-out answer, so the
       * probe stays on the boot path: awaiting it keeps the gate from flashing
       * the opening read first. Same-origin on the Worker, never a proxy hop.
       */
      yield* promiseEffect("load identity session", () => controller.loadSession())
    }
    if (runtime.backend.repositories !== undefined) {
      yield* Effect.sync(() => void controller.loadRepos())
      yield* Effect.sync(() => void controller.loadHarnesses())
      // Agents as data (custom-agents.md): the app-agents mirror loads beside the harness list.
      yield* Effect.sync(() => void controller.loadAgents())
    }
    // Web identity loads its Cloud session before resuming parked commands.
    // The native PAT is independent of GitHub and still needs its own read.
    if (bootstrap.host === "local" && hasCapability(bootstrap, "cloud")) {
      yield* Effect.sync(() => void controller.loadCloudSession())
    }
    // Both URL rewrites keep the entry's state: on a repository path the
    // frame history stores the frame location there, not in the URL.
    // A GitHub App setup-URL return (onboarding SCRIPT v4 beat 11) carries its own parameters.
    if (controller.handleInstallReturn(entrySearch)) {
      window.history.replaceState(window.history.state, "", window.location.pathname)
    }
    if (controller.handleAuthReturn(entrySearch)) {
      window.history.replaceState(window.history.state, "", window.location.pathname)
    }
    // `/owner/name` (or the landing page's `/?repo=owner/name`) preselects a public-catalog repository.
    // The path stays in the address bar; the parameter leaves it.
    if (requested !== null) {
      yield* Effect.sync(() => void openRequestedRepo(controller, runtime.http, requested))
      if (window.location.search !== "") {
        window.history.replaceState(window.history.state, "", withoutRepoParam(window.location))
      }
    }
    return controller
  })

export const runControllerBoot = (options: ControllerBootOptions = {}): Promise<AppController> =>
  Effect.runPromise(bootProgram(options))
