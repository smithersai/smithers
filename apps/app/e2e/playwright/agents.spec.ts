import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

/*
 * Custom agents, T1 (docs/workbench-lanes/custom-agents.md; flow-forms.md):
 * an agent created through the derived agent.create form card appears in the
 * `+` menu with its availability. The server is a double, like tabs.spec.ts: `/api/agents`
 * holds the list in memory and answers what routes/agents.ts answers, so the
 * spec proves the SPA's side of the contract and keeps passing unchanged
 * once the real `bun src/bun/serve.ts` stands behind the same paths.
 */

const HARNESSES = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "/opt/homebrew/bin/claude",
    version: "2.1.0",
    status: "signed-in",
    account: { email: "will@codeplane.app" },
    launch: { argv: ["claude"] },
    models: { suggestions: ["claude-fable-5", "fable", "opus", "sonnet"], listable: false }
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "/opt/homebrew/bin/codex",
    version: "0.50.0",
    status: "api-key",
    account: { label: "OPENAI_API_KEY" },
    launch: { argv: ["codex"] },
    models: { suggestions: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], listable: false }
  },
  {
    id: "opencode-kimi",
    displayName: "OpenCode · Kimi",
    binary: "/Users/will/.opencode/bin/opencode",
    version: "1.18.22",
    status: "binary-only",
    account: null,
    launch: { argv: ["opencode", "--model", "kimi-for-coding/k3"] },
    models: { suggestions: ["kimi-for-coding/k3"], listable: true }
  }
]

const BUILTINS = [
  { id: "orchestrator", label: "Orchestrator", purpose: "Plans and delegates.", model: { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" }, harness: "claude", delegates: true },
  { id: "explainer", label: "Explainer", purpose: "Explains things.", model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" }, harness: "opencode-kimi", delegates: false },
  { id: "implementation", label: "Implementation", purpose: "Implements changes.", model: { provider: "openai", id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }, harness: "codex", delegates: false },
  { id: "trivial-implementation", label: "Trivial implementation", purpose: "Small changes.", model: { provider: "openai", id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }, harness: "codex", delegates: false },
  { id: "ui", label: "UI", purpose: "UI work.", model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" }, harness: "opencode-kimi", delegates: false },
  { id: "fast-ui", label: "Fast UI", purpose: "Fast UI.", model: { provider: "cerebras", id: "cerebras/gpt-oss-120b", label: "Cerebras gpt-oss-120b" }, harness: "opencode-cerebras", delegates: false }
].map((role) => ({ ...role, builtin: true, createdAt: 0, updatedAt: 0 }))

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })

interface AgentsDouble {
  readonly puts: Array<{ id: string; body: Record<string, unknown> }>
}

const serve = async (page: Page): Promise<AgentsDouble> => {
  const agents: Array<Record<string, unknown>> = [...BUILTINS]
  const puts: Array<{ id: string; body: Record<string, unknown> }> = []
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404)))
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill(json({
      apiVersion: 1,
      host: "local",
      version: "e2e",
      buildSha: "e2e",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    })))
  await page.route("**/api/health", (route) => route.fulfill(json({ ok: true, version: "e2e", pid: 1, home: "/Users/will", node: null, sandbox: { platform: "darwin", enforced: true } })))
  await page.route("**/api/harnesses", (route) => route.fulfill(json({ harnesses: HARNESSES })))
  await page.route("**/api/harnesses/*/models", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3] ?? ""
    const row = HARNESSES.find((harness) => harness.id === id)
    route.fulfill(json({ harnessId: id, models: row?.models.suggestions ?? [], source: "suggestions" }))
  })
  await page.route("**/api/repos", (route) => route.fulfill(json({ repos: [] })))
  await page.route("**/api/agents", (route) => route.fulfill(json({ agents })))
  await page.route("**/api/agents/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop() ?? ""
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>
      puts.push({ id, body })
      const existing = agents.findIndex((row) => row.id === id)
      const row = { id, ...body, delegates: false, builtin: false, createdAt: 100, updatedAt: 100 }
      if (existing === -1) agents.push(row)
      else agents.splice(existing, 1, row)
      route.fulfill(json({ agent: row }, existing === -1 ? 201 : 200))
      return
    }
    if (route.request().method() === "DELETE") {
      const existing = agents.findIndex((row) => row.id === id)
      if (existing === -1) {
        route.fulfill(json({ error: { code: "not_found", message: "no such agent" } }, 404))
        return
      }
      agents.splice(existing, 1)
      route.fulfill(json({ ok: true }))
      return
    }
    route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404))
  })
  return { puts }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("an agent created through the derived form appears in the + menu with its availability", async ({ page }) => {
  const double = await serve(page)
  await page.goto("/")
  // The sidebar's `+` ends with New agent…, which renders agent.create's form card in the chat (THE FORM LAW).
  await page.getByTestId("tab-add").click()
  const newAgent = page.getByTestId("tab-add-new-agent")
  await expect(newAgent).toHaveText("New agent…")
  await newAgent.click()
  const form = page.locator("[data-kind=flow-form]")
  await expect(form).toBeVisible()
  // The harness select is the harness seam: an unpickable harness is disabled with its reason.
  await expect(page.getByTestId("flow-form-harness").locator("option[value=opencode-kimi]")).toHaveJSProperty("disabled", true)
  await expect(page.getByTestId("flow-form-harness").locator("option[value=opencode-kimi]")).toContainText("no credential")
  await page.getByTestId("flow-form-id").fill("reviewer")
  await page.getByTestId("flow-form-id").press("Enter")
  await page.getByTestId("flow-form-harness").selectOption("codex")
  await page.getByTestId("flow-form-model").fill("gpt-5.6-terra")
  await page.getByTestId("flow-form-model").press("Enter")
  await page.getByTestId("flow-form-purpose").fill("Reviews diffs for correctness")
  await page.getByTestId("flow-form-purpose").press("Enter")
  const submit = page.getByTestId("flow-form-submit")
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(form).toHaveAttribute("data-status", "acted")
  expect(double.puts).toEqual([{
    id: "reviewer",
    body: {
      label: "Reviewer",
      purpose: "Reviews diffs for correctness",
      harness: "codex",
      model: { provider: "openai", id: "gpt-5.6-terra", label: "gpt-5.6-terra" }
    }
  }])
  // The `+` menu lists it after the built-ins, available on Codex's api-key credential.
  await page.getByTestId("tab-add").click()
  const row = page.getByTestId("tab-add-role-reviewer")
  await expect(row).toContainText("Reviewer · gpt-5.6-terra")
  await expect(row).toContainText("OPENAI_API_KEY")
  await expect(row).toBeEnabled()
  // The Agents card lists it too, with Remove (a custom agent) beside Launch and Edit.
  await page.getByTestId("tab-add-new-agent").press("Escape")
  await page.getByTestId("composer-input").fill("/agent.list")
  await page.getByTestId("composer-input").press("Enter")
  const agents = page.locator("[data-kind=agents]")
  await expect(agents).toBeVisible()
  await expect(agents.locator("[data-agent=reviewer]")).toContainText("Reviewer (mine)")
  await expect(page.getByTestId("agents-remove-reviewer")).toBeVisible()
  await expect(page.getByTestId("agents-remove-orchestrator")).toHaveCount(0)
})
