// @ts-nocheck
/**
 * <LogDigest> — Compress build/test/deploy logs into root-cause hypotheses,
 * likely owner, and next commands to run.
 *
 * Shape: shell/tool runner -> log collector -> summarizer agent.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import CollectPrompt from "./prompts/log-digest/collect.mdx";
import SummarizePrompt from "./prompts/log-digest/summarize.mdx";

const collectedLogsSchema = z.object({
  source: z.string(),
  lineCount: z.number(),
  errorLines: z.array(z.string()),
  warningLines: z.array(z.string()),
  rawTail: z.string().describe("Last ~100 lines of combined logs"),
});

const digestSchema = z.object({
  rootCauseHypotheses: z.array(
    z.object({
      hypothesis: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      evidence: z.array(z.string()),
    })
  ),
  likelyOwner: z.object({
    team: z.string(),
    reasoning: z.string(),
  }),
  nextCommands: z.array(
    z.object({
      command: z.string(),
      purpose: z.string(),
    })
  ),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  collectedLogs: collectedLogsSchema,
  digest: digestSchema,
});

const collector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a log collector. Gather logs from the specified paths or by
running the provided commands. Extract error and warning lines, and capture the tail
of the output. Be thorough — check for stack traces, assertion failures, timeout
messages, and exit codes.`,
});

const summarizer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a root-cause analyst. Given collected log data, produce
ranked hypotheses about what went wrong, identify the most likely owning team,
and suggest concrete next commands a developer should run to confirm or fix the issue.
Focus on actionable output — skip noise.`,
});

export default smithers((ctx) => (
  <Workflow name="log-digest">
    <Sequence>
      {/* Stage 1: Collect logs via shell/tool runner */}
      <Task id="collect" output={outputs.collectedLogs} agent={collector}>
        <CollectPrompt
          logPaths={ctx.input.logPaths ?? []}
          commands={ctx.input.commands ?? []}
          tailLines={ctx.input.tailLines ?? 100}
        />
      </Task>

      {/* Stage 2: Summarizer agent produces root-cause hypotheses */}
      <Task id="summarize" output={outputs.digest} agent={summarizer} deps={{ collect: outputs.collectedLogs }}>
        {(deps) => (
          <SummarizePrompt
            errorLines={deps.collect.errorLines}
            warningLines={deps.collect.warningLines}
            rawTail={deps.collect.rawTail}
            source={deps.collect.source}
            lineCount={deps.collect.lineCount}
          />
        )}
      </Task>
    </Sequence>
  </Workflow>
));
