import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"
import * as Content from "../release-content/workflow.vibe"
import { type Host, main } from "../release-support/main.ts"
import { inspect, readLayer, retryStep, type StepTiming } from "../release-support/retry.ts"
import { type Candidate, ReleaseError } from "../release-support/schema.vibe"
import ReleaseFlow from "../release/flow.ts"
import * as Release from "../release/workflow.vibe"
import { repository } from "./fixtures.ts"

test("a release that fails at smoke retries from smoke, and status reports each step's timing", {
  timeout: 90_000
}, async (test) => {
  const fixture = await repository(test)
  const calls: string[] = []
  const written: string[] = []
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
  // The command's own host, with the release steps replaced by recorded ones.
  const host: Host = {
    root: fixture.root,
    write: (text) => void written.push(text),
    runtime: (options) => {
      const engine = NodeRuntime.layerHost(
        {
          filename: options.filename,
          workspaceRoot: options.root,
          owner: { hostId: "release-retry-test" },
          signals: []
        },
        Layer.mergeAll(
          Release.AuditDocs.toLayer(() => note("audit", { passed: true, missing: [], explanation: "covered" })),
          Release.PreparePlan.toLayer(() => Effect.die("must not prepare during publication")),
          Release.WritePreparation.toLayer(() => Effect.die("must not write preparation during publication")),
          Content.Collect.toLayer(() => note("collect", fixture.evidence)),
          Release.Validate.toLayer(() => note("validate", fixture.evidence)),
          Release.Checks.toLayer(() => note("checks", fixture.evidence)),
          Release.Build.toLayer(() => note("build", fixture.evidence).pipe(Effect.delay(60))),
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
      // Only the release flow is registered: these commands never ask for a content step.
      return engine as unknown as ReturnType<Host["runtime"]>
    }
  }
  const output = async (...argv: string[]) => {
    written.length = 0
    await main(argv, host)
    return JSON.parse(written.at(-1)!)
  }
  const rows = (steps: ReadonlyArray<StepTiming>) => steps.map((row) => [row.step, row.status, row.attempts])

  const input = JSON.stringify({ phase: "publish", from: "v0.35.0", requireContentApproval: false })
  await assert.rejects(main(["release", "--run", "rc", "--input", input], host), /registry unreachable/)
  assert.deepEqual(calls, ["collect", "audit", "validate", "checks", "build", "pack", "smoke"])

  const failed = await output("status", "rc")
  assert.equal(failed.status, "failed")
  assert.equal(failed.failure.action, "release/smoke")
  assert.equal(failed.retry, undefined)
  const steps: ReadonlyArray<StepTiming> = failed.steps
  assert.deepEqual(rows(steps), [
    ["release-content/collect", "completed", 1],
    ["release/audit-documentation", "completed", 1],
    ["release/validate", "completed", 1],
    ["release/checks", "completed", 1],
    ["release/build", "completed", 1],
    ["release/pack", "completed", 1],
    ["release/smoke", "failed", 1],
    ["release/verify-candidate", "skipped", 0],
    ["release/outcome", "skipped", 0]
  ])
  const ran = steps.slice(0, 7)
  assert.ok(ran.every((row) => !Number.isNaN(Date.parse(row.startedAt!)) && row.durationMs! >= 0))
  // Only build waits, so a step's time is its own and not the time since the run began.
  assert.ok(steps[4]!.durationMs! >= 60)
  assert.ok(steps[5]!.durationMs! < 60 && steps[6]!.durationMs! < 60)
  assert.deepEqual(steps.slice(7).map((row) => [row.startedAt, row.durationMs]), [[null, null], [null, null]])
  const smoke = steps[6]!.nodeId

  // The cause was outside the source tree and is gone: a new run starts at smoke.
  smokeFails = false
  calls.length = 0
  const retried = await output("release", "--retry", "rc", "--run", "rc-2")
  assert.equal(retried.result.status, "preview")
  assert.deepEqual(calls, ["smoke", "verify"])
  const second = await output("status", "rc-2")
  assert.equal(second.status, "completed")
  assert.deepEqual(second.retry, { of: "rc", step: smoke, store: "rc" })
  assert.equal(second.failure, undefined)
  assert.deepEqual(second.steps.slice(0, 6), steps.slice(0, 6), "replayed steps keep the timing they ran with")
  assert.deepEqual(rows(second.steps).slice(6), [
    ["release/smoke", "completed", 1],
    ["release/verify-candidate", "completed", 1],
    ["release/outcome", "completed", 1]
  ])
  // The failed run is a record, not a draft: the retry left it as it was.
  assert.deepEqual(await output("status", "rc"), failed)

  // Reopening the retry, or asking for the same retry again, joins it and runs nothing.
  assert.deepEqual(await output("release", "--resume", "rc-2"), retried)
  assert.deepEqual(await output("release", "--retry", "rc", "--from", "release/smoke", "--run", "rc-2"), retried)
  assert.deepEqual(calls, ["smoke", "verify"])

  // A retry of a retry names a step by action or node id and stays in the first run's database.
  calls.length = 0
  await output("release", "--retry", "rc-2", "--from", "release/verify-candidate", "--run", "rc-3")
  assert.deepEqual(calls, ["verify"])
  assert.equal((await output("status", "rc-3")).retry.store, "rc")
  const third = await output("release", "--retry", "rc-2", "--from", second.steps[7].nodeId, "--run", "rc-4")
  assert.equal(third.result.status, "preview")

  calls.length = 0
  await assert.rejects(
    main(["release", "--retry", "rc", "--from", "release/publish"], host),
    /Run rc: no step release\/publish that ran; its steps are release-content\/collect, .*release\/smoke$/
  )
  await assert.rejects(main(["release", "--retry", "rc-2"], host), /Run rc-2: no failed step to retry from/)
  await assert.rejects(main(["release", "--retry", "rc", "--input", input], host), /--retry uses the stored input/)
  await assert.rejects(main(["release", "--resume", "rc-2", "--retry", "rc"], host), /--resume uses the stored input/)
  await assert.rejects(main(["release", "--from", "release/smoke"], host), /--from names the step a --retry/)
  await assert.rejects(main(["release-content", "--retry", "rc"], host), /different workflow/)
  await assert.rejects(main(["release", "--retry", "rc", "--run", "rc-3"], host), /already belongs to different/)
  assert.deepEqual(calls, [])

  // An action a run dispatched more than once is named by node id.
  const filename = join(fixture.root, ".flows/releases/runs/rc/engine.db")
  const source = await Effect.runPromise(
    Effect.scoped(inspect("rc").pipe(Effect.provide(readLayer(filename, fixture.root))))
  )
  const twice = {
    ...source,
    steps: [...source.steps, { ...source.steps.find((step) => step.nodeId === smoke)!, nodeId: "again" }]
  }
  const refused = await Effect.runPromise(Effect.flip(retryStep(twice, "release/smoke")))
  assert.equal(refused.message, `Run rc: release/smoke ran 2 times; name one node: ${smoke}, again`)
  assert.equal(await Effect.runPromise(retryStep(twice, "again")), "again")
})
