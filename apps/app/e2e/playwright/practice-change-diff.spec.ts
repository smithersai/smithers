import { expect, test, type Page } from "@playwright/test"

const base = "a".repeat(40), commit = "b".repeat(40)
const repo = "practice:smithersai/hello-server"
const plan = { id: "canary-plan", title: "Canary plan", summary: "Fix greetings", baseCommitId: base, steps: ["Fix greeting"], files: ["src/hello.ts"] }
const command = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text)
  await input.press("Enter")
}

// Response fixtures exercise the real shell/registry; they are not live execution proof.
test("a signed-out practice Change opens its recorded full diff by keyboard and survives reload", async ({ page }) => {
  const launches: string[] = [], hostedReads: string[] = []
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
  await page.route("**/api/tutorial/live/*", route => {
    const operation = route.request().url().split("/").at(-1)!
    launches.push(operation)
    return route.fulfill({ status: 202, json: {
      sessionId: "canary-session", runId: `canary-${operation}`, operation, phase: "completed", createdAt: 1, updatedAt: 2, events: [], result: `${operation} complete`,
      ...(operation === "plan" ? { plan } : {}),
      ...(operation === "implement" ? { plan, baseCommitId: base, commits: [{ commitId: commit, parentCommitId: base, message: "Fix greeting", files: ["src/hello.ts"], additions: 1, deletions: 1 }],
        diff: [{ path: "src/hello.ts", changeType: "modified", additions: 1, deletions: 1, isBinary: false, patch: "@@ -1 +1 @@\n-old\n+new" }], files: { "src/hello.ts": "new" }, tests: { command: "node --test", exitCode: 0, output: "pass" } } : {}),
      ...(operation === "change" ? { change: { id: "canary-change", title: "Canary Change", summary: "Fix greeting", baseCommitId: base, commitIds: [commit] } } : {})
    } })
  })
  page.on("request", request => { if (/\/api\/(?:cloud\/api\/)?repos\/.*\/changes\//.test(request.url())) hostedReads.push(request.url()) })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, `/agent.change ${repo}`)
  await expect(page.locator('[data-kind="run-trace"]').last()).toContainText("Canary plan")
  await command(page, "/agent.change.start practice-plan")
  await expect(page.locator('[data-kind="commit-pick"]')).toBeVisible()
  await command(page, `/change.open ${repo} ${commit}`)
  const change = page.locator('[data-kind="change"]')
  await expect(change).toContainText("Canary Change")
  const open = change.getByRole("button", { name: "Open the full diff card" })
  await expect(open).toHaveAttribute("data-flow", "files.implementation-diff")
  await open.focus()
  await page.keyboard.press("Enter")
  const diff = page.locator('[data-kind="diff"]')
  await expect(diff).toContainText("src/hello.ts")
  expect(launches).toEqual(["plan", "implement", "change"])
  expect(hostedReads).toEqual([])
  await page.reload()
  await expect(diff).toContainText("src/hello.ts")
  await command(page, "/files.implementation-diff canary-change")
  await expect(diff).toHaveCount(1)
  expect(hostedReads).toEqual([])
})
