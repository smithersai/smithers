import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test"
import type { OwnedWorkflowRepository } from "../flow-execution/fixture"
import { acceptedRunId, gatewayCall, runSummary } from "../flow-execution/production"
import { attachProductionJson } from "../repositories-github/production"
import { closeComposer, command, expect, reloadApp } from "../support/test"
import { GESTURE_SOURCES, STRIP_SOURCES, deployedHeaderSource, deployedSource } from "./revisions"
import { journalMeaning, requireLaterPhase, type JournalRow, type Meaning } from "./semantic"
import { frameLines, phaseStrip, readBands, readLines, readPins } from "./timeline"

export const readJournal = async (page: Page, request: APIRequestContext, owned: OwnedWorkflowRepository, runId: string): Promise<readonly JournalRow[]> => {
  const answer = await gatewayCall(page, request, owned.repo, "Projection.Snapshot", { selector: { _tag: "run-events", runId } }, owned.workspaceId)
  const rows = (answer.payload as { rows?: unknown }).rows
  expect(Array.isArray(rows)).toBe(true)
  return rows as readonly JournalRow[]
}

/**
 * A run can report a terminal status before its final output document is
 * readable: two production runs of the same module answered `completed` with
 * the document present once and absent once. This waits for the document the
 * terminal status promises instead of reading whichever arrived first.
 */
export const readFinalOutput = async (page: Page, request: APIRequestContext, owned: OwnedWorkflowRepository, runId: string): Promise<string> => {
  let document: unknown
  await expect.poll(async () => {
    const answer = await gatewayCall(page, request, owned.repo, "Projection.Snapshot", { selector: { _tag: "run-summary", runId } }, owned.workspaceId)
    document = runSummary(answer)?.finalOutput
    return typeof document === "string"
  }, { message: "a completed run must record its final output document", timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(true)
  return document as string
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

export const compareMeaning = async (card: Locator, trace: Locator, meaning: Meaning, status = meaning.status) => {
  await expect.poll(async () => (await readBands(trace)).map(band => ({ phase: band.phase, seq: band.seq })), { timeout: 60000 }).toEqual(meaning.bands)
  expect(await renderedLines(trace)).toEqual(meaning.lines)
  expect((await readPins(trace)).map(pin => ({ seq: pin.seq, label: pin.label }))).toEqual(meaning.pins)
  // Retain the failed verdict while allowing the owned run to finish and archive its edit and controls.
  await expect.soft(card.locator(".run-outcome-words")).toHaveText(status)
  // Prompt subjects record no coding plan. Inventing a goal or a verified state fails here.
  await expect(card.locator("[data-goal]")).toHaveCount(meaning.goals.length)
  // These subjects request no human decision. A stray action or condition is also a false header.
  await expect(card.locator(".run-outcome-condition")).toHaveCount(0)
  await expect(card.locator(".run-outcome").getByRole("button")).toHaveCount(0)
  return { bands: await readBands(trace), lines: await renderedLines(trace), pins: await readPins(trace),
    status: await card.locator(".run-outcome-words").textContent(), goals: [] }
}

/**
 * A journal that opened no frame has no timeline to place a moment on, so the
 * card must draw no strip at all rather than invent one. The caller reaches
 * this only on a host that predates the producer; a host that carries it
 * requires recorded frames instead.
 */
export const compareEmptyTimeline = async (card: Locator, trace: Locator, meaning: Meaning) => {
  expect(meaning.frames, "an empty timeline is only the reading for a journal with no recorded frames").toEqual([])
  await expect(phaseStrip(trace)).toHaveCount(0)
  expect(await readLines(trace)).toEqual([])
  await expect.soft(card.locator(".run-outcome-words")).toHaveText(meaning.status)
  await expect(card.locator("[data-goal]")).toHaveCount(0)
  await expect(card.locator(".run-outcome-condition")).toHaveCount(0)
  await expect(card.locator(".run-outcome").getByRole("button")).toHaveCount(0)
  return { bands: [], lines: [], pins: [], status: await card.locator(".run-outcome-words").textContent() }
}

/** One DOM read captures the header and strip at the same rendered journal boundary. */
const liveDom = (card: Locator) => card.evaluate(element => {
  const text = (node: Element | null) => (node?.textContent ?? "").trim()
  return {
    through: Number(element.querySelector('[role="slider"]')?.getAttribute("aria-valuemax") ?? -1),
    status: text(element.querySelector(".run-outcome-words")),
    phase: element.querySelector(".run-outcome")?.getAttribute("data-phase"),
    bands: [...element.querySelectorAll("button[data-phase-band]")].map(node => ({ phase: node.getAttribute("data-phase-band"), seq: Number(node.getAttribute("data-seq")) })),
    lines: [...element.querySelectorAll("button[data-frame-line]")].map(node => ({
      node: node.getAttribute("data-frame-line"), number: text(node.querySelector(".run-line-number")),
      verb: text(node.querySelector(".run-line-verb")), subject: text(node.querySelector(".run-line-subject")), result: text(node.querySelector(".run-line-result"))
    })),
    pins: [...element.querySelectorAll('.run-phase-pins button[data-flow]')].map(node => ({
      seq: Number(node.getAttribute("data-flow-args")?.split(" ").at(-1)), label: text(node.querySelector("span"))
    })),
    goals: [...element.querySelectorAll("[data-goal]")].map(node => ({ id: node.getAttribute("data-goal"), state: node.getAttribute("data-state") })),
    conditions: [...element.querySelectorAll(".run-outcome-condition")].map(text),
    actions: [...element.querySelectorAll(".run-outcome button")].map(text)
  }
})

/** Match each DOM snapshot to the independently read journal sequence, then require growth between them. */
export const inspectRunning = async (page: Page, request: APIRequestContext, owned: OwnedWorkflowRepository,
  subject: Awaited<ReturnType<typeof launchSubject>>, testInfo: TestInfo, frontendRevision: string,
  meaningOf = journalMeaning, requireCallGrowth = true): Promise<void> => {
  type Sample = { journal: readonly JournalRow[]; expected: Meaning; rendered: Awaited<ReturnType<typeof liveDom>>; summary: ReturnType<typeof runSummary> }
  const samples: Sample[] = []
  const observe = async (previous?: Sample): Promise<Sample> => {
    let sample: Sample | undefined
    await expect.poll(async () => {
      const journal = await readJournal(page, request, owned, subject.runId)
      const expected = meaningOf(journal)
      const callCount = (meaning: Meaning) => meaning.frames.reduce((n, frame) => n + frame.calls.length, 0)
      if (expected.frames.length <= (previous?.expected.frames.length ?? 0) ||
        requireCallGrowth && previous !== undefined && callCount(expected) <= callCount(previous.expected)) return false
      const rendered = await liveDom(subject.card)
      const through = Math.max(...journal.map(row => Number(row.sequence)))
      if (rendered.through !== through) return false
      const summary = runSummary(await gatewayCall(page, request, owned.repo, "Projection.Snapshot", {
        selector: { _tag: "run-summary", runId: subject.runId }
      }, owned.workspaceId))
      expect(summary?.status, "the shared journal boundary is observed while running").toBe("running")
      sample = { journal, expected, rendered, summary }
      return true
      // A later sample needs the subject's next frame, which is a model response away.
    }, { message: "a later journal boundary must arrive while the run is still running", timeout: 300000, intervals: [250, 500, 1000] }).toBe(true)
    return sample!
  }
  const deployed = deployedHeaderSource(frontendRevision)
  const headerGaps: unknown[] = []
  try {
    const first = await observe()
    samples.push(first)
    const later = await observe(first)
    samples.push(later)
    for (const sample of samples) {
      expect(sample.rendered.bands).toEqual(sample.expected.bands)
      expect(sample.rendered.lines).toEqual(sample.expected.lines)
      expect(sample.rendered.pins).toEqual(sample.expected.pins)
      expect(sample.rendered.goals).toEqual(sample.expected.goals)
      expect(sample.rendered.conditions).toEqual([])
      expect(sample.rendered.actions).toEqual([])
      // A deployed build that carries this working copy's header source must say exactly what the
      // journal recorded. Only the one known older reading, a cell announcement standing in for the
      // call it hid, is recorded as an absent proof instead, naming the revision that produced it.
      if (sample.rendered.status !== sample.expected.status &&
        deployed._tag === "DeployedSourcePredatesWorkingCopy" && sample.rendered.status === "Running code") {
        headerGaps.push({ _tag: "DeployedHeaderPredatesWorkingCopy", frontendRevision, files: deployed.files,
          through: sample.rendered.through, recorded: sample.expected.status, rendered: sample.rendered.status,
          message: `${deployed.message}; its header said "Running code" where the journal records ${JSON.stringify(sample.expected.status)}` })
      } else expect(sample.rendered.status).toBe(sample.expected.status)
      expect(sample.rendered.phase).toBe("running")
    }
    expect(later.rendered.through).toBeGreaterThan(first.rendered.through)
    // Two consecutive frames of the same phase are one band, so a live strip can
    // advance without a new band. The frame lines are what must have grown.
    expect(later.rendered.lines).not.toEqual(first.rendered.lines)
    expect(later.rendered.lines.length).toBeGreaterThan(first.rendered.lines.length)
    await subject.card.screenshot({ path: testInfo.outputPath("timeline-running.png") })
    await testInfo.attach("timeline-running", { path: testInfo.outputPath("timeline-running.png"), contentType: "image/png" })
  } finally {
    await attachProductionJson(testInfo, "timeline-live-observations", samples)
    await attachProductionJson(testInfo, "timeline-deployed-header-source", { deployed, headerGaps })
    for (const gap of headerGaps) testInfo.annotations.push({ type: "DeployedHeaderPredatesWorkingCopy", description: String((gap as { message: string }).message) })
  }
}

/**
 * Gather evidence in a `finally` without replacing the failure it belongs to.
 *
 * A throw inside `finally` discards the exception the block was entered with.
 * A production attempt lost its real failure that way: the gateway answered a
 * journal read with no `ok` field, and the error the run reported was that read
 * rather than whatever the scenario had actually found. The gathering failure is
 * attached, and it only fails the test when the test had nothing else to say.
 */
export const gatherEvidence = async (testInfo: TestInfo, gather: () => Promise<void>): Promise<void> => {
  try { await gather() } catch (error) {
    await attachProductionJson(testInfo, "timeline-evidence-error", {
      _tag: "EvidenceNotGathered", message: error instanceof Error ? error.message : String(error)
    })
    testInfo.annotations.push({ type: "EvidenceNotGathered", description: String(error) })
    if (testInfo.errors.length === 0) throw error
  }
}

const press = async (control: Locator, key: string): Promise<void> => {
  await control.focus(); await expect(control).toBeFocused(); await control.press(key)
}

/** Presses inside one band's own bar and releases inside it, so the committed position stays in that band. */
const scrubWithinBand = async (page: Page, trace: Locator, seq: number): Promise<number> => {
  const band = phaseStrip(trace).locator(`button[data-phase-band][data-seq="${seq}"]`)
  const box = await band.boundingBox()
  expect(box, "the band must be laid out before it can be dragged").not.toBeNull()
  const slider = trace.getByRole("slider", { name: "Run position" })
  const before = await slider.getAttribute("aria-valuenow")
  const y = box!.y + box!.height / 2
  await page.mouse.move(box!.x + box!.width * 0.15, y)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.85, y, { steps: 8 })
  await page.mouse.up()
  /*
   * The release dispatches one selection that is persisted before the card
   * re-renders, so the slider still reads the previous cursor for a beat. A
   * production attempt read it in the same tick and reported the position the
   * cluster walk had left behind. This waits for the write, bounded, and then
   * returns whatever the slider says, so the caller's assertions carry the
   * value the card actually committed rather than a message about waiting.
   */
  const deadline = Date.now() + 15_000
  let now = before
  while (now === before && Date.now() < deadline) {
    await page.waitForTimeout(250)
    now = await slider.getAttribute("aria-valuenow")
  }
  return Number(now)
}

/** One capture per width, with the card's own box proving it did not overflow that width. */
const captureWidths = async (page: Page, card: Locator, testInfo: TestInfo, label: string): Promise<unknown[]> => {
  const original = page.viewportSize()
  const measured: unknown[] = []
  try {
    for (const width of [390, 900] as const) {
      await page.setViewportSize({ width, height: 900 })
      const overflow = await card.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
      expect(overflow.scrollWidth, `the run card reads without sideways scrolling at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth + 1)
      const path = testInfo.outputPath(`${label}-${width}.png`)
      await card.screenshot({ path })
      await testInfo.attach(`${label}-${width}`, { path, contentType: "image/png" })
      measured.push({ width, ...overflow })
    }
  } finally { if (original) await page.setViewportSize(original) }
  return measured
}

/** Each cursor is checked again after reload, so a DOM-only keyboard response cannot pass. */
export const inspectKeyboard = async (page: Page, subject: Awaited<ReturnType<typeof launchSubject>>, rows: readonly JournalRow[], testInfo: TestInfo, frontendRevision: string): Promise<void> => {
  const { trace, card } = subject, whole = journalMeaning(rows), later = requireLaterPhase(whole)
  const steps: unknown[] = []
  const at = async (seq: number, action: string) => {
    const frame = [...whole.frames].reverse().find(frame => frame.opens <= seq)
    const selected = frame?.node ?? `run:${subject.runId}`
    const current = [...whole.bands].reverse().find(band => band.seq <= seq)?.seq
    // What the card actually parked on, recorded before the assertions so a
    // failed step says where the cursor went instead of only where it did not.
    const observed = await trace.evaluate(element => ({
      cursor: element.querySelector(".run-trace-cursor")?.textContent ?? null,
      valuenow: element.querySelector('[role="slider"]')?.getAttribute("aria-valuenow") ?? null,
      latest: element.querySelector('button[data-flow="runs.trace.live"]') !== null
    }))
    steps.push({ action, seq, observed })
    const check = async () => {
      await expect(trace.getByText(`At #${seq}`, { exact: true })).toBeVisible()
      await expect(trace.getByRole("slider", { name: "Run position" })).toHaveAttribute("aria-valuenow", String(seq))
      await expect(trace.locator(`button[data-trace-span="${selected}"]`)).toHaveAttribute("aria-pressed", "true")
      expect(await renderedLines(trace)).toEqual(journalMeaning(rows, seq).lines)
      await expect(card.locator(".run-outcome-words")).toHaveText(whole.status)
      expect((await readBands(trace)).map(band => ({ phase: band.phase, seq: band.seq, reached: band.reached, current: band.current })))
        .toEqual(whole.bands.map(band => ({ ...band, reached: String(band.seq <= seq), current: band.seq === current ? "location" : null })))
    }
    await check()
    // The card's durable write is asynchronous and unobservable from here, and a
    // reload issued in the same tick cancels it: three stops in one production run
    // survived and the fourth did not. This settles the write; `reloadApp` then
    // waits for the app to boot again, and the cursor still has to be found on the
    // booted page for the stop to count as persisted.
    await page.waitForLoadState("networkidle").catch(() => undefined)
    await page.waitForTimeout(1_000)
    await reloadApp(page)
    await check()
    steps.push({ action, seq, selected, current, persisted: true })
  }
  try {
    await press(trace.getByRole("button", { name: "Details", exact: true }), "Enter")
    await expect(trace).toHaveAttribute("data-view", "timeline")
    await press(phaseStrip(trace).locator(`button[data-phase-band][data-seq="${whole.bands[0]!.seq}"]`), "Enter")
    await at(whole.bands[0]!.seq, "first band Enter")
    await press(phaseStrip(trace).locator(`button[data-phase-band][data-seq="${later.seq}"]`), "Space")
    await at(later.seq, "later phase Space")
    const positions = [...new Set(rows.map(row => Number(row.sequence)))].sort((a, b) => a - b)
    const slider = trace.getByRole("slider", { name: "Run position" })
    const valuenow = async () => Number(await slider.getAttribute("aria-valuenow"))
    /*
     * The card's own stops are the records it holds, which is a subset of the
     * journal read here: its last stop was two sequences behind the projection.
     * Counting stops off the journal therefore names a position the card never
     * had. Each key is required instead to land on a recorded position, in its
     * own direction, and `at` then checks the exact cursor and log cap there.
     */
    for (const [key, forward] of [["Home", false], ["ArrowRight", true], ["PageUp", true], ["PageDown", false], ["End", true], ["ArrowLeft", false]] as const) {
      const before = await valuenow()
      await press(slider, key)
      const moved = expect.poll(valuenow, { message: `${key} must move the cursor`, timeout: 15_000 })
      if (forward) await moved.toBeGreaterThan(before)
      else await moved.toBeLessThan(before)
      const landed = await valuenow()
      expect(positions, `${key} must land on a recorded position`).toContain(landed)
      await at(landed, `slider ${key}`)
    }
    await press(trace.getByRole("button", { name: "Latest", exact: true }), "Enter")
    await expect(trace.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
    await press(trace.getByRole("button", { name: "Timeline", exact: true }), "Enter")
    await expect(trace).toHaveAttribute("data-view", "turns")
    const line = frameLines(trace).filter({ has: trace.page().locator('.run-line-subject', { hasText: "README.md" }) }).first()
    const node = await line.getAttribute("data-frame-line")
    await press(line, "Enter")
    await expect(line).toHaveAttribute("aria-expanded", "true")
    await reloadApp(page)
    await expect(trace.locator(`button[data-frame-line="${node}"]`)).toHaveAttribute("aria-expanded", "true")
    await press(trace.locator(`button[data-frame-line="${node}"]`), "Space")
    await expect(trace.locator(`button[data-frame-line="${node}"]`)).toHaveAttribute("aria-expanded", "false")
    steps.push({ action: "frame Enter/reload/Space", node, persisted: true })
    const cluster = phaseStrip(trace).locator('details[class~="run-phase-cluster"]').first()
    if (await cluster.count() === 0) {
      const fact = { _tag: "ClusterNotRecorded", message: "This journal did not produce a milestone cluster. Cluster keyboard coverage remains absent." }
      await attachProductionJson(testInfo, "timeline-cluster-gap", fact)
      testInfo.annotations.push({ type: fact._tag, description: fact.message })
      throw new Error(fact.message)
    } else {
      const summary = cluster.locator("summary")
      await press(summary, "Enter"); await expect(cluster).toHaveAttribute("open", "")
      await press(summary, "Escape"); await expect(cluster).not.toHaveAttribute("open", "")
      await press(summary, "Space"); await expect(cluster).toHaveAttribute("open", "")
      // Every folded milestone must be reachable by Tab, and the last one selects its own sequence.
      const members = cluster.getByRole("button")
      const count = await members.count()
      expect(count, "a disclosed cluster folds at least two milestones").toBeGreaterThan(1)
      await summary.press("Tab")
      await expect(members.first()).toBeFocused()
      for (let index = 1; index < count; index++) {
        await members.nth(index - 1).press("Tab")
        await expect(members.nth(index)).toBeFocused()
      }
      const member = members.nth(count - 1)
      const seq = Number((await member.getAttribute("data-flow-args"))!.split(" ").at(-1))
      await member.press("Enter")
      await expect(summary).toBeFocused()
      await press(trace.getByRole("button", { name: "Details", exact: true }), "Enter")
      await at(seq, "cluster Enter/Escape/Space/Tab/Enter")
      await press(trace.getByRole("button", { name: "Timeline", exact: true }), "Enter")
    }
    const boxes = await Promise.all(whole.bands.map(async band =>
      ({ band, box: await phaseStrip(trace).locator(`button[data-phase-band][data-seq="${band.seq}"]`).boundingBox() })))
    const widest = boxes.filter(one => one.box !== null).sort((a, b) => b.box!.width - a.box!.width)[0]!
    const dropped = await scrubWithinBand(page, trace, widest.band.seq)
    const following = whole.bands.find(band => band.seq > widest.band.seq)?.seq ?? Infinity
    expect(positions, "a pointer release commits a recorded position").toContain(dropped)
    expect(dropped).toBeGreaterThanOrEqual(widest.band.seq)
    /*
     * Containment is a property of this working copy's strip, which commits the
     * last position recorded at or before the release. The deployed bundle may
     * still commit the position NEAREST it, and a band whose subject slept has
     * its far end nearest the following band's opening frame. Assert the
     * property where the browser under test carries it; where it does not, say
     * which revision could not prove it instead of failing the run or passing
     * quietly.
     */
    const strip = deployedSource(frontendRevision, STRIP_SOURCES)
    steps.push({ action: "pointer release containment", dropped, band: widest.band, following, strip })
    if (strip._tag === "DeployedSourceMatchesWorkingCopy") {
      expect(dropped, "a release inside one band stays inside it").toBeLessThan(following)
    } else {
      const fact = { _tag: strip._tag, frontendRevision, files: strip.files, dropped, band: widest.band, following,
        message: `${strip.message}; a release inside the band at #${widest.band.seq} committed #${dropped}, and containment is unproven on this revision` }
      await attachProductionJson(testInfo, "timeline-release-containment", fact)
      testInfo.annotations.push({ type: fact._tag, description: fact.message })
    }
    // The selected span is named by the technical view, so the drag's cursor is read there.
    await press(trace.getByRole("button", { name: "Details", exact: true }), "Enter")
    await expect(trace).toHaveAttribute("data-view", "timeline")
    await at(dropped, "pointer drag within one band")
    await press(trace.getByRole("button", { name: "Timeline", exact: true }), "Enter")
    await expect(trace).toHaveAttribute("data-view", "turns")
    steps.push({ action: "pointer drag", band: widest.band, dropped })
    await press(slider, "Home"); await press(trace.getByRole("button", { name: "Latest", exact: true }), "Enter")
    await expect(trace.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
    await reloadApp(page)
    // An absent card hides every button, so the card is required before its
    // live-tail state is read.
    await expect(trace, "the run card must re-render before its live-tail state is read").toBeVisible()
    /*
     * Returning to Latest is durable only where the deployed bundle waits for
     * that write before it answers. A production attempt pressed Latest,
     * reloaded, and found the card still parked, because the gesture answered
     * first and the reload cancelled its write. Assert the reload where the
     * browser under test carries the fix; otherwise say which revision could
     * not prove it, with what the card read after the reload.
     */
    const gesture = deployedSource(frontendRevision, GESTURE_SOURCES)
    const latest = trace.getByRole("button", { name: "Latest", exact: true })
    if (gesture._tag === "DeployedSourceMatchesWorkingCopy") {
      await expect(latest, "returning to Latest survives the reload that follows it").toBeHidden()
      await compareMeaning(card, trace, whole)
    } else {
      const parked = await latest.isVisible()
      const fact = { _tag: gesture._tag, frontendRevision, files: gesture.files, stillParkedAfterReload: parked,
        message: `${gesture.message}; after pressing Latest and reloading the card ${parked ? "was still parked" : "was at its tail"}, and the durability of that gesture is unproven on this revision` }
      await attachProductionJson(testInfo, "timeline-live-tail-durability", fact)
      testInfo.annotations.push({ type: fact._tag, description: fact.message })
      if (!parked) await compareMeaning(card, trace, whole)
    }
    steps.push({ action: "Latest Enter/reload", persisted: true, gesture })
    steps.push({ action: "width captures", measured: await captureWidths(page, card, testInfo, "timeline-completed") })
  } finally { await attachProductionJson(testInfo, "timeline-keyboard-roundtrips", steps) }
}
