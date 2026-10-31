import { expect, type Page, type TestInfo } from "@playwright/test"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { github } from "./github"
import { baseURL, requires } from "./target"
import { strictTest as test } from "./watch"

// A TODO coded by an external agent on a runner (decision 0133, docs/features/agent-runners.md): an Admin registers a
// runner and names the repository's coding agent, the spec starts that runner itself (`smthrs runner serve`) with the
// deterministic ACP test agent as the profile's command, a person commits a TODO, and the App opens its pull request
// with the agent's change. Everything is real: the app, its routes and flows, Postgres, the runner, its jj checkout, the
// agent process and GitHub. The test agent stands in for a model, so this proves the seam; a real agent's lane is the
// production proof (FINAL.md §5).
//
// It writes to GitHub, so it runs only on a dev build signing in through the GitHub App, against a scratch repository
// the test account administers (`agentRunner`, e2e/target.ts). It never merges.

const started = new WeakMap<TestInfo, number>()
const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const smthrs = join(root, "packages/smithers/bin/smithers.mjs")
const testAgent = join(root, "packages/smithers/agent/test/fixtures/acp-test-agent.mjs")

test.beforeEach(async ({ page }, info) => {
  started.set(info, Date.now())
  requires("agentRunner")
  await page.emulateMedia({ colorScheme: themeOf(info) })
  await recordActions(page, info, "Maya")
})

test.afterEach(async ({}, info) => {
  await writeManifest(info, "flow.json", started.get(info) ?? Date.now(), [{ name: "Maya", video: "video.webm", openedAt: 0 }])
})

/** An Admin's write to the repository's runners or agents, as the signed-in page. */
const adminWrite = async (page: Page, path: string, method: "PUT" | "DELETE", body?: unknown) => {
  const response = await page.request.fetch(new URL(`/api/repos/${repo}/${path}`, baseURL).href, {
    method,
    ...(body === undefined ? {} : { data: body }),
  })
  expect(response.status(), `${method} ${path}`).toBe(202)
}

test("agent runner: an external agent's TODO publishes a pull request", {
  annotation: { type: "summary", description: "An Admin points TODOs at an agent on a runner; the App opens its pull request." },
}, async ({ page }) => {
  test.setTimeout(15 * 60_000)
  const word = `a${Date.now().toString(36)}`
  const state = mkdtempSync(join(tmpdir(), "agent-runner-e2e-"))
  const name = `e2e-${word}`
  let runner: ChildProcess | undefined
  try {
    await step("An Admin registers a runner and names the coding agent", async () => {
      const sha = execFileSync(process.execPath, [smthrs, "runner", "token", "--state", state], { encoding: "utf8" }).trim()
      await page.goto(`/${repo}/stack`)
      await adminWrite(page, `runners/${name}`, "PUT", { tokenSha256: sha, labels: ["e2e"], capacity: 1 })
      await adminWrite(page, `agents/${name}`, "PUT", { labels: ["e2e"], profile: "acp-test", coding: true })
      const config = {
        origin: new URL(baseURL).origin,
        name,
        capacity: 1,
        stateDir: state,
        repositories: { [`github/${repo.toLowerCase()}`]: { mirror: process.env.E2E_RUNNER_MIRROR! } },
        profiles: { "acp-test": { argv: [process.execPath, testAgent], env: { ACP_TEST_AGENT_STATE: join(state, "agent") } } },
      }
      writeFileSync(join(state, "runner.json"), JSON.stringify(config))
      runner = spawn(process.execPath, [smthrs, "runner", "serve", "--config", join(state, "runner.json")], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: new URL(baseURL).hostname === "localhost" ? "0" : "1" },
      })
    })

    const title = `Note alpha ${word}`
    await step("A person commits a TODO", async () => {
      await page.getByRole("button", { name: "New TODO", exact: true }).click()
      const draft = page.getByRole("form", { name: "TODO draft" })
      await draft.getByLabel("Title", { exact: true }).fill(title)
      await draft.getByLabel("Prompt", { exact: true }).fill(`add the line \`alpha ${word}\` to \`NOTES.md\``)
      await draft.getByRole("button", { name: "Commit", exact: true }).click()
    })

    const row = page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: word })
    await step("The runner's agent works on it", async () => {
      await expect(row).toHaveAttribute("data-status", /running|in_review/, { timeout: 60_000 })
    })

    await step("The App opens its pull request with the agent's change", async () => {
      await expect(row).toHaveAttribute("data-status", "in_review", { timeout: 10 * 60_000 })
      const number = (await row.textContent())!.match(/T(\d+)/)![1]!
      const pulls = await github<Array<{ number: number; head: { ref: string }; user: { type: string } }>>(
        page,
        `/repos/${repo}/pulls?state=open&per_page=100`,
      )
      const pull = pulls.find((each) => each.head.ref.startsWith(`smithers/t${number}-`))
      expect(pull, "one pull request on the TODO's branch").toBeDefined()
      expect(pull!.user.type).toBe("Bot")
      const files = await github<Array<{ filename: string; patch?: string }>>(page, `/repos/${repo}/pulls/${pull!.number}/files`)
      expect(files.map((file) => file.filename)).toEqual(["NOTES.md"])
      expect(files[0]!.patch).toContain(`+alpha ${word}`)
    })
  } finally {
    // The repository codes with Smithers' own agent again, and the runner is retired.
    await adminWrite(page, `agents/${name}`, "DELETE").catch(() => undefined)
    await adminWrite(page, `runners/${name}`, "DELETE").catch(() => undefined)
    runner?.kill("SIGTERM")
    const stderr = runner?.stderr?.read()?.toString() ?? ""
    if (test.info().status !== test.info().expectedStatus) test.info().attach("runner.log", { body: stderr })
    rmSync(state, { recursive: true, force: true })
  }
})
