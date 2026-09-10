import { expect, test } from "@playwright/test"
import type { Locator, Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CODING_PLAN } from "../../src/mainview/cards/fixtures/CodingPlan"
import { blockedCodingJournal, earlyCodingJournal } from "../../src/mainview/cards/fixtures/CodingJournal"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane runs T1 (docs/workbench-lanes/runs.md "Exit"): launch a fixture flow,
 * steer it, stop it, and see it in the run inbox — the whole lifecycle over
 * the workspace gateway, with the server as a double: the shared cloud
 * fixture (cloudFixture.ts) answers the bootstrap, the sessions and the
 * Smithers Cloud inventory, this spec adds the gateway, and the RPC double
 * records each procedure so the test asserts the wire, not just the pixels.
 */

const REPO = "smithersai/smithers"
const RUN_ID = "run-e2e"

interface RpcCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: Record<string, unknown>
}

const summaryRow = (status: string) => ({
  runId: RUN_ID,
  flowId: "review-pr",
  status,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: 1,
  calls: 2,
  callsFailed: 0,
  editsAttempted: 0,
  editsSucceeded: 0,
  inputTokens: 0,
  outputTokens: 0,
  verdict: status === "completed" ? "completed — done." : status,
  diagnosis: "Verdict   done."
})

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in as the scoped-down user, one loaded repo, one gateway that accepts everything. */
const serve = async (page: Page, journal: ReadonlyArray<Record<string, unknown>> = []): Promise<{ rpc: Array<RpcCall> }> => {
  const rpc: Array<RpcCall> = []
  let planned: { flowId: string; input: unknown } | undefined
  /** The engine's own accounting: a steer the gateway took is pending until the next turn. */
  let steeringPending = 0
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat", "local.repositories"] })
  await page.route("**/api/workflow/provision", (route) =>
    route.fulfill(json({ status: "ready", repo: REPO, gatewayId: "gw-1" })))
  await page.route("**/api/workflow/rpc", async (route) => {
    const call = route.request().postDataJSON() as RpcCall
    rpc.push(call)
    const rows = (projection: string, value: ReadonlyArray<unknown>) =>
      route.fulfill(json({ ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: value } }))
    switch (call.procedure) {
      case "List":
        return route.fulfill(json({
          ok: true,
          payload: { _tag: "flows", items: [{ flowId: "review-pr", description: "Review a PR" }] }
        }))
      case "Plan":
        planned = { flowId: String(call.payload.flowId), input: call.payload.input }
        return route.fulfill(json({
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: planned.flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        }))
      case "Run":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: RUN_ID } }))
      case "Approval.Submit":
        // The launch path auto-approves the plan it just made.
        return route.fulfill(json({ ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } }))
      case "Steer":
        steeringPending += 1
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Resume":
      case "Signal":
      case "Cancel":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Projection.Snapshot": {
        const selector = (call.payload.selector ?? {}) as { _tag?: string }
        switch (selector._tag) {
          case "workspace-runs":
            return rows("workspace-runs", [{ ...summaryRow("running"), steeringPending }])
          case "run-summary":
            return rows("run-summary", [{ ...summaryRow("running"), steeringPending }])
          case "approvals":
            return rows("approvals", [])
          case "transcript":
            return rows("transcript", [])
          case "run-events": {
            const after = call.payload.after as { value: number; offset: number } | undefined
            let offset = 0
            return rows("run-events", journal.filter((event, index) => {
              offset = index > 0 && journal[index - 1]?.sequence === event.sequence ? offset + 1 : 0
              return after === undefined || Number(event.sequence) > after.value ||
                (event.sequence === after.value && offset > after.offset)
            }))
          }
          default:
            return rows(String(selector._tag), [])
        }
      }
      default:
        return route.fulfill(json({ ok: false, error: { message: `no ${call.procedure}` } }))
    }
  })
  return { rpc }
}

const send = async (page: Page, text: string): Promise<void> => {
  await expect(page.locator(".guide-shell")).toBeVisible()
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-send").click()
}

/** Exercise workspace flows after the introduction, using its existing command. */
const finishGuide = async (page: Page): Promise<void> => {
  await expect(page.locator(".guide-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText("/onboarding.act finish")
  await page.keyboard.press("Enter")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-step", "14")
  await expect(page.getByTestId("composer-input")).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: launch a fixture flow, steer it, stop it, and see it in the run inbox", async ({ page }) => {
  const { rpc } = await serve(page)
  await page.goto("/")
  await finishGuide(page)

  // Launch: /flow.run provisions the workspace, plans, and runs — the card tracks the run.
  await send(page, `/flow.run review-pr ${REPO}`)
  const runCardId = `flow-run-${RUN_ID}`
  const card = page.getByTestId(`card-${runCardId}`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("Running on your workspace.")
  expect(rpc.map((call) => call.procedure)).toContain("Run")

  // Steer: the row's message rides the Steer procedure with the steer envelope.
  await card.getByTestId(`flow-run-steer-input-${RUN_ID}`).fill("use the smaller diff")
  await card.getByRole("button", { name: "Steer" }).click()
  await expect.poll(() => rpc.some((call) => call.procedure === "Steer")).toBe(true)
  const steer = rpc.find((call) => call.procedure === "Steer")!
  expect(steer.payload.runId).toBe(RUN_ID)
  expect(steer.payload.message).toMatchObject({ kind: "Message", body: "use the smaller diff", runId: RUN_ID })
  await expect(card).toContainText("steering pending")

  // The run inbox: /runs.list renders the workspace's runs, this one among them.
  await send(page, `/runs.list ${REPO}`)
  const runListCardId = `run-list-${REPO}`
  const inbox = page.getByTestId(`card-${runListCardId}`)
  await expect(inbox).toBeVisible()
  await expect(inbox).toContainText(RUN_ID)
  await expect(inbox).toContainText("review-pr")
  expect(rpc.some((call) =>
    call.procedure === "Projection.Snapshot" &&
    JSON.stringify(call.payload).includes("workspace-runs")
  )).toBe(true)

  // Stop: the card's own act cancels the run, and the card says so.
  await card.getByTestId(`flow-run-stop-${RUN_ID}`).click()
  await expect.poll(() => rpc.some((call) => call.procedure === "Cancel")).toBe(true)
  const cancel = rpc.find((call) => call.procedure === "Cancel")!
  expect(cancel.payload.runId).toBe(RUN_ID)
  await expect(card).toContainText("Cancelled.")
})

test("T1: turn explanations lead to durable historical inspection in the same embedded frame", async ({ page }) => {
  const record = (sequence: number, kind: string, payload: Record<string, unknown>) => ({ sequence, kind, occurredAt: 1000 + sequence, payload })
  const journal = [
    record(1, "control.agent.turn-opened", { seat: "test-model" }),
    record(2, "control.agent.model-settled", { text: "I’ll read the existing implementation before changing it." }),
    record(3, "control.agent.cell-produced", { language: "ts", text: "await ctx.call('files.read', { path: 'src/index.ts' })" }),
    record(4, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "src/index.ts" } })
  ]
  await serve(page, journal)
  await page.goto("/")
  await finishGuide(page)
  await send(page, `/runs.open run-e2e ${REPO}`)
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  await expect(card.getByRole("list", { name: "Turn explanations" })).toContainText("I’ll read the existing implementation")
  await expect(card.getByRole("list", { name: "Call tree" })).toHaveCount(0)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await send(page, "/debug.verbose")
  await expect(page.getByText("Verbose on — showing every flow, including hidden and background ones", { exact: true })).toBeVisible()

  await card.locator("[data-turn='1']").click()
  await card.locator("[data-trace-span='call-1']").click()
  const pane = card.getByTestId(`run-trace-pane-${RUN_ID}`)
  await expect(pane).toHaveAttribute("data-span", "call-1")
  await expect(pane).toContainText("src/index.ts")
  // Rendering is optimistic; wait for the existing command-settlement trace before reloading OPFS.
  await expect(page.getByText(/You ran \/runs\.trace\.select sourceCard=flow-run-run-e2e run-e2e call-1 .*→ executed/)).toBeVisible()
  await expect(card).toContainText("At #4")
  journal.push(record(5, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "later recorded content" }))

  // Reload keeps the selected historical input and does not show a later value.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Talk to Smithers" })).toBeHidden()
  await page.reload()
  await expect(page.locator(".guide-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  await expect(pane).toHaveAttribute("data-span", "call-1")
  await expect(pane).not.toContainText("later recorded content")
  await expect(card).toContainText("At #4")
  const path = card.getByRole("navigation", { name: "Recorded call path" })
  await expect(path).toContainText("frame 1")
  await expect(path).toContainText("cell · ts")

  await card.evaluate((element) => element.setAttribute("data-node-proof", "preserved"))
  await card.getByTestId(`card-maximize-flow-run-${RUN_ID}`).click()
  await expect(card).toHaveAttribute("data-node-proof", "preserved")
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await card.getByTestId(`card-minimize-flow-run-${RUN_ID}`).click()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await card.getByRole("button", { name: "Latest", exact: true }).click()
  await expect(card.getByRole("list", { name: "Call tree" })).toHaveCount(0)
  await card.locator("[data-turn='1']").click()
  await card.locator("[data-trace-span='call-1']").click()
  await expect(pane).toContainText("later recorded content")
  await expect(card).toContainText("At #5")
})


/** Reach a native control through the keyboard order; never move focus with a pointer or DOM mutation. */
const tabTo = async (page: Page, target: Locator): Promise<void> => {
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  throw new Error("The coding control was not reachable with Tab")
}

test("T1: a prompt-only run reveals its recorded plan and blocked execution through keyboard controls", async ({ page }) => {
  test.setTimeout(120_000)
  // The same synthetic production-writer records as the projection test,
  // addressed to this gateway fixture's actual run ID.
  const events = JSON.parse(JSON.stringify(blockedCodingJournal()).replaceAll("run-1", RUN_ID))
  await serve(page, events)
  await page.goto("/")
  await finishGuide(page)
  await expect(page.locator(".guide-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ prompt: CODING_PLAN.prompt })}`)
  await page.keyboard.press("Enter")
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  await expect(card.getByRole("list", { name: "Predicted Changes", exact: true })).toContainText("Store repository memory")
  await expect(card).toContainText("Blocked after 1 round.")
  await expect(page.locator(".guide-start-actions")).toHaveCount(0)
  await expect(card).not.toContainText("Validated after")
  const first = card.getByRole("button", { name: /Store repository memory/ })
  await tabTo(page, first)
  await page.keyboard.press("Enter")
  await expect(first).toHaveAttribute("aria-expanded", "true")
  const inspect = card.getByRole("button", { name: "Inspect failed execution" })
  await tabTo(page, inspect)
  expect(await inspect.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  await expect(card.locator("[data-span='engine:failed-round:0']")).toContainText("The required fast check failed.")
  await page.screenshot({ path: "/tmp/smithers-coding-overlay-after.png", fullPage: true })
})

test("T1: early review feedback opens durable debugger detail through the keyboard", async ({ page }) => {
  test.setTimeout(120_000)
  // Synthetic producer-shaped evidence; the browser exercises the actual
  // controller, persisted selection and existing frame presentation.
  await serve(page, JSON.parse(JSON.stringify(earlyCodingJournal()).replaceAll("run-1", RUN_ID)))
  await page.goto("/")
  await finishGuide(page)
  await page.keyboard.press("Control+k")
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ prompt: CODING_PLAN.prompt })}`)
  await page.keyboard.press("Enter")
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  const feedback = card.getByLabel("Coding review feedback", { exact: true })
  await expect(feedback).toContainText("Review requested changes. Waiting for the correction result.")
  await expect(feedback).toContainText("Keep the causal revision when merging wiki edits.")
  await expect(card.getByLabel("Coding outcome", { exact: true })).toHaveCount(0)
  await tabTo(page, page.getByTestId("composer-input"))
  await page.keyboard.insertText("/debug.verbose")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Verbose on — showing every flow, including hidden and background ones", { exact: true })).toBeVisible()
  const inspect = feedback.getByRole("button", { name: "Inspect review feedback" })
  await tabTo(page, inspect)
  expect(await inspect.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  const pane = card.locator("[data-span='engine:observe:0']")
  await expect(pane).toContainText("coding/EarlyFeedback")
  const failure = pane.locator("pre[aria-label='Failure']")
  await tabTo(page, failure)
  expect(await failure.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none")
  const initialScroll = await failure.evaluate(element => element.scrollTop)
  await page.keyboard.press("PageDown")
  await expect.poll(() => failure.evaluate(element => element.scrollTop)).toBeGreaterThan(initialScroll)
  await expect(page.getByText(/You ran \/runs\.trace\.select sourceCard=flow-run-run-e2e run-e2e engine:observe:0 .*→ executed/)).toBeVisible()
  await page.reload()
  await expect(pane).toContainText("coding/EarlyFeedback")
  await expect(feedback).toContainText("Waiting for the correction result.")
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  const node = await card.getByRole("region", { name: "Coding plan" }).elementHandle()
  await tabTo(page, card.getByTestId(`card-maximize-flow-run-${RUN_ID}`))
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  expect(await card.getByRole("region", { name: "Coding plan" }).evaluate((element, original) => element === original, node)).toBe(true)
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(card).toHaveCSS("opacity", "1")
  await expect(card).toHaveCSS("transform", "none")
  await page.screenshot({ path: "/tmp/smithers-coding-early-feedback-ui.png", fullPage: true })
})

test("T1: coding plan launch, inspection and restoration work with only the keyboard in the Command-K shell", async ({ page }) => {
  test.setTimeout(120_000)
  const { rpc } = await serve(page)
  await page.goto("/")
  await finishGuide(page)
  await expect(page.locator(".guide-shell")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ plan: CODING_PLAN })}`)
  await page.keyboard.press("Enter")
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  await expect(card.getByRole("list", { name: "Predicted Changes", exact: true })).toContainText("Store repository memory")
  expect(rpc.find((call) => call.procedure === "Plan")?.payload).toMatchObject({ flowId: "coding", input: { plan: CODING_PLAN } })
  const first = card.getByRole("button", { name: /Store repository memory/ })
  await tabTo(page, page.getByTestId("composer-input"))
  await page.keyboard.insertText("/debug.verbose")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Verbose on — showing every flow, including hidden and background ones", { exact: true })).toBeVisible()
  await tabTo(page, first)
  expect(await first.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  await expect(first).toHaveAttribute("aria-expanded", "true")
  await expect(card.getByRole("list", { name: "Predicted atomic changes" })).toContainText("persist causal documents")
  await expect(card).toContainText("src/memory.test.ts")
  await expect(card).toContainText("fast · required")
  await expect(card).not.toContainText("passed")
  await expect(page.getByText(/You ran \/runs\.coding\.select sourceCard=flow-run-run-e2e run-e2e memory .*→ executed/)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Talk to Smithers" })).toBeHidden()
  await page.reload()
  await expect(page.locator(".guide-shell")).toBeVisible()
  await expect(page.locator(".guide-start-actions")).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("Control+k")
  await expect(first).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.insertText("/debug.verbose")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Verbose off", { exact: true })).toBeVisible()
  await tabTo(page, first)
  await page.keyboard.press("Space")
  await expect(first).toHaveAttribute("aria-expanded", "false")
  const second = card.getByRole("button", { name: /Connect the Wiki interface/ })
  await page.keyboard.press("Tab")
  await expect(second).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(card.getByRole("list", { name: "Predicted atomic changes" })).toContainText("render repository memory")
  await page.screenshot({ path: "/tmp/smithers-coding-plan-ui.png", fullPage: true })
  await tabTo(page, card.getByTestId(`card-maximize-flow-run-${RUN_ID}`))
  const node = await card.getByRole("region", { name: "Coding plan" }).elementHandle()
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  expect(await card.getByRole("region", { name: "Coding plan" }).evaluate((element, original) => element === original, node)).toBe(true)
  expect(rpc.some((call) => call.procedure === "Run")).toBe(true)
})


test("T1: real retained prototype source and feedback remain embedded and keyboard accessible", async ({ page }) => {
  test.setTimeout(120_000)
  const records = readFileSync(join(__dirname, "../../src/mainview/cards/fixtures/CodingPocHostDecisions.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  const events = JSON.parse(JSON.stringify(records).replaceAll('"run-1"', JSON.stringify(RUN_ID)))
  const { rpc } = await serve(page, events)
  await page.goto("/")
  await finishGuide(page)
  await page.keyboard.press("Control+k")
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ prompt: "Add a greeting" })}`)
  await page.keyboard.press("Enter")
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  const poc = card.getByRole("region", { name: "Disposable prototype", exact: true })
  await expect(poc).toContainText("Drafted and discarded. No build or tests ran.")
  const preview = poc.getByText("Retained source preview", { exact: true })
  await tabTo(page, preview)
  await page.keyboard.press("Enter")
  await expect(poc.getByRole("region", { name: "hello.txt", exact: true })).toContainText("prototype greeting")
  await expect(poc.locator("iframe, script, img")).toHaveCount(0)
  await page.screenshot({ path: "/tmp/smithers-coding-poc-source-ui.png", fullPage: true })
  const feedback = poc.getByRole("button", { name: "Give prototype feedback", exact: true })
  await tabTo(page, feedback)
  await page.keyboard.press("Enter")
  const form = page.locator('.flow-form[data-flow-name="runs.steer"]')
  const body = form.getByTestId("flow-form-body")
  await expect(body).toBeVisible()
  await expect(form).toHaveAttribute("data-via", "user")
  await tabTo(page, body)
  await page.keyboard.insertText("Keep the greeting small; use the expected real text.")
  await page.keyboard.press("Tab")
  const submit = form.getByTestId("flow-form-submit")
  await expect(submit).toBeEnabled()
  await tabTo(page, submit)
  await page.keyboard.press("Enter")
  await expect.poll(() => rpc.find(call => call.procedure === "Steer")?.payload).toMatchObject({
    runId: RUN_ID, message: { kind: "Message", body: "Keep the greeting small; use the expected real text.", runId: RUN_ID }
  })
  await expect(card).toContainText("steering pending")
  await expect(card).not.toContainText("Validated after")
  await page.keyboard.press("Escape")
  await page.reload()
  await expect(poc).toContainText("Drafted and discarded. No build or tests ran.")
  await expect(card).toHaveAttribute("data-maximized", "false")
})

test("T1: bounded long prototype values keep the summary compact and source keyboard-scrollable", async ({ page }) => {
  test.setTimeout(120_000)
  // Synthetic display bounds around the real producer envelope; this test
  // makes no claim that these deliberately long values were a native POC.
  const records = readFileSync(join(__dirname, "../../src/mainview/cards/fixtures/CodingPocHostDecisions.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  const events = JSON.parse(JSON.stringify(records).replaceAll('"run-1"', JSON.stringify(RUN_ID)))
  const result = events.find((row: { sequence: number }) => row.sequence === 263).payload.payload.state.result.exit.value
  result.findings = ["Unvalidated hypothesis. ".repeat(600)]
  result.feedback = "Long next-plan feedback. ".repeat(1000)
  result.changes.files[0].after = "Long retained source line.\n".repeat(2000)
  await serve(page, events)
  await page.goto("/")
  await finishGuide(page)
  await page.keyboard.press("Control+k")
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ prompt: "Inspect source bounds" })}`)
  await page.keyboard.press("Enter")
  const poc = page.getByRole("region", { name: "Disposable prototype", exact: true })
  await expect(poc).toBeVisible()
  expect((await poc.boundingBox())!.height).toBeLessThan(350)
  expect(await poc.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const preview = poc.getByText("Retained source preview", { exact: true })
  await tabTo(page, preview)
  await page.keyboard.press("Enter")
  const source = poc.getByRole("region", { name: "hello.txt", exact: true }).locator("pre").last()
  await tabTo(page, source)
  expect((await source.boundingBox())!.height).toBeLessThanOrEqual(162)
  await page.keyboard.press("PageDown")
  await expect.poll(() => source.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  await page.screenshot({ path: "/tmp/smithers-coding-poc-long-source-ui.png", fullPage: true })
})
