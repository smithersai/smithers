import { WebCrypto } from "@smthrs/crypto"
import { FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Cause, Effect, Exit, Layer, Metric, Option } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { describe, expect, test } from "vitest"
import { ASK_RETRY, TodoStepRefused } from "./flows"
import { drafts, queued } from "./metrics"
import type { TodosCall } from "./schema"
import { keepDraft, queueChange, TabTodos } from "./steps"

// The TODO steps where no real tab answers: the step runs here as its engine runs it, in the run its execution id
// names; the retry policy is the engine's. Every step a tab answers runs on a real engine in todos.test.ts.

/** The person's own press, and the agent's call in an answer (src/flows/catalog.ts `childExecutionId`). */
const PERSON = "8a7f0c2e-5d1b-4c4a-9a43-0f2a1f7e9b10"
const AGENT = "answer-1/chat/Respond@abc:1/call/1.0"

/** Runs `step` as execution `executionId`, its tabs reached through `tabs`, counting into `registry`. */
const run = <A, E>(
  step: Effect.Effect<A, E, FlowRuntime.FlowInstance | TabTodos | EffectDigest.Digest>,
  executionId: string,
  tabs: Layer.Layer<TabTodos>,
  registry: Metric.MetricRegistry
) =>
  Effect.runPromise(
    Effect.exit(
      step.pipe(
        // Only the execution id is read.
        Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]),
        Effect.provide(tabs),
        Effect.provide(WebCrypto.layer),
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    )
  )

/** No tab listens on this engine's channel (Node's own `BroadcastChannel`): the tab that asked is gone. */
const noTab = TabTodos.layerChannel({ name: `none-${crypto.randomUUID()}`, within: "100 millis" }).pipe(
  Layer.provide(TabChannel.layer)
)

/** A tab that answers every call with `kept`, through a button, recording what it was asked; `missing` its issue. */
const recordingTab = (kept: boolean, missing = false) => {
  const asked: Array<{ readonly requester: string; readonly call: TodosCall }> = []
  return {
    asked,
    layer: Layer.succeed(
      TabTodos,
      TabTodos.of({
        ask: (call) =>
          Effect.sync(() => {
            asked.push(call)
            return Option.some({ door: "button" as const, kept, missing })
          })
      })
    )
  }
}

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const count = (registry: Metric.MetricRegistry, metric: typeof queued, attributes: Record<string, string>) =>
  Effect.runSync(
    Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))
  ).count

const commit = queueChange({ op: "commit", repo: "octo/hello", title: " T ", prompt: "P" })

describe("the agent's door", () => {
  test("a commit or drop that is the agent's call is refused before any tab is asked", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(true)
    expect(failure(await run(commit, AGENT, tab.layer, registry))).toEqual(new TodoStepRefused({ reason: "agent" }))
    const dropping = queueChange({ op: "drop", repo: "octo/hello", number: 2 })
    expect(failure(await run(dropping, AGENT, tab.layer, registry))).toEqual(new TodoStepRefused({ reason: "agent" }))
    expect(tab.asked).toEqual([])
    expect(count(registry, queued, { op: "commit", door: "agent", outcome: "agent" })).toBe(1)
    expect(count(registry, queued, { op: "drop", door: "agent", outcome: "agent" })).toBe(1)
  })

  test("a person's press asks its tab, with an op id the same run always names", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(true)
    const first = await run(commit, PERSON, tab.layer, registry)
    const again = await run(commit, PERSON, tab.layer, registry)
    expect(Exit.isSuccess(first) && first.value).toEqual({ opId: expect.any(String), status: "requested" })
    expect(Exit.isSuccess(again) && again.value).toEqual(Exit.isSuccess(first) && first.value)
    expect(tab.asked[0]).toEqual({
      requester: PERSON,
      call: {
        kind: "queue",
        op: {
          id: expect.any(String),
          repo: "octo/hello",
          op: "commit",
          title: "T",
          prompt: "P",
          acceptance: [],
          number: 0
        }
      }
    })
    expect(count(registry, queued, { op: "commit", door: "button", outcome: "kept" })).toBe(2)
  })

  test("the agent drafts: its draft remembers the answer it belongs to", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(true)
    const exit = await run(
      keepDraft({ repo: "octo/hello", prompt: "Do it", title: " Short " }),
      AGENT,
      tab.layer,
      registry
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      draftId: expect.any(String),
      status: "drafted",
      path: "/octo/hello/stack"
    })
    expect(tab.asked[0]!.call).toEqual({
      kind: "draft",
      draft: expect.objectContaining({
        title: "Short",
        answerId: "answer-1",
        repoId: "github/octo/hello",
        acceptance: []
      })
    })
    expect(count(registry, drafts, { door: "agent", outcome: "kept" })).toBe(1)
  })
})

describe("no tab answers, or it doesn't keep it", () => {
  test("a person's commit: the tab is gone, by an unknown door", async () => {
    const registry: Metric.MetricRegistry = new Map()
    expect(failure(await run(commit, PERSON, noTab, registry))).toEqual(new TodoStepRefused({ reason: "tab_gone" }))
    expect(count(registry, queued, { op: "commit", door: "unknown", outcome: "tab_gone" })).toBe(1)
  })

  test("a draft or change the tab couldn't keep is refused not_kept", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(false)
    expect(failure(await run(keepDraft({ repo: "octo/hello", prompt: "x" }), PERSON, tab.layer, registry)))
      .toEqual(new TodoStepRefused({ reason: "not_kept" }))
    expect(failure(await run(commit, PERSON, tab.layer, registry))).toEqual(new TodoStepRefused({ reason: "not_kept" }))
    expect(count(registry, drafts, { door: "button", outcome: "not_kept" })).toBe(1)
  })
})

describe("a draft from an issue", () => {
  test("names the issue and leaves out what the tab fills from it; a title or prompt passed goes as passed", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(true)
    const exit = await run(keepDraft({ repo: "octo/hello", issue: 7 }), PERSON, tab.layer, registry)
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      draftId: expect.any(String),
      status: "drafted",
      path: "/octo/hello/stack"
    })
    expect(tab.asked[0]!.call).toEqual({
      kind: "draft",
      draft: expect.objectContaining({ title: "", prompt: "", issue: 7, answerId: null, repoId: "github/octo/hello" })
    })
    await run(keepDraft({ repo: "octo/hello", issue: 7, prompt: "## Better\n\nRefined." }), AGENT, tab.layer, registry)
    expect(tab.asked[1]!.call).toEqual({
      kind: "draft",
      draft: expect.objectContaining({
        title: "Better",
        prompt: "## Better\n\nRefined.",
        issue: 7,
        answerId: "answer-1"
      })
    })
    expect(count(registry, drafts, { door: "button", outcome: "kept" })).toBe(1)
    expect(count(registry, drafts, { door: "agent", outcome: "kept" })).toBe(1)
  })

  test("a draft without an issue names none", async () => {
    const tab = recordingTab(true)
    await run(keepDraft({ repo: "octo/hello", prompt: "x" }), PERSON, tab.layer, new Map())
    expect(tab.asked[0]!.call.kind === "draft" && "issue" in tab.asked[0]!.call.draft).toBe(false)
  })

  test("a device without the issue: refused issue_not_found, and counted so", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(false, true)
    expect(failure(await run(keepDraft({ repo: "octo/hello", issue: 99 }), PERSON, tab.layer, registry)))
      .toEqual(new TodoStepRefused({ reason: "issue_not_found" }))
    expect(count(registry, drafts, { door: "button", outcome: "issue_not_found" })).toBe(1)
  })

  test("a commit carries the issue it was made from; one without names none", async () => {
    const tab = recordingTab(true)
    await run(
      queueChange({ op: "commit", repo: "octo/hello", title: "T", prompt: "P", issue: 7 }),
      PERSON,
      tab.layer,
      new Map()
    )
    await run(commit, `${PERSON}-2`, tab.layer, new Map())
    expect(tab.asked.map(({ call }) => call.kind === "queue" && call.op.issue)).toEqual([7, undefined])
  })
})

test("permanent TODO refusals stop on the first attempt; transport failures retry", () => {
  for (const reason of ["agent", "issue_not_found", "not_kept", "tab_gone"] as const) {
    expect(RetryPolicy.decide(ASK_RETRY, { attempt: 1, error: new TodoStepRefused({ reason }) })).toEqual({
      _tag: "GiveUp",
      reason: "nonRetryable"
    })
  }
  expect(RetryPolicy.decide(ASK_RETRY, { attempt: 1, error: { _tag: "TransportUnavailable" } })).toEqual({
    _tag: "RetryAfter",
    delayMs: 1000
  })
})

test("the agent retries through the same durable queue and replays the same press id", async () => {
  const registry: Metric.MetricRegistry = new Map()
  const tab = recordingTab(true)
  const retry = queueChange({ op: "retry", repo: "octo/hello", number: 1 })
  const first = await run(retry, AGENT, tab.layer, registry)
  const again = await run(retry, AGENT, tab.layer, registry)
  expect(Exit.isSuccess(first)).toBe(true)
  expect(again).toEqual(first)
  expect(tab.asked[0]!.call).toMatchObject({ kind: "queue", op: { op: "retry", number: 1 } })
  expect(tab.asked[1]!.call).toEqual(tab.asked[0]!.call)
})
