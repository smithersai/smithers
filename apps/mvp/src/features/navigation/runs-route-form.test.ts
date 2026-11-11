import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { afterEach, expect, test } from "vitest"
import { dom } from "../../../tests/fixtures/dom"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom) })
const { router } = await import("../../router")
const { Persistence } = await import("@smthrs/effect-tanstack-db")
const { BrowserEngine } = await import("@smthrs/platform-browser")
const { repoAuthority } = await import("../../test/repoAuthority")
const { FlowDispatch } = await import("../../flows/dispatch")
const { RemoteRunsClient } = await import("../runs/api")
const actions = await import("../runs/actions")
const { RunsStore } = await import("../runs/store")
const { FORM } = await import("../runs/schema")

type Enter = (load: unknown) => Promise<void>

const opened: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of opened.splice(0)) await runtime.dispose() })

/**
 * The runs page's route over the real Run form: the Runs store and its actions, GitHub's flows and inputs answered at
 * once, and `repo/run` recorded as dispatched.
 */
const setup = async () => {
  const dispatched: Array<unknown> = []
  const engine = Layer.succeed(BrowserEngine.BrowserEngine, BrowserEngine.BrowserEngine.of({
    retry: () => Effect.die("unused"), start: () => Effect.die("unused"), result: () => Effect.die("unused"), cancel: () => Effect.die("unused"),
    signal: () => Effect.die("unused"), inspect: () => Effect.die("unused"), runs: () => Effect.die("unused") as never,
    list: () => Effect.succeed({ runs: [], cursor: null }), events: Effect.never as never, unavailable: Effect.never,
  }))
  const remote = RemoteRunsClient.of({
    inspect: () => Effect.die("unused"), steer: () => Effect.die("unused"), stop: () => Effect.die("unused"), list: Effect.succeed([]), start: () => Effect.die("unused"),
    flows: (repo: { readonly name: string }) => Effect.succeed({ flows: [{ name: "deploy" }, { name: `${repo.name}-only` }], defaultBranch: "main" }),
    inputs: () => Effect.succeed({ sha: "s", inputs: { type: "object", properties: {} } }),
  } as unknown as typeof RemoteRunsClient.Service)
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    RunsStore.layer({ origin: "http://test" }).pipe(Layer.provide(repoAuthority), Layer.provide(Layer.mergeAll(engine, Persistence.memory, Layer.succeed(RemoteRunsClient, remote)))),
    engine,
    Layer.succeed(FlowDispatch, FlowDispatch.of({ dispatch: ((name: string, payload: unknown) => Effect.sync(() => { dispatched.push({ name, payload }) }).pipe(Effect.andThen(Effect.never))) as never })),
    Layer.succeed(actions.RunsNavigation, { navigate: () => undefined }),
  ))
  opened.push(runtime)
  const store = await runtime.runPromise(Effect.service(RunsStore))
  const run = <A>(effect: Effect.Effect<A, never, any>) => runtime.runPromise(effect as Effect.Effect<A>)
  const context = {
    repo: { actions: { warmRoute: () => undefined, openRoute: () => undefined, role: () => undefined, knownName: () => null, canonicalName: async () => null } },
    home: { actions: { warm: () => undefined, open: () => undefined } },
    runs: { actions: {
      warmRepoRuns: (owner: string, name: string) => run(actions.warmRepoRuns({ owner, name })),
      openRepoRuns: (owner: string, name: string) => run(actions.openRepoRuns({ owner, name })),
    } },
  }
  const enter = (owner: string, repo: string, preload: boolean) =>
    (router.routesById["/$owner/$repo/runs"].options.beforeLoad as unknown as Enter)({
      context,
      params: { owner, repo },
      location: { pathname: `/${owner}/${repo}/runs`, searchStr: "", hash: "" },
      preload,
      search: {},
      abortController: new AbortController(),
    })
  const form = () => run(store.form.get(FORM)).then(Option.getOrThrow)
  // Run waits for its answer, which never comes here: the page keeps its form, and the test reads what was dispatched.
  const start = (values: Readonly<Record<string, string>>) => void runtime.runFork(actions.runRepoFlow(values))
  return { run, enter, form, start, dispatched }
}

// Code review F3 (#5295): the route's warm read the page's flows into the one live Run form, so a hovered Runs link
// reset the flow and branch a person chose, and another repository's link pointed the next Run at that repository
// under the page still shown.
test("a preload of the runs page, the page's own or another repository's, leaves the Run form as it is", async () => {
  const t = await setup()
  await t.enter("acme", "production", false)
  await expect.poll(t.form).toMatchObject({ repo: { owner: "acme", name: "production" }, state: "ready", ref: "main" })
  await t.run(actions.chooseRepoFlow("deploy"))
  await t.run(actions.setRunRef("preview"))
  const chosen = await t.form()
  expect(chosen).toMatchObject({ flow: "deploy", ref: "preview", state: "ready" })

  await t.enter("acme", "production", true)
  await t.enter("acme", "staging", true)
  await t.run(Effect.yieldNow)
  expect(await t.form()).toEqual(chosen)

  t.start({})
  await expect.poll(() => t.dispatched).toEqual([{ name: "repo/run", payload: { repo: "acme/production", flow: "deploy", ref: "preview", input: {} } }])
})

test("a navigation reads its repository's flows into the Run form", async () => {
  const t = await setup()
  await t.enter("acme", "production", false)
  await expect.poll(t.form).toMatchObject({ repo: { owner: "acme", name: "production" }, state: "ready" })
  await t.enter("acme", "staging", false)
  await expect.poll(t.form).toMatchObject({ repo: { owner: "acme", name: "staging" }, flows: [{ name: "deploy" }, { name: "staging-only" }], flow: null, ref: "main", state: "ready" })
})
