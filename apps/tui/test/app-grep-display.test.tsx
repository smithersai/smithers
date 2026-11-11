import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Option } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import * as Files from "../src/files.ts"
import type * as Host from "../src/host.vibe"
import * as Session from "../src/session.ts"

// Actual App, native frames, persisted harness events and real commands. The
// host never executes a provider or a flow. File completion uses its existing
// lister seam so even a future completion change cannot spawn git here.
let root: string
let cwd: string
let saved: Session.Writer
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let files: ReturnType<typeof spyOn<typeof Files, "lister">>
let runs = 0
const frame = () => setup!.captureCharFrame()
const capture = (name: string) => {
  const text = frame()
  if (process.env.SMITHERS_GREP_FRAME_DIR !== undefined) {
    mkdirSync(process.env.SMITHERS_GREP_FRAME_DIR, { recursive: true })
    writeFileSync(join(process.env.SMITHERS_GREP_FRAME_DIR, `${name}.txt`), text)
  }
  return text
}
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await setup!.renderOnce()
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.pressKeys(Array.from(text))
  })
  await setup!.renderOnce()
}
const command = async (text: string) => {
  await type(text)
  await key("RETURN", { meta: true })
}
const cells = () => Session.restore(Session.load(saved.file)).transcript.items.filter((item) => item.kind === "cell")
const kept = () =>
  cells().filter((cell) =>
    setup!.renderer.root.findDescendantById(`chat:${cell.id}`) !== null &&
    setup!.renderer.root.findDescendantById(`chat:${cell.id}`) !== undefined
  ).map((cell) => cell.index)
const visible = async (text: string) => {
  const deadline = Date.now() + 4000
  while (!frame().includes(text)) {
    if (Date.now() > deadline) throw new Error(`Missing rendered text: ${text}\n${frame()}`)
    await act(async () => {
      await setImmediate()
      await setup!.renderOnce()
    })
  }
}
const mount = async (width = 140) => {
  const host: Host.Host = {
    cwd,
    judged: false,
    run: () => {
      runs++
      throw new Error("Search must stay local")
    },
    dispose: async () => {}
  }
  await act(async () => {
    setup = await testRender(
      <App host={host} seat="replay:grep-display" models={[]} contextWindow={() => 10000} resume={saved.file} />,
      { width, height: 70, exitOnCtrlC: false, kittyKeyboard: true }
    )
    await setImmediate()
  })
  await visible("Ordinary answer")
}
const event = (value: AgentEvent.AgentEvent) => saved.append({ type: "event", at: 100 + cells().length, event: value })
const seedCell = (options: {
  flow?: string
  subject?: string
  message?: string
  denied?: boolean
  raised?: string
  rejected?: boolean
  notes?: boolean
} = {}) => {
  event(
    new AgentEvent.TurnOpened({
      eventType: "flows.harness.turn-opened.v1",
      seat: "replay:grep-display",
      modelParams: {},
      activeToolNames: [],
      contextDigest: "display-fixture"
    })
  )
  const cell = Cell.source(`const value${cells().length + 1} = 1`)
  event(new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell }))
  if (options.flow !== undefined) {
    const identity = new Cell.CallIdentity({
      session: "display-fixture",
      frame: cells().length,
      cell: cell.digest,
      ordinal: 0,
      declaration: options.flow,
      layers: []
    })
    event(
      new AgentEvent.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: options.flow,
          input: { path: options.subject ?? "visible.txt" },
          identity,
          capabilities: [],
          placement: Option.none(),
          effects: { reads: [], writes: [], tier: "compensable", mode: "expected", onConflict: "serialize" },
          presentation: {
            verb: { pending: "reading", success: "read", failure: "failed to read" },
            subject: "path",
            result: "read"
          }
        })
      })
    )
    event(
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: options.flow,
        identity,
        result: new Cell.CallResult(
          options.message === undefined
            ? { outcome: "success", value: {} }
            : {
              outcome: "failure",
              value: null,
              message: options.message,
              ...(options.denied ? { code: "capability_refused" } : {})
            }
        )
      })
    )
  }
  event(
    new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: cell.digest,
      outcome: options.rejected
        ? new Cell.Rejected({ code: "compile_failed", message: "compilerDiagnostic" })
        : options.raised === undefined ?
        new Cell.Settled({ transition: new Cell.Continue({}) })
        : new Cell.Raised({ name: "TypeError", message: options.raised })
    })
  )
  if (options.notes) {
    event(
      new AgentEvent.ReadOnlyDemanded({
        eventType: "flows.harness.read-only-demanded.v1",
        streak: 2,
        cap: 2,
        nextFrame: 3,
        nextAction: "write"
      })
    )
    event(
      new AgentEvent.NarrowedDemanded({
        eventType: "flows.harness.narrowed-demanded.v1",
        flow: "bash",
        broader: "broadEvidence",
        narrower: "narrowEvidence",
        broaderDigest: "before",
        currentDigest: "after",
        nextFrame: 3
      })
    )
  }
}
const finish = () => {
  event(
    new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant("Ordinary answer")
    })
  )
  saved.append({
    type: "outcome",
    at: 200,
    prompt: "Ordinary question",
    outcome: { _tag: "done", answer: "Ordinary answer" }
  })
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-grep-display-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  files = spyOn(Files, "lister").mockImplementation(() => () => [])
  runs = 0
  saved = Session.create(cwd)
  saved.append({ type: "user", at: 100, text: "Ordinary question" })
})
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    await setImmediate()
  })
  setup = undefined
  files.mockRestore()
  if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
  rmSync(root, { recursive: true, force: true })
  expect(runs).toBe(0)
})

test.each(["read-only", "narrowed"])("grep finds visible %s callout titles and disclosure details", async (title) => {
  seedCell({ flow: "read", subject: "callout.txt", notes: true })
  finish()
  await mount()
  expect(capture(`${title}-initial`)).toContain(`△ ${title}`)
  await command(`/grep ${title}`)
  expect(capture(`${title}-grep`)).toContain(`△ ${title}`)
  expect(kept()).toEqual([1])
  await command("/grep broadEvidence")
  expect(capture(`${title}-body-collapsed`)).not.toContain("callout.txt")
  await key("o", { ctrl: true })
  expect(capture(`${title}-body-expanded`)).toContain("broadEvidence")
  expect(kept()).toEqual([1])
  await key("o", { ctrl: true })
  expect(kept()).toEqual([])
  await command("/grep")
  expect(frame()).toContain(`△ ${title}`)
})

test.each([
  { query: "This step failed.", expected: [1], shown: "This step failed." },
  { query: "rawDiagnostic", expected: [], shown: undefined },
  { query: "visible.txt", expected: [2], shown: "visible.txt" },
  { query: "hiddenSubjectTail", expected: [], shown: undefined },
  { query: "plumbingSubject", expected: [], shown: undefined },
  { query: "compile_failed", expected: [], shown: undefined },
  { query: "This action failed.", expected: [3], shown: "This action failed." },
  { query: "callDiagnostic", expected: [], shown: undefined },
  { query: "no such file", expected: [4], shown: "no such file" },
  {
    query: "failed to read missing.txt · no such file",
    expected: [4],
    shown: "failed to read missing.txt · no such file"
  },
  { query: "readStepDiagnostic", expected: [], shown: undefined }
])("grep $query uses the collapsed non-program display", async ({ query, expected, shown }) => {
  seedCell({ raised: "rawDiagnostic" })
  seedCell({ flow: "read", subject: "visible.txt\nhiddenSubjectTail" })
  seedCell({ flow: "bash", subject: "check.mjs", message: "callDiagnostic" })
  seedCell({
    flow: "read",
    subject: "missing.txt",
    message: "File not found: missing.txt",
    raised: "readStepDiagnostic"
  })
  seedCell({ flow: "ui.publish", subject: "plumbingSubject" })
  seedCell({ rejected: true })
  finish()
  await mount()
  const initial = capture(`${query}-initial`)
  expect(initial).toContain("This step failed.")
  expect(initial).toContain("visible.txt")
  for (
    const hidden of [
      "rawDiagnostic",
      "hiddenSubjectTail",
      "plumbingSubject",
      "compile_failed",
      "callDiagnostic",
      "readStepDiagnostic"
    ]
  ) expect(initial).not.toContain(hidden)
  const original = Session.load(saved.file)
  await command(`/grep ${query}`)
  const searched = capture(`${query}-grep`)
  expect(kept()).toEqual([...expected])
  if (shown !== undefined) expect(searched).toContain(shown)
  await command("/grep")
  await visible("Ordinary answer")
  expect(frame()).toContain("Ordinary question")
  expect(frame()).toContain("Ordinary answer")
  expect(Session.load(saved.file)).toEqual(original)
})

test("Ctrl+O and Cells expose failures and plumbing with their existing detail rules", async () => {
  seedCell({ raised: "rawDiagnostic" })
  seedCell({ flow: "ui.publish", subject: "plumbingSubject" })
  seedCell({ rejected: true })
  finish()
  await mount()
  await command("/grep rawDiagnostic")
  expect(kept()).toEqual([])
  await key("o", { ctrl: true })
  expect(capture("failure-expanded")).toContain("TypeError: rawDiagnostic")
  expect(kept()).toEqual([1])
  await key("o", { ctrl: true })
  expect(kept()).toEqual([])
  await command("/grep")
  await command("/filter")
  await type("Cells")
  await key("ARROW_DOWN")
  await key("RETURN")
  await key("ESCAPE")
  await command("/grep This step's code did not compile.")
  expect(capture("rejected-program")).toContain("This step's code did not compile.")
  expect(kept()).toEqual([3])
  expect(frame()).not.toContain("compile_failed")
  await command("/grep compile_failed")
  expect(kept()).toEqual([])
  await key("o", { ctrl: true })
  expect(frame()).toContain("compile_failed")
  expect(kept()).toEqual([3])
  await command("/grep plumbingSubject")
  expect(frame()).toContain("plumbingSubject")
  expect(kept()).toEqual([2])
})

test("ordinary messages and answers keep case-insensitive matching, kinds and order", async () => {
  seedCell({ flow: "read", subject: "ordinary.txt" })
  finish()
  await mount()
  await command("/grep ORDINARY")
  const text = capture("ordinary-grep")
  expect(text.indexOf("Ordinary question")).toBeLessThan(text.indexOf("ordinary.txt"))
  expect(text.indexOf("ordinary.txt")).toBeLessThan(text.indexOf("Ordinary answer"))
  await command("/filter")
  await type("Messages")
  await key("ARROW_DOWN")
  await key("RETURN")
  await key("ESCAPE")
  expect(frame()).not.toContain("Ordinary question")
  expect(frame()).toContain("ordinary.txt")
  expect(frame()).toContain("Ordinary answer")
  await command("/grep Ordinary answer")
  expect(kept()).toEqual([])
  expect(frame()).toContain("Ordinary answer")
})

test("callout search uses the rendered journal even when a later delegation is projected out", async () => {
  seedCell({ flow: "read", subject: "earlier.txt", notes: true })
  seedCell({ flow: "agent.delegate", subject: "delegated.txt" })
  finish()
  saved.append({ type: "user", at: 201, text: "Ordinary question" })
  finish()
  await mount()
  expect(frame()).toContain("△ read-only")
  await command("/grep read-only")
  expect(capture("callout-after-delegation")).toContain("△ read-only")
  expect(kept()).toEqual([1])
})

test("a denial never searches its raw message, including under Ctrl+O", async () => {
  seedCell({ flow: "bash", subject: "denied.txt", message: "Denied: denialDiagnostic", denied: true })
  finish()
  await mount()
  await command("/grep Not approved.")
  expect(frame()).toContain("Not approved.")
  expect(kept()).toEqual([1])
  await key("o", { ctrl: true })
  expect(frame()).not.toContain("denialDiagnostic")
  await command("/grep denialDiagnostic")
  expect(kept()).toEqual([])
})

test("viewport clipping does not remove the rest of a displayed subject from search", async () => {
  seedCell({ flow: "read", subject: `prefix.txt ${"x".repeat(240)}clippedSubject` })
  finish()
  await mount(80)
  expect(frame()).toContain("prefix.txt")
  expect(frame()).not.toContain("clippedSubject")
  await command("/grep clippedSubject")
  expect(capture("viewport-subject-grep")).toContain("prefix.txt")
  expect(kept()).toEqual([1])
})

test("inspection searches the selected cell's displayed failure without revealing its diagnostic", async () => {
  seedCell({ rejected: true })
  finish()
  await mount()
  await command("/grep This step's code did not compile.")
  expect(kept()).toEqual([])
  await key("t", { ctrl: true })
  expect(capture("rejected-selected-grep")).toContain("const value1 = 1")
  expect(frame()).toContain("This step's code did not compile.")
  expect(frame()).not.toContain("compile_failed")
  expect(kept()).toEqual([1])
  await key("t", { ctrl: true })
  expect(kept()).toEqual([])
})

test("Ctrl+O searches disclosed call diagnostics and the failure of a read-only step", async () => {
  seedCell({ flow: "bash", subject: "check.mjs", message: "Error: callDiagnostic in dependency" })
  seedCell({ flow: "read", subject: "config.txt", raised: "readStepDiagnostic" })
  finish()
  await mount()
  for (
    const [query, index, visibleDetail] of [
      ["callDiagnostic", 1, "Error: callDiagnostic in dependency"],
      ["readStepDiagnostic", 2, "TypeError: readStepDiagnostic"]
    ] as const
  ) {
    await command(`/grep ${query}`)
    expect(kept()).toEqual([])
    await key("o", { ctrl: true })
    expect(capture(`${query}-disclosed`)).toContain(visibleDetail)
    expect(kept()).toEqual([index])
    await key("o", { ctrl: true })
    expect(kept()).toEqual([])
  }
})
