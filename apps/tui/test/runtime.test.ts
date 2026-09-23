import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Changes from "../src/changes.ts"
import type * as Host from "../src/host.ts"
import * as Models from "../src/models.ts"
import * as Panels from "../src/panels.ts"
import * as Runtime from "../src/runtime.ts"
import * as Session from "../src/session.ts"
import * as Summary from "../src/summary.ts"
import * as Transcript from "../src/transcript.ts"
import { Workspace } from "../src/workspace.ts"

const panel: Panels.Panel = {
  id: "checks",
  title: "Checks",
  summary: "Two checks passed.",
  rows: [{
    id: "test",
    label: "Checked addition",
    status: "done",
    details: [{ kind: "code", code: "assert(add(2, 3) === 5)", language: "javascript" }],
    action: { label: "Run again", prompt: "Run the addition check again" }
  }]
}
const fixture = () =>
  Session.restore(
    readFileSync(join(import.meta.dir, "fixtures/fix-add.jsonl"), "utf8").trim().split("\n").map((line) => ({
      type: "event" as const,
      ...JSON.parse(line)
    }))
  ).transcript

it("summarizes real cells, their code, failures and the answer without dumping source in labels", () => {
  const transcript = fixture()
  const summary = Summary.panel(transcript)
  expect(summary.summary).toMatch(/Fixed/)
  const cells = transcript.items.filter((item) => item.kind === "cell")
  expect(summary.rows.filter((row) => row.details.some((block) => block.kind === "code"))).toHaveLength(cells.length)
  expect(summary.rows.some((row) => /exit 1/.test(row.label))).toBe(true)
  expect(summary.rows.some((row) => /Updated math.js/.test(row.label))).toBe(true)
  expect(summary.rows.some((row) => row.label.includes("ctx.call"))).toBe(false)
  expect(Summary.panel(Transcript.failure(transcript, "Provider unavailable", 99)).summary).toBe(
    "Stopped: Provider unavailable"
  )
  expect(Summary.panel(Transcript.user(transcript, "Now fix subtraction")).summary).toBe(
    "Requested: Now fix subtraction"
  )
})

it("supports hjkl and arrows, per-row expansion and independent diff toggles", () => {
  const rows = [...panel.rows, { ...panel.rows[0]!, id: "second" }]
  let state = Panels.initial()
  state = Panels.navigate(state, "l", rows)
  expect(state.expanded.has("test")).toBe(true)
  state = Panels.navigate(state, "down", rows)
  state = Panels.navigate(state, "return", rows)
  expect([...state.expanded]).toEqual(["test", "second"])
  state = Panels.navigate(state, "k", rows)
  state = Panels.navigate(state, "left", rows)
  expect([...state.expanded]).toEqual(["second"])
  expect(Panels.navigate(state, "d", rows).diff).toBe(true)
  expect(Panels.navigate(state, "v", rows).split).toBe(true)
  expect(Panels.navigate(state, "up", rows).selected).toBe(0)
  expect(Panels.navigate(state, "down", []).selected).toBe(0)
})

it("validates runtime panels and rejects duplicate rows, oversized input and executable blocks", () => {
  expect(Panels.decode(panel)).toEqual(panel)
  expect(() => Panels.decode({ ...panel, rows: [panel.rows[0], panel.rows[0]] })).toThrow("unique")
  expect(() => Panels.decode({ ...panel, summary: "x".repeat(241) })).toThrow()
  expect(() =>
    Panels.decode({
      ...panel,
      rows: [{ id: "evil", label: "evil", details: [{ kind: "eval", source: "process.exit()" }] }]
    })
  ).toThrow()
})

it("registers real catalog flows and validates before publishing without invoking actions", async () => {
  const published: Panels.Panel[] = []
  const bindings = await Effect.runPromise(Runtime.source({ publish: (value) => published.push(value) }).bindings())
  expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["ui.publish"])
  const call = { input: panel } as unknown as Parameters<(typeof bindings)[number]["run"]>[0]
  expect((await Effect.runPromise(bindings[0]!.run(call))).outcome).toBe("success")
  expect(published).toEqual([panel])
  const invalid = await Effect.runPromise(bindings[0]!.run({ ...call, input: { ...panel, summary: false } }))
  expect(invalid.outcome).toBe("failure")
  expect(published).toHaveLength(1)
})

it("exposes flow.list and flow.run only with a flows port, and returns the run receipt at once", async () => {
  const requests: Array<unknown> = []
  const bindings = await Effect.runPromise(Runtime.source({
    publish: () => {},
    flows: {
      list: () => [{ name: "review", description: "Review a change" }],
      run: (request) => {
        requests.push(request)
        return { id: request.id, status: "requested" }
      }
    }
  }).bindings())
  expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["ui.publish", "flow.list", "flow.run"])
  const run = bindings.find((binding) => binding.descriptor.name === "flow.run")!
  const call = (input: unknown) => run.run({ input } as Parameters<typeof run.run>[0])
  const result = await Effect.runPromise(call({ id: "r1", flow: "review", input: { title: "x" } }))
  expect(result).toMatchObject({ outcome: "success", value: { id: "r1", status: "requested" } })
  expect(requests).toEqual([{ id: "r1", flow: "review", input: { title: "x" } }])
  expect((await Effect.runPromise(call({ id: "r2" }))).outcome).toBe("failure")
  const list = bindings.find((binding) => binding.descriptor.name === "flow.list")!
  expect(await Effect.runPromise(list.run({ input: {} } as Parameters<typeof list.run>[0]))).toMatchObject({
    outcome: "success",
    value: [{ name: "review", description: "Review a change" }]
  })
})

it("accepts only named models in the delegate flow", async () => {
  const requests: Array<unknown> = []
  const bindings = await Effect.runPromise(Runtime.source({
    publish: () => {},
    delegate: (value) => { requests.push(value); return { status: "requested" } },
    read: () => ({}),
    list: () => []
  }).bindings())
  const delegate = bindings.find((binding) => binding.descriptor.name === "agent.delegate")!
  const input = { id: "test", title: "Test", prompt: "Test work" }
  const call = (value: unknown) => delegate.run({ input: value } as Parameters<typeof delegate.run>[0])
  for (const model of Object.keys(Models.delegateModels)) {
    expect((await Effect.runPromise(call({ ...input, model }))).outcome).toBe("success")
  }
  expect((await Effect.runPromise(call(input))).outcome).toBe("success")
  expect((await Effect.runPromise(call({ ...input, model: "unknown" }))).outcome).toBe("failure")
  expect(requests).toHaveLength(8)
})

it("produces contextual hunks, preserves unchanged lines, and captures patch rename paths", () => {
  const patch = Changes.patch("math.js", "// addition\nreturn a - b\n// end\n", "// addition\nreturn a + b\n// end\n")!
  expect(patch.patch).toContain(" // addition")
  expect(patch.patch).toContain("-return a - b")
  expect(patch.patch).toContain("+return a + b")
  expect(Changes.patch("same", "same", "same")).toBeUndefined()
  expect(
    Changes.paths("apply_patch", {
      input: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+b\n*** Delete File: c.ts\n*** End Patch"
    })
  ).toEqual(["a.ts", "b.ts", "c.ts"])
  // A patch apply_patch refuses writes nothing, so it names no file.
  expect(Changes.touched("apply_patch", { input: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch" }))
    .toBeUndefined()
})

it("captures actual overwrite contents at a flow boundary and preserves the result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-diff-"))
  writeFileSync(join(cwd, "a.ts"), "before\n")
  const receipts: Changes.Receipt[] = []
  const source = {
    name: "test",
    bindings: () =>
      Effect.succeed([{
        descriptor: { name: "write" },
        run: () =>
          Effect.sync(() => {
            writeFileSync(join(cwd, "a.ts"), "after\n")
            return { outcome: "success", value: 1 }
          })
      }])
  } as unknown as Parameters<typeof Changes.capture>[0]
  const [binding] = await Effect.runPromise(
    Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
  )
  const result = await Effect.runPromise(
    binding!.run(
      {
        flowName: "write",
        input: { path: "a.ts", content: "after\n" },
        identity: { session: "test", frame: 1, ordinal: 0 }
      } as any
    )
  )
  expect(result.value).toBe(1)
  expect(receipts[0]?.patches[0]?.patch).toContain("-before")
  expect(receipts[0]?.patches[0]?.patch).toContain("+after")
})

const setup = (run?: Host.Host["run"]) => {
  let resolve!: (outcome: Host.Outcome) => void
  let input!: Host.TurnInput
  let launched = 0
  let cancelled = 0
  const records: Session.Record[] = []
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-worker-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: run ?? ((value) => {
      launched++
      input = value
      return {
        done: new Promise((done) => {
          resolve = done
        }),
        cancel: () => {
          cancelled++
          resolve({ _tag: "cancelled" })
        }
      }
    })
  }
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record)
  })
  return {
    workspace,
    records,
    host,
    complete: (outcome: Host.Outcome) => resolve(outcome),
    launched: () => launched,
    cancelled: () => cancelled,
    input: () => input
  }
}
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const request = { id: "fix", title: "Fix addition", prompt: "Fix addition and run the checks." }

describe("background work", () => {
  it("caches one Luna description per tab and falls back to the title on failure", async () => {
    const f = setup()
    let finish!: (text: string) => void
    const calls: Array<{ title: string; prompt: string; model: string }> = []
    ;(f.host as { describe?: Host.Host["describe"] }).describe = (input) => {
      calls.push(input)
      return new Promise((resolve) => { finish = resolve })
    }
    f.workspace.request(request)
    expect(f.workspace.snapshot().tabs[0]?.description).toBeUndefined()
    f.workspace.request(request)
    expect(calls).toEqual([{ title: request.title, prompt: request.prompt, model: "luna" }])
    finish("  Fix   addition\n and verify " + "x".repeat(90))
    await tick()
    const description = f.workspace.snapshot().tabs[0]?.description
    expect(description).toStartWith("Fix addition and verify")
    expect(description?.includes("\n")).toBe(false)
    expect(description?.length).toBe(80)
    expect(Session.restore(f.records).workspace.tabs[0]?.description).toBe(description)
    expect(calls).toHaveLength(1)
    f.complete({ _tag: "done", answer: "Done" })
    await tick()

    const failed = setup()
    ;(failed.host as { describe?: Host.Host["describe"] }).describe = async () => { throw new Error("Luna unavailable") }
    failed.workspace.request(request)
    await tick()
    expect(failed.workspace.snapshot().tabs[0]?.description).toBe(request.title)
    failed.complete({ _tag: "done", answer: "Done" })
    await tick()
  })
  it("uses the named delegate model for the worker and preserves the default seat", async () => {
    const named = setup()
    named.workspace.request({ ...request, model: "astra" })
    expect(named.workspace.snapshot().tabs[0]?.seat).toBe(Models.delegateModels.astra)
    await tick()
    expect(named.input().seat).toBe("openai:gpt-6-astra")
    named.complete({ _tag: "done", answer: "Done" })
    await tick()

    const defaultWorker = setup()
    defaultWorker.workspace.request(request)
    await tick()
    expect(defaultWorker.input().seat).toBe("worker:test")
    defaultWorker.complete({ _tag: "done", answer: "Done" })
    await tick()
  })
  it("persists and acknowledges before launch, keeps running through unresolved execution, and deduplicates", async () => {
    const f = setup()
    expect(f.workspace.request(request)).toEqual({ id: "fix", status: "requested" })
    expect(f.records[0]).toMatchObject({ type: "tab", tab: { status: "requested" } })
    expect(f.launched()).toBe(0)
    f.workspace.request(request)
    expect(f.records).toHaveLength(1)
    await tick()
    expect(f.launched()).toBe(1)
    expect(f.workspace.read("fix").status).toBe("running")
    // Chat can publish, inspect, and request other work while the worker never resolves.
    f.workspace.publish(panel)
    expect(f.workspace.snapshot().panels).toEqual([panel])
    expect(f.workspace.busy).toBe(true)
    expect(f.input().role).toBe("worker")
    expect(f.input().runtime?.delegate).toBeUndefined()
    f.complete({ _tag: "done", answer: "Fixed addition; the check passes." })
    await tick()
    expect(f.workspace.read("fix")).toMatchObject({ status: "done", answer: "Fixed addition; the check passes." })
    expect(f.workspace.busy).toBe(false)
    expect(Session.restore(f.records).workspace.panels).toEqual([panel])
    expect(Session.restore(f.records).workspace.tabs[0]?.status).toBe("done")
  })
  it("shows launch failures and supports an explicit retry", async () => {
    let fail = true
    const f = setup(() => {
      if (fail) throw new Error("Launch refused")
      return { done: Promise.resolve({ _tag: "done", answer: "Done" }), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    expect(f.workspace.read("fix")).toMatchObject({ status: "failed", message: "Error: Launch refused" })
    fail = false
    f.workspace.retry("fix")
    expect(f.workspace.read("fix").status).toBe("requested")
    await tick()
    expect(f.workspace.read("fix").status).toBe("done")
  })
  it("cancels before launch and refuses id collisions", async () => {
    const f = setup()
    f.workspace.request(request)
    expect(() => f.workspace.request({ ...request, prompt: "Different work" })).toThrow("another task")
    expect(() => f.workspace.request({ ...request, model: "sol" })).toThrow("another task")
    f.workspace.cancel("fix")
    await tick()
    expect(f.launched()).toBe(0)
    expect(f.workspace.read("fix").status).toBe("cancelled")
  })
  it("restores custom UI and marks a lost local worker interrupted instead of claiming success", async () => {
    const f = setup()
    f.workspace.request(request)
    f.workspace.publish(panel)
    const restored = new Workspace({
      host: f.host,
      workerSeat: "worker:test",
      history: () => [],
      persist: () => {},
      restored: Session.restore(f.records).workspace
    })
    expect(restored.snapshot().panels).toEqual([panel])
    expect(restored.read("fix")).toMatchObject({ status: "failed", message: "Interrupted; retry to continue." })
    expect(f.launched()).toBe(0)
    f.workspace.dispose()
  })
})

it("prefers Cerebras for chat and keeps a distinct worker seat and explicit overrides", () => {
  const seats = Models.detect({
    CEREBRAS_API_KEY: "test",
    ANTHROPIC_API_KEY: "test",
    SMITHERS_TUI_WORKER_SEAT: "anthropic:worker"
  })
  expect(seats.defaultSeat).toBe("cerebras:qwen-3.8-27b")
  expect(seats.workerSeat).toBe("anthropic:worker")
  expect(Models.detect({ CEREBRAS_API_KEY: "test", SMITHERS_TUI_SEAT: "explicit:chat" }).defaultSeat).toBe(
    "explicit:chat"
  )
})

it("captures shell changes against a jj snapshot without attributing pre-existing edits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-jj-diff-"))
  const init = Bun.spawn(["jj", "git", "init", cwd], { stdout: "ignore", stderr: "ignore" })
  expect(await init.exited).toBe(0)
  writeFileSync(join(cwd, "a.ts"), "pre-existing content\n")
  writeFileSync(join(cwd, "unrelated.ts"), "leave this alone\n")
  const receipts: Changes.Receipt[] = []
  const source = {
    name: "test",
    bindings: () =>
      Effect.succeed([{
        descriptor: { name: "bash" },
        run: () =>
          Effect.sync(() => {
            writeFileSync(join(cwd, "a.ts"), "new content\n")
            return { outcome: "success" }
          })
      }])
  } as unknown as Parameters<typeof Changes.capture>[0]
  const [binding] = await Effect.runPromise(
    Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
  )
  await Effect.runPromise(
    binding!.run(
      {
        flowName: "bash",
        input: { command: "update a.ts" },
        identity: { session: "test", frame: 1, ordinal: 0 }
      } as any
    )
  )
  expect(receipts[0]?.patches).toHaveLength(1)
  expect(receipts[0]?.patches[0]?.path).toBe("a.ts")
  expect(receipts[0]?.patches[0]?.patch).toContain("-pre-existing content")
  expect(receipts[0]?.patches[0]?.patch).toContain("+new content")
})

it("keeps worker files out of the conversation picker and latest-session lookup", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-session-kind-"))
  const chat = Session.create(cwd)
  chat.append({ type: "user", at: 1, text: "Conversation" })
  const worker = Session.create(cwd, "worker")
  worker.append({ type: "user", at: 2, text: "Background task" })
  expect(Session.latest(cwd)).toBe(chat.file)
  expect(Session.list(cwd).map((row) => row.file)).toEqual([chat.file])
  expect(Session.restore(Session.load(worker.file)).prompts).toEqual(["Background task"])
})

it("recovers a worker completion written before the parent recorded it", () => {
  const f = setup()
  const writer = Session.create(f.host.cwd, "worker")
  writer.append({
    type: "outcome",
    at: 99,
    prompt: request.prompt,
    outcome: { _tag: "done", answer: "The check passes." }
  })
  const records: Session.Record[] = []
  const workspace = new Workspace({
    host: f.host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record),
    restored: {
      panels: [],
      tabs: [{ ...request, file: writer.file, seat: "worker:test", startedAt: 1, status: "running" }]
    }
  })
  expect(workspace.read("fix")).toMatchObject({ status: "done", answer: "The check passes." })
  expect(records[0]).toMatchObject({ type: "tab", tab: { status: "done", endedAt: 99 } })
})

it("uses full call identities and replays persisted captions and actual diffs", () => {
  const transcript = fixture()
  const cell = transcript.items.find((item) => item.kind === "cell" && item.calls.some((call) => call.flow === "edit"))!
  if (cell.kind !== "cell") throw new Error("Missing edit cell")
  const call = cell.calls.find((call) => call.flow === "edit")!
  const receipt = { call: call.identity!, patches: [{ path: "math.js", patch: "real recorded diff" }] }
  const patched = Transcript.patched(transcript, receipt)
  expect(
    patched.items.filter((item) => item.kind === "cell").flatMap((item) => item.calls).filter((item) =>
      item.patches !== undefined
    )
  ).toHaveLength(1)
  const records: Session.Record[] = readFileSync(join(import.meta.dir, "fixtures/fix-add.jsonl"), "utf8").trim().split(
    "\n"
  ).map((line) => ({ type: "event", ...JSON.parse(line) }))
  records.push({ type: "patch", receipt }, { type: "caption", prose: "Verified addition." })
  const restored = Session.restore(records).transcript
  expect(
    Summary.panel(restored).rows.flatMap((row) => row.details).some((block) =>
      block.kind === "diff" && block.patch === "real recorded diff"
    )
  ).toBe(true)
  expect(restored.items.findLast((item) => item.kind === "cell")?.prose).toBe("Verified addition.")
})
