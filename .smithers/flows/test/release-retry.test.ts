import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as RunInspection from "@smthrs/engine-store/RunInspection"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"
import * as Content from "../release-content/workflow.ts"
import { type Candidate, ReleaseError } from "../release-support/schema.ts"
import ReleaseFlow from "../release/flow.ts"
import * as Release from "../release/workflow.ts"
import { releaseInput, repository } from "./fixtures.ts"

test("a release that fails at smoke retries from smoke and replays every earlier step", {
  timeout: 90_000
}, async (test) => {
  const fixture = await repository(test)
  const filename = join(fixture.root, ".flows", "engine.db")
  const calls: string[] = []
  let smokeFails = true
  const candidate: Candidate = {
    directory: ".flows/releases/npm/test",
    digest: "sha512-tested",
    sourceSha: fixture.evidence.sourceSha,
    version: fixture.evidence.version,
    packageCount: 49,
    approvalPrompt: "Publish the 49 exact tested packages?"
  }
  const note = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name)
      return value
    })
  // The engine a Smithers host runs the flow on, with the release steps replaced by recorded ones.
  const engine = () =>
    NodeRuntime.layerHost(
      { filename, workspaceRoot: fixture.root, owner: { hostId: "release-retry-test" }, signals: [] },
      Layer.mergeAll(
        Release.AuditDocs.toLayer(() => note("audit", { passed: true, missing: [], explanation: "covered" })),
        Release.PreparePlan.toLayer(() => Effect.die("must not prepare during publication")),
        Release.WritePreparation.toLayer(() => Effect.die("must not write preparation during publication")),
        Content.Collect.toLayer(() => note("collect", fixture.evidence)),
        Release.Validate.toLayer(() => note("validate", fixture.evidence)),
        Release.Checks.toLayer(() => note("checks", fixture.evidence)),
        Release.Build.toLayer(() => note("build", fixture.evidence)),
        Release.Pack.toLayer(() => note("pack", candidate)),
        Release.Smoke.toLayer(() =>
          Effect.flatMap(
            note("smoke", candidate),
            (value) =>
              smokeFails
                ? Effect.fail(new ReleaseError({ step: "smoke", message: "registry unreachable" }))
                : Effect.succeed(value)
          )
        ),
        Release.VerifyCandidate.toLayer(() => note("verify", candidate)),
        Release.Publish.toLayer(() => Effect.die("a dry run must not publish")),
        Release.Outcome.toLayer(Effect.succeed),
        HumanTask.layer,
        Interpreter.layer(ReleaseFlow)
      ).pipe(Layer.provideMerge(Action.layerImplementations))
    )
  const inspect = (runId: string) =>
    Effect.runPromise(Effect.scoped(
      Effect.flatMap(RunInspection.RunInspection, (inspection) => inspection.inspect(runId)).pipe(
        Effect.provide(
          RunInspection.layer.pipe(
            Layer.provideMerge(NodeRuntime.storage(filename, fixture.root)),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
          )
        )
      )
    ))
  const rows = (inspection: RunInspection.Inspection) =>
    inspection.steps.flatMap((step) =>
      step.kind === "ActionCall" && step.action !== null ? [[step.action, step.status, step.attempts.length]] : []
    )

  const input = releaseInput(
    { phase: "publish", from: "v0.35.0", requireContentApproval: false },
    fixture.evidence.version
  )
  await assert.rejects(
    Effect.runPromise(Effect.scoped(ReleaseFlow.execute(input, { executionId: "rc" }).pipe(Effect.provide(engine())))),
    /registry unreachable/
  )
  assert.deepEqual(calls, ["collect", "audit", "validate", "checks", "build", "pack", "smoke"])
  const failed = await inspect("rc")
  const smoke = failed.steps.find((step) => step.action === "release/smoke")!.nodeId

  // The cause was outside the source tree and is gone: a new run starts at smoke.
  smokeFails = false
  calls.length = 0
  const retried = await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const id = yield* ReleaseFlow.retryFrom("rc", { step: smoke, executionId: "rc-2" })
      return yield* ReleaseFlow.execute(input, { executionId: id })
    }).pipe(Effect.provide(engine()))
  ))
  assert.equal(retried.status, "preview")
  assert.deepEqual(calls, ["smoke", "verify"], "every step before smoke replays from the failed run")
  assert.deepEqual(rows(await inspect("rc-2")).slice(6), [
    ["release/smoke", "completed", 1],
    ["release/verify-candidate", "completed", 1],
    ["release/outcome", "completed", 1]
  ])
  // The failed run is a record, not a draft: the retry left it as it was.
  assert.deepEqual(rows(await inspect("rc")), rows(failed))
})
