import { expect } from "@playwright/test"
import { preparedCodingJournal } from "../../../src/mainview/cards/fixtures/CodingJournal"
import { showcase } from "../showcase"

const REPO = "smithersai/smithers"
const REVIEW = "run-review-70"
const CODING = "run-coding-12"

// The coding run's recorded journal (e2e/playwright/run-reading.spec.ts): two turns, a failed check.
const journal = [
  ...preparedCodingJournal(),
  { sequence: 6, kind: "control.agent.turn-opened", occurredAt: 600, payload: {} },
  { sequence: 7, kind: "control.agent.cell-produced", occurredAt: 700, payload: { text: 'const text = await ctx.call("read", { path: "src/memory.ts" });' } },
  { sequence: 8, kind: "control.agent.cell-call-started", occurredAt: 800, payload: { flowName: "read", callId: "read", input: { path: "src/memory.ts" } } },
  { sequence: 9, kind: "control.agent.cell-call-settled", occurredAt: 900, payload: { flowName: "read", callId: "read", outcome: "success", value: "export const memory = []" } },
  { sequence: 10, kind: "control.agent.cell-settled", occurredAt: 1000, payload: { outcome: "success" } },
  { sequence: 11, kind: "control.agent.turn-opened", occurredAt: 1100, payload: {} },
  { sequence: 12, kind: "control.agent.cell-call-started", occurredAt: 1200, payload: { flowName: "bash", callId: "check", input: { command: "bun run check //memory:typecheck" } } },
  { sequence: 13, kind: "control.agent.cell-call-settled", occurredAt: 1300, payload: { flowName: "bash", callId: "check", outcome: "success", value: { exitCode: 1 } } },
  { sequence: 14, kind: "control.run.failed", occurredAt: 1400, payload: {} }
]

export default showcase({
  id: "runs",
  order: 100,
  title: "Runs",
  summary: "The run inbox; a run's trace and transcript; steer, re-seat and stop a live run.",
  flows: ["runs.list", "runs.open", "runs.trace.select", "runs.trace.view", "runs.logs", "runs.steps", "flow.run.retry", "runs.steer", "runs.seat", "runs.thinking", "flow.run.stop"],
  run: async ({ page, app, backend }) => {
    const now = Date.now()
    const steers: Array<{ kind: string; body?: string }> = []
    const cancelled = new Set<string>()
    const summaries = new Map<string, number>()
    const base = { editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, diagnosis: "Recorded status" }
    const row = (runId: string) => {
      if (runId === CODING) return { ...base, runId, flowId: "coding", status: "failed", createdAt: now - 3_600_000, updatedAt: now - 3_000_000, turns: 2, calls: 2, callsFailed: 1, verdict: "failed" }
      const status = cancelled.has(runId) ? "cancelled" : "running"
      return { ...base, runId, flowId: "review-pr", status, createdAt: now - 240_000, updatedAt: now, turns: 3, calls: 7, callsFailed: 0,
        verdict: status, steeringPending: cancelled.has(REVIEW) ? 0 : steers.filter(steer => steer.body !== undefined).length }
    }
    await backend.cloud({ capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
    await backend.json("/api/workflow/provision", { status: "ready", repo: REPO, gatewayId: "gw-1" })
    await backend.route(url => url.pathname === "/api/workflow/rpc", route => {
      const call = route.request().postDataJSON() as { procedure: string; payload: { runId?: string; message?: { kind: string }; selector?: { _tag?: string; runId?: string }; after?: { value: number } } }
      const ok = (payload: unknown) => route.fulfill({ json: { ok: true, payload } })
      const rows = (projection: string, value: ReadonlyArray<unknown>) => ok({ cursor: { projection, runId: null, value: 0 }, rows: value })
      switch (call.procedure) {
        case "Steer": steers.push(call.payload.message ?? { kind: "" }); return ok({ _tag: "Accepted", receiptId: "ok" })
        case "Cancel": cancelled.add(call.payload.runId ?? ""); return ok({ _tag: "Accepted", receiptId: "ok" })
        case "Projection.Snapshot": {
          const selector = call.payload.selector ?? {}
          if (selector._tag === "workspace-runs") return rows("workspace-runs", [row(REVIEW), row(CODING)])
          if (selector._tag === "run-summary") summaries.set(selector.runId ?? REVIEW, (summaries.get(selector.runId ?? REVIEW) ?? 0) + 1)
          if (selector._tag === "run-summary") return rows("run-summary", [row(selector.runId ?? REVIEW)])
          if (selector._tag === "run-events" && JSON.stringify(call.payload).includes(CODING)) {
            return rows("run-events", journal.filter(event => event.sequence > (call.payload.after?.value ?? 0)))
          }
          if (selector._tag === "transcript" && JSON.stringify(call.payload).includes(CODING)) {
            return rows("transcript", [
              { runId: CODING, sequence: 7, turn: 1, at: now - 3_400_000, kind: "cell", text: 'const text = await ctx.call("read", { path: "src/memory.ts" })' },
              { runId: CODING, sequence: 12, turn: 2, at: now - 3_300_000, kind: "cell", text: "bun run check //memory:typecheck  →  exit 1" }
            ])
          }
          return rows(String(selector._tag), [])
        }
        default: return ok({ _tag: "Accepted", receiptId: "ok" })
      }
    })

    await app.open("/")
    await app.click(page.getByRole("button", { name: "Dismiss", exact: true }))
    await app.slash(`/runs.list ${REPO}`)
    const inbox = page.getByTestId(`card-run-list-${REPO}`)
    await expect(inbox).toContainText(CODING)
    await app.closeComposer()
    await app.show(inbox)
    await app.beat(900)

    // A finished run reads as its recorded trace, and as its transcript.
    await app.click(inbox.getByTestId(`runs-open-${CODING}`))
    const coding = page.getByTestId(`card-flow-run-${CODING}`)
    const trace = coding.getByTestId(`run-trace-${CODING}`)
    await expect(trace.locator("[data-frame-line]")).toHaveCount(2)
    await app.show(coding)
    const turn = trace.locator('[data-frame-line="frame-1"]')
    await app.click(turn)
    await expect(trace.getByLabel("Recorded turn source", { exact: true })).toContainText('ctx.call("read"')
    await app.beat(700)
    await app.click(trace.getByRole("button", { name: "Details", exact: true }))
    await expect(trace.getByLabel("Waterfall", { exact: true })).toBeVisible()
    await app.show(trace.getByLabel("Waterfall", { exact: true }))
    await app.beat(900)
    await app.click(coding.getByTestId(`flow-run-facet-transcript-${CODING}`))
    await expect(coding.getByTestId(`flow-run-facet-transcript-${CODING}`)).toHaveAttribute("aria-selected", "true")
    await app.beat(900)
    await app.click(coding.getByTestId(`flow-run-facet-steps-${CODING}`))
    await expect(coding.getByTestId(`flow-run-facet-steps-${CODING}`)).toHaveAttribute("aria-selected", "true")
    const reads = summaries.get(CODING) ?? 0
    await app.click(coding.getByRole("button", { name: "Check again" }))
    await expect.poll(() => summaries.get(CODING) ?? 0).toBeGreaterThan(reads)
    await app.beat(500)

    // A live run takes a steer, a new seat and a thinking level, then stops from its toast.
    await app.show(inbox)
    await app.click(inbox.getByTestId(`runs-open-${REVIEW}`))
    const review = page.getByTestId(`card-flow-run-${REVIEW}`)
    await expect(review).toContainText("Running")
    await app.show(review)
    await app.type(review.getByTestId(`flow-run-steer-input-${REVIEW}`), "smaller diff")
    await app.click(review.getByRole("button", { name: "Steer" }))
    await expect(review).toContainText("steering pending")
    const seat = review.getByLabel("Move the run to a seat")
    await app.type(seat, "claude-opus")
    await seat.press("Enter")
    await app.saw("runs.seat", () => expect.poll(() => steers.map(steer => steer.kind)).toContain("Seat"))
    await review.getByTestId(`flow-run-thinking-${REVIEW}`).selectOption("high")
    await app.saw("runs.thinking", () => expect.poll(() => steers.map(steer => steer.kind)).toContain("Thinking"))
    await app.beat(900)
    const toast = page.locator('.toast-stack .toast[data-toast-status="running"]').filter({ hasText: "review-pr" })
    await app.click(toast.getByRole("button", { name: "Stop" }))
    await expect(review.getByTestId(`run-outcome-${REVIEW}`)).toHaveAttribute("data-phase", "cancelled")
    await app.show(review)
    await app.beat(1200)
  }
})
