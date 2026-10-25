import { expect, test } from "vitest"
import { githubList, isDeploymentRepository } from "./scope"
import type { AboutRow } from "./rows"

test("deployment capabilities fail closed until About confirms this repository, including cached older answers", () => {
  const row = (state: AboutRow["state"], about: unknown) => ({ key: "github/owner/repo", state, about, message: null }) as AboutRow
  expect(isDeploymentRepository("owner", "repo", undefined)).toBe(false)
  expect(isDeploymentRepository("owner", "repo", row("loading", null))).toBe(false)
  expect(isDeploymentRepository("owner", "repo", row("ready", null))).toBe(false)
  expect(isDeploymentRepository("owner", "repo", row("ready", {}))).toBe(false)
  expect(isDeploymentRepository("owner", "repo", row("ready", { deploymentRepository: "other/repo" }))).toBe(false)
  expect(isDeploymentRepository("owner", "repo", row("ready", { deploymentRepository: "OWNER/REPO" }))).toBe(true)
})

test("unsynced lists name their GitHub destination without claiming an empty or requested list", () => {
  expect(githubList("smithersai", "vibelang", "issues")).toEqual({ href: "https://github.com/smithersai/vibelang/issues", text: "Issues for this repository are on GitHub." })
  expect(githubList("smithersai", "vibelang", "pulls")).toEqual({ href: "https://github.com/smithersai/vibelang/pulls", text: "Pull requests for this repository are on GitHub." })
})
