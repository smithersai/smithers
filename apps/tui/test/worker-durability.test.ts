import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import { workerFallbackSeats } from "../src/models.ts"
import { ModelError } from "@smthrs/model/ModelError"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const request = { id: "review", title: "Review", prompt: "Review the files.", model: "sol" as const }

const fixture = (run: Host.Host["run"], restored?: ConstructorParameters<typeof Workspace>[0]["restored"]) => {
  const records: Session.Record[] = []
  const host = { cwd: mkdtempSync(join(tmpdir(), "tui-durable-")), judged: false, compaction: async () => undefined,
    dispose: async () => {}, run } satisfies Host.Host
  return { records, workspace: new Workspace({ host, workerSeat: "openai:gpt-6-astra", history: () => [],
    persist: (record) => records.push(record), restored }) }
}

describe("worker durability", () => {
  it("tries detected non-Cerebras seats in order and honors the override", () => {
    const available = { models: [
      { seat: "openai:gpt-6-sol", provider: "ChatGPT", label: "Sol" },
      { seat: "anthropic:claude", provider: "Anthropic", label: "Claude" },
      { seat: "cerebras:qwen", provider: "Cerebras", label: "Qwen" }
    ], defaultSeat: "openai:gpt-6-sol", workerSeat: "openai:gpt-6-sol", environment: {} }
    expect(workerFallbackSeats("openai:gpt-6-sol", available, {})).toEqual(["anthropic:claude"])
    expect(workerFallbackSeats("openai:gpt-6-sol", available, { SMITHERS_TUI_WORKER_SEATS: "other:a,anthropic:claude" }))
      .toEqual(["other:a", "anthropic:claude"])
  })

  it("parks a limited worker, then unparked work stays on the same tab", async () => {
    let input: Host.TurnInput | undefined
    const f = fixture((value) => {
      input = value
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    input!.onEvent(new AgentEvent.ModelParked({ eventType: "flows.harness.model-parked.v1", seat: "openai:gpt-6-sol", wakeAt: Date.UTC(2026, 8, 30, 21), source: "reset", code: "rate_limited" }))
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ id: "review", status: "parked", wakeAt: Date.UTC(2026, 8, 30, 21) })
    input!.onEvent(new AgentEvent.ModelUnparked({ eventType: "flows.harness.model-unparked.v1", seat: "openai:gpt-6-sol", at: Date.UTC(2026, 8, 30, 21) }))
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ id: "review", status: "running" })
    input!.onEvent(new AgentEvent.SeatFailedOver({ eventType: "flows.harness.seat-failed-over.v1", from: "openai:gpt-6-sol", to: "anthropic:claude", code: "rate_limited" }))
    expect(f.workspace.transcript("review").items.some((item) => item.kind === "note" && item.text.includes("↪ switched to anthropic:claude · ChatGPT limit"))).toBe(true)
    expect(f.workspace.snapshot().tabs[0]?.activeSeat).toBe("anthropic:claude")
  })

  it("keeps an interrupted in-memory park and relaunches at wake", async () => {
    const inputs: Host.TurnInput[] = []
    let stop: ((outcome: Host.Outcome) => void) | undefined
    const f = fixture((input) => {
      inputs.push(input)
      return inputs.length === 1
        ? { done: new Promise((resolve) => { stop = resolve }), cancel: () => {} }
        : { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    inputs[0]!.onEvent(new AgentEvent.ModelParked({ eventType: "flows.harness.model-parked.v1", seat: "openai:gpt-6-sol",
      wakeAt: Date.now() + 80, source: "reset", code: "rate_limited" }))
    stop!({ _tag: "cancelled" })
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("parked")
    expect(Session.load(f.workspace.snapshot().tabs[0]!.file).some((record) => record.type === "outcome")).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(inputs).toHaveLength(2)
    expect(inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.user === request.prompt)).toBe(true)
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("frees a pool slot while a worker is parked", async () => {
    const inputs = new Map<string, Host.TurnInput>()
    const f = fixture((input) => {
      inputs.set(input.source!, input)
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    for (let index = 0; index < 7; index++) f.workspace.request({ ...request, id: `worker-${index}` })
    await tick()
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-6")?.status).toBe("queued")
    inputs.get("worker-0")!.onEvent(new AgentEvent.ModelParked({ eventType: "flows.harness.model-parked.v1",
      seat: "openai:gpt-6-sol", wakeAt: Date.now() + 60_000, source: "reset", code: "rate_limited" }))
    await tick()
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-0")?.status).toBe("parked")
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-6")?.status).toBe("running")
    expect(f.workspace.busy).toBe(true)
  })

  it("resumes with the original seat and printed cells after failure", async () => {
    const inputs: Host.TurnInput[] = []
    const f = fixture((input) => {
      inputs.push(input)
      if (inputs.length === 1) return { done: Promise.resolve({ _tag: "failed", message: "raw provider response", detail: "stack" }), cancel: () => {} }
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    const old = f.workspace.snapshot().tabs[0]!
    const append = (at: number, event: unknown) => Session.reopen(old.file).append({ type: "event", at,
      event: event as Extract<Session.Record, { type: "event" }>["event"] })
    append(2, { _tag: "model-requested" })
    append(3, { _tag: "model-delta", delta: { type: "text-delta", text: "```js\nprint(1)\n```" } })
    append(4, { _tag: "cell-produced", cell: { text: "print(1)" } })
    append(5, { _tag: "cell-printed", text: "one" })
    f.workspace.retry(request.id)
    await tick()
    expect(inputs[1]?.seat).toBe("openai:gpt-6-sol")
    expect(inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.answer.includes("raw provider response"))).toBe(true)
    expect(inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.answer.includes("print(1)"))).toBe(true)
    expect(inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.answer.includes("one"))).toBe(true)
    expect(f.workspace.snapshot().tabs.map((tab) => tab.id)).toEqual(["review"])
    expect(Session.load(f.workspace.snapshot().tabs[0]!.file)[0]).toMatchObject({ type: "session", parent: old.file })
  })

  it("restarts a running tab automatically with its prior worker context", async () => {
    const first = fixture(() => ({ done: new Promise(() => {}), cancel: () => {} }))
    first.workspace.request(request)
    await tick()
    const prior = first.workspace.snapshot().tabs[0]!
    Session.reopen(prior.file).append({ type: "user", at: 1, text: "Additional worker note" })
    first.workspace.dispose()
    const inputs: Host.TurnInput[] = []
    const second = fixture((input) => {
      inputs.push(input)
      return { done: new Promise(() => {}), cancel: () => {} }
    }, Session.restore(first.records).workspace)
    await tick()
    expect(second.workspace.snapshot().tabs[0]).toMatchObject({ id: "review", status: "running" })
    expect(inputs[0]?.history.some((entry) => entry.kind === "exchange" && entry.user.includes("Review the files"))).toBe(true)
  })

  it("keeps a parked tab parked until wake, then resumes the recorded task", async () => {
    let firstInput: Host.TurnInput | undefined
    const first = fixture((input) => {
      firstInput = input
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    first.workspace.request(request)
    await tick()
    firstInput!.onEvent(new AgentEvent.ModelParked({ eventType: "flows.harness.model-parked.v1", seat: "openai:gpt-6-sol", wakeAt: Date.now() + 80,
      source: "reset", code: "rate_limited" }))
    first.workspace.dispose()
    let relaunched: Host.TurnInput | undefined
    const restored = fixture((input) => {
      relaunched = input
      return { done: new Promise(() => {}), cancel: () => {} }
    }, Session.restore(first.records).workspace)
    expect(restored.workspace.snapshot().tabs[0]?.status).toBe("parked")
    expect(relaunched).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(relaunched?.seat).toBe("openai:gpt-6-sol")
    expect(relaunched?.history.some((entry) => entry.kind === "exchange" && entry.user === request.prompt)).toBe(true)
    expect(restored.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("waits for a failed provider's reset before resuming", async () => {
    const inputs: Host.TurnInput[] = []
    const f = fixture((input) => {
      inputs.push(input)
      return inputs.length === 1
        ? { done: Promise.resolve({ _tag: "failed", message: "raw limit", detail: "stack",
          error: new ModelError({ code: "rate_limited", message: "raw limit", resetAtEpochMillis: Date.now() + 80 }) }), cancel: () => {} }
        : { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("failed")
    const receipt = Session.load(f.workspace.snapshot().tabs[0]!.file).findLast((record) => record.type === "outcome")
    expect(receipt).toMatchObject({ type: "outcome", outcome: { headline: "ChatGPT usage limit reached" } })
    expect(receipt?.type === "outcome" && "error" in receipt.outcome).toBe(false)
    f.workspace.waitForReset(request.id)
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("parked")
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(inputs).toHaveLength(2)
    expect(inputs[1]?.seat).toBe("openai:gpt-6-sol")
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("running")
  })
})
