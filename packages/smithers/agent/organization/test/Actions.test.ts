/**
 * The organization's durable steps on the memory engine: each declaration
 * called from an ordinary flow and implemented by `Actions.layer`, plus the
 * Review-gate handler's refusals with test doubles standing in for the role
 * task.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, Schema } from "effect"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Actions from "../src/Actions.ts"
import * as Authority from "../src/Authority.ts"
import * as Gates from "../src/Gates.ts"
import type * as Profile from "../src/Profile.ts"
import * as Workspace from "../src/Workspace.ts"
import { done, failureOf, loadSnapshot, payloadFor, task } from "./dispatchSupport.ts"
import { tempDir } from "./support.ts"
import { fixtureRepo, git, hostMachines } from "./workspaceSupport.ts"

const stack = (
  flow: any,
  snapshot: Authority.Snapshot,
  options: { readonly repo?: string; readonly wiki?: string; readonly machines?: Workspace.Machines } = {}
): Layer.Layer<any> =>
  Layer.mergeAll(
    Actions.layer({
      repositories: { "example/demo": options.repo ?? "/nowhere" },
      wiki: { root: options.wiki ?? tempDir(), generatedDir: "Org/Runs/" }
    }),
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Authority.layerRegistry(snapshot)),
    Layer.provideMerge(Workspace.layer({ machines: options.machines ?? hostMachines().machines, maxConcurrentVMs: 2 })),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer)
  ) as Layer.Layer<any>

/** Runs `flow` once on a fresh composition; loosely typed, since each case reads its own shape. */
const execute = (
  flow: any,
  payload: unknown,
  snapshot: Authority.Snapshot,
  options?: {
    readonly repo?: string
    readonly wiki?: string
    readonly executionId?: string
    readonly machines?: Workspace.Machines
  }
): Promise<Exit.Exit<any, unknown>> =>
  Effect.runPromise(
    (flow.execute(payload, { executionId: options?.executionId ?? "run-1" }) as Effect.Effect<any, unknown, any>).pipe(
      Effect.provide(stack(flow, snapshot, options)),
      Effect.exit
    ) as Effect.Effect<Exit.Exit<any, unknown>>
  )

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(String(failureOf(exit)))
  return exit.value
}

const Pin = Flow.make("test/pin", {
  payload: {},
  success: Schema.Struct({ revision: Schema.String }),
  body: () => Actions.PinRoster.call({})
})

const Compose = Flow.make("test/compose", {
  payload: Actions.ComposeTask.payloadSchema,
  success: Authority.RoleTaskPayload,
  error: Authority.DispatchRefused,
  body: (payload) => Actions.ComposeTask.call(payload)
})

const Validate = Flow.make("test/validate", {
  payload: Actions.ValidateResult.payloadSchema,
  success: Actions.Validation,
  error: Authority.DispatchRefused,
  body: (payload) => Actions.ValidateResult.call(payload)
})

const Receipt = Flow.make("test/receipt", {
  payload: Actions.WriteReceipt.payloadSchema,
  success: Actions.WriteReceipt.successSchema,
  error: Actions.ReceiptFailed,
  body: (payload) => Actions.WriteReceipt.call(payload)
})

describe("roster steps", () => {
  it("pins the current revision and composes a ready role-task payload", async () => {
    const snapshot = await loadSnapshot()
    expect(value(await execute(Pin, {}, snapshot))).toEqual({ revision: snapshot.revision })
    const composed = value(
      await execute(Compose, {
        revision: snapshot.revision,
        principal: "builder",
        task: task(),
        context: [],
        workspace: { key: "run-1/example/demo/build", repository: "example/demo" }
      }, snapshot)
    )
    expect(composed).toEqual({
      ...payloadFor(snapshot, "builder", task()),
      workspace: { key: "run-1/example/demo/build", repository: "example/demo" }
    })
    const plain = value(
      await execute(Compose, { revision: snapshot.revision, principal: "lead", task: task(), context: [] }, snapshot)
    )
    expect(plain).toEqual(payloadFor(snapshot, "lead", task()))
    const refused = failureOf(
      await execute(Compose, {
        revision: snapshot.revision,
        principal: "nobody",
        task: task(),
        context: []
      }, snapshot)
    )
    expect(refused).toMatchObject({ reason: "unknown-principal" })
  })

  it("validates a result against the principal's charter at the pinned revision", async () => {
    const snapshot = await loadSnapshot()
    const check = (principal: string, result: Profile.RoleResult, revision = snapshot.revision) =>
      execute(Validate, { revision, principal, result }, snapshot)
    expect(value(await check("builder", done({ summary: "s", commands: "c" })))).toEqual({
      valid: true,
      violations: []
    })
    const invalid = value(await check("builder", done({ summary: "s" })))
    expect(invalid.valid).toBe(false)
    expect(invalid.violations.map((violation: { readonly code: string }) => violation.code)).toEqual(["missing-field"])
    expect(failureOf(await check("nobody", done({})))).toMatchObject({ reason: "unknown-principal" })
    expect(failureOf(await check("builder", done({}), "0".repeat(64)))).toMatchObject({ reason: "unknown-revision" })
  })
})

describe("WriteReceipt", () => {
  it("writes the receipt atomically under the generated directory of the run", async () => {
    const snapshot = await loadSnapshot()
    const wiki = tempDir()
    const written = value(
      await execute(
        Receipt,
        {
          runId: "run:1/../x",
          name: "deliver",
          receipt: { status: "done", commit: "abc" }
        },
        snapshot,
        { wiki }
      )
    )
    expect(written.path).toBe("Org/Runs/run-1-..-x/deliver.json")
    const text = readFileSync(join(wiki, written.path), "utf8")
    expect(JSON.parse(text)).toEqual({ status: "done", commit: "abc" })
    expect(readdirSync(join(wiki, "Org/Runs/run-1-..-x"))).toEqual(["deliver.json"])
    const again = value(
      await execute(Receipt, { runId: "run:1/../x", name: "deliver", receipt: { status: "failed" } }, snapshot, {
        wiki
      })
    )
    expect(again.digest).not.toBe(written.digest)
    expect(JSON.parse(readFileSync(join(wiki, again.path), "utf8"))).toEqual({ status: "failed" })
    expect(Actions.runDirectory(".hidden")).toBe("-hidden")
    expect(Actions.executionOfWorkspace("run-1/example/demo/build")).toBe("run-1")
  })

  it("refuses a generated directory that escapes the wiki root, and a directory it cannot write", async () => {
    const snapshot = await loadSnapshot()
    const wiki = tempDir()
    mkdirSync(join(wiki, "Org"))
    symlinkSync(tempDir(), join(wiki, "Org", "Runs"))
    const escaped = failureOf(await execute(Receipt, { runId: "r", name: "x", receipt: {} }, snapshot, { wiki }))
    expect(escaped).toMatchObject({ message: "Org/Runs/r/x.json resolves outside the wiki root" })
    const blocked = tempDir()
    mkdirSync(join(blocked, "Org", "Runs", "r", "x.json"), { recursive: true })
    const notFile = failureOf(
      await execute(Receipt, { runId: "r", name: "x", receipt: {} }, snapshot, { wiki: blocked })
    )
    expect(notFile).toMatchObject({ message: "Org/Runs/r/x.json could not be renamed into place" })
    expect(readdirSync(join(blocked, "Org", "Runs", "r"))).toEqual(["x.json"])
    const missing = failureOf(
      await execute(Receipt, { runId: "r", name: "x", receipt: {} }, snapshot, { wiki: join(blocked, "absent") })
    )
    expect(missing).toMatchObject({ message: "Org/Runs/r/x.json the wiki root could not be resolved" })
  })
})

const step = <P extends Schema.Struct.Fields, A extends Schema.Top>(
  name: string,
  payload: P,
  success: A,
  call: (payload: Schema.Struct<P>["Type"]) => any
) => Flow.make(`test/${name}`, { payload, success, error: Workspace.WorkspaceError, body: call })

const Prepare = step(
  "prepare",
  { repository: Schema.String, commit: Schema.String },
  Workspace.Prepared,
  (payload) => Actions.PrepareWorkspace.call({ repository: payload.repository, commit: payload.commit, slug: "build" })
)
const PrepareChecking = step(
  "prepare-checking",
  { repository: Schema.String, commit: Schema.String, patch: Schema.String },
  Workspace.Prepared,
  (payload) => Actions.PrepareWorkspace.call({ ...payload, slug: "check-1" })
)
const Resolve = step(
  "resolve",
  { repository: Schema.String, commit: Schema.String },
  Schema.Struct({ ref: Schema.String, commit: Workspace.CommitId, fetched: Schema.Boolean }),
  (payload) => Actions.ResolveBase.call(payload)
)
const Collect = step(
  "collect",
  { workspace: Workspace.Prepared },
  Workspace.Diff,
  (payload) => Actions.CollectDiff.call(payload)
)
const Check = step(
  "check",
  { repository: Schema.String, commit: Workspace.CommitId, patch: Schema.String },
  Workspace.Checks,
  (payload) => Actions.RunChecks.call({ ...payload, checks: [{ name: "readme", argv: ["test", "-f", "README.md"] }] })
)
const Apply = step(
  "apply",
  { repository: Schema.String, parent: Workspace.CommitId, patch: Schema.String },
  Workspace.Applied,
  (payload) =>
    Actions.ApplyChange.call({
      ...payload,
      branch: "smithers/empty",
      message: "Nothing to change",
      principal: "builder",
      at: 1_790_000_000_000
    })
)
const Dispose = step(
  "dispose",
  { workspace: Workspace.Prepared },
  Schema.Void,
  (payload) => Actions.DisposeWorkspace.call(payload)
)

describe("workspace steps", () => {
  it("prepare under the execution's key, collect, check, land, and dispose by repository name", async () => {
    const snapshot = await loadSnapshot()
    const { repo, commit } = fixtureRepo()
    const options = { repo, machines: hostMachines().machines }
    const prepared = value(
      await execute(Prepare, { repository: "example/demo", commit: "main" }, snapshot, {
        ...options,
        executionId: "exec-7"
      })
    )
    expect(value(await execute(Resolve, { repository: "example/demo", commit: "HEAD" }, snapshot, options))).toEqual({
      ref: "HEAD",
      commit,
      fetched: false
    })
    expect(prepared.key).toBe("exec-7/example/demo/build")
    expect(prepared.commit).toBe(commit)
    const diff = value(await execute(Collect, { workspace: prepared }, snapshot, options))
    expect(diff).toMatchObject({ patch: "", files: [] })
    // No check passes on nothing: an empty change fails the `change` check
    // without booting a machine.
    const unchecked = value(
      await execute(Check, { repository: "example/demo", commit, patch: diff.patch }, snapshot, options)
    )
    expect(unchecked).toEqual(Actions.unchanged(commit))
    expect(unchecked.passed).toBe(false)
    expect(unchecked.receipts).toMatchObject([{ name: "change", exitCode: 1 }])
    const patch = git(repo, "diff", "--binary", commit, "--", "README.md") +
      "diff --git a/NOTES.md b/NOTES.md\nnew file mode 100644\n--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1 @@\n+notes\n"
    const checks = value(await execute(Check, { repository: "example/demo", commit, patch }, snapshot, options))
    expect(checks.passed).toBe(true)
    expect(checks.receipts.map((receipt: Workspace.CheckReceipt) => receipt.name)).toEqual(["readme"])
    const applied = value(
      await execute(Apply, { repository: "example/demo", parent: commit, patch: diff.patch }, snapshot, {
        ...options,
        executionId: "exec-8"
      })
    )
    expect(applied).toMatchObject({ branch: "smithers/empty", parent: commit, created: true })
    expect(git(repo, "log", "-1", "--format=%B", applied.commit)).toContain("Smithers-Run: exec-8")
    value(await execute(Dispose, { workspace: prepared }, snapshot, options))
    expect(existsSync(prepared.workdir)).toBe(false)
  })

  it("prepares a checker's workspace with the collected change applied", async () => {
    const snapshot = await loadSnapshot()
    const { repo, commit } = fixtureRepo()
    const options = { repo, machines: hostMachines().machines, executionId: "exec-9" }
    const patch = git(repo, "diff", "--binary", commit, commit) + ""
    const checking = value(
      await execute(PrepareChecking, { repository: "example/demo", commit, patch }, snapshot, options)
    )
    expect(checking.key).toBe("exec-9/example/demo/check-1")
    expect(value(await execute(Collect, { workspace: checking }, snapshot, options))).toMatchObject({ files: [] })
  })

  it("refuses a repository the host does not configure", async () => {
    const snapshot = await loadSnapshot()
    const other = "example/other"
    const zero = "0".repeat(40)
    for (
      const [flow, payload] of [
        [Prepare, { repository: other, commit: "main" }],
        [Check, { repository: other, commit: zero, patch: "" }],
        [Apply, { repository: other, parent: zero, patch: "" }]
      ] as const
    ) {
      expect(failureOf(await execute(flow as never, payload, snapshot))).toMatchObject({
        code: "invalid-request",
        message: "repository example/other is not configured"
      })
    }
  })
})

describe("reviewHandler refusals", () => {
  const request: Gates.ReviewRequest = {
    gateId: "ship-review",
    reviewer: "checker",
    boundary: "release",
    target: "test/deliver",
    revision: "r1",
    subject: { diff: "+x" }
  }

  const review = async (
    implementation: ((payload: unknown) => Effect.Effect<unknown, unknown>) | undefined,
    subject: unknown = request.subject
  ) => {
    const snapshot = await loadSnapshot()
    return Effect.runPromise(
      Effect.gen(function*() {
        if (implementation !== undefined) {
          yield* (yield* Action.Implementations).add({ name: Authority.roleTaskTag, action: implementation as never })
        }
        return yield* Actions.reviewHandler()({ ...request, subject: subject as never })
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Authority.layerRegistry(snapshot), Action.layerImplementations)),
        Effect.flip
      ) as Effect.Effect<Gates.ReviewFailed>
    )
  }

  const verdict = async (result: unknown) => {
    const snapshot = await loadSnapshot()
    return Effect.runPromise(
      Effect.gen(function*() {
        yield* (yield* Action.Implementations).add({
          name: Authority.roleTaskTag,
          action: () => Effect.succeed(result)
        })
        return yield* Actions.reviewHandler()(request)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Authority.layerRegistry(snapshot), Action.layerImplementations))
      ) as Effect.Effect<Gates.ReviewVerdict, Gates.ReviewFailed>
    )
  }

  it("fails without a role task, with a failing one, with a malformed result, or an oversized subject", async () => {
    expect((await review(undefined)).message).toBe("no organization/role-task is registered")
    expect((await review(() => Effect.fail(new Error("the model is down")))).message).toBe(
      "the review did not complete: the model is down"
    )
    expect((await review(() => Effect.succeed({ status: "maybe" }))).message).toBe(
      "the review returned a malformed result"
    )
    expect(
      (await review(() => Effect.succeed(done({ verdict: "approve", findings: "x" })), { blob: "x".repeat(60_000) }))
        .message
    )
      .toContain("the cap is 49152")
  })

  it("requests changes when the reviewer did not finish", async () => {
    const blocked: Profile.RoleResult = { ...done({}), status: "blocked", evidence: [] }
    expect(await verdict(blocked)).toEqual({ decision: "request-changes", reason: "Done.", reviewer: "checker" })
    expect(await verdict(done({ verdict: "approve", findings: "none" }))).toMatchObject({ decision: "approve" })
  })
})
