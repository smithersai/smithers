import { Effect, Layer } from "effect"
import { describe, expect, test } from "vitest"
import { RepoClient, RepoRefused } from "./api"
import { RepoNotFound, RepoReader, RepoReadsPaused, RepoReadUnavailable } from "./flows"
import { readerLayer, readFailure } from "./reader"
import type { Refs } from "./schema"

// The device's `RepoReader`: what each RepoApi answer means to the agent's read steps. RepoApi's real answers reach it
// in repo.test.ts; here a faulty `RepoClient` gives each refusal (test.faults-by-injection).

const SHA = "e".repeat(40)

/** A client whose reads answer `tree`, `blob` and `refs`. */
const client = (answers: {
  readonly tree?: Effect.Effect<{ readonly paths: ReadonlyArray<string>; readonly truncated: boolean }, RepoRefused>
  readonly blob?: Effect.Effect<{ readonly bytes: Uint8Array }, RepoRefused>
  readonly refs?: Effect.Effect<Refs, RepoRefused>
}) =>
  Layer.succeed(
    RepoClient,
    RepoClient.of({
      clone: () => Effect.die(new Error("unused")),
      launch: () => Effect.die(new Error("unused")),
      tree: () => answers.tree ?? Effect.die(new Error("unused")),
      blob: () => answers.blob ?? Effect.die(new Error("unused")),
      refs: () => answers.refs ?? Effect.die(new Error("unused")),
      about: () => Effect.die(new Error("unused")),
    }),
  )

const read = (layer: Layer.Layer<RepoClient>) =>
  Effect.runPromise(
    Effect.service(RepoReader).pipe(
      Effect.flatMap((reader) =>
        Effect.all([Effect.result(reader.tree("o", "n", SHA)), Effect.result(reader.read("o", "n", SHA, "a"))])
      ),
      Effect.provide(readerLayer.pipe(Layer.provide(layer))),
    ),
  )

describe("readFailure", () => {
  test("gone, paused, or worth trying again after the server's wait", () => {
    expect(readFailure(new RepoRefused({ status: 404, code: "not_found" }))).toBeInstanceOf(RepoNotFound)
    expect(readFailure(new RepoRefused({ status: 400, code: "invalid" }))).toBeInstanceOf(RepoNotFound)
    expect(readFailure(new RepoRefused({ status: 503, code: "capacity" }))).toBeInstanceOf(RepoReadsPaused)
    expect(readFailure(new RepoRefused({ status: 503, code: "unavailable", retryAfterMillis: 4_000 }))).toEqual(
      new RepoReadUnavailable({ retryAfterMillis: 4_000 }),
    )
    expect(readFailure(new RepoRefused({ status: 503, code: "rate_limited", retryAfterMillis: 60_000 }))).toEqual(
      new RepoReadUnavailable({ reason: "rate_limited", retryAfterMillis: 60_000 }),
    )
    expect(readFailure(new RepoRefused({ status: 503, code: "github_unavailable" }))).toEqual(
      new RepoReadUnavailable({ reason: "github_unavailable" }),
    )
    expect(readFailure(new RepoRefused({ status: 500 }))).toEqual(new RepoReadUnavailable({}))
    expect(readFailure(new RepoRefused({}))).toEqual(new RepoReadUnavailable({}))
  })
})

describe("readerLayer", () => {
  test("a listing as RepoApi sent it, and a file as text or binary", async () => {
    const [tree, text] = await read(
      client({
        tree: Effect.succeed({ paths: ["a"], truncated: false }),
        blob: Effect.succeed({ bytes: new TextEncoder().encode("hé") }),
      }),
    )
    expect(tree).toMatchObject({ _tag: "Success", success: { paths: ["a"], truncated: false } })
    expect(text).toMatchObject({ _tag: "Success", success: { state: "text", contents: "hé", size: 3 } })
    const [, binary] = await read(client({ tree: Effect.succeed({ paths: [], truncated: false }), blob: Effect.succeed({ bytes: new Uint8Array([1, 0, 2]) }) }))
    expect(binary).toMatchObject({ _tag: "Success", success: { state: "binary", size: 3 } })
  })

  test("a file over the limit is too large with its size; a refusal is the step's failure", async () => {
    const [, large] = await read(
      client({
        tree: Effect.fail(new RepoRefused({ status: 503, code: "capacity" })),
        blob: Effect.fail(new RepoRefused({ status: 413, code: "too_large", size: 700_000 })),
      }),
    )
    expect(large).toMatchObject({ _tag: "Success", success: { state: "too-large", size: 700_000 } })
    const [tree, file] = await read(
      client({
        tree: Effect.fail(new RepoRefused({ status: 503, code: "capacity" })),
        blob: Effect.fail(new RepoRefused({ status: 413 })),
      }),
    )
    expect(tree).toMatchObject({ _tag: "Failure", failure: new RepoReadsPaused() })
    expect(file).toMatchObject({ _tag: "Failure", failure: new RepoReadUnavailable({}) })
  })
})

describe("refs", () => {
  test("the branches and tags as RepoApi sent them; a repository that isn't ready is gone", async () => {
    const refs: Refs = { defaultBranch: "main", head: SHA, branches: [{ name: "main", sha: SHA }], tags: [], truncated: false }
    const refsOf = (answer: Effect.Effect<Refs, RepoRefused>) =>
      Effect.runPromise(
        Effect.service(RepoReader).pipe(
          Effect.flatMap((reader) => Effect.result(reader.refs("o", "n"))),
          Effect.provide(readerLayer.pipe(Layer.provide(client({ refs: answer })))),
        ),
      )
    expect(await refsOf(Effect.succeed(refs))).toMatchObject({ _tag: "Success", success: refs })
    expect(await refsOf(Effect.fail(new RepoRefused({ status: 404, code: "not_found" })))).toMatchObject({
      _tag: "Failure",
      failure: new RepoNotFound(),
    })
  })
})


test("a clone whose transport never answers remains unavailable without inventing an HTTP status", async () => {
  const { launchClone } = await import("./clone")
  const { RepoCloneUnavailable } = await import("./flows")
  const fault = RepoClient.of({ clone: () => Effect.die("unused"), launch: () => Effect.fail(new RepoRefused({})),
    tree: () => Effect.die("unused"), blob: () => Effect.die("unused"), refs: () => Effect.die("unused"), about: () => Effect.die("unused"),
  })
  const result = await Effect.runPromise(Effect.flip(launchClone({ repo: "octo/hello", cloneId: crypto.randomUUID() }).pipe(Effect.provideService(RepoClient, fault))))
  expect(result).toBeInstanceOf(RepoCloneUnavailable)
})
