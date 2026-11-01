import { type Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout as timerPhase } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"

// Real native headless App and session IO, with controlled Host execution and
// Host turn boundaries. No provider or model calls execute.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let saved: Session.Writer
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
const frame = () => setup!.captureCharFrame()
const render = async () => {
  await setup!.renderOnce()
}
const visibleRow = async (text: string) => {
  const deadline = Date.now() + 4000
  while (!frame().includes(text)) {
    if (Date.now() > deadline) throw new Error(`Missing rendered text: ${text}`)
    await act(async () => {
      await setImmediate()
      await render()
    })
  }
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.pressKeys(Array.from(text))
  })
  await render()
}
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await render()
}
// Alt+Enter submits the literal command instead of accepting an argument
// completion (important for invalid values and omitted optional arguments).
const command = async (text: string) => {
  await type(text)
  await key("RETURN", { meta: true })
}
const records = () => Session.load(saved.file)
const seed = (user: string, answer: string, source?: string) => {
  saved.append({ type: "user", at: 100, text: user })
  saved.append({
    type: "event",
    at: 101,
    event: new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: ModelRequest.Message.assistant(answer),
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40 }
    })
  })
  if (source !== undefined) {
    saved.append({
      type: "event",
      at: 102,
      event: new AgentEvent.CellProduced({
        eventType: "flows.harness.cell-produced.v1",
        cell: Cell.source(source)
      })
    })
  }
  saved.append({
    type: "event",
    at: 103,
    event: new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant(answer)
    })
  })
  saved.append({ type: "outcome", at: 104, prompt: user, outcome: { _tag: "done", answer } })
}
const mount = async (height = 35, width = 140, ready = "Beta answer", clock?: ManualClock) => {
  const host: Host.Host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const turn = { input, done: Promise.withResolvers<Host.Outcome>() }
      turns.push(turn)
      return { done: turn.done.promise, cancel: () => turn.done.resolve({ _tag: "cancelled" }) }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:one"
        models={[{ seat: "replay:one", label: "One", provider: "Fixture" }]}
        contextWindow={() => 10000}
        resume={saved.file}
      />,
      // Legacy control bytes cannot distinguish Ctrl+P from Ctrl+Shift+P.
      { width, height, exitOnCtrlC: false, kittyKeyboard: true, clock }
    )
    await setImmediate()
  })
  await render()
  if (height > 24) await visibleRow("Alpha answer")
  await visibleRow(ready)
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-app-transcript-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  saved = Session.create(cwd)
  seed("Alpha question", "Alpha answer")
  seed("Beta question", "Beta answer")
})
afterEach(async () => {
  try {
    await act(async () => {
      for (const turn of turns) turn.done.resolve({ _tag: "cancelled" })
      await Promise.all(turns.map((turn) => turn.done.promise))
      await setImmediate()
      setup?.renderer.destroy()
    })
  } finally {
    setup = undefined
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

const expectedHistory = [
  { kind: "exchange", user: "Alpha question", answer: "Alpha answer" },
  { kind: "exchange", user: "Beta question", answer: "Beta answer" }
] satisfies Host.TurnInput["history"]
const closePicker = async () => {
  await key("ESCAPE")
  const deadline = Date.now() + 3000
  while (frame().includes("Filter chat")) {
    if (Date.now() > deadline) throw new Error("Filter did not close")
    await act(async () => {
      await setImmediate()
      await render()
    })
  }
}
const palette = async (query: string) => {
  await key("k", { ctrl: true })
  await type(query)
  await key("RETURN")
}

test.each([
  { query: "ALPHA QUESTION", visible: "Alpha question", absent: ["Alpha answer", "Beta question", "Beta answer"] },
  { query: "beta answer", visible: "Beta answer", absent: ["Alpha question", "Alpha answer", "Beta question"] },
  {
    query: "not-present-anywhere",
    visible: undefined,
    absent: ["Alpha question", "Alpha answer", "Beta question", "Beta answer"]
  }
])(
  "grep $query filters actual transcript rows and empty grep resets without changing storage",
  async ({ query, visible, absent }) => {
    await mount()
    const original = records()
    await command(`/grep ${query}`)
    if (visible !== undefined) {
      await visibleRow(visible)
      expect(frame()).toContain(visible)
    }
    for (const text of absent) expect(frame()).not.toContain(text)
    expect(turns).toEqual([])
    expect(records()).toEqual(original)
    await command("/grep")
    await visibleRow("Alpha answer")
    await visibleRow("Beta answer")
    for (const text of ["Alpha question", "Alpha answer", "Beta question", "Beta answer"]) {
      expect(frame()).toContain(
        text
      )
    }
    await command("Next question")
    expect(turns[0]!.input.history).toEqual(expectedHistory)
  }
)

test("grep matches source code independently of message and answer fields", async () => {
  seed("Code question", "Code answer", "const sourceOnlyNeedle = 7")
  await mount(48)
  const original = records()
  await key("o", { ctrl: true })
  await command("/grep sourceOnlyNeedle")
  expect(frame()).toContain("sourceOnlyNeedle")
  expect(frame()).not.toContain("Alpha question")
  expect(frame()).not.toContain("Beta answer")
  expect(frame()).not.toContain("Code question")
  expect(frame()).not.toContain("Code answer")
  expect(turns).toEqual([])
  expect(records()).toEqual(original)
  await command("Continue after source inspection")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Continue after source inspection")
  expect(turns[0]!.input.history).toEqual([
    ...expectedHistory,
    { kind: "exchange", user: "Code question", answer: "Code answer" }
  ])
})

test("Chat hides program source by default; Ctrl+O and the Cells filter each show it in place", async () => {
  seed("Code question", "Code answer", "const sourceOnlyNeedle = 7")
  await mount(48)
  const original = records()
  // The seeded program ran under a second, so the hint names no time.
  const program = /Code answer\s*\n\s+ctrl\+o program *\n/
  await visibleRow("Code answer")
  expect(frame()).toMatch(program)
  expect(frame()).not.toContain("sourceOnlyNeedle")
  expect(frame()).not.toMatch(/printed \d+ lines?/)
  expect(frame()).not.toContain("filtered")
  // Only answers backed by a program name it.
  expect(frame().match(/ctrl\+o program/g)).toHaveLength(1)
  await key("o", { ctrl: true })
  await visibleRow("sourceOnlyNeedle")
  await key("o", { ctrl: true })
  expect(frame()).not.toContain("sourceOnlyNeedle")
  await command("/filter")
  await type("Cells")
  await key("ARROW_DOWN")
  await key("RETURN")
  await closePicker()
  await visibleRow("sourceOnlyNeedle")
  expect(frame()).not.toContain("filtered")
  expect(frame()).toMatch(program)
  await command("/filter")
  await type("Cells")
  await key("ARROW_DOWN")
  await key("RETURN")
  await closePicker()
  expect(frame()).not.toContain("sourceOnlyNeedle")
  expect(records()).toEqual(original)
  expect(turns).toEqual([])
})

test.each([
  { kind: "Messages", hidden: "Alpha question", kept: "Alpha answer" },
  { kind: "Answers", hidden: "Alpha answer", kept: "Alpha question" }
])(
  "$kind toggle composes with text filtering and Show all resets both while keeping the dialog open",
  async ({ kind, hidden, kept }) => {
    await mount()
    const original = records()
    await command("/grep alpha")
    await command("/filter")
    await type(kind)
    await key("ARROW_DOWN")
    await key("RETURN")
    expect(frame()).toContain("Filter chat")
    await closePicker()
    await visibleRow(kept)
    expect(frame()).not.toContain(hidden)
    expect(frame()).toContain(kept)
    expect(frame()).not.toContain("Beta answer")
    await command("/filter")
    await key("RETURN")
    expect(frame()).toContain("Filter chat")
    await closePicker()
    await visibleRow("Beta answer")
    for (const text of ["Alpha question", "Alpha answer", "Beta question", "Beta answer"]) {
      expect(frame()).toContain(
        text
      )
    }
    expect(records()).toEqual(original)
    expect(turns).toEqual([])
  }
)

test("conversation rename queries the saved name and survives actual App reload without entering history", async () => {
  await mount()
  await command("/name")
  expect(frame()).toContain("This conversation has no name")
  expect(records().filter((r) => r.type === "name")).toEqual([])
  await command("/name Review café 😀")
  expect(records().filter((r) => r.type === "name")).toEqual([{ type: "name", name: "Review café 😀" }])
  await command("/name")
  expect(frame()).toContain("Conversation: Review café 😀")
  await act(async () => {
    setup!.renderer.destroy()
    setup = undefined
    await setImmediate()
  })
  await mount()
  await command("/name")
  expect(frame()).toContain("Conversation: Review café 😀")
  await command("Next question")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

test("conversation reports owning session and token receipts without writing a prompt or metadata into history", async () => {
  await mount()
  const original = records()
  await command("/conversation")
  expect(frame().replace(/\s/g, "")).toContain(saved.file)
  expect(frame()).toContain("2 exchanges · ↑240 ↓60 R80")
  expect(records()).toEqual(original)
  expect(turns).toEqual([])
  await command("Continue")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

test("palette Summary returns to Chat with the native draft still owned by the composer", async () => {
  await mount()
  await type("Draft preserved")
  await palette("summary")
  expect(frame()).toContain("Asked: Alpha question")
  expect(frame()).toContain("Draft preserved")
  await palette("chat")
  expect(frame()).not.toContain("Asked: Alpha question")
  expect(frame()).toContain("Alpha question")
  await type(" and continued")
  await key("RETURN")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Draft preserved and continued")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

test("an unknown command stays local, keeps its line, and never pollutes the next Host conversation", async () => {
  await mount(140)
  const original = records()
  await command("/not-a-command value")
  expect(frame()).toContain("Unknown command /not-a-command")
  expect(frame()).toContain("/not-a-command value")
  expect(turns).toEqual([])
  expect(records()).toEqual(original)
  await key("c", { ctrl: true })
  await command("A real question")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("A real question")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

const descendant = <T extends Renderable>(node: Renderable, kind: new(...args: never[]) => T): T | undefined => {
  if (node instanceof kind) return node
  for (const child of node.getChildren()) {
    const found = descendant(child, kind)
    if (found !== undefined) return found
  }
  return undefined
}
const composer = () => descendant(setup!.renderer.root, TextareaRenderable)!
const scroll = () => descendant(setup!.renderer.root, ScrollBoxRenderable)!
const delegate = async (id: string, title: string) => {
  await act(async () => {
    turns[0]!.input.runtime!.delegate!({ id, title, prompt: `Work on ${title}` })
    await setImmediate()
  })
  await render()
}
const stream = async (index: number) => {
  const input = turns[index]!.input
  await act(async () => {
    input.onEvent(
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: input.seat,
        modelParams: {},
        activeToolNames: [],
        contextDigest: `fixture-${index}`
      })
    )
    input.onEvent(
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: { type: "text-delta", id: `fixture-${index}`, text: "Earlier agent transcript\n".repeat(50) }
      })
    )
    await setImmediate()
  })
  await render()
}
// A later timer drains the real 60 ms reveal and restore callbacks, then
// rendering settles the native layout before checking the visible frame.
const drainDeferredScroll = async () => {
  await act(async () => {
    await timerPhase(100)
    await setImmediate()
  })
  await render()
}
const inserts = (index: number) =>
  Effect.runSync(turns[index]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts
    .map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))

test.each([24, 32])(
  "Escape dismisses completion before leaving an agent and Enter keeps its target at 80×%i",
  async (height) => {
    mkdirSync(join(cwd, "src"))
    writeFileSync(join(cwd, "src/app.ts"), "export const fixture = true\n")
    await mount(height, 80)
    await command("Coordinate both agents")
    await delegate("agent-a", "Agent A")
    await delegate("agent-b", "Agent B")
    await key("ARROW_RIGHT", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Agent A")
    await type("explain @src/app")
    await visibleRow("src/app.ts")
    expect(frame()).toContain("tab Complete")
    expect(frame()).toContain("enter Choose")
    expect(frame()).not.toContain("esc Chat")
    await key("ESCAPE")
    await drainDeferredScroll()
    expect(frame()).not.toContain("src/app.ts")
    expect(frame()).not.toContain("tab Complete")
    expect(frame()).toContain("Back (ctrl+y)")
    expect(frame()).toContain("steer ↳ Agent A")
    expect(composer().plainText).toBe("explain @src/app")
    expect(composer().focused).toBe(true)
    await key("RETURN")
    expect(inserts(1)).toEqual(["explain @src/app"])
    expect(inserts(2)).toEqual([])
    expect(inserts(0)).toEqual([])
    expect(turns).toHaveLength(3)
    expect(composer().plainText).toBe("")
    expect(frame()).toContain("Continue Agent A")
  }
)

test("starting inspection in a different agent returns to that agent and submits to its composer", async () => {
  await mount()
  await command("Coordinate both agents")
  await delegate("agent-a", "Agent A")
  await delegate("agent-b", "Agent B")
  await stream(1)
  await stream(2)
  await key("ARROW_RIGHT", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  expect(frame()).toContain("Continue Agent A")
  await key("t", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  expect(frame()).toContain("Continue Agent B")
  await key("\u001b[5~")
  const prior = scroll().scrollTop
  await key("t", { ctrl: true })
  await key("ARROW_LEFT")
  await drainDeferredScroll()
  await key("ESCAPE")
  await drainDeferredScroll()
  expect(frame()).toContain("Continue Agent B")
  expect(scroll().scrollTop).toBe(prior)
  expect(composer().focused).toBe(true)
  await type("Reply from B")
  await key("RETURN")
  expect(inserts(1)).toEqual([])
  expect(inserts(2)).toEqual(["Reply from B"])
  expect(inserts(0)).toEqual([])
})

test.each(["timeline", "escape"])(
  "%s after navigating from inspection to an agent awaiting activity keeps its composer target at 80×24",
  async (dismissal) => {
    await mount(24, 80)
    await command("Coordinate both agents")
    await delegate("agent-a", "Agent A")
    await delegate("agent-b", "Agent B")
    await stream(1)
    await key("ARROW_RIGHT", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Agent A")
    await key("t", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Agent B")
    if (dismissal === "timeline") await key("t", { ctrl: true })
    else await key("ESCAPE")
    await drainDeferredScroll()
    expect(frame()).toContain("Continue Agent B")
    expect(composer().focused).toBe(true)
    await type("Reply from empty B")
    await key("RETURN")
    expect(inserts(1)).toEqual([])
    expect(inserts(2)).toEqual(["Reply from empty B"])
    expect(inserts(0)).toEqual([])
    await key("ESCAPE")
    expect(frame()).not.toContain("Continue Agent B")
    expect(frame()).toContain("Steer, or alt+enter to queue")
  }
)

test.each([24, 32])(
  "a scrolled send at 80×%i reveals its text after worker toasts and deferred layout",
  async (height) => {
    await mount(height, 80)
    await command("Coordinate an agent")
    await delegate("review", "Review one file")
    await delegate("other", "Other review")
    await delegate("third", "Third review")
    await stream(1)
    // A live step shows its prose only expanded.
    await key("o", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Review one file")
    await act(async () => {
      await timerPhase(400)
    })
    for (let index = 0; index < 5; index++) await render()
    await key("\u001b[5~")
    expect(scroll().scrollHeight).toBeGreaterThan(50)
    expect(scroll().viewport.height).toBeGreaterThan(1)
    expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
    await type("Reply with exactly: hello")
    await key("RETURN")
    await drainDeferredScroll()
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        await timerPhase(100)
      })
      await render()
      expect(frame()).toContain("Reply with exactly: hello")
    }
    expect(composer().plainText).toBe("")
    expect(frame()).toContain("Reply with exactly: hello")
    expect(inserts(1)).toEqual(["Reply with exactly: hello"])
    expect(inserts(0)).toEqual([])
  }
)

const cellsToggle = async () => {
  await command("/filter")
  await type("Cells")
  await key("ARROW_DOWN")
  await key("RETURN")
  await closePicker()
  await drainDeferredScroll()
}
const seedLongConversation = (wrapped = false) => {
  for (let index = 0; index < 20; index++) {
    seed(
      `Question ${index}`,
      `Answer ${index}\n${
        Array.from({ length: 5 }, (_, line) => `Detail ${index}:${line}${wrapped ? " wrapping text".repeat(10) : ""}`)
          .join("\n")
      }`,
      Array.from({ length: 15 }, (_, line) => `const cell${index}line${line} = ${line}`).join("\n")
    )
  }
}
const firstMessage = () => {
  const lines = frame().split("\n")
  const row = lines.findIndex((line) => /Question \d+|Answer \d+|Detail \d+:\d+/.test(line))
  return { text: lines[row]!.trim(), row }
}

test("Cells keeps the visible message while browsing a long Chat across repeated toggles", async () => {
  seedLongConversation()
  await mount(24, 80, "Detail 19:4")
  await drainDeferredScroll()
  for (let index = 0; index < 5; index++) await key("\u001b[5~")
  const anchor = firstMessage()
  expect(anchor.text).not.toContain("19")
  expect(scroll().scrollTop).toBeGreaterThan(0)
  for (let index = 0; index < 4; index++) {
    await cellsToggle()
    const lines = frame().split("\n")
    const row = lines.findIndex((line) => line.trim() === anchor.text)
    expect(row).toBeGreaterThan(0)
    expect(Math.abs(row - anchor.row)).toBeLessThanOrEqual(1)
    expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
    expect(composer().focused).toBe(true)
  }
  await type("Draft still works")
  expect(composer().plainText).toBe("Draft still works")
  expect(turns).toEqual([])
})

test("Cells keeps a reader at the live bottom of a long Chat", async () => {
  seedLongConversation()
  await mount(24, 80, "Detail 19:4")
  await drainDeferredScroll()
  expect(frame()).toContain("Detail 19:4")
  for (let index = 0; index < 4; index++) {
    await cellsToggle()
    expect(frame()).toContain("Detail 19:4")
    expect(scroll().scrollTop).toBe(scroll().scrollHeight - scroll().viewport.height)
  }
})

test("Cells preserves short Chat, and Ctrl+O preserves a scrolled message after resizing", async () => {
  seed("Code question", "Code answer", "const sourceOnlyNeedle = 7")
  await mount(48)
  for (let index = 0; index < 4; index++) {
    await cellsToggle()
    expect(frame()).toContain("Alpha question")
    expect(frame()).toContain("Code answer")
    expect(scroll().scrollTop).toBe(0)
  }
  await act(async () => setup!.renderer.destroy())
  setup = undefined
  seedLongConversation(true)
  await mount(24, 80, "Detail 19:4")
  for (let index = 0; index < 5; index++) await key("\u001b[5~")
  for (const [width, height] of [[60, 32], [80, 24]]) {
    await act(async () => {
      setup!.resize(width!, height!)
      await setImmediate()
    })
    await drainDeferredScroll()
    const anchor = firstMessage()
    await key("o", { ctrl: true })
    await drainDeferredScroll()
    expect(frame()).toContain(anchor.text)
    await key("o", { ctrl: true })
    await drainDeferredScroll()
    expect(frame()).toContain(anchor.text)
    expect(composer().focused).toBe(true)
  }
})

test("hiding the program under the viewport chooses a nearby surviving message", async () => {
  seedLongConversation()
  await mount(24, 80, "Detail 19:4")
  await cellsToggle()
  // Put a program's interior on the top edge, using the native transcript's
  // actual row geometry rather than a synthetic offset calculation.
  // Find the middle turn's cell by the public transcript order (two initial
  // exchanges followed by the question, cell and answer for each fixture turn).
  const cell = scroll().getChildren()[4 + 10 * 3 + 1]!
  expect(cell.height).toBeGreaterThan(4)
  await act(async () => {
    scroll().scrollTop += cell.y - scroll().viewport.y + 4
  })
  await render()
  expect(frame()).toContain("cell10line")
  await cellsToggle()
  expect(frame()).not.toContain("cell10line")
  expect(frame()).toContain("Answer 10")
  expect(scroll().scrollTop).toBeGreaterThan(0)
  expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
  await key("\u001b[5~")
  const prior = scroll().scrollTop
  await drainDeferredScroll()
  expect(scroll().scrollTop).toBe(prior)
})

// Hold the native renderer's clock: input commits can happen between exactly
// counted frames, including the second frame that settles anchor restoration.
const inputWithoutFrame = async (bytes: string) => {
  const id = setup!.renderer.frameId
  await act(async () => {
    setup!.renderer.stdin.emit("data", Buffer.from(bytes))
    await setImmediate()
  })
  expect(setup!.renderer.frameId).toBe(id)
}
const screenReceipt = (name: string) => {
  const prefix = process.env.SMITHERS_INTERACTION_RECEIPT
  if (prefix !== undefined) writeFileSync(`${prefix}-${name}.txt`, frame())
}
/** The turn a visible message line belongs to, as the fixture numbers them. */
const turnOf = (line: string) => Number(/(?:Question|Answer|Detail) (\d+)/.exec(line)![1])

test.each(
  [0, 1].flatMap((frames) =>
    ["pageup", "pagedown", "shiftup", "shiftdown", "wheel", "wheeldown", "drag"].map((input) => ({ frames, input }))
  )
)(
  "newer $input wins after Cells and $frames native frames",
  async ({ frames, input }) => {
    seedLongConversation()
    const clock = new ManualClock()
    await mount(24, 80, "Detail 19:4", clock)
    await drainDeferredScroll()
    for (let index = 0; index < 5; index++) await key("\u001b[5~")
    const start = firstMessage()
    setup!.renderer.pause()
    if (input === "drag") {
      await act(async () => {
        await setup!.mockMouse.pressDown(8, start.row)
        await setup!.mockMouse.emitMouseEvent("drag", 20, start.row)
      })
      await render()
    }
    const bytes = input === "pageup" ? "\x1b[5~" : input === "pagedown" ?
      "\x1b[6~" :
      input === "shiftup"
      ? "\x1b[1;2A"
      : "\x1b[1;2B"
    const before = scroll().scrollTop
    const id = setup!.renderer.frameId
    if (frames === 0 && ["pageup", "pagedown", "shiftup", "shiftdown"].includes(input)) {
      // One terminal read, not two separately settled key helpers.
      await inputWithoutFrame(`\x0f${bytes}`)
    } else {
      await inputWithoutFrame("\x0f")
      for (let index = 0; index < frames; index++) await render()
      if (input === "wheel" || input === "wheeldown") {
        await act(async () => {
          await setup!.mockMouse.scroll(5, 10, input === "wheel" ? "up" : "down")
        })
      } else if (input === "drag") {
        await act(async () => {
          await setup!.mockMouse.emitMouseEvent("drag", 20, 0)
          expect(setup!.renderer.getSelection()?.isDragging).toBe(true)
        })
      } else await inputWithoutFrame(bytes)
    }
    expect(setup!.renderer.frameId).toBe(id + frames)
    const intended = scroll().scrollTop
    if (input !== "drag") expect(intended).not.toBe(before)
    // Give the first frame after the drag real elapsed time, so its native
    // autoscroll competes with restoration rather than waiting until settled.
    if (input === "drag") clock.setTime(clock.now() + 400)
    for (let index = 0; index < 4; index++) await render()
    screenReceipt(`${input}-${frames}`)
    if (input === "drag") {
      await act(async () => setup!.mockMouse.release(20, 0))
      await render()
      screenReceipt(`${input}-${frames}-released`)
      expect(scroll().scrollTop).toBeLessThan(intended)
      expect(setup!.renderer.getSelection()?.getSelectedText()).not.toBe("")
    } else {
      // The newer scroll decides the view: restoring alone would put the row
      // the reader left back on its own screen row, and it does not.
      const lines = frame().split("\n")
      expect(lines.findIndex((line) => line.trim() === start.text)).not.toBe(start.row)
      // It still lands on the content they scrolled from: about one page away,
      // never the dozen turns that dropping the position costs.
      const landed = firstMessage()
      expect(landed.row).toBeGreaterThanOrEqual(0)
      expect(Math.abs(turnOf(start.text) - turnOf(landed.text))).toBeLessThanOrEqual(2)
    }
    expect(frame()).toMatch(/Question \d+|Answer \d+|Detail \d+:\d+|const cell\d+line/)
    expect(scroll().scrollTop).toBeGreaterThan(0)
    expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
    if (input === "drag") {
      await act(async () => setup!.mockMouse.click(composer().x + 3, composer().y))
    }
    await type("Still typing")
    expect(composer().plainText).toBe("Still typing")
  }
)

const deltaWithoutFrame = async (text: string) => {
  const id = setup!.renderer.frameId
  await act(async () => {
    turns[0]!.input.onEvent(
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: { type: "text-delta", id: "interaction-stream", text }
      })
    )
    await setImmediate()
  })
  expect(setup!.renderer.frameId).toBe(id)
}

test.each(["browsing", "live"])("streaming Cells toggle keeps the %s reader and input usable", async (position) => {
  seedLongConversation()
  await mount(24, 80, "Detail 19:4", new ManualClock())
  setup!.renderer.pause()
  await command("Stream a turn")
  await stream(0)
  await drainDeferredScroll()
  if (position === "browsing") { for (let index = 0; index < 5; index++) await key("\x1b[5~") }
  const anchor = firstMessage()
  expect(turns).toHaveLength(1)
  if (position === "browsing") expect(anchor.text).not.toContain("19")
  await type("Draft during stream")
  for (let index = 0; index < 4; index++) {
    await inputWithoutFrame("\x0f")
    // Host remains unresolved. New text grows the live cell both before the
    // first restoration frame and between its first and settling frames.
    await deltaWithoutFrame(`Stream chunk ${index}\n`.repeat(8))
    await render()
    await deltaWithoutFrame(`Stream tail ${index}\n`)
    for (let frame = 0; frame < 4; frame++) await render()
    screenReceipt(`stream-${position}-${index}`)
    if (position === "browsing") {
      const row = frame().split("\n").findIndex((line) => line.trim() === anchor.text)
      expect(row).toBeGreaterThan(0)
      expect(Math.abs(row - anchor.row)).toBeLessThanOrEqual(1)
      expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
    } else {
      expect(scroll().scrollTop).toBe(scroll().scrollHeight - scroll().viewport.height)
      if (index % 2 === 0) expect(frame()).toContain(`Stream tail ${index}`)
      else {
        expect(frame()).toContain("Stream a turn")
        expect(frame()).toContain("working")
      }
    }
    expect(composer().focused).toBe(true)
    expect(composer().plainText).toBe("Draft during stream")
  }
  await act(async () => {
    turns[0]!.input.onEvent(
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant("Streaming finished")
      })
    )
    turns[0]!.done.resolve({ _tag: "done", answer: "Streaming finished" })
    await setImmediate()
  })
  for (let index = 0; index < 4; index++) await render()
  await type(" and sent")
  await key("RETURN")
  expect(turns).toHaveLength(2)
  expect(turns[1]!.input.prompt).toBe("Draft during stream and sent")
})

test.each([0, 1].flatMap((frames) => ["conversation", "surface"].map((change) => ({ frames, change }))))(
  "pending Cells anchor is discarded on $change change after $frames native frames",
  async ({ frames, change }) => {
    seedLongConversation()
    await mount(24, 80, "Detail 19:4", new ManualClock())
    setup!.renderer.pause()
    await drainDeferredScroll()
    for (let index = 0; index < 5; index++) await key("\x1b[5~")
    const anchor = firstMessage().text
    await inputWithoutFrame("\x0f")
    for (let index = 0; index < frames; index++) await render()
    if (change === "surface") await inputWithoutFrame("\x13")
    else {
      await inputWithoutFrame("/new")
      await act(async () => {
        setup!.mockInput.pressKey("RETURN", { meta: true })
        await setImmediate()
      })
    }
    for (let index = 0; index < 4; index++) await render()
    screenReceipt(`${change}-${frames}`)
    if (change === "surface") {
      expect(frame()).toContain("Asked:")
      await inputWithoutFrame("\x13")
      for (let index = 0; index < 4; index++) await render()
      const position = scroll().scrollTop
      await inputWithoutFrame("\x1b[5~")
      expect(scroll().scrollTop).toBeLessThan(position)
      const intended = scroll().scrollTop
      for (let index = 0; index < 4; index++) await render()
      expect(scroll().scrollTop).toBe(intended)
    } else {
      expect(frame()).not.toContain(anchor)
      expect(frame()).not.toContain("Question 19")
      expect(scroll().scrollTop).toBe(0)
      await command("New conversation prompt")
      expect(turns[0]!.input.history).toEqual([])
    }
    expect(composer().focused).toBe(true)
  }
)

test("rapid Cells toggles and resize retain an unchanged browsing position", async () => {
  seedLongConversation(true)
  await mount(24, 80, "Detail 19:4", new ManualClock())
  setup!.renderer.pause()
  await drainDeferredScroll()
  for (let index = 0; index < 5; index++) await key("\x1b[5~")
  const anchor = firstMessage().text
  // Several commits before layout, then another change between settling frames.
  await inputWithoutFrame("\x0f\x0f\x0f")
  await act(async () => setup!.resize(60, 32))
  await render()
  await inputWithoutFrame("\x0f\x0f")
  for (let index = 0; index < 5; index++) await render()
  expect(frame()).toContain(anchor)
  expect(scroll().scrollTop).toBeGreaterThan(0)
  expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
  screenReceipt("rapid-resize")
  await type("Draft after resize")
  expect(composer().plainText).toBe("Draft after resize")
})

test("navigation between two Cells toggles in one burst cannot revive the older anchor", async () => {
  seedLongConversation()
  await mount(24, 80, "Detail 19:4", new ManualClock())
  setup!.renderer.pause()
  await drainDeferredScroll()
  for (let index = 0; index < 5; index++) await key("\x1b[5~")
  const start = firstMessage()
  const before = scroll().scrollTop
  await inputWithoutFrame("\x0f\x1b[5~\x0f\x1b[5~Burst draft")
  const intended = scroll().scrollTop
  expect(intended).toBeLessThan(before)
  for (let index = 0; index < 4; index++) await render()
  // Two page keys up from the reader's own position, not the first anchor.
  const landed = firstMessage()
  expect(frame().split("\n").findIndex((line) => line.trim() === start.text)).not.toBe(start.row)
  expect(Math.abs(turnOf(start.text) - turnOf(landed.text))).toBeLessThanOrEqual(4)
  expect(scroll().scrollTop).toBeGreaterThan(0)
  expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
  expect(frame()).not.toContain("const cell")
  expect(frame()).toContain("Burst draft")
  expect(composer().plainText).toBe("Burst draft")
  screenReceipt("two-toggle-navigation-burst")
})
