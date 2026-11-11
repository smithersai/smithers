// The review flow's rounds (.smithers/flows/review) on this app's engine: the engine the Node host composes over the
// compose Postgres (worker/test/flowHost.ts), as worker/Executions.ts does on Cloudflare. The change set comes from a
// GitHub comparison, as checks/Review reads it, through the flow's `comparisonSnapshot`; each file's review is
// a round of `ReviewFiles` handing off (`Flow.to`) to the next batch, then to `VerifyReview` and `NarrateReview`,
// different flows whose success is the first round's. The model behind the review seats is scripted, admitted and
// metered by the model endpoint's own `ModelEndpoint.local`: the only stand-in. The walkthrough is written with the
// flow's own file implementation into a temporary directory; a Worker has no filesystem and needs its own.
// The flow is imported by relative path because `@smithers/release-workflows` (.smithers/flows/package.json) declares
// no exports and no package depends on it; bench/cerebras-load/run.ts reaches its flow the same way. Production
// imports need a declared export first (#4590).
import { Agent, AgentAction, Budget, QuotaPolicy, Seat, SeatResolver } from "@smthrs/agent"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type { GitHub } from "@smthrs/integrations"
import { Evaluator, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { Registry } from "@smthrs/registry"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { comparisonSnapshot } from "../../../../.smithers/flows/review/src/github/comparisonSnapshot.ts"
import { preparedReviewOf } from "../../../../.smithers/flows/review/src/review/preparedReviewOf.ts"
import {
  applyVerdictsLayer,
  finalizeReviewLayer,
  mergeFileBatchLayer,
} from "../../../../.smithers/flows/review/src/workflow/reviewActions.ts"
import {
  NarrateChanges,
  ReviewFile,
  VerifyFindings,
} from "../../../../.smithers/flows/review/src/workflow/reviewAgentActions.ts"
import { ReviewFailure } from "../../../../.smithers/flows/review/src/workflow/reviewFailureSchema.ts"
import { NarrateReview, ReviewFiles, VerifyReview } from "../../../../.smithers/flows/review/src/workflow/reviewFlow.ts"
import { renderWalkthroughLayer } from "../../../../.smithers/flows/review/src/workflow/reviewHostActions.ts"
import { ReviewInput } from "../../../../.smithers/flows/review/src/workflow/reviewInputSchema.ts"
import { ReviewFilesPayload, ReviewResult } from "../../../../.smithers/flows/review/src/workflow/reviewSchemas.ts"
import { judgeSeat } from "../github/test/fixtures.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import type { Seat as EndpointSeat } from "../ModelEndpoint.ts"

const runtime = testFile("review_rounds")
const outputs = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-review-rounds-")))
afterAll(() => rmSync(outputs, { recursive: true, force: true }))

/** Two added files of two lines each, and a binary one, as GitHub's comparison lists them. */
const FILES: ReadonlyArray<GitHub.Commits.ChangedFile> = [
  { filename: "src/a.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+export const a = 1\n+export const a2 = a" },
  { filename: "src/b.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+export const b = 1\n+export const b2 = b" },
  { filename: "logo.png", status: "modified", additions: 0, deletions: 0 },
]

/** What each review seat asks, answered with one `cell` that settles the action: a major finding on line 2 of a file. */
const answer = (asked: Array<string>) => (request: ModelRequest.ModelRequest) => {
  const text = [...request.system.map((part) => part.text), ...request.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))].join("\n")
  const value = text.includes("adjudicate code-review findings")
    ? (asked.push("verify"), { verdicts: [0, 1].map((index) => ({ index, verdict: "keep", reason: "the diff shows it" })) })
    : (() => {
      const path = /src\/[ab]\.ts/.exec(text)?.[0] ?? ""
      asked.push(path)
      return {
        status: "success",
        message: "",
        summary: null,
        warnings: [],
        comments: [{
          path,
          content: "The second binding repeats the first.",
          severity: "major",
          category: "correctness",
          confidence: "confirmed",
          startLine: 2,
          endLine: 2,
          existingCode: "",
          suggestionCode: "",
          thinking: "",
        }],
      }
    })()
  return Stream.fromIterable<ModelEvent.ModelEvent>([
    { type: "text-delta", id: "t", text: "```cell\nctx.done(" + JSON.stringify(value) + ")\n```" },
    { type: "usage", inputTokens: 30, outputTokens: 10 },
    { type: "settle", stopReason: "stop" },
  ])
}

/** The review's seats, both answered by `seat`, the model endpoint's role in process. */
const seats = (seat: EndpointSeat) =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({ id, modelId: id, model: seat.model, route: seat.route, contextWindowTokens: 200_000 })),
  })

/** A parent that runs the rounds as one child execution, as a check would. */
const Parent = Flow.make("test/review-rounds-parent", {
  payload: ReviewFilesPayload,
  success: ReviewResult,
  error: ReviewFailure,
  body: (payload) => ReviewFiles.child(payload),
})

/** The rounds, their pure steps, their model steps over `seat`, and the walkthrough written to a file. */
const registration = (seat: EndpointSeat) =>
  Layer.mergeAll(
    Interpreter.layer(Parent),
    Interpreter.layer(ReviewFiles),
    Interpreter.layer(VerifyReview),
    Interpreter.layer(NarrateReview),
    mergeFileBatchLayer,
    finalizeReviewLayer,
    applyVerdictsLayer,
    renderWalkthroughLayer,
    ReviewFile.layer,
    VerifyFindings.layer,
    NarrateChanges.layer,
  ).pipe(
    Layer.provide(Layer.mergeAll(
      AgentAction.layerHost({ registry: Registry.makeNoop(), limits: { calls: 8 }, maxFrames: 4, capabilityEnvelope: [] }),
      seats(seat),
      Agent.layer,
    )),
    Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
    Layer.provide(Layer.mergeAll(Agent.layerDefaults, Evaluator.layerUnavailable())),
    Layer.provideMerge(Action.layerImplementations),
  )

/** The first round's payload: the comparison of `base` and `head` as the flow's change set, one file per round. */
const payloadOf = (out: string) => {
  const input = Schema.decodeUnknownSync(ReviewInput)({ concurrency: 1, narrate: false, out })
  const snapshot = comparisonSnapshot({
    input,
    repository: "acme/widgets",
    base: "a".repeat(40),
    head: "b".repeat(40),
    files: FILES,
    truncated: false,
  })
  return { input, prepared: preparedReviewOf(snapshot), offset: 0, outcomes: [] }
}

describe("the review flow's rounds on this app's engine", { timeout: 120_000 }, () => {
  test.each([
    ["started as the first round", ReviewFiles],
    ["run as a child execution", Parent],
  ] as const)("hand off from batch to batch, then to verification and the verdict: %s", async (_, flow) => {
    const asked: Array<string> = []
    const { seat, requests } = await judgeSeat(runtime, answer(asked))
    const out = join(outputs, crypto.randomUUID(), "walkthrough.html")
    const ran = await runFlow(flow, payloadOf(out), registration(seat))
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    if (!Exit.isSuccess(ran.exit)) return
    const result = ran.exit.value
    // One model call per reviewable file, each in its own round, then one verification: the binary file costs none.
    expect(asked).toEqual(["src/a.ts", "src/b.ts", "verify"])
    expect(requests).toHaveLength(3)
    expect(result.verdict).toBe("fail")
    expect(result.review.status).toBe("success")
    expect(result.review.comments.map((comment) => [comment.path, comment.startLine, comment.severity])).toEqual([
      ["src/a.ts", 2, "major"],
      ["src/b.ts", 2, "major"],
    ])
    expect(result.target).toEqual({ repoDir: "acme/widgets", mode: "range", ref: `${"a".repeat(40)}..${"b".repeat(40)}` })
    expect(ran.status).toBe("completed")
    expect(existsSync(out)).toBe(true)
  })
})
