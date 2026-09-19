import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test"
import type { OwnedWorkflowRepository } from "../flow-execution/fixture"
import { acceptedRunId, gatewayCall, runSummary } from "../flow-execution/production"
import { attachProductionJson } from "../repositories-github/production"
import { closeComposer, command, expect } from "../support/test"
import { journalMeaning, requireLaterPhase, type JournalRow, type Meaning } from "./semantic"
import { frameLines, phaseStrip, readBands, readLines, readPins } from "./timeline"

export const readJournal = async (page: Page, request: APIRequestContext, owned: OwnedWorkflowRepository, runId: string): Promise<readonly JournalRow[]> => {
  const answer = await gatewayCall(page, request, owned.repo, "Projection.Snapshot", { selector: { _tag: "run-events", runId } }, owned.workspaceId)
  const rows = (answer.payload as { rows?: unknown }).rows
  expect(Array.isArray(rows)).toBe(true)
  return rows as readonly JournalRow[]
}

/** Resolve the source card from the accepted request in this exact repository/workspace. */
export const launchSubject = async (page: Page, owned: OwnedWorkflowRepository, flow: string, input: Record<string, unknown>, testInfo: TestInfo) => {
  const accepted = acceptedRunId(page, owned.repo, owned)
  const scoped = page.waitForResponse(response => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
    const body = response.request().postDataJSON()
    return body.repo === owned.repo && body.workspaceId === owned.workspaceId && body.procedure === "Plan" && body.payload?.flowId === flow
  })
  const running = page.waitForResponse(response => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
    const body = response.request().postDataJSON()
    return body.repo === owned.repo && body.workspaceId === owned.workspaceId && body.procedure === "Run"
  })
  void scoped.catch(() => undefined)
  void running.catch(() => undefined)
  await command(page, `/flow.run ${flow} ${owned.repo} ${JSON.stringify(input)}`)
  const runId = await accepted
  const response = await scoped
  const body = response.request().postDataJSON() as { repo: string; workspaceId: string; payload: { idempotencyKey: string } }
  const plan = await response.json() as { payload: { planId: string } }
  const runResponse = await running
  expect(runResponse.request().postDataJSON().payload.planId).toBe(plan.payload.planId)
  const receipt = await runResponse.json() as { payload: { runId: string } }
  expect(receipt.payload.runId).toBe(runId)
  expect(body.payload.idempotencyKey).toMatch(/^plan:[0-9a-f-]{36}$/)
  const cardId = `flow-request-${body.payload.idempotencyKey.slice("plan:".length)}`
  const card = page.getByTestId(`card-${cardId}`)
  await closeComposer(page)
  await expect(card).toHaveCount(1)
  await expect(card).toHaveAttribute("data-run-id", runId)
  await expect(card.locator(".smithers-card-title")).toContainText(owned.repo)
  await attachProductionJson(testInfo, "timeline-run-scope", { repo: body.repo, workspaceId: body.workspaceId, runId, cardId, requestId: body.payload.idempotencyKey })
  return { runId, card, trace: card.getByTestId(`run-trace-${runId}`) }
}

const renderedLines = async (trace: Locator) => (await readLines(trace)).map(line => ({
  node: line.node, number: line.number, verb: line.verb.join(""), subject: line.subject.join(""), result: line.result.join("")
}))

export const compareMeaning = async (card: Locator, trace: Locator, meaning: Meaning, status = meaning.status): Promise<void> => {
  await expect.poll(async () => (await readBands(trace)).map(band => ({ phase: band.phase, seq: band.seq })), { timeout: 60000 }).toEqual(meaning.bands)
  expect(await renderedLines(trace)).toEqual(meaning.lines)
  expect((await readPins(trace)).map(pin => ({ seq: pin.seq, label: pin.label }))).toEqual(meaning.pins)
  await expect(card.locator(".run-outcome-words")).toHaveText(status)
  // Prompt subjects record no coding plan. Inventing a goal or a verified state fails here.
  await expect(card.locator("[data-goal]")).toHaveCount(meaning.goals.length)
}

/** Observe both an early frame and later calls while the gateway still says running. */
export const inspectRunning = async (page: Page, request: APIRequestContext, owned: OwnedWorkflowRepository,
  subject: Awaited<ReturnType<typeof launchSubject>>, testInfo: TestInfo): Promise<void> => {
  const samples: unknown[] = []
  try {
    let first: readonly JournalRow[] = []
    await expect.poll(async () => {
      first = await readJournal(page, request, owned, subject.runId)
      return first.filter(({ kind: journalKind }) => journalKind === "control.agent.turn-opened").length
    }, { timeout: 120000, intervals: [300, 600, 1000] }).toBeGreaterThan(0)
    const summary = async () => runSummary(await gatewayCall(page, request, owned.repo, "Projection.Snapshot", {
      selector: { _tag: "run-summary", runId: subject.runId }
    }, owned.workspaceId))
    const firstSummary = await summary()
    expect(firstSummary?.status, "inspection attaches before settlement").toBe("running")
    await expect(phaseStrip(subject.trace)).toBeVisible()
    await expect(subject.card.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
    const earlyBands = await readBands(subject.trace)
    samples.push({ stage: "first-frame", summary: firstSummary, journal: first, bands: earlyBands,
      header: await subject.card.locator(".run-outcome-words").textContent() })
    let later: readonly JournalRow[] = []
    await expect.poll(async () => {
      later = await readJournal(page, request, owned, subject.runId)
      return later.filter(({ kind: journalKind }) => journalKind === "control.agent.cell-call-started").length
    }, { timeout: 180000, intervals: [500, 1000] }).toBeGreaterThan(1)
    const laterSummary = await summary()
    expect(laterSummary?.status, "new calls arrive during inspection").toBe("running")
    const expected = journalMeaning(later)
    await compareMeaning(subject.card, subject.trace, expected)
    expect(expected.frames.length, "a later frame extends the live strip").toBeGreaterThan(1)
    expect(expected.bands).not.toEqual(earlyBands.map(band => ({ phase: band.phase, seq: band.seq })))
    samples.push({ stage: "later-running-frame", summary: laterSummary, journal: later, expected,
      bands: await readBands(subject.trace), header: await subject.card.locator(".run-outcome-words").textContent() })
    await subject.card.screenshot({ path: testInfo.outputPath("timeline-running.png") })
    await testInfo.attach("timeline-running", { path: testInfo.outputPath("timeline-running.png"), contentType: "image/png" })
  } finally { await attachProductionJson(testInfo, "timeline-live-observations", samples) }
}

const press = async (control: Locator, key: string): Promise<void> => {
  await control.focus(); await expect(control).toBeFocused(); await control.press(key)
}

/** Each cursor is checked again after reload, so a DOM-only keyboard response cannot pass. */
export const inspectKeyboard = async (page: Page, subject: Awaited<ReturnType<typeof launchSubject>>, rows: readonly JournalRow[], testInfo: TestInfo): Promise<void> => {
  const { trace, card } = subject, whole = journalMeaning(rows), later = requireLaterPhase(whole)
  const steps: unknown[] = []
  const at = async (seq: number, action: string) => {
    await expect(trace.getByText(`At #${seq}`, { exact: true })).toBeVisible()
    expect(await renderedLines(trace)).toEqual(journalMeaning(rows, seq).lines)
    await expect(card.locator(".run-outcome-words")).toHaveText(whole.status)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(trace.getByText(`At #${seq}`, { exact: true })).toBeVisible()
    expect(await renderedLines(trace)).toEqual(journalMeaning(rows, seq).lines)
    expect((await readBands(trace)).map(band => ({ phase: band.phase, seq: band.seq }))).toEqual(whole.bands)
    steps.push({ action, seq, persisted: true })
  }
  try {
    await press(phaseStrip(trace).locator(`button[data-phase-band][data-seq="${whole.bands[0]!.seq}"]`), "Enter")
    await at(whole.bands[0]!.seq, "first band Enter")
    await press(phaseStrip(trace).locator(`button[data-phase-band][data-seq="${later.seq}"]`), "Space")
    await at(later.seq, "later phase Space")
    const positions = [...new Set(rows.map(row => Number(row.sequence)))].sort((a, b) => a - b)
    const slider = trace.getByRole("slider", { name: "Run position" })
    for (const [key, index] of [["Home", 0], ["ArrowRight", 1], ["PageUp", 11], ["PageDown", 1], ["End", positions.length - 1], ["ArrowLeft", positions.length - 2]] as const) {
      await press(slider, key)
      await at(positions[Math.min(Math.max(index, 0), positions.length - 1)]!, `slider ${key}`)
    }
    await press(trace.getByRole("button", { name: "Latest", exact: true }), "Enter")
    await expect(trace.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
    const line = frameLines(trace).filter({ has: trace.page().locator('.run-line-subject', { hasText: "README.md" }) }).first()
    const node = await line.getAttribute("data-frame-line")
    await press(line, "Enter")
    await expect(line).toHaveAttribute("aria-expanded", "true")
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(trace.locator(`button[data-frame-line="${node}"]`)).toHaveAttribute("aria-expanded", "true")
    await press(trace.locator(`button[data-frame-line="${node}"]`), "Space")
    await expect(trace.locator(`button[data-frame-line="${node}"]`)).toHaveAttribute("aria-expanded", "false")
    steps.push({ action: "frame Enter/reload/Space", node, persisted: true })
    const cluster = phaseStrip(trace).locator('details[class~="run-phase-cluster"]').first()
    if (await cluster.count() === 0) {
      const fact = { _tag: "ClusterNotRecorded", message: "This journal did not produce a milestone cluster. Cluster keyboard coverage remains absent." }
      await attachProductionJson(testInfo, "timeline-cluster-gap", fact)
      testInfo.annotations.push({ type: fact._tag, description: fact.message })
    } else {
      const summary = cluster.locator("summary")
      await press(summary, "Enter"); await expect(cluster).toHaveAttribute("open", "")
      await press(summary, "Escape"); await expect(cluster).not.toHaveAttribute("open", "")
      await press(summary, "Space"); await expect(cluster).toHaveAttribute("open", "")
      const member = cluster.getByRole("button").first()
      const seq = Number((await member.getAttribute("data-flow-args"))!.split(" ").at(-1))
      await summary.press("Tab"); await expect(member).toBeFocused(); await member.press("Enter")
      await expect(summary).toBeFocused(); await at(seq, "cluster Enter/Escape/Space/Tab/Enter")
    }
    await press(slider, "Home"); await press(trace.getByRole("button", { name: "Latest", exact: true }), "Enter")
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(trace.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
    await compareMeaning(card, trace, whole)
    steps.push({ action: "Latest Enter/reload", persisted: true })
  } finally { await attachProductionJson(testInfo, "timeline-keyboard-roundtrips", steps) }
}
