// smithers-source: seeded
// smithers-display-name: Smoke Test
/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import SmoketestPrompt from "../prompts/smoketest.mdx";

/**
 * Resolve the monorepo root from this workflow file's location
 * (`<repo>/.smithers/workflows/smoketest.tsx`) so the smoke test always
 * targets the currently-checked-out version + its changelog, not whatever
 * npm `@latest` happens to be or whatever the agent stumbles onto.
 */
const workflowDir = fileURLToPath(new URL(".", import.meta.url));
const monorepoRoot = resolve(workflowDir, "../..");
const rootPkg = JSON.parse(
  readFileSync(resolve(monorepoRoot, "package.json"), "utf8"),
) as { version: string };
const CURRENT_VERSION = String(rootPkg.version);
const CHANGELOG_PATH = resolve(
  monorepoRoot,
  "docs/changelogs",
  `${CURRENT_VERSION}.mdx`,
);
const CURRENT_CHANGELOG = readFileSync(CHANGELOG_PATH, "utf8");

const smoketestOutputSchema = z.looseObject({
  passed: z.boolean(),
  summary: z.string(),
  findings: z
    .array(
      z.object({
        area: z.string(),
        status: z.enum(["pass", "fail", "skipped"]),
        evidence: z.string(),
      }),
    )
    .default([]),
  reproSteps: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z
    .string()
    .default(
      "Smoke test the latest published smithers-orchestrator release against the pinned changelog entry.",
    ),
  version: z.string().default(CURRENT_VERSION),
  changelog: z.string().default(CURRENT_CHANGELOG),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  smoketest: smoketestOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="smoketest">
    <Task id="smoketest" output={smoketestOutputSchema} agent={agents.cheapFast}>
      <SmoketestPrompt
        prompt={ctx.input.prompt}
        version={ctx.input.version}
        changelog={ctx.input.changelog}
      />
    </Task>
  </Workflow>
));
