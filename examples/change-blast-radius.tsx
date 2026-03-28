// @ts-nocheck
/**
 * <ChangeBlastRadius> — Map a file diff to likely impacted services, tests, docs, and owners.
 *
 * Shape: diff parser -> dependency/context gatherer -> blast-radius agent.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ParsePrompt from "./prompts/change-blast-radius/parse.mdx";
import GatherPrompt from "./prompts/change-blast-radius/gather.mdx";
import BlastRadiusPrompt from "./prompts/change-blast-radius/blast-radius.mdx";

const parsedDiffSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      changeType: z.enum(["added", "modified", "deleted", "renamed"]),
      hunks: z.number(),
      linesChanged: z.number(),
    })
  ),
  totalFiles: z.number(),
  summary: z.string(),
});

const dependencyContextSchema = z.object({
  dependencies: z.array(
    z.object({
      source: z.string(),
      dependsOn: z.array(z.string()),
      service: z.string(),
    })
  ),
  relatedTests: z.array(z.string()),
  relatedDocs: z.array(z.string()),
  owners: z.array(
    z.object({
      team: z.string(),
      files: z.array(z.string()),
    })
  ),
  summary: z.string(),
});

const blastRadiusSchema = z.object({
  impactedServices: z.array(
    z.object({
      name: z.string(),
      risk: z.enum(["low", "medium", "high", "critical"]),
      reason: z.string(),
    })
  ),
  impactedTests: z.array(z.string()),
  impactedDocs: z.array(z.string()),
  owners: z.array(z.string()),
  overallRisk: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  parsedDiff: parsedDiffSchema,
  dependencyContext: dependencyContextSchema,
  blastRadius: blastRadiusSchema,
});

const gatherer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a dependency and context gatherer. Given a list of changed files,
trace imports, find CODEOWNERS entries, locate related test files and documentation.
Be thorough: check package.json, tsconfig paths, import graphs, and doc references.`,
});

const blastRadiusAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a blast-radius analyst. Given changed files and their dependency context,
determine which services, tests, and docs are impacted. Assign a risk level to each service
based on how central the changed code is. Identify all owners who should review the change.
Be specific about why each service is impacted.`,
});

export default smithers((ctx) => {
  const parsed = ctx.outputMaybe("parsedDiff", { nodeId: "parse-diff" });
  const context = ctx.outputMaybe("dependencyContext", { nodeId: "gather-context" });

  return (
    <Workflow name="change-blast-radius">
      <Sequence>
        {/* Stage 1: Parse the raw diff into structured changed-file records */}
        <Task id="parse-diff" output={outputs.parsedDiff}>
          <ParsePrompt
            diff={ctx.input.diff ?? ""}
            gitRef={ctx.input.gitRef ?? "HEAD~1..HEAD"}
          />
        </Task>

        {/* Stage 2: Gather dependency graph, related tests, docs, and owners */}
        <Task id="gather-context" output={outputs.dependencyContext} agent={gatherer}>
          <GatherPrompt
            files={parsed?.files ?? []}
            repoRoot={ctx.input.repoRoot ?? "."}
          />
        </Task>

        {/* Stage 3: Blast-radius agent synthesizes impact analysis */}
        <Task id="blast-radius" output={outputs.blastRadius} agent={blastRadiusAgent}>
          <BlastRadiusPrompt
            files={parsed?.files ?? []}
            dependencies={context?.dependencies ?? []}
            relatedTests={context?.relatedTests ?? []}
            relatedDocs={context?.relatedDocs ?? []}
            owners={context?.owners ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
