import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
import { useLiveQuery } from "@tanstack/react-db"
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { createRoot } from "react-dom/client"
import { FlowDispatch } from "../../src/flows/dispatch.vibe"
import * as actions from "../../src/features/runs/actions.vibe"
import { RemoteRunsClient } from "../../src/features/runs/api.vibe"
import { RepoFlowCard } from "../../src/features/runs/components/RepoFlowsView"
import { RunsStore } from "../../src/features/runs/store.vibe"
import { repoAuthority } from "../../src/test/repoAuthority"

async function mount() {
  const release = Effect.runSync(Deferred.make<void>())
  const output = document.createElement("output")
  document.body.append(output)
  const requests: string[] = []
  const record = (message: string) => { requests.push(message); output.textContent = requests.join("\n") }
  const unused = () => Effect.die("Unexpected browser fixture call")
  const engine = Layer.succeed(BrowserEngine.BrowserEngine, BrowserEngine.BrowserEngine.of({
    retry: unused, start: unused, result: unused, cancel: unused, signal: unused, list: unused,
    inspect: unused, runs: () => Stream.empty, events: Stream.never, unavailable: Effect.never,
  }))
  const remote = Layer.succeed(RemoteRunsClient, RemoteRunsClient.of({
    list: Effect.succeed([]), start: unused, stop: unused, inspect: unused, steer: unused,
    flows: () => Effect.succeed({ defaultBranch: "main", flows: [{ name: "audit" }] }),
    inputs: (_repo, _flow, ref) => Effect.gen(function* () {
      if (ref !== "main") {
        record("read " + ref)
        yield* Deferred.await(release)
      }
      return { sha: "a".repeat(40), inputs: {} }
    }),
  }))
  const dispatch = Layer.succeed(FlowDispatch, FlowDispatch.of({
    dispatch: ((_name: string, payload: { ref: string }) => Effect.sync(() => {
      record("run " + payload.ref)
      return { _tag: "Done", value: { runId: "audit:fixture" } } as const
    })) as FlowDispatch["Service"]["dispatch"],
  }))
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    RunsStore.layer({ origin: location.origin }).pipe(Layer.provide(repoAuthority), Layer.provide(Layer.mergeAll(engine, remote, Persistence.memory))),
    dispatch, Layer.succeed(actions.RunsNavigation, { navigate: () => {} }),
  ))
  const store = await runtime.runPromise(Effect.service(RunsStore))
  await runtime.runPromise(store.loadRepoFlows({ owner: "octo", name: "hello" }))
  await runtime.runPromise(store.chooseRepoFlow("audit"))
  Object.assign(window, { releaseInputs: () => runtime.runPromise(Deferred.succeed(release, undefined)) })
  function Fixture() {
    const { data } = useLiveQuery(store.formRow.tanstack)
    const form = data?.[0]
    return form ? <RepoFlowCard form={form} actions={{
      chooseRepoFlow: flow => { runtime.runFork(actions.chooseRepoFlow(flow)) },
      setRunRef: ref => { runtime.runFork(actions.setRunRef(ref)) },
      reloadRepoFlow: () => { runtime.runFork(actions.reloadRepoFlow) },
      runRepoFlow: values => { runtime.runFork(actions.runRepoFlow(values)) },
    }} /> : null
  }
  createRoot(document.getElementById("app")!).render(<Fixture />)
}
void mount()
