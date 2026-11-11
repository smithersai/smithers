import { type Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import * as Files from "../src/files.ts"
import type * as Host from "../src/host.vibe"

// Actual App, native parser/editor and session IO; offline controlled Host.
// Completion uses its existing seam, never a Git command.
let root = ""
let previousRoot: string | undefined
let previousRepo: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
let cancellations: Host.TurnInput[] = []
let fileLister: ReturnType<typeof spyOn<typeof Files, "lister">>
const descendant = <T extends Renderable>(node: Renderable, kind: new(...args: never[]) => T): T | undefined => {
  if (node instanceof kind) return node
  for (const child of node.getChildren()) {
    const found = descendant(child, kind)
    if (found !== undefined) return found
  }
  return undefined
}
const composer = () => descendant(setup!.renderer.root, TextareaRenderable)!
const frame = () => setup!.captureCharFrame()
const write = async (bytes: string) => {
  await act(async () => {
    setup!.renderer.stdin.emit("data", Buffer.from(bytes))
    await setImmediate()
  })
  await setup!.renderOnce()
}
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await setup!.renderOnce()
}
let boundary = 0
const inserts = (index: number) =>
  Effect.runSync(turns[index]!.input.steering!.drain({ boundary: `focus-${boundary++}`, wouldIdle: false })).inserts
    .map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))
const liveWorker = async () => {
  await write("Coordinate work\r")
  expect(turns).toHaveLength(1)
  await act(async () => {
    turns[0]!.input.runtime!.delegate!({ id: "review", title: "Review one file", prompt: "Review a file" })
    await setImmediate()
  })
  await setup!.renderOnce()
  expect(turns).toHaveLength(2)
  await key("ARROW_RIGHT", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  expect(frame()).toContain("Continue Review one file")
}
const assertNoStop = () => {
  expect(frame()).not.toContain("Stop Review one file?")
  expect(cancellations).toEqual([])
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-summary-focus-"))
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  // `SMITHERS_REPO` names the repository the Smithers tab reads, so the mount
  // never shells out to read a remote.
  previousRepo = process.env.SMITHERS_REPO
  process.env.SMITHERS_REPO = "smithersai/smithers"
  fileLister = spyOn(Files, "lister").mockImplementation(() => () => ["src/app.ts"])
  turns = []
  cancellations = []
  const host: Host.Host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const done = Promise.withResolvers<Host.Outcome>()
      turns.push({ input, done })
      return {
        done: done.promise,
        cancel: () => {
          cancellations.push(input)
          done.resolve({ _tag: "cancelled" })
        }
      }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:chat"
        workerSeat="replay:worker"
        models={[{ seat: "replay:chat", label: "Chat", provider: "Fixture" }]}
        contextWindow={() => 10000}
      />,
      { width: 100, height: 32, exitOnCtrlC: false, kittyKeyboard: true }
    )
    await setImmediate()
  })
  await setup!.renderOnce()
  expect(fileLister).toHaveBeenCalled()
})
afterEach(async () => {
  try {
    await act(async () => {
      setup?.renderer.destroy()
      for (const turn of turns) turn.done.resolve({ _tag: "cancelled" })
      await Promise.all(turns.map((turn) => turn.done.promise))
      await setImmediate()
    })
  } finally {
    setup = undefined
    fileLister.mockRestore()
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    if (previousRepo === undefined) delete process.env.SMITHERS_REPO
    else process.env.SMITHERS_REPO = previousRepo
    rmSync(root, { recursive: true, force: true })
  }
})

test("Summary opening on a live worker types x instead of requesting Stop", async () => {
  await liveWorker()
  await key("s", { ctrl: true })
  await write("x")
  assertNoStop()
  expect(composer().plainText).toBe("x")
  expect(turns).toHaveLength(2)
})

test.each(["shortcut", "tab", "command", "palette"])(
  "Summary via %s preserves an existing draft and every letter in a burst",
  async (opening) => {
    await write("Draft ")
    if (opening === "shortcut") await key("s", { ctrl: true })
    if (opening === "tab") await key("ARROW_RIGHT", { ctrl: true })
    if (opening === "command") {
      await key("c", { ctrl: true })
      await write("/summary")
      await key("RETURN", { meta: true })
      await write("Draft ")
    }
    if (opening === "palette") {
      await key("k", { ctrl: true })
      await write("summary\r")
    }
    await write("xhjkl agdvun café 😀")
    expect(composer().plainText).toBe("Draft xhjkl agdvun café 😀")
    assertNoStop()
    expect(turns).toEqual([])
    await key("RETURN")
    expect(turns).toHaveLength(1)
    expect(turns[0]!.input.prompt).toBe("Draft xhjkl agdvun café 😀")
    expect(composer().plainText).toBe("")
  }
)

test("Ctrl+S plus text, newline and Enter in one native read sends exactly one Chat message", async () => {
  await write("\x13x hello\x0asecond line\r")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("x hello\nsecond line")
  expect(composer().plainText).toBe("")
  assertNoStop()
})

test.each([false, true])(
  "focus and bracketed paste in one native read preserve the draft with live work=%s",
  async (live) => {
    if (live) await liveWorker()
    await write("Draft ")
    const message = "Draft x pasted café 😀\nsecond line continued"
    await write("\x13\t\x1b[200~x pasted café 😀\nsecond line\x1b[201~ continued\r")
    assertNoStop()
    expect(composer().plainText).toBe("")
    if (live) {
      expect(turns).toHaveLength(2)
      expect(inserts(0)).toEqual([message])
      expect(inserts(1)).toEqual([])
    } else {
      expect(turns).toHaveLength(1)
      expect(turns[0]!.input.prompt).toBe(message)
    }
  }
)

test.each(["tree", "cards"])(
  "explicit Summary %s keeps Stop confirmation and paste returns to Chat composer",
  async (pane) => {
    await liveWorker()
    await key("s", { ctrl: true })
    await key("TAB") // Deliberately focus Summary's rows.
    if (pane === "cards") await key("TAB")
    await key("x")
    expect(frame()).toContain("Stop Review one file?")
    expect(cancellations).toEqual([])
    await key("ESCAPE")
    await write("\x1b[200~x pasted café 😀\nsecond line\x1b[201~ continued")
    expect(composer().plainText).toBe("x pasted café 😀\nsecond line continued")
    assertNoStop()
    expect(turns).toHaveLength(2)
    await key("RETURN")
    expect(inserts(0)).toEqual(["x pasted café 😀\nsecond line continued"])
    expect(inserts(1)).toEqual([])
    expect(composer().plainText).toBe("")
  }
)

test("explicit Summary Stop requires confirmation and cancels only the selected worker", async () => {
  await liveWorker()
  await key("s", { ctrl: true })
  await key("TAB")
  await key("x")
  expect(frame()).toContain("Stop Review one file?")
  expect(cancellations).toEqual([])
  await key("RETURN")
  expect(cancellations).toEqual([turns[1]!.input])
  expect(turns).toHaveLength(2)
  expect(composer().plainText).toBe("")
})

test("Summary row Enter opens the worker; worker row typing and Summary return retain the draft", async () => {
  await liveWorker()
  await key("s", { ctrl: true })
  await key("TAB")
  await key("RETURN")
  expect(frame()).toContain("Continue Review one file")
  await write("\tx worker") // Agent-tab Tab selects rows; typing returns to its editor (#3037).
  expect(composer().plainText).toBe("x worker")
  assertNoStop()
  await key("s", { ctrl: true })
  await write(" draft")
  expect(composer().plainText).toBe("x worker draft")
  await key("s", { ctrl: true })
  expect(frame()).toContain("Back (ctrl+y)")
  await key("RETURN")
  expect(inserts(1)).toEqual(["x worker draft"])
  expect(inserts(0)).toEqual([])
  await key("s", { ctrl: true })
  await key("ESCAPE")
  expect(frame()).not.toContain("Continue Review one file")
  await write("x chat\r")
  expect(inserts(0)).toEqual(["x chat"])
  expect(cancellations).toEqual([])
})

test("Summary arrows acquire rows and hjkl, pane switching, i and a following burst retain their meanings", async () => {
  await liveWorker()
  await key("s", { ctrl: true })
  await key("ARROW_UP") // First arrow both acquires focus and selects Chat.
  await key("x")
  assertNoStop()
  expect(composer().plainText).toBe("")
  await key("j") // Back to the worker, using the documented letter navigation.
  await key("g")
  await key("g")
  await key("TAB") // Cards.
  await key("x")
  expect(frame()).toContain("Stop Review one file?")
  await key("ESCAPE")
  await write("ix after rows\x0asecond line\r")
  expect(inserts(0)).toEqual(["x after rows\nsecond line"])
  expect(inserts(1)).toEqual([])
  expect(composer().plainText).toBe("")
  assertNoStop()
})

test("Summary Alt+X is deliberate even with a draft, and cancellation preserves that draft", async () => {
  await liveWorker()
  await write("Draft ")
  await key("s", { ctrl: true })
  await key("x", { meta: true })
  expect(frame()).toContain("Stop Review one file?")
  expect(cancellations).toEqual([])
  await key("ESCAPE")
  // The chord acted on the row without taking its keys: typing stays ordinary.
  await write("x typed")
  expect(composer().plainText).toBe("Draft x typed")
  assertNoStop()
  await write("\x1b[200~x pasted\x1b[201~ suffix")
  expect(composer().plainText).toBe("Draft x typedx pasted suffix")
  assertNoStop()
  await key("RETURN")
  expect(inserts(0)).toEqual(["Draft x typedx pasted suffix"])
  expect(inserts(1)).toEqual([])
})

test("Summary Alt+X confirmed stops the selected worker and leaves the composer focused", async () => {
  await liveWorker()
  await key("s", { ctrl: true })
  await key("x", { meta: true })
  expect(frame()).toContain("Stop Review one file?")
  await key("RETURN")
  expect(cancellations).toEqual([turns[1]!.input])
  expect(turns).toHaveLength(2)
  await write("x after stopping")
  expect(composer().plainText).toBe("x after stopping")
  expect(frame()).not.toContain("Stop Review one file?")
})

test("Summary Alt+V on settled work keeps the draft and ordinary typing in the composer", async () => {
  await liveWorker()
  await act(async () => {
    for (const turn of turns) turn.done.resolve({ _tag: "done", answer: "Finished" })
    await Promise.all(turns.map((turn) => turn.done.promise))
    await setImmediate()
  })
  await setup!.renderOnce()
  await key("s", { ctrl: true })
  await write("Draft ")
  await key("v", { meta: true }) // No changed file to diff: the chord acts on nothing.
  await key("ESCAPE")
  await write("x typed")
  expect(composer().plainText).toBe("Draft x typed")
  assertNoStop()
  await key("RETURN")
  expect(turns[2]!.input.prompt).toBe("Draft x typed")
})

test("Summary arrow editing in a nonempty composer keeps letters in the draft", async () => {
  await liveWorker()
  await write("Draft")
  await key("s", { ctrl: true })
  await key("ARROW_LEFT")
  await write("x")
  expect(composer().plainText).toBe("Drafxt")
  assertNoStop()
  await key("RETURN")
  expect(inserts(0)).toEqual(["Drafxt"])
  expect(inserts(1)).toEqual([])
})

test("Summary after all work settles keeps x and ordinary text in the composer", async () => {
  await liveWorker()
  await act(async () => {
    for (const turn of turns) turn.done.resolve({ _tag: "done", answer: "Finished" })
    await Promise.all(turns.map((turn) => turn.done.promise))
    await setImmediate()
  })
  await setup!.renderOnce()
  await key("s", { ctrl: true })
  await write("x settled work")
  expect(composer().plainText).toBe("x settled work")
  assertNoStop()
  expect(turns).toHaveLength(2)
  await key("RETURN")
  expect(turns).toHaveLength(3)
  expect(turns[2]!.input.prompt).toBe("x settled work")
})

test("an explicitly focused Summary ask opens its form and Enter answers the selected choice", async () => {
  await liveWorker()
  let answered: Promise<{ readonly answer: string }> | undefined
  await act(async () => {
    answered = turns[1]!.input.runtime!.ask!({ question: "Which name?", options: ["sum", "plus"] })
    await setImmediate()
  })
  await setup!.renderOnce()
  await key("s", { ctrl: true })
  await write("a")
  expect(composer().plainText).toBe("a")
  expect(frame()).not.toContain("enter Answer")
  await key("c", { ctrl: true })
  await key("TAB")
  await key("a")
  expect(frame()).toContain("Which name?")
  await key("ARROW_DOWN")
  await key("RETURN")
  expect(await answered).toMatchObject({ answer: "plus" })
  expect(turns).toHaveLength(2)
  expect(composer().plainText).toBe("")
  assertNoStop()
})

test("Summary Enter with an empty composer never opens a row without explicit focus", async () => {
  await liveWorker()
  await key("s", { ctrl: true })
  await key("RETURN")
  expect(frame()).not.toContain("Continue Review one file")
  expect(turns).toHaveLength(2)
  expect(composer().plainText).toBe("")
  assertNoStop()
})

test("Summary composer keeps file completion and Escape returns to Chat afterward", async () => {
  await key("s", { ctrl: true })
  await write("explain @src/app")
  expect(composer().plainText).toBe("explain @src/app")
  expect(frame()).toContain("src/app.ts")
  await key("ESCAPE")
  expect(composer().plainText).toBe("explain @src/app")
  expect(frame()).not.toContain("tab Complete")
  await key("ESCAPE")
  await key("RETURN")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("explain @src/app")
})
