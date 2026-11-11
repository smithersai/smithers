import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import * as Credit from "../src/credit.vibe"
import * as Files from "../src/files.ts"
import type * as Host from "../src/host.vibe"
import * as Session from "../src/session.ts"

// Real App, native renderer and worker persistence; only execution is controlled.
let root: string
let previousRepo: string | undefined
let previousSessions: string | undefined
let files: ReturnType<typeof spyOn>
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }>
const frame = () => setup!.captureCharFrame()
const flush = async () => {
  await act(async () => {
    await setImmediate()
  })
  await act(async () => setup!.renderOnce())
}
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await flush()
}
const command = async (text: string) => {
  await act(async () => setup!.mockInput.pressKeys(Array.from(text)))
  await key("RETURN", { meta: true })
}
const switchTo = async (to: string) => {
  await act(async () => {
    turns[1]!.input.onEvent(
      new AgentEvent.SeatFailedOver({
        eventType: "flows.harness.seat-failed-over.v1",
        from: "openai:gpt-6.1-sol",
        to,
        code: "rate_limited"
      })
    )
  })
  await flush()
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-model-switch-"))
  previousRepo = process.env.SMITHERS_REPO
  previousSessions = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_REPO = "fixture/model-switch"
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  files = spyOn(Files, "lister").mockImplementation(() => () => [])
  turns = []
})
afterEach(async () => {
  try {
    await act(async () => {
      turns.forEach((turn) => turn.done.resolve({ _tag: "cancelled" }))
      await setImmediate()
      setup?.renderer.destroy()
    })
  } finally {
    setup = undefined
    files.mockRestore()
    if (previousRepo === undefined) delete process.env.SMITHERS_REPO
    else process.env.SMITHERS_REPO = previousRepo
    if (previousSessions === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousSessions
    rmSync(root, { recursive: true, force: true })
  }
})
const mount = async (width: number, height: number, resume?: string, credit?: Credit.Ledger) => {
  const host: Host.Host = {
    cwd: root,
    judged: false,
    credit,
    dispose: async () => {},
    run: (input) => {
      const done = Promise.withResolvers<Host.Outcome>()
      turns.push({ input, done })
      return { done: done.promise, cancel: () => done.resolve({ _tag: "cancelled" }) }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:one"
        workerSeat={credit === undefined ? undefined : "openai:gpt-6.1-sol"}
        models={[]}
        contextWindow={() => 10000}
        resume={resume}
      />,
      {
        width,
        height,
        exitOnCtrlC: false,
        kittyKeyboard: true
      }
    )
    await setImmediate()
  })
  await flush()
}
test.each([[80, 24], [40, 16]])("typed failover appears on the actual worker card at %s×%s", async (width, height) => {
  await mount(width, height)
  await command("Coordinate")
  await act(async () => {
    turns[0]!.input.runtime!.delegate!({ id: "fix", title: "Fix addition", prompt: "Fix addition" })
    await setImmediate()
  })
  await flush()
  expect(turns).toHaveLength(2)
  await act(async () => {
    turns[1]!.input.onEvent(
      new AgentEvent.ModelSelected({
        eventType: "flows.harness.model-selected.v1",
        seat: "openai:gpt-6-luna"
      })
    )
  })
  await flush()
  expect(frame()).not.toContain("↪")
  await switchTo("openai:gpt-6-luna")
  await key("ARROW_RIGHT", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  expect(frame()).toContain("↪ switched to GPT-6 Luna")
  await key("y", { ctrl: true })
  expect(frame()).toContain("Fix addition")
  expect(frame()).toContain("↪ switched to GPT-6 Luna")
  await switchTo("anthropic:claude")
  expect(frame()).toContain("↪ switched to claude")
  expect(frame()).not.toContain("↪ switched to GPT-6 Luna")
  await act(async () => turns[1]!.done.resolve({ _tag: "done", answer: "Fixed addition." }))
  await flush()
  expect(frame()).toContain("Fixed addition.")
  expect(frame()).toContain("↪ switched to claude")
  expect(frame()).toContain("enter Open")
  await act(async () => turns[0]!.done.resolve({ _tag: "done", answer: "Coordinated." }))
  await flush()
  const saved = Session.list(root).find((row) => Session.load(row.file).some((record) => record.type === "tab"))!.file
  await act(async () => {
    setup!.renderer.destroy()
    await setImmediate()
  })
  setup = undefined
  await mount(width, height, saved)
  expect(turns).toHaveLength(2)
  expect(frame()).toContain("↪ switched to claude")
  expect(frame()).toContain("Fixed addition.")
  expect(frame()).not.toContain("↪ switched to GPT-6 Luna")
  // Open the settled card and continue through the real worker composer.
  const y = frame().split("\n").findIndex((line) => line.includes("Fix addition"))
  await act(async () => setup!.mockMouse.click(6, y))
  await flush()
  expect(frame()).toContain("↪ switched to GPT-6 Luna")
  expect(frame()).toContain("↪ switched to claude")
  await command("Next turn")
  await key("y", { ctrl: true })
  expect(turns).toHaveLength(3)
  expect(turns[2]!.input.prompt).toBe("Next turn")
  expect(frame()).toContain("Fix addition")
  expect(frame()).not.toContain("↪ switched")
})

test.each([[80, 24], [40, 16]])(
  "a real credit stand-in appears on the mounted card and persisted restore at %s×%s",
  async (width, height) => {
    const sol = "openai:gpt-6.1-sol"
    const qwen = "cerebras:qwen-3.8-27b"
    const credit = Credit.make([])
    credit.spend(sol)
    credit.answered(qwen)
    const notice = Credit.notice(sol, qwen)
    await mount(width, height, undefined, credit)
    await command("Coordinate")
    await act(async () => {
      turns[0]!.input.runtime!.delegate!({ id: "fix", title: "Fix addition", prompt: "Fix" })
      await setImmediate()
    })
    await flush()
    expect(turns).toHaveLength(2)
    expect(turns[1]!.input.seat).toBe(qwen)
    expect(turns[1]!.input.fallbackSeats).toEqual([])
    // The real Workspace selected the replacement; first inspect the worker's view.
    await key("ARROW_RIGHT", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame().replace(/[▌┃]/g, " ").replace(/\s+/g, " ")).toContain(notice)
    expect(frame().match(/↪/g)).toHaveLength(1)
    await key("y", { ctrl: true })
    expect(frame()).toContain("Fix addition")
    expect(frame().replace(/[▌┃]/g, " ").replace(/\s+/g, " ")).toContain(notice)
    expect(frame().match(/↪/g)).toHaveLength(1)
    await act(async () => {
      turns[1]!.done.resolve({ _tag: "done", answer: "Fixed." })
      turns[0]!.done.resolve({ _tag: "done", answer: "Coordinated." })
    })
    await flush()
    const saved = Session.list(root).find((row) => Session.load(row.file).some((record) => record.type === "tab"))!.file
    await act(async () => {
      setup!.renderer.destroy()
      await setImmediate()
    })
    setup = undefined
    await mount(width, height, saved, credit)
    expect(turns).toHaveLength(2)
    expect(frame().replace(/[▌┃]/g, " ").replace(/\s+/g, " ")).toContain(notice)
    expect(frame().match(/↪/g)).toHaveLength(1)
    const y = frame().split("\n").findIndex((line) => line.includes("Fix addition"))
    await act(async () => setup!.mockMouse.click(6, y))
    await flush()
    expect(frame().replace(/[▌┃]/g, " ").replace(/\s+/g, " ")).toContain(notice)
    expect(frame().match(/↪/g)).toHaveLength(1)
    await command("Next turn")
    await key("y", { ctrl: true })
    expect(turns[2]!.input.seat).toBe(qwen)
    expect(frame()).not.toContain("↪")
    await act(async () => {
      turns[2]!.input.onEvent(
        new AgentEvent.SeatFailedOver({
          eventType: "flows.harness.seat-failed-over.v1",
          from: qwen,
          to: "openai:gpt-6-luna",
          code: "quota_exceeded",
          retryAfterMillis: 1000
        })
      )
    })
    await flush()
    expect(frame()).toContain("↪ switched to GPT-6 Luna")
    expect(frame()).not.toContain("has no credit")
    expect(frame().match(/↪/g)).toHaveLength(1)
  }
)
