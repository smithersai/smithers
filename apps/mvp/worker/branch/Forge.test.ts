// Where a branch's git comes from (worker/branch/Forge.ts, decision 0013 §2): Code Storage with a `git:read` token for
// the one repository when the deployment has an organization, else the public repository on GitHub with no credential
// at all. GitHub is the scripted git host of worker/test/branch.ts, reached through Effect's `FetchHttpClient`.
import { CodeStorage, GitProxy, GitRemote } from "@smthrs/effect-code-storage"
import { Cause, ConfigProvider, Effect, Exit, Layer, Metric, Redacted, Tracer } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import { gitHost, shaOf } from "../test/branch.ts"
import { machineOf } from "../flows/TodoMachine.ts"
import { branchHead, CreateRefused, createBranch, defaultBranch, failureFields, Forge, forgeOf, proxy } from "./Forge.ts"

/** A fresh ES256 key, as Code Storage's Keys page hands one out: a PKCS#8 PEM. */
const pem = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`
}

/** Runs `effect` with `Forge.layerConfig` under `config`, over `fetch`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Forge | import("effect/http").HttpClient.HttpClient>,
  config: Record<string, string>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(Forge.layerConfig.pipe(Layer.provideMerge(FetchHttpClient.layer))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
    ),
  )

const upstream = (repository: { readonly owner: string; readonly name: string }) =>
  Effect.flatMap(Forge, (forge) => forge.upstream(repository))

const value = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${String(exit.cause)}`)
  return exit.value
}

/** GitHub with `octocat/Spoon-Knife` (`main` and `feature`) and a private `octocat/secret`. */
const github = () => {
  const host = gitHost()
  host.publish("octocat", "Spoon-Knife", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), feature: shaOf("feature") },
  })
  host.publish("octocat", "secret", { defaultBranch: "main", branches: { main: shaOf("secret") }, private: true })
  return host
}

describe("Forge.layerConfig", () => {
  test("without Code Storage: the public repository on GitHub, with no credential, GITHUB_TOKEN or not", async () => {
    const configs: ReadonlyArray<Record<string, string>> = [{}, { GITHUB_TOKEN: "ghp_sentinel" }, { CODE_STORAGE_ORG: "acme" }]
    for (const config of configs) {
      expect(value(await run(upstream({ owner: "octo cat", name: "Spoon/Knife" }), config))).toEqual({
        url: "https://github.com/octo%20cat/Spoon%2FKnife.git",
      })
    }
  })

  test("with a Code Storage organization and key: the repository's mirror, with a git:read token for it", async () => {
    const remote = value(
      await run(upstream({ owner: "OctoCat", name: "Spoon-Knife" }), { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() }),
    )
    expect(remote.url).toBe("https://acme.code.storage/github/octocat/spoon-knife.git")
    const authorization = Redacted.value(remote.authorization!)
    expect(authorization).toMatch(/^Basic /)
    const token = atob(authorization.slice("Basic ".length)).slice("t:".length)
    const claims = JSON.parse(atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")))
    expect(claims).toMatchObject({ repo: "github/octocat/spoon-knife", scopes: ["git:read"] })
  })
})

describe("forgeOf: the forge a branch's machine checks out through", () => {
  const codeStorage = async () => ({ CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() })
  const upstreamOf = (branch: { readonly owner: string; readonly name: string; readonly forge?: "github" }) =>
    Effect.flatMap(Forge, (forge) => forgeOf(forge, branch).upstream(branch))

  test("a TODO's machine reads its attempt branch on GitHub, with no credential, where the deployment's forge is Code Storage", async () => {
    // It checks out its base commit from GitHub, the head of a branch the mirror may not have pulled yet.
    const machine = machineOf({
      attemptId: "6f0e2b9c-1d4a-4c3b-9e8f-7a6b5c4d3e2f",
      repoId: "github/OctoCat/Spoon-Knife",
      checkout: shaOf("main"),
      ownerId: "maya",
    })
    expect(machine.branch.forge).toBe("github")
    expect(value(await run(upstreamOf(machine.branch), await codeStorage()))).toEqual({
      url: "https://github.com/OctoCat/Spoon-Knife.git",
    })
  })

  test("any other branch keeps the deployment's forge: the mirror with Code Storage, GitHub without", async () => {
    const remote = value(await run(upstreamOf({ owner: "OctoCat", name: "Spoon-Knife" }), await codeStorage()))
    expect(remote.url).toBe("https://acme.code.storage/github/octocat/spoon-knife.git")
    expect(remote.authorization).toBeDefined()
    expect(value(await run(upstreamOf({ owner: "octocat", name: "Spoon-Knife" }), {}))).toEqual({
      url: "https://github.com/octocat/Spoon-Knife.git",
    })
  })

  test("GitHub's forge never creates a branch: it holds no credential", async () => {
    const exit = await run(
      Effect.flatMap(Forge, (forge) =>
        forgeOf(forge, { forge: "github" }).create({ owner: "octocat", name: "Spoon-Knife" }, "b", shaOf("main"))),
      await codeStorage(),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "CreateRefused", code: "not_configured" })
  })
})

describe("branchHead and defaultBranch on GitHub", () => {
  test("read a branch's commit and the default branch, sending no credential", async () => {
    const host = github()
    const config = { GITHUB_TOKEN: "ghp_sentinel" }
    expect(value(await run(branchHead({ owner: "octocat", name: "Spoon-Knife" }, "feature"), config, host.fetch)))
      .toBe(shaOf("feature"))
    expect(value(await run(defaultBranch({ owner: "octocat", name: "Spoon-Knife" }), config, host.fetch))).toEqual({
      sha: shaOf("main"),
      branch: "main",
    })
    expect(host.seen.map((seen) => seen.authorization)).toEqual([null, null])
  })

  test("a private or missing repository is not_found, and a branch GitHub doesn't have is ref_not_found", async () => {
    const host = github()
    const failure = async (effect: Effect.Effect<unknown, GitRemote.GitRemoteError, Forge | import("effect/http").HttpClient.HttpClient>) => {
      const exit = await run(effect, { GITHUB_TOKEN: "ghp_sentinel" }, host.fetch)
      return Exit.isFailure(exit) ? exit.cause : undefined
    }
    expect(String(await failure(branchHead({ owner: "octocat", name: "secret" }, "main")))).toContain("not_found")
    expect(String(await failure(defaultBranch({ owner: "octocat", name: "secret" })))).toContain("not_found")
    expect(String(await failure(branchHead({ owner: "octocat", name: "gone" }, "main")))).toContain("not_found")
    expect(String(await failure(branchHead({ owner: "octocat", name: "Spoon-Knife" }, "nope")))).toContain("ref_not_found")
    expect(host.seen.every((seen) => seen.authorization === null)).toBe(true)
  })
})

describe("the forge proxy", () => {
  test.each([
    ["GET", "/info/refs?service=git-upload-pack"],
    ["POST", "/git-upload-pack"],
    ["POST", "/git-receive-pack"],
  ])("refuses an unscoped ephemeral %s %s before contacting the provider", async (method, path) => {
    let contacted = false
    const registry: Metric.MetricRegistry = new Map()
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    } })
    const service = GitProxy.classify(method, path) ?? "refused"
    const count = () => Effect.runSync(Metric.value(Metric.withAttributes(GitProxy.requests, { service, outcome: "refused" })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    )).count
    const before = count()
    const exit = await run<HttpServerResponse.HttpServerResponse, unknown>(Effect.flatMap(Forge, (forge) => proxy(
      HttpServerRequest.fromWeb(new Request(`http://forge.smithers.internal${path}`, { method })),
      forge,
      { owner: "octocat", name: "Spoon-Knife", namespace: "ephemeral" },
    )).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(Tracer.Tracer, tracer),
    ), {}, async () => {
      contacted = true
      throw new Error("injected transport outage")
    })
    expect(value(exit).status).toBe(403)
    expect(contacted).toBe(false)
    expect(count()).toBe(before + 1)
    expect(spans.map((span) => ({ name: span.name, attributes: Object.fromEntries(span.attributes) }))).toEqual([{
      name: "sandbox.forge",
      attributes: { "git.proxy.service": service, "http.response.status_code": 403, outcome: "namespace_unscoped" },
    }])
  })

  test("reads only the branch's own repository, whatever repository the guest's path names", async () => {
    const host = github()
    const exit = await run(
      Effect.gen(function* () {
        const guest = new Request("http://forge.smithers.internal/octocat/secret/info/refs?service=git-upload-pack")
        return yield* proxy(HttpServerRequest.fromWeb(guest), yield* Forge, { owner: "octocat", name: "Spoon-Knife" })
      }),
      {},
      host.fetch,
    )
    const response = HttpServerResponse.toWeb(value(exit))
    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain(`${shaOf("main")} HEAD`)
    expect(host.seen.map((seen) => [seen.path, seen.authorization])).toEqual([
      ["/octocat/Spoon-Knife.git/info/refs?service=git-upload-pack", null],
    ])
  })
})


test("Code Storage transport refusal retains its tag and code without inventing an HTTP status", async () => {
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const client = yield* CodeStorage.CodeStorage.pipe(Effect.provide(
      CodeStorage.CodeStorage.layer({ org: "acme", key: Redacted.make(yield* Effect.promise(pem)) }),
    ))
    const faulty = { ...client, createBranch: () => Effect.fail(new CodeStorage.CodeStorageError({
      operation: "createBranch", code: "transport",
    })) }
    return yield* createBranch({ owner: "octocat", name: "Spoon-Knife" }, "b", "main").pipe(
      Effect.provide(Forge.codeStorage(faulty)),
    )
  }).pipe(Effect.provide(FetchHttpClient.layer)))
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
    _tag: "CreateRefused", code: "unavailable",
    errorTag: "@smthrs/effect-code-storage/CodeStorageError", errorCode: "transport",
  })
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).not.toHaveProperty("errorStatus")
})


test.each([
  [401, "unauthorized"],
  [403, "forbidden"],
  [403, "insufficient_scope"],
  [403, "authentication_unavailable"],
  [401, "conflict"],
])("Code Storage %s %s is a terminal refusal with its cause", async (status, code) => {
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const client = yield* CodeStorage.CodeStorage.pipe(Effect.provide(
      CodeStorage.CodeStorage.layer({ org: "acme", key: Redacted.make(yield* Effect.promise(pem)) }),
    ))
    const faulty: CodeStorage.Client = { ...client, createBranch: () => Effect.fail(new CodeStorage.CodeStorageError({
      operation: "createBranch", code, status,
    })) }
    return yield* createBranch({ owner: "smithersai", name: "smithers" }, "b", "main").pipe(
      Effect.provide(Forge.codeStorage(faulty)),
    )
  }).pipe(Effect.provide(FetchHttpClient.layer)))
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
    _tag: "CreateRefused", code: "forbidden",
    errorTag: "@smthrs/effect-code-storage/CodeStorageError", errorCode: code, errorStatus: status,
  })
})

test("an ephemeral branch's proxy remote stays in its persisted namespace", async () => {
  const exit = await run(Effect.flatMap(Forge, (forge) =>
    forgeOf(forge, { namespace: "ephemeral" }).upstream({ owner: "octocat", name: "Spoon-Knife" })),
    { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() })
  expect(value(exit).url).toBe("https://acme.code.storage/github/octocat/spoon-knife+ephemeral.git")
})

test("default conversation creation asks only for the ephemeral destination", async () => {
  let options: unknown
  await Effect.runPromise(Effect.gen(function* () {
    const client = yield* CodeStorage.CodeStorage
    const faulty: CodeStorage.Client = { ...client, createBranch: (_repo, input) => {
      options = input
      return Effect.fail(new CodeStorage.CodeStorageError({ operation: "createBranch", code: "transport" }))
    } }
    yield* createBranch({ owner: "o", name: "r" }, "conversation", "main").pipe(
      Effect.provide(Forge.codeStorage(faulty)), Effect.flip)
  }).pipe(Effect.provide(CodeStorage.CodeStorage.layer({ org: "acme", key: Redacted.make(await pem()) }).pipe(
    Layer.provide(FetchHttpClient.layer)))))
  expect(options).toEqual({ branch: "conversation", from: "main", namespace: "ephemeral" })
})


test("an ephemeral sandbox advertises only its persisted branch through its namespace", async () => {
  const seen: Array<string> = []
  const tip = shaOf("conversation")
  const pkt = (line: string) => (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line
  const exit = await run<HttpServerResponse.HttpServerResponse, unknown>(Effect.flatMap(Forge, (forge) => proxy(
    HttpServerRequest.fromWeb(new Request("http://forge.smithers.internal/other/repo/info/refs?service=git-upload-pack", {
      headers: { "git-protocol": "version=2" },
    })), forge,
    { owner: "octocat", name: "Spoon-Knife", branch: "conversation", namespace: "ephemeral" },
  )), { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() }, async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    seen.push(request.url)
    expect(await request.text()).toContain("ref-prefix refs/heads/conversation")
    return new Response(pkt(`${tip} refs/heads/conversation\n`) + pkt(`${shaOf("secret")} refs/heads/secret\n`) + "0000", {
      headers: { "content-type": "application/x-git-upload-pack-result" },
    })
  })
  const response = HttpServerResponse.toWeb(value(exit))
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain(`${tip} refs/heads/conversation`)
  expect(body).not.toContain("secret")
  expect(seen).toEqual(["https://acme.code.storage/github/octocat/spoon-knife+ephemeral.git/git-upload-pack"])
})


test.each([
  [409, "conflict", "exists"],
  [404, "not_found", "not_found"],
  [404, "repository_not_found", "not_found"],
  [404, "ref_not_found", "not_found"],
  [404, "branch_not_found", "not_found"],
  [503, "unavailable", "unavailable"],
])("Code Storage %s %s preserves the creation refusal class", async (status, code, expected) => {
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const client = yield* CodeStorage.CodeStorage
    const faulty: CodeStorage.Client = { ...client, createBranch: () => Effect.fail(new CodeStorage.CodeStorageError({
      operation: "createBranch", code, status,
    })) }
    return yield* createBranch({ owner: "o", name: "r" }, "conversation", "main").pipe(
      Effect.provide(Forge.codeStorage(faulty)),
    )
  }).pipe(Effect.provide(CodeStorage.CodeStorage.layer({ org: "acme", key: Redacted.make(await pem()) }).pipe(
    Layer.provide(FetchHttpClient.layer),
  ))))
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
    _tag: "CreateRefused", code: expected, errorCode: code, errorStatus: status,
  })
})

test("forge diagnostics fall back to the typed refusal and retain direct read failures", () => {
  expect(failureFields("create_ref", new CreateRefused({ code: "not_configured" }))).toEqual({
    forgeOperation: "create_ref", forgeErrorTag: "CreateRefused", forgeErrorCode: "not_configured",
  })
  expect(failureFields("refs_read", new GitRemote.GitRemoteError({ code: "not_found", status: 404 }))).toEqual({
    forgeOperation: "refs_read", forgeErrorTag: "@smthrs/effect-code-storage/GitRemoteError", forgeErrorCode: "not_found", forgeStatus: 404,
  })
})
