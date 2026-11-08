/**
 * Compress build and deploy logs into root-cause hypotheses, a likely owner, and next commands to run.
 *
 * Port of the 0.x `log-digest.jsx`. A collector agent gathers the logs at the
 * given paths and from the given commands and extracts the error lines, the
 * warning lines and the last `tailLines` lines (default 100). A root-cause
 * analyst agent reads that collection and returns ranked hypotheses, the
 * likely owning team and the next commands to run. Nothing branches or loops.
 *
 * 0.x's two prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** What the collector gathered. */
export const CollectedLogs = Schema.Struct({
  source: Schema.String,
  lineCount: Schema.Number,
  errorLines: Schema.Array(Schema.String),
  warningLines: Schema.Array(Schema.String),
  rawTail: Schema.String.annotate({ description: "Last ~100 lines of combined logs" })
})

/** The digest the flow settles with. */
export const Digest = Schema.Struct({
  rootCauseHypotheses: Schema.Array(Schema.Struct({
    hypothesis: Schema.String,
    confidence: Schema.Literals(["high", "medium", "low"]),
    evidence: Schema.Array(Schema.String)
  })),
  likelyOwner: Schema.Struct({ team: Schema.String, reasoning: Schema.String }),
  nextCommands: Schema.Array(Schema.Struct({ command: Schema.String, purpose: Schema.String })),
  summary: Schema.String
})

/** Gathers the logs and pulls out the lines that matter. */
export const Collect = AgentAction.make("examples/LogDigest/Collect", {
  payload: {
    logPaths: Schema.Array(Schema.String),
    commands: Schema.Array(Schema.String),
    tailLines: Schema.Number
  },
  output: CollectedLogs,
  seat,
  system: [
    `You are a log collector. Gather logs from the specified paths or by
running the provided commands. Extract error and warning lines, and capture the tail
of the output. Be thorough — check for stack traces, assertion failures, timeout
messages, and exit codes.`
  ],
  prompt: ({ commands, logPaths, tailLines }) =>
    `Collect these logs.\n\nLog paths: ${JSON.stringify(logPaths)}\nCommands: ${
      JSON.stringify(commands)
    }\nTail lines: ${tailLines}`
})

/** Turns the collection into hypotheses, an owner and next commands. */
export const Summarize = AgentAction.make("examples/LogDigest/Summarize", {
  payload: CollectedLogs,
  output: Digest,
  seat,
  system: [
    `You are a root-cause analyst. Given collected log data, produce
ranked hypotheses about what went wrong, identify the most likely owning team,
and suggest concrete next commands a developer should run to confirm or fix the issue.
Focus on actionable output — skip noise.`
  ],
  prompt: ({ errorLines, lineCount, rawTail, source, warningLines }) =>
    `Digest these logs.\n\nSource: ${source}\nLine count: ${lineCount}\nError lines: ${
      JSON.stringify(errorLines)
    }\nWarning lines: ${JSON.stringify(warningLines)}\nRaw tail:\n${rawTail}`
})

/** The flow: collect, then summarize. */
export const LogDigest = Flow.make("examples/LogDigest", {
  payload: {
    logPaths: Schema.optional(Schema.Array(Schema.String)),
    commands: Schema.optional(Schema.Array(Schema.String)),
    tailLines: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)))
  },
  success: Digest,
  error: AgentAction.AgentFailure,
  body: ({ commands = [], logPaths = [], tailLines = 100 }) =>
    Node.bindPlanned(
      Collect.call({ logPaths, commands, tailLines }),
      (logs: Planned.Planned<typeof CollectedLogs.Type>) =>
        Summarize.call({
          source: logs.source,
          lineCount: logs.lineCount,
          errorLines: logs.errorLines,
          warningLines: logs.warningLines,
          rawTail: logs.rawTail
        })
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Collect.layer, Summarize.layer)
