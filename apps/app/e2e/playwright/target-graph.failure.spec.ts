import { expect, test } from "@playwright/test"
import type { WebSocketRoute } from "@playwright/test"
import type { TargetRunFrame, TargetsQueryResponse } from "@smthrs/rpc/LocalApp"
import type { RunRecord, TargetGraphResponse } from "@smthrs/rpc/TargetGraph"
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { localApiGet, localApiPost } from "./localApi"

/*
 * Detection for the CI-only query-contributor exception seen while a failed
 * node reached the graph and run cards. The original exception has not been
 * reproduced locally; this exercises the captured transition sequence in the
 * actual browser and asserts terminal state, history, and absence of errors.
 * HTTP and WebSocket seams supply the failure without depending on a host's
 * sandbox being unavailable. No target process or model is launched.
 */
test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")

test("a failed node settles the graph, run card, and target history without a query exception", async ({ page, request }) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "smithers-failed-target-")))
  const repository = join(directory, "repo")
  cpSync(resolve(__dirname, "../fixtures/repo-plugin"), repository, {
    recursive: true,
    filter: (path) => ![".git", ".flows", "node_modules"].includes(basename(path))
  })
  let repoId: string | undefined
  let socket: WebSocketRoute | undefined
  let history: Array<RunRecord> = []
  const errors: Array<string> = []
  const runId = "failed-target-run"
  const label = "//:hello"
  const startedAt = Date.now()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => window.localStorage.clear())
  await page.route("**/api/targets/query", (route) => route.fulfill({ json: {
    targets: [{ id: "hello-target", label, target: "Shell.Test", kinds: ["test"], package: "//", name: "hello", workspace: "." }],
    warnings: [],
    durationMs: 1
  } satisfies TargetsQueryResponse }))
  await page.route("**/api/targets/graph", (route) => route.fulfill({ json: {
    repoId: repoId!,
    nodes: [{ label, package: "//", name: "hello", rule: "Shell.Test", kinds: ["test"], private: false }],
    edges: [],
    warnings: [],
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: 1
  } satisfies TargetGraphResponse }))
  await page.route("**/api/targets/runs", (route) => route.fulfill({ json: { runs: history } }))
  await page.route("**/api/targets/run", (route) => route.fulfill({ json: { runId } }))
  await page.routeWebSocket("**/ws", (route) => {
    route.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as { type: string; runId?: string }
      if (parsed.type === "target-run.attach" && parsed.runId === runId) socket = route
    })
  })
  const command = async (text: string) => {
    await page.getByTestId("composer-input").fill(text)
    await page.getByTestId("composer-send").click()
  }
  const send = (frame: TargetRunFrame) => socket!.send(JSON.stringify({ type: "target-run", runId, frame }))

  try {
    await page.goto("/")
    page.once("dialog", (dialog) => void dialog.accept(repository))
    await page.getByTestId("composer-repo-trigger").click()
    await page.getByTestId("chrome-open-repo").click()
    await expect(page.getByTestId("repo-chip")).toHaveAttribute("title", repository)
    const listed = await localApiGet(page, request, "/api/repos")
    expect(listed.ok()).toBe(true)
    const { repos } = await listed.json() as { repos: Array<{ id: string; path: string }> }
    repoId = repos.find((repo) => repo.path === repository)?.id
    expect(repoId).toBeDefined()
    await command("/target.list")
    const targets = page.locator('.smithers-card[data-kind="targets"]')
    await expect(targets.locator(`[data-target-row="${label}"]`)).toBeVisible()
    await command(`/target.graph ${label}`)
    const graph = page.locator('.smithers-card[data-kind="graph"]')
    await graph.locator('[data-flow="target.run"]').click()
    const run = page.locator('.smithers-card[data-kind="target-run"]')
    await expect(run.locator(".target-run-card")).toHaveAttribute("data-run-status", "running")
    await expect.poll(() => socket !== undefined).toBe(true)
    send({ type: "started", runId, label, labels: [label], at: startedAt, seq: 0 })
    send({ type: "stderr", data: "Running //:hello\n", seq: 1 })
    await expect(run.locator(".target-run-output")).toContainText("Running //:hello")

    const endedAt = startedAt + 122
    const reason = "sandbox: the declared confinement cannot be enforced on this host: bwrap is not on PATH"
    const summary = { total: 1, hit: 0, ran: 0, failed: 1, skipped: 0, durationMs: 122, ok: false, criticalPath: [label] }
    history = [{ runId, repoId: repoId!, label, labels: [label], status: "failed", startedAt, endedAt, exitCode: 1, summary }]
    // Deliver the final frames together, while both card projections persist.
    send({ type: "stderr", data: `${reason}\n`, label, seq: 2 })
    send({ type: "node", node: { label, status: "failed", startedAt, endedAt, durationMs: 122, reason }, at: endedAt, seq: 3 })
    send({ type: "summary", summary, at: endedAt, seq: 4 })
    send({ type: "exit", code: 1, seq: 5 })
    await expect(graph.locator(`.graph-node[data-label="${label}"]`)).toHaveAttribute("data-run-status", "failed")
    await expect(run.locator(".target-run-card")).toHaveAttribute("data-run-status", "failed")
    await expect(run).toHaveAttribute("data-status", "error")
    await expect(run.locator(`[data-run-row="${label}"]`)).toHaveAttribute("data-node-status", "failed")
    await expect(run.locator('[data-kpi="failed"] .sui-kpi-value')).toHaveText("1")
    await expect(targets.locator(`[data-target-row="${label}"]`)).toHaveAttribute("data-state", "failed")
    expect(errors).toEqual([])
  } finally {
    if (repoId !== undefined) await localApiPost(page, request, "/api/repo/close", { repoId })
    rmSync(directory, { recursive: true, force: true })
  }
})
