import { WebCrypto } from "@smthrs/crypto"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { expect, test } from "vitest"
import { runFlow } from "../worker/test/flowHost"
import { RunCredentials } from "../src/flows/credentials"
import { IssueCommitment, IssueTriage, IssueWriteRefused, TriageEnable, TriageRunAgain } from "../src/features/issues/flows"
import { registration as issueRegistration, TabIssues } from "../src/features/issues/steps"
import { TodoDrop, TodoRetry, TodoStepRefused } from "../src/features/todos/flows"
import { registration as todoRegistration, TabTodos } from "../src/features/todos/steps"

const errorOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

test("registered issue flows preserve their operation and report a refused tab admission", async () => {
  const seen: Array<{ id: string; op: string; number: number; commitment?: string; decision?: string; dailyTokens?: number }> = []
  const refusal = Layer.succeed(TabIssues, TabIssues.of({ queue: ({ write }) => Effect.sync(() => {
    seen.push(write)
    return Option.some({ door: "button" as const, queued: false })
  }) }))
  const registration = issueRegistration.pipe(Layer.provide(Layer.mergeAll(refusal,
    Layer.succeed(RunCredentials, RunCredentials.of({ bearer: Effect.succeedNone })), WebCrypto.layer)))
  const results = await Promise.all([
    runFlow(IssueCommitment, { repo: "octo/hello", number: 7, commitment: "next" }, registration, { maxConnections: 1 }),
    runFlow(IssueTriage, { repo: "octo/hello", number: 7, decision: "accept" }, registration, { maxConnections: 1 }),
    runFlow(TriageEnable, { repo: "octo/hello", dailyTokens: 1234 }, registration, { maxConnections: 1 }),
    runFlow(TriageRunAgain, { repo: "octo/hello", number: 7 }, registration, { maxConnections: 1 }),
  ])
  for (const result of results) expect(errorOf(result.exit)).toEqual(new IssueWriteRefused({ reason: "not_admitted" }))
  for (const expected of [
    { op: "issue/commitment", number: 7, commitment: "next" },
    { op: "issue/triage", number: 7, decision: "accept" },
    { op: "triage/run", number: 7 },
    { op: "triage/enable", number: 0, dailyTokens: 1234 },
  ]) {
    const attempts = seen.filter(write => write.op === expected.op)
    expect(attempts.length).toBeGreaterThan(0)
    for (const attempt of attempts) expect(attempt).toMatchObject(expected)
    expect(new Set(attempts.map(write => write.id)).size).toBe(1)
  }
}, 60_000)

test("registered TODO retry and drop preserve their operation and report refused admission", async () => {
  const seen: Array<{ op: string; number?: number }> = []
  const refusal = Layer.succeed(TabTodos, TabTodos.of({ ask: ({ call }) => Effect.sync(() => {
    if (call.kind === "queue") seen.push(call.op)
    return Option.some({ door: "button" as const, kept: false })
  }) }))
  const registration = todoRegistration.pipe(Layer.provide(Layer.mergeAll(refusal, WebCrypto.layer)))
  const retry = await runFlow(TodoRetry, { repo: "octo/hello", number: 7 }, registration)
  const drop = await runFlow(TodoDrop, { repo: "octo/hello", number: 7 }, registration)
  for (const result of [retry, drop]) expect(errorOf(result.exit)).toEqual(new TodoStepRefused({ reason: "not_kept" }))
  expect(seen).toMatchObject([{ op: "retry", number: 7 }, { op: "drop", number: 7 }])
}, 60_000)
