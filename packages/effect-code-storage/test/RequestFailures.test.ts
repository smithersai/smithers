import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { HttpClient } from "effect/http"
import { beforeAll, describe, expect, test } from "vitest"
import { CodeStorage, GitRemote } from "../src/index.ts"
import { codeStorage, httpClient, keyPair, ORG, telemetry } from "./fixtures.ts"

let pem: string
let publicKey: CryptoKey
beforeAll(async () => {
  ;({ pem, publicKey } = await keyPair())
})

const calls = [
  ["createRepo", "createRepo", (client, repo) => client.createRepo({ name: repo }).pipe(Effect.asVoid)],
  ["deleteRepo", "deleteRepo", (client, repo) => client.deleteRepo(repo)],
  ["pullUpstream", "pullUpstream", (client, repo) => client.pullUpstream(repo)],
  [
    "createBranch",
    "createBranch",
    (client, repo) => client.createBranch(repo, { branch: "b", from: "main" }).pipe(Effect.asVoid)
  ],
  ["listFiles", "listFiles", (client, repo) => client.listFiles(repo).pipe(Effect.asVoid)],
  ["readFile", "readFile", (client, repo) => client.readFile(repo, { path: "x", maxBytes: 1 }).pipe(Effect.asVoid)],
  ["streamFile", "readFile", (client, repo) => client.streamFile(repo, { path: "x" }).pipe(Effect.asVoid)],
  ["listCommits", "listCommits", (client, repo) => client.listCommits(repo).pipe(Effect.asVoid)],
  ["listBranches", "listBranches", (client, repo) => client.listBranches(repo).pipe(Effect.asVoid)],
  ["listTags", "listTags", (client, repo) => client.listTags(repo).pipe(Effect.asVoid)]
] satisfies ReadonlyArray<
  readonly [
    string,
    CodeStorage.Operation,
    (client: CodeStorage.Client, repo: string) => Effect.Effect<void, CodeStorage.CodeStorageError>
  ]
>

describe.each(calls)("%s request failures", (_method, operation, call) => {
  test.each(["\ud800", "\udfff", "a\ud800", "\udc00/b", "a/\ud800/b", "\udc00\ud800", "🚀/\ud800"])(
    "rejects malformed repository %j inside its observed effect before HTTP",
    async (repo) => {
      const service = codeStorage(publicKey)
      const recorded = telemetry()
      const client = await Effect.runPromise(CodeStorage.CodeStorage.pipe(Effect.provide(
        CodeStorage.CodeStorage.layer({ org: ORG, key: Redacted.make(pem) }).pipe(
          Layer.provide(httpClient(service.fetch))
        )
      )))
      // Construct outside Effect: deletion and sync must not throw at their call sites either.
      const effect = call(client, repo)
      const exit = await Effect.runPromiseExit(recorded.provide(effect))
      expect(Exit.findErrorOption(exit)).toMatchObject({ _tag: "Some", value: { operation, code: "invalid_argument" } })
      expect(service.seen).toEqual([])
      expect(recorded.count(CodeStorage.requests, { operation, outcome: "invalid_argument" })).toBe(1)
      expect(recorded.count(CodeStorage.requests, { operation, outcome: "interrupted" })).toBe(0)
      expect(recorded.spans.find((span) => span.name === "CodeStorage." + operation)?.status._tag).toBe("Ended")
    }
  )

  test.each(
    [
      ["defect", Cause.die(new Error("injected client defect")), "defect"],
      ["interruption", Cause.interrupt(), "interrupted"],
      ["empty cause", Cause.empty, "defect"],
      [
        "defect and interruption",
        Cause.combine(Cause.die(new Error("injected finalizer defect")), Cause.interrupt()),
        "defect"
      ]
    ] as const
  )("counts an injected %s separately from other outcomes", async (_name, cause, outcome) => {
    const recorded = telemetry()
    const http = Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.failCause(cause)))
    const exit = await Effect.runPromiseExit(recorded.provide(
      CodeStorage.CodeStorage.use((client) => call(client, "repo")).pipe(Effect.provide(
        CodeStorage.CodeStorage.layer({ org: ORG, key: Redacted.make(pem) }).pipe(Layer.provide(http))
      ))
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(recorded.count(CodeStorage.requests, { operation, outcome })).toBe(1)
    expect(
      recorded.count(CodeStorage.requests, { operation, outcome: outcome === "defect" ? "interrupted" : "defect" })
    ).toBe(0)
  })
})

test.each(["a/🚀", "日本語", "a\ud800\udc00b"])("preserves well-formed repository %j", async (repo) => {
  const service = codeStorage(publicKey)
  await Effect.runPromise(
    CodeStorage.CodeStorage.use((client) =>
      Effect.gen(function*() {
        yield* client.createRepo({ name: repo })
        expect((yield* client.listFiles(repo)).paths).toEqual([])
      })
    ).pipe(Effect.provide(
      CodeStorage.CodeStorage.layer({ org: ORG, key: Redacted.make(pem) }).pipe(
        Layer.provide(httpClient(service.fetch))
      )
    ))
  )
  expect(service.seen).toHaveLength(2)
  expect(service.seen[1]!.url.pathname).toBe("/api/repos/" + encodeURIComponent(repo) + "/files")
})

describe.each(
  [
    ["head", () => GitRemote.head("https://example.com/repo.git").pipe(Effect.asVoid)],
    ["ref", () => GitRemote.ref({ url: "https://example.com/repo.git" }, "main").pipe(Effect.asVoid)]
  ] as const
)("GitRemote.%s request failures", (_name, call) => {
  test.each(
    [
      ["defect", Cause.die(new Error("injected client defect")), "defect"],
      ["interruption", Cause.interrupt(), "interrupted"],
      ["empty cause", Cause.empty, "defect"],
      [
        "defect and interruption",
        Cause.combine(Cause.die(new Error("injected finalizer defect")), Cause.interrupt()),
        "defect"
      ]
    ] as const
  )("counts an injected %s separately from other outcomes", async (_name, cause, outcome) => {
    const recorded = telemetry()
    const exit = await Effect.runPromiseExit(recorded.provide(
      call().pipe(Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.failCause(cause))
      ))
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(recorded.count(GitRemote.requests, { outcome })).toBe(1)
    expect(recorded.count(GitRemote.requests, { outcome: outcome === "defect" ? "interrupted" : "defect" })).toBe(0)
  })
})
