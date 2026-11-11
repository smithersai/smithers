/**
 * Bisect a commit range for a regression, with an agent judging each test result.
 *
 * Port of the 0.x `bisect-guide.jsx`. Each step tests the commit at the
 * midpoint of the current bounds, and an adjudicator agent reads the exit code
 * and output, calls the commit good, bad or skip (for a flaky or ambiguous
 * run), and narrows the bounds. The loop ends when the adjudicator reports the
 * culprit or after twenty steps, returning the last verdict either way, and a
 * summary names the culprit and the step count.
 *
 * 0.x's `<Loop until maxIterations={20} onMaxReached="return-last">` is a planned recursion of at most twenty steps, as in `code-review-loop.ts`. `Loop.make` hands each round only the previous one's result, where 0.x tells both steps every verdict so far.
 * 0.x tested each commit with an agent told to report without judging; here the test is a deterministic `Action` a host implements over its checkout, because the 1.0 completion brake refuses an agent's report of commands its run never recorded. It takes the bounds, not the verdict history the agent was shown.
 * 0.x's summary task had no agent and rendered its placeholder prompt as the output; the port computes the summary from the same props.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** How many bisect steps one run may spend. */
export const maxIterations = 20

/** One tested commit. */
export const BisectStep = Schema.Struct({
  sha: Schema.String.annotate({ description: "Current commit SHA being tested" }),
  low: Schema.Number.annotate({ description: "Lower bound index" }),
  high: Schema.Number.annotate({ description: "Upper bound index" }),
  mid: Schema.Number.annotate({ description: "Current midpoint index" }),
  testOutput: Schema.String.annotate({ description: "Raw test runner output" }),
  exitCode: Schema.Number.annotate({ description: "Test process exit code" })
})

/** The adjudicator's verdict and the narrowed bounds. */
export const Adjudication = Schema.Struct({
  verdict: Schema.Literals(["good", "bad", "skip"]).annotate({
    description: "Agent interpretation of the test result"
  }),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
    description: "How confident the agent is in this verdict"
  }),
  reasoning: Schema.String.annotate({ description: "Why the agent reached this verdict" }),
  nextLow: Schema.Number.annotate({ description: "Updated lower bound" }),
  nextHigh: Schema.Number.annotate({ description: "Updated upper bound" }),
  culpritFound: Schema.Boolean.annotate({ description: "Whether the bisect has converged" }),
  culpritSha: Schema.NullOr(Schema.String).annotate({ description: "The identified culprit commit, if found" })
})

/** What the flow settles with. */
export const Output = Schema.Struct({
  culpritSha: Schema.NullOr(Schema.String).annotate({ description: "The commit that introduced the regression" }),
  totalSteps: Schema.Number.annotate({ description: "Number of bisect steps performed" }),
  summary: Schema.String.annotate({ description: "Human-readable summary of the bisect result" })
})

type Adjudication = typeof Adjudication.Type
type Output = typeof Output.Type

/**
 * Checks out the commit at index `mid` and runs `testCommand`, reporting the
 * raw output and exit code without judging them. A host implements it over
 * its checkout; the tests implement it with a deterministic layer.
 */
export const TestCommit = Action.make("examples/BisectGuide/BisectStep", {
  payload: {
    repoPath: Schema.String,
    testCommand: Schema.String,
    low: Schema.Number,
    high: Schema.Number,
    mid: Schema.Number
  },
  success: BisectStep
})

/** Judges one test result and narrows the bounds. */
export const Adjudicate = AgentAction.make("examples/BisectGuide/Adjudicate", {
  payload: {
    sha: Schema.String,
    testOutput: Schema.String,
    exitCode: Schema.Number,
    low: Schema.Number,
    high: Schema.Number,
    mid: Schema.Number,
    previousVerdicts: Schema.Array(Adjudication)
  },
  output: Adjudication,
  seat,
  system: [
    `You are a bisect adjudicator. Given a test result (output + exit code), determine whether this commit is "good", "bad", or "skip" (ambiguous/flaky). Consider timeouts, partial failures, and infrastructure noise. Update the search bounds accordingly. Mark culpritFound when low >= high.`
  ],
  prompt: ({ exitCode, high, low, mid, previousVerdicts, sha, testOutput }) =>
    `Adjudicate the test result for commit ${sha}.\n\nBounds: low ${low}, high ${high}, mid ${mid}\nExit code: ${exitCode}\nTest output: ${
      JSON.stringify(testOutput)
    }\nPrevious verdicts: ${JSON.stringify(previousVerdicts)}`
})

type Requirements = Action.Requirement<"examples/BisectGuide/BisectStep" | "examples/BisectGuide/Adjudicate">

/** A search bound: real on the first step, the previous verdict's afterwards. */
type Bound = number | Planned.Planned<number>

/** The midpoint 0.x tested. Pure, so it is a `Node.map`, not a step. */
const midpoint = ({ high, low }: { readonly low: number; readonly high: number }) => Math.floor((low + high) / 2)

/** The summary. Pure, so it is a `Node.map`, not a step. */
const summarize = (totalSteps: number) => ({ culpritSha }: { readonly culpritSha: string | null }): Output => ({
  culpritSha,
  totalSteps,
  summary: culpritSha === null
    ? `No culprit found after ${totalSteps} bisect steps.`
    : `Culprit ${culpritSha} found after ${totalSteps} bisect steps.`
})

/**
 * Step `iteration`: test the midpoint, adjudicate, and either settle on the
 * culprit or narrow the bounds and step again. The last planned step settles
 * on whatever its verdict says, which is 0.x's `return-last`.
 */
const step = (
  repoPath: string,
  testCommand: string,
  iteration: number,
  low: Bound,
  high: Bound,
  verdicts: ReadonlyArray<Planned.Planned<Adjudication>>
): Node.Node<Output, AgentAction.AgentFailure, Requirements> =>
  Node.bindPlanned(Node.map(Node.succeed({ low, high }), midpoint), (mid: Planned.Planned<number>) =>
    Node.bindPlanned(
      TestCommit.call({ repoPath, testCommand, low, high, mid }),
      (tested: Planned.Planned<typeof BisectStep.Type>) => {
        const adjudication = Adjudicate.call({
          sha: tested.sha,
          testOutput: tested.testOutput,
          exitCode: tested.exitCode,
          low,
          high,
          mid,
          previousVerdicts: verdicts
        })
        const settle = (latest: Planned.Planned<Adjudication>) =>
          Node.map(Node.succeed({ culpritSha: latest.culpritSha }), summarize(iteration))
        return iteration >= maxIterations
          ? Node.bindPlanned(adjudication, settle)
          : Node.branch(adjudication, {
            if: (latest) => latest.culpritFound,
            then: settle,
            else: (latest) =>
              step(repoPath, testCommand, iteration + 1, latest.nextLow, latest.nextHigh, [...verdicts, latest])
          })
      }
    ))

/** The bounded bisect. `commitCount` is real at plan time, so it sets the first upper bound. */
export const BisectGuide = Flow.make("examples/BisectGuide", {
  payload: { repoPath: Schema.String, testCommand: Schema.String, commitCount: Schema.Number },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ commitCount, repoPath, testCommand }) => step(repoPath, testCommand, 1, 0, Math.max(0, commitCount - 1), [])
})

/** Every agent step the flow calls. The host implements {@link TestCommit}. */
export const layer = Adjudicate.layer
