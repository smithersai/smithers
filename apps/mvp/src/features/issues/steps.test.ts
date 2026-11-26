import { WebCrypto } from "@smthrs/crypto"
import { FlowRuntime } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Cause, Effect, Exit, Metric, Option } from "effect"
import { describe, expect, test } from "vitest"
import * as RunCredentials from "../../flows/credentials.vibe"
import { IssueWriteRefused } from "./flows.vibe"
import { writes } from "./metrics"
import { queueWrite, TabIssues } from "./steps.vibe"

// An issue write's step when no tab answers on the engine's issues channel (Node's own `BroadcastChannel`): the tab that
// asked is gone. The step runs here as its engine runs it, in the run its execution id names; the retry policy, which
// asks again for 30 s, is the engine's. Who the run acts as is its engine's run credentials' to say, given here: the
// person's press has none, a run that isn't one has its credential, and one with no credential to send queues nothing.
// Every step a tab answers, with the engine's real credentials, runs on a real engine in issues.test.ts.

/** The run credentials of a run that is the person's press, has `token`, or can't have one (`reason`). */
const acting = (as: { readonly token?: string; readonly reason?: string } = {}) =>
  RunCredentials.RunCredentials.of({
    bearer: as.reason !== undefined
      ? Effect.fail(new RunCredentials.CredentialUnavailable({ reason: as.reason }))
      : Effect.succeed(Option.fromNullishOr(as.token)),
  })

/** The step for `executionId`, as `credentials` say it acts, asking a channel no tab listens on, counting into `registry`. */
const run = (
  executionId: string,
  registry: Metric.MetricRegistry,
  credentials: RunCredentials.RunCredentials["Service"] = acting(),
) =>
  Effect.runPromise(
    Effect.exit(
      queueWrite({ op: "issue/comment", repo: "octo/hello", number: 7, body: "Hi" }).pipe(
        // Only the execution id is read.
        Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]),
        Effect.provideService(RunCredentials.RunCredentials, credentials),
        Effect.provide(TabIssues.layerChannel({ name: `none-${crypto.randomUUID()}`, within: "100 millis" })),
        Effect.provide(TabChannel.layer),
        Effect.provide(WebCrypto.layer),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ),
  )

/** How the step failed: its declared error, if any. */
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const count = (registry: Metric.MetricRegistry, attributes: Record<string, string>) =>
  Effect.runSync(
    Metric.value(Metric.withAttributes(writes, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  ).count

describe("no tab answers", () => {
  test("a person's press: the tab is gone, by an unknown door", async () => {
    const registry: Metric.MetricRegistry = new Map()
    expect(failure(await run(crypto.randomUUID(), registry))).toEqual(new IssueWriteRefused({ reason: "tab_gone" }))
    expect(count(registry, { op: "issue/comment", door: "unknown", outcome: "tab_gone" })).toBe(1)
  })

  test("the agent's call: the tab is gone, by the agent's door", async () => {
    const registry: Metric.MetricRegistry = new Map()
    expect(failure(await run("answer-1/chat/Respond@abc:1/call/1.0", registry, acting({ token: "t" })))).toEqual(
      new IssueWriteRefused({ reason: "tab_gone" }),
    )
    expect(count(registry, { op: "issue/comment", door: "agent", outcome: "tab_gone" })).toBe(1)
  })

  test("a run with no credential to send queues nothing: never in the person's session", async () => {
    const registry: Metric.MetricRegistry = new Map()
    expect(failure(await run("retry:x:1", registry, acting({ reason: "person_only" })))).toEqual(
      new IssueWriteRefused({ reason: "no_credential" }),
    )
    expect(count(registry, { op: "issue/comment", door: "unknown", outcome: "no_credential" })).toBe(1)
  })
})
