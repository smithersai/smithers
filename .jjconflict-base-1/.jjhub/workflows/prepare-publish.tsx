/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task, Workflow, Approval, approvalDecisionSchema } from "smithers-orchestrator";
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { z } from "zod";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const UNSAFE = process.env.SMITHERS_UNSAFE === "1";

const claude = new ClaudeCodeAgent({
  model: process.env.CLAUDE_MODEL ?? "claude-opus-4-6",
  systemPrompt: "You are a release manager running pre-publish validations and chore tasks.",
  addDir: [REPO_ROOT],
  dangerouslySkipPermissions: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
});

const codex = new CodexAgent({
  model: process.env.CODEX_MODEL ?? "gpt-5.3-codex",
  systemPrompt: "You are a strict DevOps agent running validations and managing git operations.",
  addDir: [REPO_ROOT],
  yolo: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
  config: { model_reasoning_effort: "high" },
});

const ValidateSchema = z.object({
  lintPassed: z.boolean().describe("Whether the linter passed"),
  testsPassed: z.boolean().describe("Whether tests passed"),
  buildPassed: z.boolean().describe("Whether the build succeeded"),
  fullOutput: z.string().describe("Log of the validation run"),
});

const BumpSchema = z.object({
  newVersion: z.string().describe("The newly assigned version string"),
  filesModified: z.array(z.string()).describe("Files where the version was updated"),
});

const ChangelogSchema = z.object({
  changelogFile: z.string().describe("Path to the updated changelog file"),
  changelogEntry: z.string().describe("The markdown entry added for this version"),
});

const PublishSchema = z.object({
  publishedVersion: z.string().describe("The version that was published"),
  status: z.enum(["published", "rejected"]),
});

const { smithers, outputs, tables } = createSmithers({
  validate: ValidateSchema,
  bump: BumpSchema,
  changelog: ChangelogSchema,
  publishApproval: approvalDecisionSchema,
  publishResult: PublishSchema,
}, {
  dbPath: `${process.env.HOME}/.cache/smithers/prepare-publish.db`,
});

export default smithers((ctx) => {
  const validate = ctx.latest(tables.validate, "validate");
  const bump = ctx.latest(tables.bump, "bump-version");
  const changelog = ctx.latest(tables.changelog, "create-changelog");
  const decision = ctx.latest(tables.publishApproval, "approve-publish");

  return (
    <Workflow name="prepare-publish">
      <Sequence>
        <Task id="validate" output={outputs.validate} agent={codex} timeoutMs={20 * 60 * 1000}>
          {`Run the linter, the test suite, and the build for this repository to ensure it's ready for publish.
Required commands:
1. linter (e.g., bun run lint or tsc)
2. tests (e.g., bun test)
3. build (e.g., bun run build)

If any fail, report it. Only set passed booleans to true if the commands actually exited with 0.`}
        </Task>

        {validate?.lintPassed && validate?.testsPassed && validate?.buildPassed ? (
          <Task id="bump-version" output={outputs.bump} agent={claude} timeoutMs={15 * 60 * 1000}>
            {`Determine the next version bump based on recent commits or the target release type (e.g., patch, minor, major).
Release type requested: ${ctx.input.releaseType ?? "patch"}

Update the package.json and any other files storing the version.
Return the new version string and a list of modified files.`}
          </Task>
        ) : null}

        {bump ? (
          <Task id="create-changelog" output={outputs.changelog} agent={claude} timeoutMs={15 * 60 * 1000}>
            {`Review the git history since the last release tag and generate a changelog entry for version ${bump.newVersion}.
Format it in Markdown, group by features/fixes/chores, and write the result into CHANGELOG.md.

Return the modified changelog file path and the entry content.`}
          </Task>
        ) : null}

        {changelog ? (
          <Approval
            id="approve-publish"
            output={outputs.publishApproval}
            request={{
              title: `Publish ${bump?.newVersion}?`,
              summary: `Validation passed.\nVersion bumped in: ${bump?.filesModified.join(", ")}\n\nChangelog:\n${changelog.changelogEntry}`,
              metadata: { version: bump?.newVersion },
            }}
            onDeny="continue"
          />
        ) : null}

        {decision ? (
          <Task id="record-decision" output={outputs.publishResult}>
            {{
              publishedVersion: bump?.newVersion ?? "unknown",
              status: decision.approved ? "published" : "rejected",
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
