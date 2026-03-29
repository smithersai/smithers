/**
 * <DependencyUpdate> — Check outdated deps → assess risk → update → verify.
 *
 * Pattern: Scan → Risk assess → Apply updates → Run tests.
 * Use cases: npm update, cargo update, pip upgrade, go mod tidy.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ScanPrompt from "./prompts/dependency-update/scan.mdx";
import UpdatePrompt from "./prompts/dependency-update/update.mdx";
import VerifyPrompt from "./prompts/dependency-update/verify.mdx";

const scanSchema = z.object({
  outdated: z.array(z.object({
    name: z.string(),
    current: z.string(),
    latest: z.string(),
    type: z.enum(["major", "minor", "patch"]),
    breaking: z.boolean(),
    changelog: z.string().optional(),
  })),
  totalOutdated: z.number(),
});

const updateSchema = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
  status: z.enum(["updated", "skipped", "failed"]),
  notes: z.string(),
});

const verifySchema = z.object({
  passed: z.boolean(),
  typecheck: z.boolean(),
  tests: z.boolean(),
  build: z.boolean(),
  errors: z.array(z.string()),
});

const reportSchema = z.object({
  updated: z.number(),
  skipped: z.number(),
  failed: z.number(),
  breaking: z.number(),
  verified: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  scan: scanSchema,
  update: updateSchema,
  verify: verifySchema,
  report: reportSchema,
});

const scanner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a dependency analyst. Check for outdated packages and assess
each update's risk level (major/minor/patch, breaking changes).`,
});

const updater = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, edit, read },
  instructions: `You are a dependency updater. Update the specified package.
For major updates, check the changelog for breaking changes and apply necessary code fixes.`,
});

const verifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `Run the full verification suite to check nothing is broken.`,
});

export default smithers((ctx) => {
  const scan = ctx.outputMaybe("scan", { nodeId: "scan" });
  const updates = ctx.outputs.update ?? [];

  // Only auto-update patch and minor; flag major for review
  const autoUpdatable = scan?.outdated?.filter((d) => !d.breaking && d.type !== "major") ?? [];

  return (
    <Workflow name="dependency-update">
      <Sequence>
        <Task id="scan" output={outputs.scan} agent={scanner}>
          <ScanPrompt
            directory={ctx.input.directory}
            checkCmd={ctx.input.checkCmd ?? "npm outdated --json"}
            lockfile={ctx.input.lockfile ?? "package-lock.json"}
          />
        </Task>

        {autoUpdatable.length > 0 && (
          <Parallel maxConcurrency={3}>
            {autoUpdatable.map((dep) => (
              <Task
                key={dep.name}
                id={`update-${dep.name}`}
                output={outputs.update}
                agent={updater}
                continueOnFail
              >
                <UpdatePrompt
                  name={dep.name}
                  current={dep.current}
                  latest={dep.latest}
                  type={dep.type}
                  directory={ctx.input.directory}
                  changelog={dep.changelog}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {updates.length > 0 && (
          <Task id="verify" output={outputs.verify} agent={verifier}>
            <VerifyPrompt
              directory={ctx.input.directory}
              typecheckCmd={ctx.input.typecheckCmd ?? "npx tsc --noEmit"}
              testCmd={ctx.input.testCmd ?? "npm test"}
              buildCmd={ctx.input.buildCmd ?? "npm run build"}
            />
          </Task>
        )}

        <Task id="report" output={outputs.report}>
          {{
            updated: updates.filter((u) => u.status === "updated").length,
            skipped: updates.filter((u) => u.status === "skipped").length + (scan?.outdated?.filter((d) => d.breaking || d.type === "major").length ?? 0),
            failed: updates.filter((u) => u.status === "failed").length,
            breaking: scan?.outdated?.filter((d) => d.breaking).length ?? 0,
            verified: ctx.outputMaybe("verify", { nodeId: "verify" })?.passed ?? false,
            summary: `Updated ${updates.filter((u) => u.status === "updated").length}/${scan?.totalOutdated ?? 0} deps. ${scan?.outdated?.filter((d) => d.breaking).length ?? 0} major updates need manual review.`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
