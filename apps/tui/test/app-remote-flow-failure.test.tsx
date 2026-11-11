import { testRender } from "@opentui/react/test-utils"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import * as FlowControl from "../src/flow-control.vibe"
import type { Settled } from "../src/flows.ts"
import * as Host from "../src/host.vibe"
import * as Session from "../src/session.ts"

// Real module -> engine-store -> control watch -> FlowRuns -> native App card.
// Only Chat's model is replaced. The public watch's terminal receipt is held so
// one native frame after releasing it proves the cause does not need Enter.
const cwd = join(import.meta.dir, "fixtures/remote-failure-project")
const root = mkdtempSync(join(tmpdir(), "tui-remote-failure-"))
const approvals = Host.make({ cwd, environment: {}, approvals: "all" })
const control = FlowControl.make({
  cwd,
  environment: {},
  stateRoot: join(root, "state"),
  approvals: approvals.approvals!
})
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let previousSessions: string | undefined
let receipt: ReturnType<typeof Promise.withResolvers<Settled>>
let settlement: Settled | undefined
let terminal: unknown
let chats: string[]
let watches: Array<
  {
    gate: ReturnType<typeof Promise.withResolvers<Settled>>
    settled?: Settled
    emit: Parameters<typeof control.watch>[1]
  }
>
const frame = () => setup!.captureCharFrame()
const records = () => Session.list(cwd).flatMap((summary) => Session.load(summary.file))
const latest = () => records().filter((record) => record.type === "flow").at(-1)?.run
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 10_000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setTimeout(10)
    })
    await setup!.renderOnce()
  }
  if (!condition()) throw new Error(`Remote failure did not settle:\n${frame()}`)
}
const submit = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.typeText(text)
    await setup!.mockInput.pressKeys(["RETURN"])
  })
  await setup!.renderOnce()
}
beforeAll(async () => {
  await control.warm!()
  await control.input!("failure")
}, 30_000)
beforeEach(async () => {
  previousSessions = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, `sessions-${Date.now()}`)
  receipt = Promise.withResolvers<Settled>()
  settlement = undefined
  terminal = undefined
  chats = []
  watches = []
  const host: Host.Host = {
    cwd,
    judged: false,
    run: (input) => {
      chats.push(input.prompt)
      return { done: Promise.resolve({ _tag: "done", answer: "Still here." }), cancel: () => {} }
    },
    dispose: async () => {}
  }
  const port = {
    ...control,
    watch: (runId: string, onEvent: Parameters<typeof control.watch>[1]) => {
      const gate = watches.length === 0 ? receipt : Promise.withResolvers<Settled>()
      const attempt = { gate, settled: undefined as Settled | undefined, emit: onEvent }
      watches.push(attempt)
      const watching = control.watch(runId, (event) => {
        if (event.kind === "control.run.failed") terminal = event.payload
        act(() => onEvent(event))
      })
      void watching.done.then((value) => {
        attempt.settled = value
        if (watches[0] === attempt) settlement = value
      }, gate.reject)
      return { done: gate.promise, close: watching.close }
    },
    dispose: async () => {}
  }
  await act(async () => {
    setup = await testRender(
      <App host={host} flows={port} seat="test:chat" models={[]} contextWindow={() => 10000} />,
      { width: 110, height: 32, exitOnCtrlC: false }
    )
    await setImmediate()
  })
})
afterEach(async () => {
  await act(async () => {
    for (const watch of watches) watch.gate.resolve(watch.settled ?? { kind: "cancelled" })
    await setImmediate()
    setup?.renderer.destroy()
  })
  setup = undefined
  if (previousSessions === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousSessions
})
afterAll(async () => {
  await control.dispose()
  await approvals.dispose()
  rmSync(root, { recursive: true, force: true })
})

const diagnostic =
  "private-fixture /private/fixture https://fixture.invalid token=fixture-secret\n\u001b[31mstack detail"
test("an actual UnencodableResult has a safe cause on the first settled native Chat frame", async () => {
  await submit(`/flow failure ${JSON.stringify({ error: diagnostic, unencodable: true })}`)
  await waitFor(() => settlement !== undefined)
  expect(terminal).toMatchObject({ fault: { tag: "unregistered" } })
  expect((terminal as { cause: string }).cause).toContain("\"_tag\":\"flows/engine-store/UnencodableResult\"")
  expect(latest()?.status).toBe("running")
  await submit("Chat while the failure receipt is held")
  expect(chats).toEqual(["Chat while the failure receipt is held"])
  await act(async () => {
    receipt.resolve(settlement!)
    await setImmediate()
  })
  await setup!.renderOnce()
  const card = frame().split("\n").find((line) => /^\s+✗ failure ·/.test(line)) ?? ""
  if (process.env.SMITHERS_3674_EVIDENCE) {
    writeFileSync(
      process.env.SMITHERS_3674_EVIDENCE,
      JSON.stringify({ settlement, terminal, card, frame: frame() }, null, 2)
    )
  }
  expect(card).toContain("failed: Flow result could not be encoded.")
  expect(card).not.toMatch(/private|https|token|stack|UnencodableResult|\u001b/)
  expect(latest()).toMatchObject({ status: "failed", failure: "Flow result could not be encoded." })
  expect(latest()?.message).toContain("UnencodableResult")
  await act(async () => {
    await setup!.mockInput.pressKeys(["TAB"])
  })
  await setup!.renderOnce()
  await act(async () => {
    await setup!.mockInput.pressKeys(["RETURN"])
  })
  await setup!.renderOnce()
  expect(frame()).toContain("UnencodableResult")
  expect(frame()).toContain("Resume")
  const firstRunId = latest()?.runId
  await act(async () => {
    await setup!.mockInput.pressKeys(["r"])
  })
  await setup!.renderOnce()
  await waitFor(() => watches.length === 2 && watches[1]!.settled !== undefined)
  expect(latest()).toMatchObject({ attempt: 2, status: "running" })
  expect(latest()?.runId).not.toBe(firstRunId)
  expect(latest()?.failure).toBeUndefined()
  expect(latest()?.message).toBeUndefined()
  await act(async () => {
    await setup!.mockInput.pressKeys(["ESCAPE"])
  })
  // A lone ESC byte is dispatched after the real terminal parser's ambiguity timeout.
  await waitFor(() => !frame().split("\n")[0]!.includes("▸"))
  expect(frame()).not.toContain("failed: Flow result could not be encoded.")
  await act(async () => {
    watches[1]!.gate.resolve(watches[1]!.settled!)
    await setImmediate()
  })
  await setup!.renderOnce()
  expect(frame()).toContain("failed: Flow result could not be encoded.")
}, 20_000)

const cases = [
  {
    name: "model transport",
    error: { _tag: "flows/model/ModelError", code: "transport", message: diagnostic },
    copy: "Model connection failed"
  },
  {
    name: "nested quota",
    error: {
      _tag: "/harness/HarnessError",
      code: "model_failed",
      message: diagnostic,
      cause: {
        _tag: "flows/model/ModelError",
        code: "quota_exceeded",
        seat: diagnostic,
        resetAtEpochMillis: 1e300,
        message: diagnostic
      }
    },
    copy: "Model quota exhausted"
  },
  {
    name: "worker engine",
    error: { _tag: "/harness/HarnessError", code: "engine_failed", message: diagnostic },
    copy: "Worker engine stopped"
  },
  {
    name: "seat unresolved",
    error: { _tag: "@smthrs/agent/Seat/SeatUnresolved", message: diagnostic },
    copy: "Model sign-in required"
  },
  {
    name: "evaluator",
    error: { _tag: "flows/model/EvaluatorError", code: "timeout", message: diagnostic },
    copy: "Worker result could not be checked"
  },
  {
    name: "seat unrouted",
    error: { _tag: "@smthrs/agent/Seat/SeatUnrouted", reason: "no_candidates", message: diagnostic },
    copy: "Model could not be chosen"
  },
  {
    // A `reason` selects copy; a remote one must not reach the shared presenter.
    name: "seat unrouted hostile reason",
    error: { _tag: "@smthrs/agent/Seat/SeatUnrouted", reason: diagnostic, message: diagnostic },
    copy: "Model could not be chosen"
  },
  { name: "unknown text", error: { message: diagnostic }, copy: "The flow failed." },
  {
    name: "malformed model",
    error: { _tag: "flows/model/ModelError", code: { secret: diagnostic }, message: diagnostic },
    copy: "The flow failed."
  },
  {
    name: "unknown model code",
    error: { _tag: "flows/model/ModelError", code: diagnostic, message: diagnostic },
    copy: "The flow failed."
  },
  {
    name: "inherited harness code",
    error: { _tag: "/harness/HarnessError", code: "constructor", message: diagnostic },
    copy: "The flow failed."
  },
  { name: "inherited tag", error: { _tag: "constructor", message: diagnostic }, copy: "The flow failed." },
  {
    name: "serialized tag in text",
    error: { message: "Error: {\"_tag\":\"flows/engine-store/UnencodableResult\"}" },
    copy: "The flow failed."
  },
  { name: "array", error: [{ _tag: "flows/model/ModelError", code: "transport" }], copy: "The flow failed." },
  { name: "check lower", error: { message: "Check exited 1" }, copy: "Check exited 1." },
  { name: "command upper", error: { message: "Command exited 255." }, copy: "Command exited 255." },
  { name: "check zero", error: { message: "Check exited 0" }, copy: "The flow failed." },
  { name: "command over bound", error: { message: "Command exited 256" }, copy: "The flow failed." },
  { name: "command leading zero", error: { message: "Command exited 07" }, copy: "The flow failed." },
  { name: "command diagnostics", error: { message: "Command exited 7: " + diagnostic }, copy: "The flow failed." },
  { name: "command next line", error: { message: "Check exited 7\n" + diagnostic }, copy: "The flow failed." },
  { name: "command terminal controls", error: { message: "\u001b[31mCommand exited 7" }, copy: "The flow failed." }
]
test.each(cases)(
  "$name enters the real watch and gets only host-authored copy on the native card",
  async ({ error, copy }) => {
    await submit(`/flow failure ${JSON.stringify({ error })}`)
    await waitFor(() => settlement !== undefined)
    expect(settlement?.kind).toBe("failed")
    expect(terminal).toBeDefined()
    await act(async () => {
      receipt.resolve(settlement!)
      await setImmediate()
    })
    await setup!.renderOnce()
    const card = frame().split("\n").find((line) => /^\s+✗ failure ·/.test(line)) ?? ""
    expect(card).toContain(`failed: ${copy}`)
    expect(card).not.toMatch(/private|https|fixture-secret|stack|\u001b|UnencodableResult|constructor/)
    expect(latest()).toMatchObject({ status: "failed", failure: copy })
  },
  20_000
)
