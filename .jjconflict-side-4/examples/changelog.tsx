/**
 * <Changelog> — Analyze git history → categorize changes → generate changelog.
 *
 * Pattern: Read commits → classify → group → render formatted output.
 * Use cases: release notes, weekly digests, sprint summaries, contributor reports.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, write } from "smithers-orchestrator/tools";
import { z } from "zod";
import AnalyzePrompt from "./prompts/changelog/analyze.mdx";
import GeneratePrompt from "./prompts/changelog/generate.mdx";

const commitAnalysisSchema = z.object({
  commits: z.array(z.object({
    sha: z.string(),
    message: z.string(),
    author: z.string(),
    category: z.enum(["feature", "fix", "refactor", "docs", "test", "chore", "breaking"]),
    scope: z.string().optional(),
    summary: z.string(),
  })),
  totalCommits: z.number(),
  dateRange: z.string(),
});

const changelogSchema = z.object({
  version: z.string(),
  date: z.string(),
  sections: z.array(z.object({
    category: z.string(),
    emoji: z.string(),
    items: z.array(z.string()),
  })),
  highlights: z.array(z.string()),
  breakingChanges: z.array(z.string()),
  contributors: z.array(z.string()),
  markdown: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  commitAnalysis: commitAnalysisSchema,
  changelog: changelogSchema,
});

const analyst = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a git historian. Analyze commits, categorize them by type
(feature, fix, refactor, docs, test, chore, breaking), and extract meaningful summaries.
Look beyond commit messages — check the actual diff context when messages are vague.`,
});

const writer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { write },
  instructions: `You are a changelog writer. Generate clear, user-facing changelogs.
Group by category with emojis. Highlight breaking changes prominently.
Write for end users, not developers (unless configured otherwise).`,
});

export default smithers((ctx) => {
  const analysis = ctx.outputMaybe("commitAnalysis", { nodeId: "analyze" });

  return (
    <Workflow name="changelog">
      <Sequence>
        <Task id="analyze" output={outputs.commitAnalysis} agent={analyst}>
          <AnalyzePrompt
            range={ctx.input.range ?? "last tag to HEAD"}
            command={`git log ${ctx.input.range ?? "--since='1 week ago'"} --pretty=format:"%H|%s|%an|%ai" --no-merges`}
          />
        </Task>

        <Task id="generate" output={outputs.changelog} agent={writer}>
          <GeneratePrompt
            totalCommits={analysis?.totalCommits ?? 0}
            commits={analysis?.commits ?? []}
            version={ctx.input.version ?? "Unreleased"}
            dateRange={analysis?.dateRange ?? "unknown"}
            audience={ctx.input.audience ?? "users"}
            outputFile={ctx.input.outputFile ?? "CHANGELOG.md"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
