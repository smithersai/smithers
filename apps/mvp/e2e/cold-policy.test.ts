import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { importRules } from "../PACKAGE"

test("cold issue and search journeys pass the real no-interception import rule", () => {
  const rule = importRules.find(rule => rule.because.startsWith("test.no-mocks-in-e2e:"))!
  const result = spawnSync(process.execPath, [
    "--import=vibelang/register",
    "../../packages/repo-targets/scripts/import-rules.mjs",
    "apps/mvp",
    JSON.stringify([{ ...rule, files: ["e2e/cold-issue.spec.ts", "e2e/cold-search.spec.ts"] }]),
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" })
  expect(result.status, result.stderr + result.stdout).toBe(0)
  expect(result.stdout).toContain("ImportRules passed")
})
