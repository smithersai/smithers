// GitHub's events start a repository's flows (worker/ci/Dispatch.ts): a delivery as the webhook names it, and
// `triggers/Dispatch` on the Node host's engine against the scripted GitHub, with the starts it asks for recorded: the
// only stand-in besides GitHub.
import { ConfigProvider, Effect, Exit, Layer, Logger, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import { REPOSITORY, reset, services as githubServices } from "../github/test/fixtures.ts"
import { scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile, uuid } from "../test/harness.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Dispatch from "./Dispatch.ts"
import * as Pause from "../flows/Pause.ts"

const runtime = testFile("ci_dispatch")
beforeEach(() => reset(runtime))

const SHA = "c".repeat(40)
const BEFORE = "b".repeat(40)
const ZEROS = "0".repeat(40)
const repository = { full_name: "acme/widgets", default_branch: "main" }

describe("requestOf", () => {
  test("a push to a branch, or of a tag, at its new head; trusted, since pushing needs write access", () => {
    expect(Dispatch.requestOf("push", "d1", { ref: "refs/heads/feature/x", before: BEFORE, after: SHA, repository })).toEqual(Option.some({
      delivery: "d1",
      repo: "acme/widgets",
      defaultBranch: "main",
      event: "push",
      ref: "refs/heads/feature/x",
      branch: "feature/x",
      tag: null,
      action: null,
      sha: SHA,
      trusted: true,
    }))
    expect(Dispatch.requestOf("push", "d2", { ref: "refs/tags/v1", before: ZEROS, after: SHA, created: true, repository })).toMatchObject(
      Option.some({ branch: null, tag: "v1" }),
    )
  })

  test("a push is admitted as every host admits it: its ref and both commits named, a new ref only when created", () => {
    const push = { ref: "refs/heads/x", before: BEFORE, after: SHA, repository }
    expect(Dispatch.requestOf("push", "d", push)).toMatchObject(Option.some({ sha: SHA, branch: "x" }))
    // No `before`: the delivery doesn't say what the ref moved from.
    expect(Dispatch.requestOf("push", "d", { ref: "refs/heads/x", after: SHA, repository })).toEqual(Option.none())
    // A ref from nothing that the delivery doesn't call created, and a ref to nothing that it doesn't call deleted.
    expect(Dispatch.requestOf("push", "d", { ...push, before: ZEROS })).toEqual(Option.none())
    expect(Dispatch.requestOf("push", "d", { ...push, before: ZEROS, created: true })).toMatchObject(Option.some({ sha: SHA }))
    expect(Dispatch.requestOf("push", "d", { ...push, after: ZEROS })).toEqual(Option.none())
    // A deleted ref that still names a commit, and a ref that is neither a branch nor a tag.
    expect(Dispatch.requestOf("push", "d", { ...push, deleted: true })).toEqual(Option.none())
    expect(Dispatch.requestOf("push", "d", { ...push, ref: "refs/pull/7/head" })).toEqual(Option.none())
  })

  test("no dispatch for a deleted ref, another event, or a payload that isn't one", () => {
    expect(Dispatch.requestOf("push", "d", { ref: "refs/heads/x", before: BEFORE, after: ZEROS, deleted: true, repository }))
      .toEqual(Option.none())
    expect(Dispatch.requestOf("issues", "d", { action: "opened", repository })).toEqual(Option.none())
    expect(Dispatch.requestOf("push", "d", { ref: "refs/heads/x" })).toEqual(Option.none())
    expect(Dispatch.requestOf("push", "d", { ref: "refs/heads/x", before: BEFORE, after: "not-a-sha", repository })).toEqual(Option.none())
    expect(Dispatch.requestOf("push", "d", { ref: "refs/heads/x", before: BEFORE, after: SHA })).toEqual(Option.none())
    expect(Dispatch.requestOf("push", "bad delivery!", { ref: "refs/heads/x", before: BEFORE, after: SHA, repository })).toEqual(Option.none())
  })

  test("a pull request at its head, against its base; trusted only from the repository itself and a Member or above", () => {
    const pullRequest = (head: string | null, association: string) => ({
      action: "synchronize",
      repository,
      pull_request: {
        number: 9,
        author_association: association,
        head: { sha: SHA, repo: head === null ? null : { full_name: head } },
        base: { ref: "main" },
      },
    })
    expect(Dispatch.requestOf("pull_request", "p1", pullRequest("acme/widgets", "MEMBER"))).toEqual(Option.some({
      delivery: "p1",
      repo: "acme/widgets",
      defaultBranch: "main",
      event: "pull_request",
      ref: "refs/pull/9/head",
      branch: "main",
      tag: null,
      action: "synchronize",
      sha: SHA,
      trusted: true,
    }))
    expect(Dispatch.requestOf("pull_request", "p2", pullRequest("someone/widgets", "OWNER"))).toMatchObject(Option.some({ trusted: false }))
    expect(Dispatch.requestOf("pull_request", "p3", pullRequest(null, "MEMBER"))).toMatchObject(Option.some({ trusted: false }))
    expect(Dispatch.requestOf("pull_request", "p4", pullRequest("acme/widgets", "CONTRIBUTOR"))).toMatchObject(
      Option.some({ trusted: false }),
    )
    const { author_association: _, ...unassociated } = pullRequest("acme/widgets", "MEMBER").pull_request
    expect(Dispatch.requestOf("pull_request", "p5", { ...pullRequest("acme/widgets", "MEMBER"), pull_request: unassociated }))
      .toMatchObject(Option.some({ trusted: false }))
  })
})

const MANIFEST = JSON.stringify({
  apiVersion: 1,
  id: "repository",
  contributes: {
    triggers: [
      { on: "github.push", flow: "ci" },
      { on: "github.push", flow: "unmerged" },
      { on: "github.pull_request", flow: "ci", branches: ["main"] },
    ],
  },
})

const FLOW = `export default {}`

const dispatch = async (
  github: ReturnType<typeof scriptedGitHub>,
  request: Dispatch.DispatchRequest,
  options: { readonly repositories?: string; readonly start?: (executionId: string) => Effect.Effect<void, unknown> } = {},
) => {
  const { services } = await githubServices(runtime, github)
  const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
  const repositories = await runtime.runPromise(Dispatch.repositories.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ REPO_FLOWS_REPOSITORIES: options.repositories ?? "acme/widgets" }))))
  const ran = await runFlow(
    Dispatch.Dispatch,
    request,
    ExecutionHost.withTriggers({ flows: [], registration: Layer.empty }, Effect.succeed({
      ...services,
      repositories,
      start: (flow, started) =>
        Effect.andThen(options.start?.(started.executionId) ?? Effect.void, Effect.sync(() => void starts.push({ flow: flow._tag, ...started }))),
    })).registration,
    { executionId: Dispatch.dispatchExecutionId(request.delivery) },
  )
  return { ran, starts }
}

const pushed = (sha: string, branch = "feature/x"): Dispatch.DispatchRequest => ({
  delivery: `delivery-${sha.slice(0, 8)}`,
  repo: `${REPOSITORY.owner}/${REPOSITORY.name}`,
  defaultBranch: "main",
  event: "push",
  ref: `refs/heads/${branch}`,
  branch,
  tag: null,
  action: null,
  sha,
  trusted: true,
})

describe("triggers/Dispatch", { timeout: 60_000 }, () => {
  test("starts each active flow a trigger on the default branch matches, as repo/Run under <flow>:<delivery>", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/factory.json": MANIFEST, ".smithers/flows/ci/flow.ts": FLOW })
    const sha = github.push("feature/x", { "README.md": "change" })
    const request = pushed(sha)
    const { ran, starts } = await dispatch(github, request)
    expect(ran.exit).toEqual(Exit.succeed([`ci:${request.delivery}`]))
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`SELECT execution, repo_id, flow, sha, ref, event, launched_by FROM runs WHERE execution = ${`ci:${request.delivery}`}`))
    expect(rows).toEqual([{ execution: `ci:${request.delivery}`, repo_id: "github/acme/widgets", flow: "ci", sha,
      ref: "refs/heads/feature/x", event: "push", launched_by: "github" }])
    // `unmerged` has a trigger but no flow.ts on the default branch: not active, never started.
    expect(starts).toEqual([{
      flow: "repo/Run",
      executionId: `ci:${request.delivery}`,
      payload: {
        run: `ci:${request.delivery}`,
        repo: "acme/widgets",
        flow: "ci",
        sha,
        ref: "refs/heads/feature/x",
        event: "push",
        secrets: true,
      },
    }])
  })

  test("a fork's pull request runs without secrets", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/factory.json": MANIFEST, ".smithers/flows/ci/flow.ts": FLOW })
    const request: Dispatch.DispatchRequest = {
      ...pushed(SHA),
      event: "pull_request",
      ref: "refs/pull/9/head",
      branch: "main",
      action: "opened",
      trusted: false,
    }
    const { starts } = await dispatch(github, request)
    expect(starts.map((start) => start.payload)).toEqual([expect.objectContaining({ event: "pull_request", secrets: false })])
  })

  test("a trigger only the pushed branch adds starts nothing: triggers come from the default branch", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/flows/ci/flow.ts": FLOW })
    const sha = github.push("feature/x", { ".smithers/factory.json": MANIFEST })
    const { ran, starts } = await dispatch(github, pushed(sha))
    expect(ran.exit).toEqual(Exit.succeed([]))
    expect(starts).toEqual([])
  })

  test("nothing starts without a manifest, without a match, or when the App can't read the repository", async () => {
    const bare = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    expect((await dispatch(bare, pushed(bare.push("feature/x", { a: "1" })))).starts).toEqual([])
    const tagsOnly = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    tagsOnly.push("main", {
      ".smithers/factory.json": JSON.stringify({ apiVersion: 1, contributes: { triggers: [{ on: "github.push", flow: "ci", tags: ["v*"] }] } }),
      ".smithers/flows/ci/flow.ts": FLOW,
    })
    expect((await dispatch(tagsOnly, pushed(tagsOnly.push("feature/x", { a: "1" })))).starts).toEqual([])
    const closed = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    closed.contentsGranted = false
    closed.push("main", { ".smithers/factory.json": MANIFEST, ".smithers/flows/ci/flow.ts": FLOW })
    expect((await dispatch(closed, pushed(closed.push("feature/x", { a: "1" })))).starts).toEqual([])
  })

  test("GitHub's outages and a start that couldn't be recorded are tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/factory.json": MANIFEST, ".smithers/flows/ci/flow.ts": FLOW })
    const sha = github.push("feature/x", { a: "1" })
    github.faults.push(
      { match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 502 },
      { match: (method, path) => method === "GET" && path.includes("/contents/"), status: 502 },
    )
    let refusals = 1
    const { ran, starts } = await dispatch(github, pushed(sha), {
      start: () => refusals-- > 0 ? Effect.fail(new Error("the object didn't answer")) : Effect.void,
    })
    expect(ran.exit).toEqual(Exit.succeed([`ci:delivery-${sha.slice(0, 8)}`]))
    expect(starts).toHaveLength(1)
  })

  test("an unreadable flow isn't active, and the others still start; a dispatch never shares an id with a run", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", {
      ".smithers/factory.json": JSON.stringify({
        apiVersion: 1,
        contributes: { triggers: [{ on: "github.push", flow: "triggers" }, { on: "github.push", flow: "ci" }] },
      }),
      // GitHub answers a directory where flow.ts should be: no text, no retry reads it.
      ".smithers/flows/triggers/flow.ts/index.ts": FLOW,
      ".smithers/flows/ci/flow.ts": FLOW,
    })
    const request = pushed(github.push("feature/x", { a: "1" }))
    const { ran, starts } = await dispatch(github, request)
    expect(ran.exit).toEqual(Exit.succeed([`ci:${request.delivery}`]))
    expect(Dispatch.dispatchExecutionId(request.delivery)).not.toBe(Dispatch.runExecutionId("triggers", request.delivery))
    expect(starts.map((start) => start.executionId)).toEqual([`ci:${request.delivery}`])
  })

  test("a manifest GitHub answers as no text starts nothing, at once", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/factory.json/index.json": "{}", ".smithers/flows/ci/flow.ts": FLOW })
    const { ran, starts } = await dispatch(github, pushed(github.push("feature/x", { a: "1" })))
    expect(ran.exit).toEqual(Exit.succeed([]))
    expect(starts).toEqual([])
  })

  test("a manifest GitHub refuses to read starts nothing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/factory.json": MANIFEST, ".smithers/flows/ci/flow.ts": FLOW })
    const sha = github.push("feature/x", { a: "1" })
    github.faults.push({ match: (method, path) => method === "GET" && path.includes("/contents/"), status: 451 })
    expect((await dispatch(github, pushed(sha))).starts).toEqual([])
  })
})

test.each(["", "other/widgets", "acme/widgets-extra", "invalid"])("repository allowlist %s skips dispatch before reading GitHub", async (repositories) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { ran, starts } = await dispatch(github, pushed(SHA), { repositories })
  expect(Exit.isSuccess(ran.exit)).toBe(true)
  expect(starts).toEqual([])
  expect(github.calls).toEqual([])
})

test("repository allowlist defaults closed and trims case-insensitive names", async () => {
  const read = (config: Record<string, string>) => runtime.runPromise(Dispatch.repositories.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
  ))
  expect(await read({})).toEqual(new Set())
  expect(await read({ REPO_FLOWS_REPOSITORIES: "  , invalid, */*, owner/repo/extra " })).toEqual(new Set())
  expect(await read({ REPO_FLOWS_REPOSITORIES: " Acme/Widgets, other/repo " })).toEqual(new Set(["acme/widgets", "other/repo"]))
})

test("a denied repository has a visible match receipt and cannot start precomputed flows", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { services } = await githubServices(runtime, github)
  const logs: unknown[] = []
  const impl = Dispatch.steps({ ...services, repositories: new Set(), start: () => Effect.die("must not start") })
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => { logs.push(options.message) })])),
  )
  expect(await runtime.runPromise(run(impl.match({ request: pushed(SHA) })))).toEqual({ flows: [], outcome: "not_allowed" })
  expect(await runtime.runPromise(run(impl.start({ request: pushed(SHA), flows: ["ci"] })))).toEqual([])
  expect(logs.flat()).toEqual(expect.arrayContaining(["ci.dispatch", "ci.start"]))
  expect(github.calls).toEqual([])
})

// Deploy configuration exists only while Alchemy builds; the execution host must use the captured value.
test.each([undefined, "other/repo", "acme/widgets", "fault"])("both steps use the injected allowlist, ignoring ambient %s", async (ambient) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.push("main", { ".smithers/factory.json": MANIFEST, ".smithers/flows/ci/flow.ts": FLOW })
  const { services } = await githubServices(runtime, github)
  const request = pushed(SHA)
  const repositories = await runtime.runPromise(Dispatch.repositories.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ REPO_FLOWS_REPOSITORIES: " Acme/Widgets " })),
  ))
  const started: string[] = []
  const impl = Dispatch.steps({ ...services, repositories, start: (_, options) => Effect.sync(() => { started.push(options.executionId) }) })
  const provider = ambient === "fault"
    ? ConfigProvider.make(() => Effect.die("runtime Config must never be read"))
    : ConfigProvider.fromUnknown(ambient === undefined ? {} : { REPO_FLOWS_REPOSITORIES: ambient })
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  ))
  expect(await run(impl.match({ request }))).toEqual({ flows: ["ci"], outcome: "matched" })
  expect(await run(impl.start({ request, flows: ["ci"] }))).toEqual([`ci:${request.delivery}`])
  expect(started).toEqual([`ci:${request.delivery}`])
  const denied = Dispatch.steps({ ...services, repositories: new Set<string>(), start: () => Effect.die("must not start") })
  expect(await run(denied.match({ request }))).toEqual({ flows: [], outcome: "not_allowed" })
  expect(await run(denied.start({ request, flows: ["ci"] }))).toEqual([])
})

// Drive the real start step once, so its durable retry cannot hide a leaked ownership row.
test.each(["conflict", "unavailable"] as const)("triggered %s rolls back ownership before retry", async (failure) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { services } = await githubServices(runtime, github)
  const request = { ...pushed(SHA), delivery: uuid() }
  const executionId = Dispatch.runExecutionId("ci", request.delivery)
  const values = new Map<string, unknown>()
  const storage: ExecutionHost.Storage = {
    get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: () => Effect.void, deleteAlarm: () => Effect.void,
  }
  if (failure === "conflict") await runtime.runPromise(Effect.flatMap(
    ExecutionHost.intent(Pause.Pause, { executionId, payload: { label: "victim", pauseMs: 60_000 } }),
    (intent) => ExecutionHost.recordStart(storage, intent),
  ))
  const before = structuredClone(values)
  const impl = Dispatch.steps({ ...services, repositories: new Set(["acme/widgets"]),
    start: (flow, options) => failure === "unavailable" ? Effect.fail(new Error("unavailable"))
      : ExecutionHost.intent(flow, { ...options, payload: options.payload as never }).pipe(
        Effect.flatMap((intent) => ExecutionHost.recordStart(storage, intent)),
      ),
  })
  const result = await runtime.runPromise(Effect.result(impl.start({ request, flows: ["ci"] })))
  expect(result._tag).toBe("Failure")
  const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT execution FROM runs WHERE execution = ${executionId}`))
  expect(rows, "triggered rejection must leave no repository ownership").toEqual([])
  expect(values).toEqual(before)
})
