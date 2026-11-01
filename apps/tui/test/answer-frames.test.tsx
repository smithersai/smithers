import {
  CodeRenderable,
  getTreeSitterClient,
  type Renderable,
  ScrollBoxRenderable,
  TextAttributes
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act, useState } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import { Entry } from "../src/view.tsx"

// Delay only the real syntax worker's reply: App, Markdown, layout and native
// frame drawing are unchanged. No frame assertion waits for answer text.
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let root = ""
let previousSessions: string | undefined
let pending: Array<{ content: string; release: () => void; done: Promise<void> }> = []
let interception: ReturnType<typeof spyOn> | undefined
let requests = 0
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []

const codes = (node: Renderable): CodeRenderable[] => [
  ...(node instanceof CodeRenderable ? [node] : []),
  ...node.getChildren().flatMap(codes)
]
const frame = async (name: string) => {
  await act(async () => {
    await setup!.renderOnce()
  })
  const chars = setup!.captureCharFrame()
  const prefix = process.env.SMITHERS_TUI_FRAME_DIR
  if (prefix) {
    writeFileSync(`${prefix}-${name}.txt`, chars)
    writeFileSync(`${prefix}-${name}.spans.json`, JSON.stringify(setup!.captureSpans(), null, 2) + "\n")
  }
  return chars
}
const releaseBatch = async () => {
  const batch = pending.splice(0)
  await act(async () => {
    batch.forEach((request) => request.release())
    await Promise.all(batch.map((request) => request.done))
    await setImmediate()
  })
}
const release = async () => {
  for (let phase = 0; phase < 20; phase++) {
    await releaseBatch()
    if (pending.length === 0 && codes(setup!.renderer.root).every((code) => !code.isHighlighting)) return
  }
  throw new Error("Syntax work did not settle after releasing every controlled reply")
}
const controlHighlight = () => {
  const client = getTreeSitterClient()
  const highlight = client.highlightOnce.bind(client)
  pending = []
  requests = 0
  interception = spyOn(client, "highlightOnce").mockImplementation((content, filetype) => {
    const gate = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    requests++
    pending.push({ content, release: () => gate.resolve(), done: completed.promise })
    return gate.promise.then(() => highlight(content, filetype)).finally(() => completed.resolve())
  })
}
const mount = async () => {
  root = mkdtempSync(join(tmpdir(), "tui-answer-frames-"))
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousSessions = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  controlHighlight()
  const host: Host.Host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const done = Promise.withResolvers<Host.Outcome>()
      turns.push({ input, done })
      return { done: done.promise, cancel: () => done.resolve({ _tag: "cancelled" }) }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App host={host} seat="replay:offline" models={[]} contextWindow={() => 10000} />,
      { width: 80, height: 24 }
    )
  })
  await act(async () => {
    setup!.renderer.stdin.emit("data", Buffer.from("Offline question\r"))
    await setImmediate()
  })
  expect(turns).toHaveLength(1)
}
const answer = async (text: string) => {
  await act(async () => {
    turns[0]!.input.onEvent(
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant(text)
      })
    )
  })
}
afterEach(async () => {
  await act(async () => {
    turns.forEach((turn) => turn.done.resolve({ _tag: "cancelled" }))
    await setImmediate()
  })
  await act(async () => setup?.renderer.destroy())
  interception?.mockRestore()
  // Destroy invalidates in-flight native snapshots before releasing them.
  pending.splice(0).forEach((request) => request.release())
  setup = undefined
  if (root) {
    if (previousSessions === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousSessions
    rmSync(root, { recursive: true, force: true })
  }
  root = ""
  turns = []
})

test("available Chat answer is visible on its first native 80x24 frame", async () => {
  await mount()
  const unresolved = await frame("unresolved")
  expect(unresolved).not.toContain("Available answer")
  expect(codes(setup!.renderer.root).filter((code) => code.filetype === "markdown")).toHaveLength(0)
  await answer("Available answer with **bold**, a [link](https://example.com), and `code`.")
  const first = await frame("available-first")
  const second = await frame("available-second")
  expect(pending.some((request) => request.content.includes("Available answer"))).toBe(true)
  await release()
  const highlighted = await frame("available-highlighted")
  expect(highlighted).toContain("Available answer")
  expect(highlighted).toContain("bold")
  expect(highlighted).toContain("link (https://example.com)")
  expect(highlighted).not.toContain("**")
  expect(highlighted).not.toContain("`code`")
  const bold = setup!.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "bold")
  expect((bold?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
  expect(first).toContain("Available answer")
  expect(second).toContain("Available answer")
  const settled = requests
  for (let extra = 0; extra < 8; extra++) expect(await frame("available-settled")).toBe(highlighted)
  // The fallback runs on every frame; unchanged content must not re-enter the worker.
  expect({ requests: requests - settled, pending: pending.length }).toEqual({ requests: 0, pending: 0 })
})

test.each([
  ["code", "```js\nconst available = 42\n```", "const available = 42"],
  ["quote", "> Available quotation", "Available quotation"],
  ["list", "- Available item\n- Another item", "Available item"]
])("%s-only answers draw before syntax completes", async (name, content, visible) => {
  await mount()
  await answer(content!)
  expect(await frame(`${name}-first`)).toContain(visible!)
  expect(await frame(`${name}-second`)).toContain(visible!)
  await release()
  expect(await frame(`${name}-highlighted`)).toContain(visible!)
})

let replace: (text: string | undefined) => void
function MutableAnswer() {
  const [text, setText] = useState<string | undefined>("Old answer")
  replace = setText
  return text === undefined ?
    <text>Other view</text> :
    <Entry item={{ kind: "answer", id: "same-answer", text }} now={0} tick="" expanded={false} />
}

test("rapid replacements and resize retain newest text across late native syntax replies", async () => {
  controlHighlight()
  await act(async () => {
    setup = await testRender(<MutableAnswer />, { width: 80, height: 24 })
  })
  expect(await frame("replacement-old")).toContain("Old answer")
  const instance = codes(setup!.renderer.root)[0]
  await act(async () => replace("Intermediate answer"))
  expect(await frame("replacement-intermediate")).toContain("Intermediate answer")
  await act(async () => replace("Newest answer " + "wrapping words ".repeat(9)))
  expect(await frame("replacement-newest")).toContain("Newest answer")
  expect(codes(setup!.renderer.root)[0]).toBe(instance)
  await releaseBatch() // Old reply arrives after both replacements.
  const late = await frame("replacement-late-old")
  expect(late).toContain("Newest answer")
  expect(late).not.toContain("Old answer")
  expect(late).not.toContain("Intermediate answer")
  await act(async () => setup!.renderer.resize(40, 24))
  const narrow = await frame("replacement-narrow")
  expect(narrow).toContain("Newest answer")
  expect(narrow.split("\n").filter((row) => row.includes("wrapping")).length).toBeGreaterThan(2)
  await release()
  expect(await frame("replacement-highlighted")).toContain("Newest answer")
  await act(async () => setup!.renderer.resize(80, 24))
  const wide = await frame("replacement-wide")
  expect(wide).toContain("Newest answer")
  const y = wide.split("\n").findIndex((row) => row.includes("Newest answer"))
  const x = wide.split("\n")[y]!.indexOf("Newest answer")
  await act(async () => {
    await setup!.mockMouse.drag(x, y, x + 13, y)
  })
  expect(setup!.renderer.getSelection()?.getSelectedText()).toContain("Newest answer")
})

test("streaming-to-final answer draws on first frame and navigation discards late syntax", async () => {
  await mount()
  await act(async () => {
    turns[0]!.input.onEvent(
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: { type: "text-delta", id: "reply", text: "Streaming preview" }
      })
    )
  })
  const streaming = await frame("streaming")
  // A writing cell may be folded by Chat; it is not a settled answer region.
  expect(streaming).not.toContain("Final available answer")
  await answer("Final available answer")
  expect(await frame("streaming-final-first")).toContain("Final available answer")
  const old = codes(setup!.renderer.root)
  await act(async () => {
    setup!.mockInput.pressKey("s", { ctrl: true })
    await setImmediate()
    // Summary opens in its composer; Tab gives its rows navigation.
    setup!.mockInput.pressKey("TAB")
    await setImmediate()
  })
  const navigated = await frame("navigation-before-reply")
  expect(navigated).toContain("Navigate")
  expect(old.every((code) => code.isDestroyed)).toBe(true)
  await release()
  expect(await frame("navigation-after-reply")).toBe(navigated)
  await act(async () => {
    setup!.mockInput.pressKey("s", { ctrl: true })
    await setImmediate()
  })
  expect(await frame("navigation-return-first")).toContain("Final available answer")
})

test("disposing an answer with pending syntax cannot write into its replacement", async () => {
  controlHighlight()
  await act(async () => {
    setup = await testRender(<MutableAnswer />, { width: 80, height: 24 })
  })
  expect(await frame("disposal-pending")).toContain("Old answer")
  const old = codes(setup!.renderer.root)[0]!
  await act(async () => replace(undefined))
  expect(old.isDestroyed).toBe(true)
  const other = await frame("disposal-other")
  await releaseBatch()
  expect(await frame("disposal-late-reply")).toBe(other)
  await act(async () => replace("New mount answer"))
  expect(await frame("disposal-new-mount-first")).toContain("New mount answer")
  await release()
  expect(await frame("disposal-new-mount-highlighted")).not.toContain("Old answer")
})

test("late answer highlighting preserves a person's transcript scroll position", async () => {
  await mount()
  await answer(Array.from({ length: 45 }, (_, index) => `Available row ${index}`).join("\n"))
  const rows = (chars: string) => chars.split("\n").filter((row) => row.includes("Available row")).length
  const first = await frame("scroll-first")
  const second = await frame("scroll-second")
  // The first frame draws the whole answer at its measured height, not one line of it.
  expect(first).toContain("Available row 44")
  expect(rows(first)).toBeGreaterThan(15)
  expect(second).toBe(first)
  const find = (node: Renderable): ScrollBoxRenderable | undefined =>
    node instanceof ScrollBoxRenderable ? node : node.getChildren().map(find).find((child) => child !== undefined)
  const scroll = find(setup!.renderer.root)!
  const bottom = scroll.scrollTop
  expect(bottom).toBeGreaterThan(0)
  await act(async () => {
    for (let tick = 0; tick < 5; tick++) await setup!.mockMouse.scroll(8, 10, "up")
  })
  await frame("scroll-up")
  const scrolled = scroll.scrollTop
  expect(scrolled).toBeLessThan(bottom)
  await release()
  const late = await frame("scroll-late-reply")
  expect(late).toContain("Available row")
  expect(rows(late)).toBeGreaterThan(15)
  expect(scroll.scrollTop).toBe(scrolled)
})
