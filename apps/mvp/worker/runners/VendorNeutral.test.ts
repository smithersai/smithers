// The external agent seat names no agent vendor (ruling PROC-23's 20:50 addendum, decision 0136): no vendor's name in
// its code, its tests or its docs, in the app or in the SDK and CLI it uses. A vendor's name belongs in our own runner
// configuration, outside these repositories.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = fileURLToPath(new URL("../../../../", import.meta.url))

/** The seam's files: every file under a directory, or the file itself. */
const SEAM = [
  "apps/mvp/worker/runners",
  "apps/mvp/worker/flows/TodoSession.ts",
  "apps/mvp/src/features/runners",
  "apps/mvp/docs/features/agent-runners.md",
  "apps/mvp/db/migrations/0078_agent_runners.ts",
  "packages/smithers/agent/src/AgentRunner.ts",
  "packages/smithers/agent/src/ExternalAgent.ts",
  "packages/smithers/agent/src/Acp.ts",
  "packages/smithers/agent/test/AgentRunner.test.ts",
  "packages/smithers/agent/test/ExternalAgent.test.ts",
  "packages/smithers/agent/test/Acp.test.ts",
  "packages/smithers/agent/test/fixtures/acp-test-agent.mjs",
  "packages/smithers/agent/docs/guides/external-agents.md",
  ".changeset/agent-external-agents.md",
  "packages/smithers/src/runner",
  "packages/smithers/src/commands/Runner.ts",
  "packages/smithers/docs/reference/cli/runner.md",
]

/** This file names the vendors it refuses, so it is the one exception. */
const SELF = fileURLToPath(import.meta.url)

const VENDORS = /claude|codex|anthropic|openai/i

const files = (path: string): Array<string> =>
  statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : [path]

test("no file of the external agent seam names an agent vendor", () => {
  const found = SEAM.flatMap((entry) => files(join(root, entry)))
    .filter((path) => path !== SELF)
    .flatMap((path) =>
      readFileSync(path, "utf8").split("\n").flatMap((line, index) =>
        VENDORS.test(line) ? [`${relative(root, path)}:${index + 1}`] : []
      )
    )
  expect(found).toEqual([])
})
