import { type Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, Option } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { openTab, type Tab } from "../../test/repoDevice"
import { AuthStore } from "../auth/store"
import { RepoClient, RepoRefused } from "./api"
import { CAPACITY_COPY, FAILURE_COPY, SIGN_IN_TO_CLONE } from "./contract"
import { cloneClicks, clones, opens } from "./metrics"
import { NotCopied } from "./repo"
import { VIEW } from "./rows"
import { RepoStore } from "./store"
import { headerOf } from "./view"

// The repository state machine's unhappy paths, driven as React drives it, with no React: RepoApi refusing, unreachable
// or answering without Electric delivering, given to the tab and its engine as a faulty `RepoClient`; a shape source
// that is down; and an engine that refuses every dispatch (test.faults-by-injection). RepoApi's real answers are in
// repo.test.ts.

const ORIGIN = "http://smithers.test"

/**
 * Waits for `check` to pass: a dispatch runs on this tab's engine, which a loaded machine can take seconds to reach.
 */
const waitFor = <A>(check: () => A, options: { readonly timeout?: number } = {}) =>
  vi.waitFor(check, { timeout: 10_000, ...options })

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

/**
 * A client whose `clone` answers `answer`, counting its calls, and whose launch answers `launch` (launched unless
 * set), counting its calls too; reads are never expected.
 */
const cloning = (
  answer: () => Effect.Effect<{ txid: number; id: string; attempt: number; cloneId: string }, RepoRefused>,
  launch: () => Effect.Effect<{ readonly launched: true }, RepoRefused> = () => Effect.succeed({ launched: true }),
) => {
  const calls: Array<string> = []
  const launches: Array<string> = []
  const layer = Layer.succeed(
    RepoClient,
    RepoClient.of({
      clone: (owner, name) => Effect.suspend(() => (calls.push(`${owner}/${name}`), answer())),
      launch: (owner, name, cloneId) => Effect.suspend(() => (launches.push(`${owner}/${name} ${cloneId}`), launch())),
      tree: () => Effect.die(new Error("no reads in this test")),
      blob: () => Effect.die(new Error("no reads in this test")),
      // Opening a repository asks what GitHub says of it, and its ready head from the refs when the device has no
      // row; this client has no network for them.
      refs: () => Effect.fail(new RepoRefused({})),
      about: () => Effect.fail(new RepoRefused({})),
      role: () => Effect.fail(new RepoRefused({})),
    }),
  )
  return { calls, launches, layer }
}

const open = async (
  client: Layer.Layer<RepoClient>,
  options: { readonly auth?: Layer.Layer<AuthStore, Collection.LoadFailed>; readonly engine?: "refusing" } = {},
) => {
  const tab = await openTab({ origin: ORIGIN, client, shapes: "down", confirmWithin: "100 millis", ...options })
  tabs.push(tab)
  return tab
}

/** The header the tab shows for `owner/name`'s view. */
const header = (tab: Tab) => {
  const { repository, clone, view } = tab.view()
  return headerOf(repository, clone, view.signedIn)
}

describe("cloning when RepoApi doesn't take it", () => {
  test("a name that isn't a GitHub repository asks nothing", async () => {
    const client = cloning(() => Effect.die(new Error("not sent")))
    const tab = await open(client.layer)
    expect(tab.repo.actions.clone("api", "x")).toBe(false)
    expect(tab.repo.actions.clone("octocat", "..")).toBe(false)
    expect(client.calls).toEqual([])
    expect(tab.count(cloneClicks, { kind: "clone" })).toBe(0)
  })

  test("signed out (401): the header asks to sign in, counted and logged with the status", async () => {
    const client = cloning(() => Effect.fail(new RepoRefused({ status: 401, code: "authentication" })))
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "octocat", name: "Spoon-Knife", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    expect(tab.repo.actions.clone("octocat", "Spoon-Knife")).toBe(true)
    await waitFor(() => expect(header(tab)).toEqual({ kind: "sign_in", text: SIGN_IN_TO_CLONE }))
    expect(tab.count(clones, { outcome: "sign_in" })).toBe(1)
    expect(tab.lines("repo.clone")[0]!.annotations).toMatchObject({ outcome: "sign_in", status: 401, feature: "repo" })
  })

  test.each([
    [403, "forbidden", "forbidden"],
    [400, "invalid", "invalid"],
    [503, "not_configured", "not_configured"],
    [503, "unavailable", "unavailable"],
  ] as const)("RepoApi's %i %s is counted as %s, and shows Couldn't clone", async (status, code, outcome) => {
    const client = cloning(() => Effect.fail(new RepoRefused({ status, code })))
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("o", "n")
    await waitFor(() => expect(header(tab)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable }))
    expect(tab.count(clones, { outcome })).toBe(1)
  })

  test("past the repository limit (429), imports are paused, and Try again asks again", async () => {
    const client = cloning(() => Effect.fail(new RepoRefused({ status: 429, code: "repository_limit" })))
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "octocat", name: "Spoon-Knife", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("octocat", "Spoon-Knife")
    await waitFor(() => expect(header(tab)).toEqual({ kind: "refused", text: CAPACITY_COPY.paused }))
    tab.repo.actions.retryClone("octocat", "Spoon-Knife")
    await waitFor(() => expect(tab.count(clones, { outcome: "limit" })).toBe(2))
    expect(client.calls).toEqual(["octocat/Spoon-Knife", "octocat/Spoon-Knife"])
    expect(tab.count(cloneClicks, { kind: "clone" })).toBe(1)
    expect(tab.count(cloneClicks, { kind: "retry" })).toBe(1)
  })

  test("no answer, or another refusal, fails with Try again; the log names the outcome", async () => {
    let answer: RepoRefused = new RepoRefused({})
    const client = cloning(() => Effect.fail(answer))
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("o", "n")
    await waitFor(() => expect(header(tab)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable }))
    expect(tab.count(clones, { outcome: "unavailable" })).toBe(1)
    expect(tab.lines("repo.clone")[0]!.annotations).not.toHaveProperty("status")
    answer = new RepoRefused({ status: 503, code: "not_configured" })
    tab.repo.actions.retryClone("o", "n")
    expect(header(tab)).toEqual({ kind: "cloning" })
    await waitFor(() => expect(header(tab)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable }))
    expect(tab.count(clones, { outcome: "not_configured" })).toBe(1)
  })

  test("a launch RepoApi can't take for a moment is tried again by this device's engine, and goes through", async () => {
    // The request persisted the attempt and answered at once; its launch is the flow's own durable step.
    let refusals = 1
    const client = cloning(
      () => Effect.succeed({ txid: 42, id: "github/o/n", attempt: 1, cloneId: "c1" }),
      () => (refusals-- > 0 ? Effect.fail(new RepoRefused({ status: 503, code: "unavailable" })) : Effect.succeed({ launched: true })),
    )
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("o", "n")
    await waitFor(() => expect(client.launches).toEqual(["o/n c1", "o/n c1"]))
    expect(client.calls).toEqual(["o/n"])
    expect(tab.lines("repo.clone.launch").map((line) => line.annotations.outcome)).toEqual(["unavailable", "launched"])
  })

  test("a launch RepoApi refuses is final: Couldn't clone, and it isn't asked again", async () => {
    const client = cloning(
      () => Effect.succeed({ txid: 42, id: "github/o/n", attempt: 1, cloneId: "c1" }),
      () => Effect.fail(new RepoRefused({ status: 403, code: "forbidden" })),
    )
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("o", "n")
    await waitFor(() => expect(header(tab)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable }))
    expect(client.launches).toEqual(["o/n c1"])
  })

  test("taken, but Electric never delivers the row: failed, unconfirmed", async () => {
    const client = cloning(() => Effect.succeed({ txid: 42, id: "github/o/n", attempt: 1, cloneId: "c1" }))
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("o", "n")
    await waitFor(() => expect(header(tab)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable }))
    expect(tab.count(clones, { outcome: "started" })).toBe(1)
    expect(tab.lines("repo.clone.unconfirmed")[0]!.annotations).toMatchObject({ feature: "repo" })
  })

  test("this tab's engine refuses the run: Couldn't clone, with Try again", async () => {
    const client = cloning(() => Effect.die(new Error("not sent")))
    const tab = await open(client.layer, { engine: "refusing" })
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("o", "n")
    await waitFor(() => expect(header(tab)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable }))
    expect(client.calls).toEqual([])
  })

  test("Clone shows cloning at once, and a press while the request is on its way sends nothing more", async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const client = cloning(() =>
      Effect.andThen(Effect.promise(() => held), Effect.fail(new RepoRefused({ status: 500 })))
    )
    const tab = await open(client.layer)
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    tab.repo.actions.clone("o", "n")
    expect(header(tab)).toEqual({ kind: "cloning" })
    tab.repo.actions.clone("o", "n")
    await waitFor(() => expect(client.calls).toEqual(["o/n"]))
    release()
    await waitFor(() => expect(tab.count(clones, { outcome: "unavailable" })).toBe(1))
    expect(client.calls).toEqual(["o/n"])
  })
})

describe("sign-in, when the app has it", () => {
  test("a signed-out person sees the sign-in link in Clone's place, and a signed-in one Clone", async () => {
    const client = cloning(() => Effect.die(new Error("not sent")))
    const tab = await open(client.layer, { auth: AuthStore.layer.pipe(Layer.provide(Persistence.memory)) })
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    expect(tab.view().view.signedIn).toBeNull()
    const set = (status: "signed_in" | "signed_out" | "unreachable") =>
      tab.runtime.runPromise(
        Effect.flatMap(Effect.service(AuthStore), ({ session }) =>
          Effect.orDie(session.update("session", (row) => void (row.status = status)))
        ),
      )
    await set("signed_out")
    await waitFor(() => expect(header(tab)).toEqual({ kind: "sign_in", text: SIGN_IN_TO_CLONE }))
    await set("signed_in")
    await waitFor(() => expect(tab.view().view.signedIn).toBe(true))
    expect(header(tab)).toEqual({ kind: "clone" })
    // Sign-in couldn't say: Clone stays, and RepoApi decides.
    await set("unreachable")
    await waitFor(() => expect(tab.view().view.signedIn).toBeNull())
    expect(header(tab)).toEqual({ kind: "clone" })
  })
})

describe("opening a view", () => {
  test("a reserved or invalid name is missing at once, and loads nothing", async () => {
    const client = cloning(() => Effect.die(new Error("not sent")))
    const tab = await open(client.layer)
    tab.repo.actions.openRoute("tree", { owner: "api", repo: "x" }, {})
    expect(tab.view().view).toMatchObject({ missing: true, repoId: null, owner: "api" })
    expect(tab.count(opens, { kind: "tree" })).toBe(1)
    expect(tab.lines("repo.open")[0]!.annotations).toMatchObject({ kind: "tree", feature: "repo" })
  })

  test("a repository the device doesn't have yet waits, holding where the URL said", async () => {
    const client = cloning(() => Effect.die(new Error("not sent")))
    const tab = await open(client.layer)
    tab.repo.actions.openRoute("blob", { owner: "o", repo: "n", ref: "main", _splat: "a.ts" }, { L: "2-5" })
    expect(tab.view().view).toMatchObject({
      repoId: "github/o/n",
      kind: "blob",
      ref: "main",
      path: "a.ts",
      line: 2,
      lineEnd: 5,
      missing: false,
      sha: null,
    })
    expect(tab.view().repository).toBeUndefined()
    expect(tab.tree().tree).toBeUndefined()
    expect(tab.repo.lookups.repository("github/o/n")).toBeUndefined()
    expect(tab.repo.lookups.readme("github/o/n", "f".repeat(40), "")).toBeUndefined()
    // Another location replaces it.
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    expect(tab.view().view).toMatchObject({ kind: "tree", path: "", line: null })
  })

  test("Copy permalink dispatches nothing before the view has a commit", async () => {
    const client = cloning(() => Effect.die(new Error("not sent")))
    const tab = await open(client.layer)
    await expect(tab.repo.actions.copy("permalink")).rejects.toBeInstanceOf(NotCopied)
    expect(tab.copied).toEqual([])
    expect(tab.lines("flow.dispatch")).toEqual([])
    const view = await tab.runtime.runPromise(
      Effect.flatMap(Effect.service(RepoStore), ({ view }) => view.get(VIEW)),
    )
    expect(Option.getOrThrow(view).sha).toBeNull()
  })

  test("a copy this tab's engine refuses to run is not copied", async () => {
    const client = cloning(() => Effect.die(new Error("not sent")))
    const tab = await open(client.layer, { engine: "refusing" })
    tab.repo.actions.open({ owner: "o", name: "n", kind: "tree", ref: null, path: "", line: null, lineEnd: null })
    await expect(tab.repo.actions.copy("clone-url")).rejects.toBeInstanceOf(NotCopied)
    expect(tab.copied).toEqual([])
  })
})
