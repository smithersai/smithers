import type { Locator, Page, Response } from "@playwright/test"
import { scenario } from "./coverage/types"
import { expect, realApi, test } from "./support"
import {
  bootWorkbench,
  card,
  changeInput,
  createTargetFixture,
  openTargetFixture,
  readJournal,
  replay,
  runCommand
} from "./targets-graph/fixture"

test.setTimeout(240_000)
test.use({ actionTimeout: 25_000 })

const targets = (page: Page): Locator => card(page, "targets")
const graph = (page: Page): Locator => card(page, "graph")
const runCard = (page: Page): Locator => card(page, "target-run")

const responseFor = (page: Page, path: string): Promise<Response> => page.waitForResponse((response) =>
  response.request().method() === "POST" && new URL(response.url()).pathname === path)

const listTargets = async (
  page: Page,
  request: Parameters<typeof realApi>[1],
  repoId: string
): Promise<{ readonly targets?: Array<{ readonly label?: unknown; readonly workspace?: unknown }> }> => {
  const query = responseFor(page, "/api/targets/query")
  await runCommand(page, `/target.list ${repoId}`)
  const response = await query
  expect(response.status()).toBe(200)
  await expect(targets(page)).toBeVisible({ timeout: 90_000 })
  const read = await realApi(page, request, "POST", "/api/targets/query", { repoId })
  expect(read.status()).toBe(200)
  return await read.json() as { readonly targets?: Array<{ readonly label?: unknown; readonly workspace?: unknown }> }
}

const waitForRun = async (
  page: Page,
  request: Parameters<typeof realApi>[1],
  repoId: string,
  label: string
): Promise<{ readonly card: Locator; readonly runId: string }> => {
  const running = responseFor(page, "/api/targets/run")
  const row = targets(page).locator(`[data-target-row="${label}"]`)
  await row.getByRole("button", { name: `Run ${label}`, exact: true }).click()
  const response = await running
  expect(response.status()).toBe(200)
  const current = runCard(page).filter({ hasText: label })
  await expect(current).toBeVisible({ timeout: 90_000 })
  await expect.poll(() => current.locator(".target-run-card").getAttribute("data-run-status"), { timeout: 90_000 })
    .toMatch(/^(done|failed)$/)
  let runId: string | undefined
  await expect.poll(async () => {
    const listed = await realApi(page, request, "POST", "/api/targets/runs", { repoId })
    if (!listed.ok()) return listed.status()
    const body = await listed.json() as { readonly runs?: readonly { readonly runId?: string; readonly label?: string }[] }
    runId = body.runs?.find((run) => run.label === label)?.runId
    return runId
  }).not.toBeUndefined()
  return { card: current, runId: runId! }
}

const outputLines = (events: readonly Record<string, unknown>[], type: "stdout" | "stderr"): readonly string[] =>
  events.filter((event) => event.type === type).map((event) => String(event.data ?? "")).join("").split(/\r?\n/)

test("target catalog filters, stars, workspaces, and reload state come from a real repository", scenario("targets.catalog-workspace-star-reload", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.list", "action:target.filter", "action:target.star", "host:local", "path:success", "path:keyboard", "path:persistence", "door:slash", "door:user-only", "dimension:keyboard", "dimension:workspace-filter", "dimension:starred-target", "dimension:reload", "evidence:target-query-response-and-card"],
  description: "Load a committed multi-workspace repository, operate its filters and star controls with the keyboard, then verify durable card state after reload."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-catalog")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)
  const body = await listTargets(page, request, repoId)
  const labels = body.targets?.map((target) => target.label)
  expect(labels).toEqual(expect.arrayContaining(["//:input", "//:prepare", "//:successful", "//:failing", "//.github:pipeline", "//:childProbe"]))

  const table = targets(page)
  await expect(table.getByTestId("targets-count")).toHaveText(`${body.targets!.length} of ${body.targets!.length}`)
  await expect(table.locator('[data-target-row="//:successful"]')).toHaveAttribute("data-workspace", ".")
  await expect(table.locator('[data-target-row="//:childProbe"]')).toHaveAttribute("data-workspace", "tools")

  const filter = table.getByTestId("targets-filter-query")
  await filter.focus()
  await page.keyboard.type("childProbe")
  await expect(table.locator("[data-target-row]")).toHaveCount(1)
  await expect(table.locator('[data-target-row="//:childProbe"]')).toBeVisible()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")

  const workspace = table.getByTestId("targets-filter-workspace")
  await workspace.selectOption("tools")
  await expect(workspace).toHaveValue("tools")
  await expect(table.locator("[data-target-row]")).toHaveCount(1)
  await expect(table.locator('[data-target-row="//:childProbe"]')).toBeVisible()
  await workspace.selectOption("*")
  await expect(workspace).toHaveValue("*")

  const star = table.getByTestId("targets-star-//:successful")
  await star.focus()
  await star.press("Space")
  await expect(star).toHaveAttribute("aria-pressed", "true")
  const featured = table.getByTestId("targets-mode-featured")
  await featured.focus()
  await featured.press("Enter")
  await expect(featured).toHaveAttribute("aria-pressed", "true")
  await expect(table.locator("[data-target-row]")).toHaveCount(1)
  await expect(table.locator('[data-target-row="//:successful"]')).toBeVisible()
  const all = table.getByTestId("targets-mode-all")
  await all.focus()
  await all.press("Enter")
  await expect(all).toHaveAttribute("aria-pressed", "true")
  await expect(table.locator("[data-target-row]")).toHaveCount(body.targets!.length)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(targets(page).getByTestId("targets-star-//:successful")).toHaveAttribute("aria-pressed", "true")
  await expect(targets(page).getByTestId("targets-mode-all")).toHaveAttribute("aria-pressed", "true")
  await expect(targets(page).locator("[data-target-row]")).toHaveCount(body.targets!.length)
  await expect(targets(page).locator('[data-target-row="//:successful"]')).toBeVisible()
})

test("dependency topology, focus, filtering, and source navigation agree", scenario("targets.graph-topology-source", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.graph", "action:target.graph.focus", "action:target.graph.filter", "action:target.source.open", "host:local", "path:success", "door:slash", "door:button", "door:user-only", "dimension:dependency-topology", "dimension:source-navigation", "evidence:graph-and-source-api-responses"],
  description: "Compare the graph card's dependency focus, label filter, and source handoff with the real build-loader response."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-mappings")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)
  await listTargets(page, request, repoId)

  const graphResponse = responseFor(page, "/api/targets/graph")
  await runCommand(page, `/target.graph ${repoId} //:successful`)
  const rawGraph = await graphResponse
  expect(rawGraph.status()).toBe(200)
  const graphRead = await realApi(page, request, "POST", "/api/targets/graph", { repoId, plan: true })
  expect(graphRead.status()).toBe(200)
  const graphBody = await graphRead.json() as {
    readonly nodes: Array<{ readonly label: string; readonly source?: { readonly file?: string; readonly line?: number } }>
    readonly edges: Array<{ readonly from: string; readonly to: string; readonly kind: string }>
  }
  expect(graphBody.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: "//:successful", to: "//:prepare", kind: "data" }),
    expect.objectContaining({ from: "//:prepare", to: "//:input", kind: "data" })
  ]))
  expect(graphBody.nodes.find((node) => node.label === "//:successful")?.source).toEqual({ file: "PACKAGE.ts", line: 9 })

  const canvas = graph(page)
  const drawer = canvas.getByTestId("graph-drawer-//:successful")
  await expect(drawer).toBeVisible({ timeout: 90_000 })
  await expect(drawer).toContainText("PACKAGE.ts:9")
  await expect(canvas.locator('[data-label="//:successful"]')).toHaveAttribute("data-focus", "root")
  await expect(canvas.locator('[data-label="//:prepare"]')).toHaveAttribute("data-focus", "highlighted")
  await expect(canvas.locator('[data-label="//:input"]')).toHaveAttribute("data-focus", "highlighted")
  await expect(canvas.locator('[data-label="//:failing"]')).toHaveAttribute("data-focus", "faded")

  await canvas.locator('[data-label="//:prepare"]').click()
  await expect(canvas.getByTestId("graph-drawer-//:prepare")).toBeVisible()
  await expect(canvas.locator('[data-label="//:prepare"]')).toHaveAttribute("data-focus", "root")
  await expect(canvas.locator('[data-label="//:input"]')).toHaveAttribute("data-focus", "highlighted")
  await expect(canvas.locator('[data-label="//:successful"]')).toHaveAttribute("data-focus", "highlighted")
  await canvas.locator('[data-label="//:successful"]').click()
  await expect(drawer).toBeVisible()
  await expect(canvas.locator('[data-label="//:successful"]')).toHaveAttribute("data-focus", "root")

  const sourceResponse = responseFor(page, "/api/targets/open-source")
  await drawer.getByRole("button", { name: "Open", exact: true }).click()
  const source = await sourceResponse
  expect(source.status()).toBe(200)
  const sourceRead = await realApi(page, request, "POST", "/api/targets/open-source", { repoId, file: "PACKAGE.ts", line: 9 })
  expect(sourceRead.status()).toBe(200)
  expect(await sourceRead.json()).toEqual({ path: `${repo.path}/PACKAGE.ts`, line: 9 })

  const search = canvas.getByRole("searchbox", { name: "Filter graph labels" })
  await search.fill("prepare")
  await expect(canvas.locator(".graph-card-counts")).toHaveText("1 targets · 0 edges")
  await expect(canvas.locator('[data-label="//:prepare"]')).toBeVisible()
  await expect(canvas.locator('[data-label="//:successful"]')).toHaveCount(0)
  await search.fill("")
})

test("a real changed file maps through dependencies to every affected target", scenario("targets.affected-jj-working-copy", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.affected", "action:target.graph", "host:local", "path:success", "door:slash", "door:button", "dimension:affected-file", "dimension:jj-working-copy", "dimension:reverse-dependencies", "evidence:affected-api-response-and-card"],
  description: "Change one tracked input in a disposable jj repository and require the affected card to map the file through the real dependency graph."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-affected")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)
  await listTargets(page, request, repoId)
  await changeInput(repo)
  const affectedResponse = responseFor(page, "/api/targets/affected")
  await runCommand(page, `/target.affected ${repoId}`)
  const rawAffected = await affectedResponse
  expect(rawAffected.status()).toBe(200)
  const affectedRead = await realApi(page, request, "POST", "/api/targets/affected", { repoId })
  expect(affectedRead.status()).toBe(200)
  const affectedBody = await affectedRead.json() as {
    readonly repoId: string
    readonly changedFiles: readonly string[]
    readonly affected: readonly { readonly label: string; readonly reason: string }[]
  }
  expect(affectedBody.repoId).toBe(repoId)
  expect(affectedBody.changedFiles).toEqual(["src/input.txt"])
  expect(affectedBody.affected.map((entry) => entry.label)).toEqual(expect.arrayContaining(["//:input", "//:prepare", "//:successful", "//:failing"]))
  const affected = card(page, "affected")
  await expect(affected.getByRole("list", { name: "Changed files" })).toContainText("src/input.txt")
  await expect(affected.locator('[data-affected-row="//:successful"]')).toBeVisible()
  await affected.locator('[data-affected-row="//:successful"]').getByRole("button", { name: "Show in graph" }).click()
  await expect(graph(page).getByTestId("graph-drawer-//:successful")).toBeVisible()
})

test("the generated CI card preserves the real pipeline target mapping and YAML", scenario("targets.ci-matrix-yaml", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.ci", "host:local", "path:success", "door:slash", "dimension:ci-mapping", "dimension:generated-yaml", "evidence:ci-api-response-and-card"],
  description: "Generate CI from a real Github.CiGen target and compare its job target and YAML with the rendered card."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-ci")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)
  const ciResponse = responseFor(page, "/api/targets/ci")
  await runCommand(page, `/target.ci ${repoId}`)
  const rawCi = await ciResponse
  expect(rawCi.status()).toBe(200)
  const ciRead = await realApi(page, request, "POST", "/api/targets/ci", { repoId })
  expect(ciRead.status()).toBe(200)
  const ciBody = await ciRead.json() as { readonly workflows: readonly { readonly name: string; readonly path: string; readonly jobs: readonly { readonly name: string; readonly targets: readonly string[] }[]; readonly yaml: string }[] }
  expect(ciBody.workflows).toHaveLength(1)
  expect(ciBody.workflows[0]?.jobs.some((job) => job.targets.includes("//:successful"))).toBe(true)
  const ci = card(page, "ci-matrix")
  await expect(ci).toContainText(ciBody.workflows[0]!.name)
  await expect(ci).toContainText("//:successful")
  await ci.locator(".ci-matrix-yaml summary").click()
  await expect(ci.locator(".ci-matrix-yaml pre")).toHaveText(ciBody.workflows[0]!.yaml)
})

test("a successful real process preserves exact output, exit, and its durable journal", scenario("targets.run-success-journal", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.list", "action:target.run", "host:local", "path:success", "path:persistence", "door:slash", "door:button", "dimension:real-process", "dimension:stdout-stderr", "dimension:journal-history", "evidence:run-replay-and-journal"],
  description: "Run a dependency-backed target and compare its exact UI output and exit with both the real replay API and physical JSONL journal."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-success")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)
  await listTargets(page, request, repoId)
  const run = await waitForRun(page, request, repoId, "//:successful")
  await expect(run.card.locator(".target-run-card")).toHaveAttribute("data-run-status", "done")
  await expect(run.card).toContainText("exit 0")
  const output = run.card.locator('[data-testid^="target-run-output-"]')
  await expect(output).toContainText("S07_PREPARE_STDOUT_EXACT")
  await expect(output).toContainText("S07_SUCCESS_STDOUT_EXACT")
  await expect(output).toContainText("S07_SUCCESS_STDERR_EXACT")

  const recorded = await replay(page, request, run.runId)
  expect(recorded.run).toMatchObject({ runId: run.runId, label: "//:successful", status: "done", exitCode: 0 })
  expect(outputLines(recorded.events, "stderr")).toContain("//:successful: S07_SUCCESS_STDOUT_EXACT")
  expect(outputLines(recorded.events, "stderr")).toContain("//:successful: S07_SUCCESS_STDERR_EXACT")
  expect(recorded.events.some((event) => event.type === "exit" && event.code === 0)).toBe(true)
  const journal = await readJournal(repo, run.runId)
  expect(outputLines(journal, "stderr")).toContain("//:successful: S07_SUCCESS_STDOUT_EXACT")
  expect(outputLines(journal, "stderr")).toContain("//:successful: S07_SUCCESS_STDERR_EXACT")
  expect(journal.some((event) => event.type === "exit" && event.code === 0)).toBe(true)
})

test("a pattern run is a real server run with its own history and replay identity", scenario("targets.run-pattern-history-replay", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.run.pattern", "action:target.history", "action:target.runs.select", "host:local", "path:success", "path:persistence", "door:slash", "door:button", "dimension:pattern-run", "dimension:real-process", "dimension:run-identity", "evidence:pattern-run-response-history-and-journal"],
  description: "Run one deterministic target through the real pattern endpoint, require the pattern's own run label and output, then recover the same run from persisted history and replay."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-pattern")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)

  const running = responseFor(page, "/api/targets/run")
  await runCommand(page, `/target.run.pattern ${repoId} . test //:successful`)
  const response = await running
  expect(response.status()).toBe(200)
  const accepted = await response.json() as { readonly runId?: unknown }
  expect(typeof accepted.runId).toBe("string")
  const runId = String(accepted.runId)

  const run = runCard(page).filter({ hasText: "test //:successful" })
  await expect(run).toBeVisible({ timeout: 90_000 })
  await expect(run.locator(".target-run-card")).toHaveAttribute("data-run-status", "done")
  await expect(run).toContainText("test //:successful")
  await expect(run).toContainText("S07_SUCCESS_STDOUT_EXACT")
  await expect(run).toContainText("S07_SUCCESS_STDERR_EXACT")

  const recorded = await replay(page, request, runId)
  expect(recorded.run).toMatchObject({ runId, label: "test //:successful", status: "done", exitCode: 0 })
  expect(recorded.events.some((event) => event.type === "exit" && event.code === 0)).toBe(true)

  await runCommand(page, `/target.history ${repoId}`)
  const history = card(page, "run-history")
  const row = history.locator(`[data-run-row="${runId}"]`)
  await expect(row).toContainText("test //:successful")
  await row.locator(".run-history-select").click()
  const timeline = card(page, "run-timeline")
  await expect(timeline).toBeVisible()
  await expect(timeline.locator('[data-timeline-row="//:successful"]')).toHaveAttribute("data-status", /^(ran|hit)$/)
  await timeline.locator('[data-timeline-row="//:successful"]').click()
  await expect(timeline.locator('[data-testid^="run-timeline-log-"]')).toContainText("S07_SUCCESS_STDOUT_EXACT")
})

test("persisted history restores keyboard scrubbing and target-specific output", scenario("targets.history-replay-output-attribution", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.list", "action:target.run", "action:target.history", "action:target.runs.select", "action:target.run.scrub", "host:local", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button", "door:user-only", "dimension:keyboard", "dimension:reload", "dimension:replay-scrubber", "dimension:target-output-attribution", "evidence:restored-history-timeline"],
  description: "Reload after a real successful run, restore it from history, scrub the timeline by keyboard, and require its target-specific output."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-history")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)
  await listTargets(page, request, repoId)
  const run = await waitForRun(page, request, repoId, "//:successful")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  const historyResponse = responseFor(page, "/api/targets/runs")
  await runCommand(page, `/target.history ${repoId}`)
  expect((await historyResponse).status()).toBe(200)
  const history = card(page, "run-history")
  const historyRow = history.locator(`[data-run-row="${run.runId}"]`)
  await expect(historyRow).toContainText("//:successful")
  await historyRow.locator(".run-history-select").click()

  const timeline = card(page, "run-timeline")
  await expect(timeline).toBeVisible()
  await expect(timeline.locator('[data-timeline-row="//:successful"]')).toHaveAttribute("data-status", "ran")
  await expect(timeline.locator('[data-timeline-row="//:prepare"]')).toHaveAttribute("data-status", /^(ran|hit)$/)
  const scrubber = timeline.getByRole("slider", { name: "Replay cursor" })
  const settled = await timeline.locator("[data-timeline-row]").count()
  await scrubber.focus()
  await page.keyboard.press("Home")
  await expect.poll(() => timeline.locator("[data-timeline-row]").count()).toBeLessThan(settled)
  await page.keyboard.press("End")
  await expect.poll(() => timeline.locator("[data-timeline-row]").count()).toBe(settled)
  await timeline.locator('[data-timeline-row="//:successful"]').click()
  await expect(timeline.locator('[data-testid^="run-timeline-log-"]')).toContainText("S07_SUCCESS_STDOUT_EXACT")
  await expect(timeline.locator('[data-testid^="run-timeline-log-"]')).toContainText("S07_SUCCESS_STDERR_EXACT")
})

test("a failing real process exposes exact stderr and child exit 23 in history and replay", scenario("targets.run-failure-history-replay", {
  capabilities: ["local.repositories", "local.targets"],
  coverage: ["action:repo.open", "action:target.list", "action:target.run", "action:target.history", "action:target.runs.select", "host:local", "path:error", "door:slash", "door:button", "dimension:real-process", "dimension:nonzero-exit", "dimension:stderr", "dimension:failure-history", "evidence:failed-run-replay-and-journal"],
  description: "Run a deterministic exit-23 target and require its exact output, terminal status, persisted history row, replay log, and physical journal."
}), async ({ page, request }) => {
  const repo = await createTargetFixture("targets-failure")
  await bootWorkbench(page)
  const repoId = await openTargetFixture(page, request, repo)
  await listTargets(page, request, repoId)
  const run = await waitForRun(page, request, repoId, "//:failing")
  await expect(run.card.locator(".target-run-card")).toHaveAttribute("data-run-status", "failed")
  await expect(run.card).toContainText("exit 23")
  const output = run.card.locator('[data-testid^="target-run-output-"]')
  await expect(output).toContainText("S07_FAILURE_STDOUT_EXACT")
  await expect(output).toContainText("S07_FAILURE_STDERR_EXACT")

  const recorded = await replay(page, request, run.runId)
  expect(recorded.run).toMatchObject({ runId: run.runId, label: "//:failing", status: "failed", exitCode: 1 })
  expect(outputLines(recorded.events, "stderr")).toContain("//:failing: S07_FAILURE_STDOUT_EXACT")
  expect(outputLines(recorded.events, "stderr")).toContain("//:failing: S07_FAILURE_STDERR_EXACT")
  expect(recorded.events.some((event) => event.type === "node" && (event.node as Record<string, unknown>)?.label === "//:failing" && (event.node as Record<string, unknown>)?.status === "failed" && String((event.node as Record<string, unknown>)?.reason).includes("exit 23"))).toBe(true)
  expect(recorded.events.some((event) => event.type === "exit" && event.code === 1)).toBe(true)
  const journal = await readJournal(repo, run.runId)
  expect(outputLines(journal, "stderr")).toContain("//:failing: S07_FAILURE_STDOUT_EXACT")
  expect(outputLines(journal, "stderr")).toContain("//:failing: S07_FAILURE_STDERR_EXACT")
  expect(journal.some((event) => event.type === "node" && (event.node as Record<string, unknown>)?.label === "//:failing" && String((event.node as Record<string, unknown>)?.reason).includes("exit 23"))).toBe(true)
  expect(journal.some((event) => event.type === "exit" && event.code === 1)).toBe(true)

  await runCommand(page, `/target.history ${repoId}`)
  const history = card(page, "run-history")
  const row = history.locator(`[data-run-row="${run.runId}"]`)
  await expect(row).toContainText("Failed")
  await expect(row).toContainText("//:failing")
  await row.locator(".run-history-select").click()
  const timeline = card(page, "run-timeline")
  await expect(timeline.locator('[data-timeline-row="//:failing"]')).toHaveAttribute("data-status", "failed")
  await timeline.locator('[data-timeline-row="//:failing"]').click()
  await expect(timeline.locator('[data-testid^="run-timeline-log-"]')).toContainText("//:failing")
  await expect(timeline.locator('[data-testid^="run-timeline-log-"]')).toContainText("failed")
})
