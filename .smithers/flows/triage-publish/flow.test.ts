/**
 * `triage-publish` through the flow API: the real graph, the real layer and a
 * real child process running `github-triage.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import TriagePublish, { argv, layer, Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    TriagePublish.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(TriagePublish, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

const inDirectory = async <A>(env: Record<string, string>, body: (root: string) => Promise<A>) => {
  const root = mkdtempSync(join(tmpdir(), "triage-publish-"))
  const previous = { cwd: process.cwd(), env: { ...process.env } }
  process.chdir(root)
  Object.assign(process.env, env)
  try {
    return await body(root)
  } finally {
    process.chdir(previous.cwd)
    for (const key of Object.keys(env)) {
      if (previous.env[key] === undefined) delete process.env[key]
      else process.env[key] = previous.env[key]
    }
    rmSync(root, { recursive: true, force: true })
  }
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ phase: "prepare", kind: "issue" }), ["prepare", "issue"])
  assert.deepEqual(argv({ phase: "apply", kind: "pr", number: 42 }), ["apply", "pr", "42"])
  // The module, not the wrapper, refuses an apply with no number.
  assert.deepEqual(argv({ phase: "apply", kind: "pr" }), ["apply", "pr"])
})

test("apply without a number is refused by the module", async () => {
  await inDirectory({}, async () => {
    const exit = await run({ phase: "apply", kind: "issue" }, "triage-publish-no-number")
    assert.ok(Exit.isFailure(exit))
  })
})

test("apply refuses a report whose event names another number, as a typed failure", async () => {
  await inDirectory({ GH_TOKEN: "test-token", GITHUB_REPOSITORY: "owner/repo" }, async (root) => {
    const event = join(root, "event.json")
    writeFileSync(event, JSON.stringify({ issue: { number: 7, title: "t", body: "b", user: { login: "a" } } }))
    process.env.GITHUB_EVENT_PATH = event
    const exit = await run({ phase: "apply", kind: "issue", number: 8 }, "triage-publish-mismatch")
    assert.ok(Exit.isFailure(exit))
    const failure = JSON.stringify(exit.cause)
    assert.match(failure, /automation\/ModuleFailed/)
    assert.match(failure, /triage-publish\/github-triage\.mjs/)
    assert.doesNotMatch(failure, /test-token/)
  })
})

test("prepare writes the context the triage flow reads", async () => {
  // The child answers GitHub from a preloaded stub: no comments on issue 7.
  const stub = join(mkdtempSync(join(tmpdir(), "triage-publish-stub-")), "fetch.mjs")
  writeFileSync(stub, "globalThis.fetch = async () => new Response('[]', { status: 200 })\n")
  const env = {
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "owner/repo",
    NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`
  }
  await inDirectory(env, async (root) => {
    const event = join(root, "event.json")
    writeFileSync(event, JSON.stringify({ issue: { number: 7, title: "Crash", body: "steps", user: { login: "a" } } }))
    process.env.GITHUB_EVENT_PATH = event
    const exit = await run({ phase: "prepare", kind: "issue" }, "triage-publish-prepare")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
    const context = JSON.parse(readFileSync(join(root, ".triage/context.json"), "utf8"))
    assert.equal(context.number, 7)
    assert.equal(context.kind, "issue")
  })
})
