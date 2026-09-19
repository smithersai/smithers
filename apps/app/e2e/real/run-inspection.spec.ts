import { enqueuedEventType } from "@smthrs/control/Steering"
import { scenario } from "./coverage/types"
import { fixtureInputText } from "./support/values"
import { closeComposer, command, expect, realApi, test } from "./support/test"
import { authenticatedTest } from "./auth-permissions/profile"
import {
  attachProductionJson,
  bootProductionRepository,
  cloudRepoPath,
  enableProductionVerbose,
  PRODUCTION_REPO,
  readJson
} from "./repositories-github/production"
import { workflowTest } from "./flow-execution/fixture"
import { acceptedRunId, exactRunId, gatewayCall, runSummary, waitForTerminalRun, type RunTracker } from "./flow-execution/production"
import {
  bootRunWorkbench,
  productionRepository,
  runCard,
  runCards,
  waitForGatewayProcedure,
  workflowRpcPosts
} from "./run-inspection/ui"
import {
  bandIdentity,
  frameLines,
  frameNode,
  journalFrames,
  lineFramesAt,
  phaseStrip,
  readBands,
  readLines,
  readPins,
  TIMELINE_PHASES,
  treeFrames
} from "./run-inspection/timeline"
import { awaitSeededFlow, restartWorkspaceHost, SEEDED_FLOW, writeSeededFlow } from "./run-inspection/seeded-flow"

test.setTimeout(120_000)
test.use({ actionTimeout: 20_000 })
authenticatedTest.setTimeout(180_000)
authenticatedTest.use({ actionTimeout: 30_000 })
workflowTest.setTimeout(12 * 60_000)
workflowTest.use({ actionTimeout: 30_000 })

type ProjectionRow = Readonly<Record<string, unknown>>

const projectionRows = (answer: { readonly payload?: unknown }): ReadonlyArray<ProjectionRow> => {
  const rows = (answer.payload as { readonly rows?: unknown } | undefined)?.rows
  expect(Array.isArray(rows), "the gateway projection must carry a rows array").toBe(true)
  return rows as ReadonlyArray<ProjectionRow>
}

const bootOwnedWorkflow = async (page: Parameters<typeof bootProductionRepository>[0], repo: string, workspaceId?: string): Promise<void> => {
  await bootProductionRepository(page, repo)
  await enableProductionVerbose(page)
  if (workspaceId !== undefined) {
    await command(page, `/workspace.view ${workspaceId}`)
    await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible()
    await closeComposer(page)
    await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
    await closeComposer(page)
  }
}

const createFlowRun = async (
  page: Parameters<typeof bootProductionRepository>[0],
  repo: string,
  marker: string,
  tracker: RunTracker
): Promise<{ readonly card: ReturnType<typeof runCards>; readonly runId: string }> => {
  const accepted = acceptedRunId(page, repo, tracker)
  await command(page, `/flow.create create a flow named ${marker} that accepts one text input and returns that text unchanged ${repo}`)
  const runId = await accepted
  await closeComposer(page)
  const card = runCard(page, runId)
  expect(await exactRunId(card)).toBe(runId)
  return { card, runId }
}

test("signed-out run inspection parks durably before any workspace RPC", scenario("runs.permission-open-durable", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:runs.open", "action:auth.prompt", "host:production", "path:permission", "path:persistence",
    "door:slash", "dimension:signed-out-run-id", "dimension:no-workspace-rpc", "dimension:reload",
    "evidence:auth-session-sign-in-card-and-network"
  ],
  description: "Ask to inspect a named run while signed out, require a durable sign-in step, and prove the browser never asks a workspace gateway about that run."
}), async ({ page, request }) => {
  await bootRunWorkbench(page)
  const session = await realApi(page, request, "GET", "/api/auth/session")
  expect(session.status()).toBe(200)
  expect(await session.json()).toEqual({ status: "signed-out" })
  const rpc = workflowRpcPosts(page)

  const requestedRun = `owned-but-absent-${Date.now()}`
  await command(page, `/runs.open ${requestedRun} ${productionRepository}`)
  const signIn = page.locator('button[data-flow="auth.sign-in"]:visible').last()
  await expect(signIn).toBeVisible()
  await expect(runCards(page)).toHaveCount(0)
  expect(rpc).toEqual([])

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  await expect(runCards(page)).toHaveCount(0)
  expect(await (await realApi(page, request, "GET", "/api/auth/session")).json()).toEqual({ status: "signed-out" })
  expect(rpc).toEqual([])
})

test("signed-out run attention cannot enumerate workspace state", scenario("runs.permission-attention-no-enumeration", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:runs.attention", "action:auth.prompt", "host:production", "path:permission", "door:slash",
    "dimension:signed-out-attention", "dimension:no-workspace-enumeration",
    "evidence:sign-in-card-and-absent-projection-rpc"
  ],
  description: "Open the attention inbox while signed out and require authentication to stop before any workspace-runs or approvals projection is requested."
}), async ({ page, request }) => {
  await bootRunWorkbench(page)
  expect(await (await realApi(page, request, "GET", "/api/auth/session")).json()).toEqual({ status: "signed-out" })
  const rpc = workflowRpcPosts(page)

  await command(page, `/runs.attention ${productionRepository}`)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="run-list"]')).toHaveCount(0)
  await expect(page.locator('.smithers-card[data-kind="approvals-inbox"]')).toHaveCount(0)
  expect(rpc).toEqual([])
})

authenticatedTest("the canary GitHub App is installed before an owned workflow fixture is attempted", scenario("runs.github-app-fixture-readiness", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:github.app", "host:production", "path:success", "door:slash",
    "dimension:owned-workflow-prerequisite", "dimension:github-app-installed",
    "evidence:ui-card-and-status-readback"
  ],
  description: "Read the existing canary repository's GitHub App state through the UI and API so a private workflow fixture is never knowingly attempted while installation wiring is unavailable."
}), async ({ page, request }, testInfo) => {
  await bootProductionRepository(page)
  await enableProductionVerbose(page)
  const statusPath = cloudRepoPath(PRODUCTION_REPO, "/github-app-status")
  const statusResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === statusPath)
  await command(page, `/github.app ${PRODUCTION_REPO}`)
  expect((await statusResponse).status()).toBe(200)
  const status = await readJson<{
    readonly github_app_installed?: unknown
    readonly github_app_configured?: unknown
    readonly installation_id?: unknown
  }>(page, request, statusPath)
  await attachProductionJson(testInfo, "run-fixture-github-app-readiness", { repo: PRODUCTION_REPO, status })
  await closeComposer(page)
  const card = page.getByTestId(`card-connector-setup-github-${PRODUCTION_REPO}`)
  await expect(card).toBeVisible()
  await expect(card).toContainText(/GitHub App installed.*configured/)
  expect(status.github_app_installed).toBe(true)
  expect(status.github_app_configured).toBe(true)
  const inventory = await readJson<{
    readonly repos?: ReadonlyArray<{ readonly fullName: string; readonly installationId: number }>
  }>(page, request, "/api/user/github-app/installations")
  expect(typeof inventory.repos?.find(repo => repo.fullName === PRODUCTION_REPO)?.installationId).toBe("number")
})

workflowTest("a completed provider run exposes its real trace, transcript, events, handoff, and durable selection", scenario("runs.inspect-completed-trace-durable", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.steps", "action:runs.logs", "action:runs.events",
    "action:runs.trace.view", "action:runs.trace.filter", "action:runs.trace.select", "action:runs.trace.live", "action:runs.handoff",
    "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:real-provider", "dimension:completed-run", "dimension:keyboard", "dimension:timeline", "dimension:transcript",
    "dimension:raw-events", "dimension:handoff", "dimension:live-tail", "dimension:reload", "evidence:gateway-projections-and-durable-card"
  ],
  description: "Run the real create-flow provider to completion, compare the embedded inspection facets with gateway projections, then reload its persisted trace selection and editable handoff."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const marker = fixtureInputText(`s16-inspect-${Date.now().toString(36)}`)
  const launched = await createFlowRun(page, repo, marker, workflowRepo)

  const terminal = await waitForTerminalRun(page, request, repo, launched.runId, 9 * 60_000, workflowRepo.workspaceId)
  expect(terminal.status).toBe("completed")
  const card = runCard(page, launched.runId)
  await expect(card.getByTestId(`run-outcome-${launched.runId}`)).toHaveAttribute("data-phase", "completed", { timeout: 60_000 })

  const eventsAnswer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-events", runId: launched.runId }
  }, workflowRepo.workspaceId)
  const transcriptAnswer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "transcript", runId: launched.runId }
  }, workflowRepo.workspaceId)
  const events = projectionRows(eventsAnswer)
  const transcript = projectionRows(transcriptAnswer)
  expect(events.length, "a completed real engine run must have a journal").toBeGreaterThan(0)
  expect(transcript.length, "the provider-backed run must record at least one transcript row").toBeGreaterThan(0)

  const trace = card.getByTestId(`run-trace-${launched.runId}`)
  const timeline = trace.getByRole("button", { name: "Timeline", exact: true })
  await timeline.focus()
  await expect(timeline).toBeFocused()
  await timeline.press("Enter")
  await expect(trace).toHaveAttribute("data-view", "timeline")
  const tree = trace.getByRole("list", { name: "Call tree" })
  await expect(tree.locator("[data-trace-span]")).not.toHaveCount(0)
  const all = trace.locator('[data-filter="all"]')
  const model = trace.locator('[data-filter="model"]')
  await model.click()
  await expect(model).toHaveAttribute("data-on", "true")
  await all.click()
  await expect(all).toHaveAttribute("data-on", "true")

  // CallTree emits depth for every span; depth zero is the run root.
  const selectable = tree.locator('[data-trace-span][data-depth]:not([data-depth="0"])').first()
  await expect(selectable).toBeVisible()
  const selectedSpan = await selectable.getAttribute("data-trace-span")
  expect(selectedSpan).toBeTruthy()
  await selectable.focus()
  await selectable.press("Enter")
  await expect(selectable).toHaveAttribute("aria-pressed", "true")
  await expect(card.getByTestId(`run-trace-pane-${launched.runId}`)).toHaveAttribute("data-span", selectedSpan!)

  await card.getByTestId(`flow-run-facet-transcript-${launched.runId}`).click()
  const transcriptList = card.getByTestId(`flow-run-transcript-${launched.runId}`)
  await expect(transcriptList.locator("li")).toHaveCount(transcript.length)

  await card.getByTestId(`flow-run-facet-events-${launched.runId}`).click()
  const eventList = card.getByTestId(`flow-run-events-${launched.runId}`)
  await expect(eventList.locator("li")).toHaveCount(events.length)
  const firstEventKind = events.map((event) => event.kind).find((kind): kind is string => typeof kind === "string")
  expect(firstEventKind, "the projected journal must name its event kinds").toBeDefined()
  await expect(eventList).toContainText(firstEventKind!)

  await card.getByTestId(`flow-run-facet-steps-${launched.runId}`).click()
  await card.getByRole("button", { name: "Prepare handoff", exact: true }).click()
  const handoff = page.locator('form[data-flow-name="chat.copy-message"]').last()
  await expect(handoff).toBeVisible()
  const handoffText = handoff.locator("textarea")
  await expect(handoffText).toHaveValue(new RegExp(`Repository: ${repo.replace("/", "\\/")}`))
  await expect(handoffText).toHaveValue(new RegExp(`Run: ${launched.runId}`))
  await expect(handoffText).toHaveValue(/Run phase: completed/)

  await page.reload({ waitUntil: "domcontentloaded" })
  const restored = runCard(page, launched.runId)
  await expect(restored).toBeVisible()
  await expect(restored.getByTestId(`run-trace-${launched.runId}`)).toHaveAttribute("data-view", "timeline")
  await expect(restored.getByTestId(`run-trace-pane-${launched.runId}`)).toHaveAttribute("data-span", selectedSpan!)
  const latest = restored.getByRole("button", { name: "Latest", exact: true })
  await latest.focus()
  await expect(latest).toBeFocused()
  await latest.press("Enter")
  await expect(latest).toBeHidden()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(runCard(page, launched.runId).getByRole("button", { name: "Latest", exact: true })).toBeHidden()
  await attachProductionJson(testInfo, "completed-run-inspection", {
    repo, marker, runId: launched.runId, terminal, selectedSpan, events, transcript
  })
})

workflowTest("a completed agent run's timeline shows its phases and frame lines, and a scrub keeps the later moments as doors across reload", scenario("runs.timeline-phase-strip-scrub-durable", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:workspace.view", "action:workspace.terminal", "action:workspace.suspend", "action:workspace.resume", "action:repo.select",
    "action:flow.run", "action:runs.trace.view", "action:runs.trace.select", "action:runs.trace.live",
    "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:real-provider", "dimension:real-pty", "dimension:repository-owned-prompt-flow", "dimension:completed-run",
    "dimension:timeline", "dimension:phase-strip", "dimension:frame-lines", "dimension:scrub-cursor",
    "dimension:later-phase-door", "dimension:reload",
    "evidence:gateway-journal-frames-and-durable-cursor"
  ],
  description: "Give a disposable repository its own prompt flow through the workspace terminal, restart the host so it discovers it, and run it on the real provider: a prompt flow is the only run the agent's cell loop journals. Read that journal from the gateway and require the timeline's phase bands and frame lines to match the frames it opened. Scrub to the first band, prove the log stops at the cursor while every later band and pin stays a door, move forward through one, press a frame line, reload, and return to live."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  const workspaceId = workflowRepo.workspaceId!
  await bootOwnedWorkflow(page, repo, workspaceId)
  await writeSeededFlow(page, request, repo, workspaceId)
  await restartWorkspaceHost(page, request, repo, workspaceId)
  await awaitSeededFlow(page, request, repo, workspaceId)
  // Bind the launch to THIS workspace again: without the binding flow.run provisions the repo-level route, which production refuses.
  await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
  await closeComposer(page)

  const marker = fixtureInputText(`s16-timeline-${Date.now().toString(36)}`)
  const [runId] = await Promise.all([
    acceptedRunId(page, repo, workflowRepo),
    command(page, `/flow.run ${SEEDED_FLOW} ${repo} ${JSON.stringify({ args: marker })}`)
  ])
  await closeComposer(page)
  // Run ids restart at run-1 on every workspace, and the signed-in profile's conversation outlives a scenario,
  // so an earlier repository's run-1 card can still be on the page. This scenario's card is the newest one.
  const ownCard = (): ReturnType<typeof runCard> => runCard(page, runId).last()
  expect(await exactRunId(ownCard())).toBe(runId)

  const terminal = await waitForTerminalRun(page, request, repo, runId, 9 * 60_000, workspaceId)
  expect(terminal.status).toBe("completed")
  await expect(ownCard().getByTestId(`run-outcome-${runId}`)).toHaveAttribute("data-phase", "completed", { timeout: 60_000 })

  // The oracle is the gateway's journal, never the card's own fold of it.
  const eventsAnswer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-events", runId }
  }, workspaceId)
  const events = projectionRows(eventsAnswer)
  const frames = journalFrames(events)
  expect(frames.length, "a provider-backed agent run must journal at least one turn; a journal with none has no band to scrub").toBeGreaterThan(0)
  const opens = frames.map((entry) => entry.opens)
  const latest = Math.max(...events.map((event) => typeof event.sequence === "number" ? event.sequence : 0))
  expect(latest, "a completed run journals records after its first turn opened").toBeGreaterThan(opens[0]!)

  const trace = ownCard().getByTestId(`run-trace-${runId}`)
  await trace.getByRole("button", { name: "Timeline", exact: true }).click()
  await expect(trace).toHaveAttribute("data-view", "timeline")
  // The pump pages the journal onto the card; give it the same minute the outcome line gets.
  await expect(treeFrames(trace), "the card must hold the same journal the gateway answered with").toHaveCount(frames.length, { timeout: 60_000 })

  // The strip: contiguous bands, each opening where the journal opened a frame.
  await expect(phaseStrip(trace)).toBeVisible()
  const bands = await readBands(trace)
  expect(bands.length).toBeGreaterThan(0)
  expect(bands.length).toBeLessThanOrEqual(frames.length)
  expect(bands.filter((band) => !TIMELINE_PHASES.includes(band.phase ?? "")), "every band wears one of the six phase words").toEqual([])
  expect(bands[0]!.seq, "the first band opens where the journal's first frame opened").toBe(opens[0])
  expect(bands.filter((band) => !opens.includes(band.seq)), "a band opens only where the journal opened a frame").toEqual([])
  expect(bands.map((band) => band.seq)).toEqual([...bands.map((band) => band.seq)].sort((left, right) => left - right))
  expect(new Set(bands.map((band) => band.seq)).size).toBe(bands.length)
  expect(bands.filter((band, index) => index > 0 && band.phase === bands[index - 1]!.phase), "neighbouring frames in one phase are one band").toEqual([])
  for (const band of bands) {
    const opened = frames.find((entry) => entry.opens === band.seq)!
    expect(band).toMatchObject({
      reached: "true", current: null, enabled: true,
      flow: "runs.trace.select", args: `${runId} ${frameNode(opened.frame)} ${band.seq}`
    })
  }
  const pins = await readPins(trace)
  expect(pins.filter((pin) => pin.flow !== "runs.trace.select" || !Number.isSafeInteger(pin.seq) || pin.seq < 1 || pin.seq > latest),
    "every pin scrubs to a sequence the journal recorded").toEqual([])

  // The lines: one per frame that called something, each a verb, what it acted on when the call named it, and a result.
  const lines = await readLines(trace)
  // Without this, a journal whose frames called nothing compares [] to [] and the loop below never runs.
  expect(lines.length, "a provider-backed run calls at least one flow, so at least one frame has a line").toBeGreaterThan(0)
  expect(lines.map((line) => line.node)).toEqual(lineFramesAt(frames).map(frameNode))
  for (const line of lines) {
    const frame = lineFramesAt(frames).find((candidate) => frameNode(candidate) === line.node)!
    expect(line).toMatchObject({ number: String(frame), flow: "runs.trace.select", args: `${runId} ${line.node}` })
    // A call whose input names nothing has no subject, and the card renders no empty element for it.
    expect([line.verb.length, line.result.length], `${line.node} renders one verb and one result`).toEqual([1, 1])
    expect(line.verb[0], `${line.node} says what the frame did`).not.toBe("")
    expect(line.subject.length, `${line.node} names at most one subject`).toBeLessThanOrEqual(1)
    expect(line.subject.filter((subject) => subject === ""), `${line.node} never renders an empty subject`).toEqual([])
  }
  // textContent, not innerText: innerText puts a newline between the verdict and the counts, which
  // toHaveText then normalises to a space the DOM never held, so an unchanged headline reads as changed.
  const outcome = (await ownCard().getByTestId(`run-outcome-${runId}`).textContent()) ?? ""
  expect(outcome, "a completed run's headline carries its verdict and its counts").toMatch(/\d+ turns?/)

  // Scrub to the first band: the cursor is recorded, the log stops there, the strip does not.
  const cursor = bands[0]!.seq
  await phaseStrip(trace).locator(`button[data-phase-band][data-seq="${cursor}"]`).click()
  await expect(trace.getByText(`At #${cursor}`, { exact: true })).toBeVisible()
  await expect(trace.getByRole("button", { name: "Latest", exact: true })).toBeVisible()
  await expect(frameLines(trace)).toHaveCount(lineFramesAt(frames, cursor).length)
  await expect(treeFrames(trace)).toHaveCount(frames.filter((entry) => entry.opens <= cursor).length)
  await expect(ownCard().getByTestId(`run-trace-pane-${runId}`)).toHaveAttribute("data-span", frameNode(1))
  const scrubbed = await readBands(trace)
  expect(bandIdentity(scrubbed), "a scrub never drops a band").toEqual(bandIdentity(bands))
  expect(scrubbed.map((band) => band.reached)).toEqual(bands.map((band) => String(band.seq <= cursor)))
  expect(scrubbed.map((band) => band.current)).toEqual(bands.map((_band, index) => index === 0 ? "location" : null))
  expect(scrubbed.filter((band) => !band.enabled), "a band past the cursor stays a door").toEqual([])
  expect((await readPins(trace)).map((pin) => pin.reached)).toEqual(pins.map((pin) => String(pin.seq <= cursor)))
  await expect(ownCard().getByTestId(`run-outcome-${runId}`), "the run's verdict and counts are not the cursor's").toHaveText(outcome)

  // A later door: the last band, else the last pin past the cursor. The scenario claims
  // `dimension:later-phase-door`, so a journal with neither fails here rather than passing
  // on the first-band state a second time and recording coverage the run never exercised.
  const laterBand = bands.length > 1 ? bands[bands.length - 1]! : undefined
  const laterPin = laterBand === undefined ? [...pins].reverse().find((pin) => pin.seq > cursor) : undefined
  expect(laterBand ?? laterPin, "this run's strip has one band and no pin past it, so it cannot prove a scrub moves forward; use a run with two phases").toBeDefined()
  const parked = (laterBand?.seq ?? laterPin?.seq)!
  if (laterBand !== undefined) await phaseStrip(trace).locator(`button[data-phase-band][data-seq="${laterBand.seq}"]`).click()
  else if (laterPin !== undefined) await phaseStrip(trace).locator(`button[data-pin-row][data-flow-args="${laterPin.args}"]`).click()
  await expect(trace.getByText(`At #${parked}`, { exact: true })).toBeVisible()
  await expect(frameLines(trace)).toHaveCount(lineFramesAt(frames, parked).length)
  await expect(treeFrames(trace)).toHaveCount(frames.filter((entry) => entry.opens <= parked).length)
  expect(bandIdentity(await readBands(trace))).toEqual(bandIdentity(bands))

  // A frame line is a door too: pressing one selects its frame and leaves the cursor where it was.
  const shown = lineFramesAt(frames, parked)
  expect(shown.length, "the later door leaves at least one frame line on screen").toBeGreaterThan(0)
  const pressed = frameNode(shown[shown.length - 1]!)
  await frameLines(trace).last().click()
  await expect(ownCard().getByTestId(`run-trace-pane-${runId}`)).toHaveAttribute("data-span", pressed)
  await expect(trace.getByText(`At #${parked}`, { exact: true })).toBeVisible()

  // The cursor is the card's, not the component's: a reload keeps it.
  await page.reload({ waitUntil: "domcontentloaded" })
  const restored = ownCard().getByTestId(`run-trace-${runId}`)
  await expect(restored).toHaveAttribute("data-view", "timeline")
  await expect(restored.getByText(`At #${parked}`, { exact: true })).toBeVisible()
  await expect(frameLines(restored)).toHaveCount(lineFramesAt(frames, parked).length)
  const reloaded = await readBands(restored)
  expect(bandIdentity(reloaded)).toEqual(bandIdentity(bands))
  expect(reloaded.map((band) => band.reached)).toEqual(bands.map((band) => String(band.seq <= parked)))
  expect(reloaded.filter((band) => band.current === "location").map((band) => band.seq))
    .toEqual([[...bands].reverse().find((band) => band.seq <= parked)!.seq])

  // Latest restores the whole log, and that survives a reload too.
  await restored.getByRole("button", { name: "Latest", exact: true }).click()
  await expect(restored.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
  await expect(restored.getByText(`At #${parked}`, { exact: true })).toBeHidden()
  await expect(frameLines(restored)).toHaveCount(lines.length)
  await expect(treeFrames(restored)).toHaveCount(frames.length)
  expect((await readBands(restored)).map((band) => [band.reached, band.current])).toEqual(bands.map(() => ["true", null]))
  expect(await readLines(restored)).toEqual(lines)
  await page.reload({ waitUntil: "domcontentloaded" })
  const live = ownCard().getByTestId(`run-trace-${runId}`)
  await expect(live).toHaveAttribute("data-view", "timeline")
  await expect(live.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
  await expect(frameLines(live)).toHaveCount(lines.length)
  await attachProductionJson(testInfo, "timeline-phase-strip-scrub", {
    repo, marker, runId, terminal, frames, bands, pins, lines, cursor, parked,
    laterDoor: laterBand !== undefined ? "band" : laterPin !== undefined ? "pin" : "none"
  })
})

workflowTest("live message, thinking, and tool steering persist as real control events across reconnect", scenario("runs.live-steering-durable-reconnect", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.steer", "action:runs.thinking", "action:runs.tools",
    "host:production", "path:success", "path:persistence", "door:slash",
    "dimension:real-provider", "dimension:live-run", "dimension:durable-reconnect",
    "dimension:message-steer", "dimension:thinking-steer", "dimension:tools-steer",
    "evidence:accepted-rpc-and-durable-control-events"
  ],
  description: "Launch an owned provider run, steer its live engine through three typed UI commands, prove their exact server-authored event ids, then reconnect to the same persisted run."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const marker = fixtureInputText(`s16-steer-${Date.now().toString(36)}`)
  const launched = await createFlowRun(page, repo, marker, workflowRepo)
  const liveStatuses = new Set(["accepted", "running", "parked", "waiting-approval"])
  let liveBefore: ReturnType<typeof runSummary> = undefined
  await expect.poll(async () => {
    const answer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
      selector: { _tag: "run-summary", runId: launched.runId }
    }, workflowRepo.workspaceId)
    liveBefore = runSummary(answer)
    return typeof liveBefore?.status === "string" && liveStatuses.has(liveBefore.status)
  }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe(true)

  const steer = async (
    commandText: string,
    expected: Readonly<Record<string, unknown>>
  ): Promise<{
    readonly messageId: string
    readonly idempotencyKey: string
    readonly request: Readonly<Record<string, unknown>>
  }> => {
    const responsePromise = waitForGatewayProcedure(page, "Steer", repo)
    await command(page, commandText)
    const response = await responsePromise
    const requestBody = response.request().postDataJSON() as {
      readonly repo?: unknown
      readonly workspaceId?: unknown
      readonly payload?: {
        readonly runId?: unknown
        readonly idempotencyKey?: unknown
        readonly message?: Readonly<Record<string, unknown>>
      }
    }
    const message = requestBody.payload?.message
    const messageId = message?.messageId
    expect(typeof messageId).toBe("string")
    const messagePrefix = `steer-${launched.runId}-`
    expect(messageId).toMatch(new RegExp(`^${messagePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+`))
    const nonce = String(messageId).slice(messagePrefix.length)
    const idempotencyKey = `steer:${launched.runId}:${nonce}`
    expect(requestBody.repo).toBe(repo)
    if (workflowRepo.workspaceId !== undefined) expect(requestBody.workspaceId).toBe(workflowRepo.workspaceId)
    expect(requestBody.payload).toMatchObject({ runId: launched.runId, message: expected })
    expect(requestBody.payload?.idempotencyKey).toBe(idempotencyKey)
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      payload: { _tag: "Accepted", receiptId: idempotencyKey, runId: launched.runId }
    })
    return { messageId: String(messageId), idempotencyKey, request: requestBody }
  }

  const message = await steer(`/runs.steer ${launched.runId} preserve the exact ${marker} flow contract`, {
    runId: launched.runId, kind: "Message", body: `preserve the exact ${marker} flow contract`
  })
  const thinking = await steer(`/runs.thinking ${launched.runId} low`, {
    runId: launched.runId, kind: "Thinking", thinking: "low"
  })
  const tools = await steer(`/runs.tools ${launched.runId} bash`, {
    runId: launched.runId, kind: "Tools", toolNames: ["bash"]
  })
  const accepted = [message, thinking, tools]

  let controlEvents: ReadonlyArray<ProjectionRow> = []
  await expect.poll(async () => {
    const answer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
      selector: { _tag: "run-events", runId: launched.runId }
    }, workflowRepo.workspaceId)
    controlEvents = projectionRows(answer).filter((event) => event.kind === enqueuedEventType)
    const ids = controlEvents.map((event) => (event.payload as ProjectionRow | undefined)?.messageId)
    return ids
  }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toEqual(expect.arrayContaining(accepted.map((entry) => entry.messageId)))
  for (const entry of accepted) {
    const persisted = controlEvents.find((event) =>
      (event.payload as ProjectionRow | undefined)?.messageId === entry.messageId
    )
    expect(persisted, `server journal must record steer ${entry.messageId}`).toBeDefined()
    const payload = persisted!.payload as ProjectionRow
    const requestMessage = ((entry.request.payload as ProjectionRow).message as ProjectionRow)
    expect(payload).toMatchObject({
      runId: launched.runId,
      messageId: entry.messageId,
      kind: requestMessage.kind,
      createdAt: requestMessage.createdAt
    })
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  const restored = runCard(page, launched.runId)
  await expect(restored).toBeVisible()
  expect(await exactRunId(restored)).toBe(launched.runId)
  const afterReconnect = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-summary", runId: launched.runId }
  }, workflowRepo.workspaceId)
  expect(runSummary(afterReconnect)?.runId).toBe(launched.runId)
  await attachProductionJson(testInfo, "live-steering-reconnect", {
    repo, marker, runId: launched.runId, liveBefore, accepted, controlEvents,
    afterReconnect: runSummary(afterReconnect)
  })
})

workflowTest("run again creates a second real execution and both appear in the server-backed completed list", scenario("runs.rerun-completed-list-open", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.rerun", "action:runs.list", "action:runs.open", "host:production",
    "path:success", "path:keyboard", "door:slash", "door:button", "dimension:real-provider",
    "dimension:rerun-new-id", "dimension:completed-filter", "dimension:keyboard", "dimension:server-backed-list",
    "evidence:two-terminal-projections-and-run-list"
  ],
  description: "Complete an owned provider run, keyboard-run it again from its card, prove a distinct accepted id executes, and open both exact ids from the completed run list."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const marker = fixtureInputText(`s16-rerun-${Date.now().toString(36)}`)
  const first = await createFlowRun(page, repo, marker, workflowRepo)
  const firstTerminal = await waitForTerminalRun(page, request, repo, first.runId, 9 * 60_000, workflowRepo.workspaceId)
  expect(firstTerminal.status).toBe("completed")
  const firstCard = runCard(page, first.runId)
  await expect(firstCard.getByTestId(`run-outcome-${first.runId}`)).toHaveAttribute("data-phase", "completed", { timeout: 60_000 })

  const rerunResponse = acceptedRunId(page, repo, workflowRepo)
  const rerun = firstCard.getByTestId(`flow-run-rerun-${first.runId}`)
  await rerun.focus()
  await expect(rerun).toBeFocused()
  await rerun.press("Enter")
  const secondRunId = await rerunResponse
  expect(secondRunId).not.toBe(first.runId)
  await expect(runCard(page, secondRunId)).toBeVisible({ timeout: 60_000 })
  const secondTerminal = await waitForTerminalRun(page, request, repo, secondRunId, 9 * 60_000, workflowRepo.workspaceId)
  expect(secondTerminal.status).toBe("completed")
  expect(secondTerminal.flowId).toBe(firstTerminal.flowId)

  await command(page, `/runs.list completed ${firstTerminal.flowId} ${repo}`)
  await closeComposer(page)
  const list = page.locator('.smithers-card[data-kind="run-list"]').last()
  await expect(list).toBeVisible()
  await expect(list.getByTestId(`runs-open-${first.runId}`)).toBeVisible()
  await expect(list.getByTestId(`runs-open-${secondRunId}`)).toBeVisible()
  await list.getByTestId(`runs-open-${first.runId}`).click()
  await expect(runCard(page, first.runId)).toBeVisible()

  const listed = await gatewayCall(page, request, repo, "Projection.Snapshot", { selector: { _tag: "workspace-runs" } }, workflowRepo.workspaceId)
  const ids = projectionRows(listed).filter((row) => row.status === "completed" && row.flowId === firstTerminal.flowId).map((row) => row.runId)
  expect(ids).toEqual(expect.arrayContaining([first.runId, secondRunId]))
  await attachProductionJson(testInfo, "rerun-completed-list", {
    repo, marker, first: firstTerminal, second: secondTerminal, completedIds: ids
  })
})

workflowTest("stop all cancels two live owned runs, leaves a terminal sibling unchanged, and terminal resume is refused", scenario("runs.stop-all-owned-live-scope", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.list", "action:flow.run.stop-all", "action:runs.resume",
    "action:flow.run.stop",
    "host:production", "path:error",
    "door:slash", "door:button", "dimension:real-provider", "dimension:multiple-live-runs",
    "dimension:owned-workspace-scope", "dimension:terminal-sibling", "dimension:terminal-drain",
    "evidence:pre-and-post-workspace-projections"
  ],
  description: "Cancel one owned run, launch two more, stop the private workspace through its run-list button, prove both live ids cancel while the terminal sibling stays unchanged, and require the gateway's typed refusal when the UI tries to resume a terminal id."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const terminalMarker = fixtureInputText(`s16-terminal-${Date.now().toString(36)}`)
  const terminalSibling = await createFlowRun(page, repo, terminalMarker, workflowRepo)
  await terminalSibling.card.getByTestId(`flow-run-stop-${terminalSibling.runId}`).click()
  const terminalBefore = await waitForTerminalRun(page, request, repo, terminalSibling.runId, 180_000, workflowRepo.workspaceId)
  expect(terminalBefore.status).toBe("cancelled")

  const firstMarker = fixtureInputText(`s16-stop-a-${Date.now().toString(36)}`)
  const secondMarker = fixtureInputText(`s16-stop-b-${Date.now().toString(36)}`)
  const first = await createFlowRun(page, repo, firstMarker, workflowRepo)
  const second = await createFlowRun(page, repo, secondMarker, workflowRepo)
  expect(new Set([terminalSibling.runId, first.runId, second.runId]).size).toBe(3)

  let beforeWorkspaceRows: ReadonlyArray<ProjectionRow> = []
  let beforeRows: ReadonlyArray<ProjectionRow> = []
  await expect.poll(async () => {
    const before = await gatewayCall(page, request, repo, "Projection.Snapshot", { selector: { _tag: "workspace-runs" } }, workflowRepo.workspaceId)
    beforeWorkspaceRows = projectionRows(before)
    beforeRows = beforeWorkspaceRows.filter((row) => row.runId === first.runId || row.runId === second.runId)
    return beforeRows.map((row) => row.runId)
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000] }).toEqual(expect.arrayContaining([first.runId, second.runId]))
  const liveStatuses = new Set(["accepted", "running", "parked", "waiting-approval"])
  const liveIds = beforeRows.filter((row) => typeof row.status === "string" && liveStatuses.has(row.status)).map((row) => String(row.runId))
  expect(liveIds, "both exact owned runs must still be live to exercise multi-run stop-all").toEqual(
    expect.arrayContaining([first.runId, second.runId])
  )
  expect(liveIds).toHaveLength(2)

  await command(page, `/runs.list ${repo}`)
  await closeComposer(page)
  const list = page.locator('.smithers-card[data-kind="run-list"]').last()
  await expect(list).toBeVisible()
  for (const runId of liveIds) await expect(list.getByTestId(`runs-open-${runId}`)).toBeVisible()
  const stopAll = list.getByTestId("run-list-stop-all")
  await expect(stopAll).toHaveText(`Stop all ${liveIds.length}`)
  await stopAll.click()

  const stopped = []
  for (const runId of liveIds) {
    const terminal = await waitForTerminalRun(page, request, repo, runId, 180_000, workflowRepo.workspaceId)
    expect(terminal.status, `run ${runId} was live at the stop-all snapshot`).toBe("cancelled")
    stopped.push(terminal)
    await expect(runCard(page, runId).getByTestId(`run-outcome-${runId}`)).toHaveAttribute("data-phase", "cancelled", { timeout: 60_000 })
  }
  const after = await gatewayCall(page, request, repo, "Projection.Snapshot", { selector: { _tag: "workspace-runs" } }, workflowRepo.workspaceId)
  const afterWorkspaceRows = projectionRows(after)
  const afterRows = afterWorkspaceRows.filter((row) => liveIds.includes(String(row.runId)))
  expect(afterRows).toHaveLength(liveIds.length)
  expect(afterRows.every((row) => row.status === "cancelled")).toBe(true)
  const terminalAfter = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-summary", runId: terminalSibling.runId }
  }, workflowRepo.workspaceId)
  expect(runSummary(terminalAfter)).toMatchObject({ runId: terminalSibling.runId, status: "cancelled" })

  const terminalRunId = liveIds[0]!
  const resumeResponse = waitForGatewayProcedure(page, "Resume", repo)
  await command(page, `/runs.resume ${terminalRunId}`)
  const refusedResponse = await resumeResponse
  expect(refusedResponse.status()).toBe(200)
  const refused = await refusedResponse.json() as {
    readonly ok?: unknown
    readonly error?: { readonly message?: unknown; readonly detail?: unknown }
  }
  expect(refused.ok, "the gateway must refuse resuming a terminal run").toBe(false)
  expect(typeof refused.error?.message).toBe("string")
  expect(JSON.stringify(refused.error?.detail), "the resume refusal must retain the gateway's typed Terminal fault").toMatch(/terminal/i)
  await expect(page.getByTestId("transcript")).toContainText(String(refused.error!.message))
  const stillTerminal = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-summary", runId: terminalRunId }
  }, workflowRepo.workspaceId)
  expect(runSummary(stillTerminal)).toMatchObject({ runId: terminalRunId, status: "cancelled" })
  const afterResume = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "workspace-runs" }
  }, workflowRepo.workspaceId)
  const afterResumeRows = projectionRows(afterResume)
  expect(afterResumeRows.filter((row) => String(row.runId) === terminalRunId)).toEqual([
    expect.objectContaining({ runId: terminalRunId, status: "cancelled" })
  ])
  expect(afterResumeRows.filter((row) => liveIds.includes(String(row.runId)))).toHaveLength(liveIds.length)
  await attachProductionJson(testInfo, "stop-all-owned-runs", {
    repo, acceptedIds: [terminalSibling.runId, first.runId, second.runId], terminalBefore,
    liveIds, beforeRows, beforeWorkspaceRows, stopped, afterRows, afterWorkspaceRows,
    terminalAfter: runSummary(terminalAfter), resumeRefusal: refused, afterResumeRows
  })
})
