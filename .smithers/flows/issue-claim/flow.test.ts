/**
 * `issue-claim` through the flow API: the real graph, the real layer and a
 * real child process running `issue-claim.mjs`. The failure case is the
 * module's own refusal of a malformed issue reference, before any GitHub call.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import IssueClaim, { argv, layer, Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    IssueClaim.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(IssueClaim, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ command: "check", issue: "smithers#1" }), ["check", "smithers#1"])
  assert.deepEqual(argv({ command: "claim", issue: "o/r#2", by: "agent/one", note: "why" }), [
    "claim",
    "o/r#2",
    "--by",
    "agent/one",
    "--note",
    "why"
  ])
  assert.deepEqual(
    argv({
      command: "comment",
      issue: "o/r#3",
      bodyFile: "receipt.md",
      close: true,
      landed: "abc",
      receipts: ["a.json", "b.json"],
      release: true,
      force: true
    }),
    [
      "comment",
      "o/r#3",
      "--force",
      "--body-file",
      "receipt.md",
      "--close",
      "--landed",
      "abc",
      "--receipt",
      "a.json",
      "--receipt",
      "b.json",
      "--release"
    ]
  )
  assert.deepEqual(
    argv({ command: "comment", issue: "o/r#4", close: true, reason: "duplicate", note: "#5", pr: true }),
    [
      "comment",
      "o/r#4",
      "--note",
      "#5",
      "--close",
      "--reason",
      "duplicate",
      "--pr"
    ]
  )
})

test("a malformed issue reference is the module's typed refusal, before any GitHub call", async () => {
  const exit = await run({ command: "check", issue: "not-an-issue" }, "issue-claim-malformed")
  assert.ok(Exit.isFailure(exit))
  const failure = JSON.stringify(exit.cause)
  assert.match(failure, /automation\/ModuleFailed/)
  assert.match(failure, /flows\/issue-claim\/issue-claim\.mjs/)
  assert.match(failure, /"exitCode":1/)
})
