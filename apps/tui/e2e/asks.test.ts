import { StdinParser } from "@opentui/core"
import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import * as Approvals from "../src/approvals.ts"
import { bunCommand, key, Tui } from "./tmux.ts"

type Snapshot = {
  now: number
  events: Array<{ kind: string; name?: string; text?: string; answer?: string; at?: number }>
  pending: Array<{ question: string }>
}
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const control = (path: string, now?: number): Promise<Snapshot> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let response = ""
    socket.setTimeout(5_000, () => socket.destroy(new Error("ask fixture control timeout")))
    socket.on("error", reject)
    socket.on("connect", () => socket.write(JSON.stringify({ now }) + "\n"))
    socket.on("data", (data) => response += data.toString())
    socket.on("end", () => resolve(JSON.parse(response)))
  })

const cases = [
  { name: "burst", burst: "a\r", message: "a" },
  { name: "short", delay: Approvals.armMs - 1, burst: "\r", message: "a" },
  { name: "long", delay: Approvals.armMs + 1, burst: "\r", message: "a" },
  { name: "free-short", free: true, delay: Approvals.armMs - 1, burst: "\r", message: "a" },
  { name: "free-long", free: true, delay: Approvals.armMs + 1, burst: "\r", message: "a" },
  { name: "continuation", burst: "and x\r", message: "and x" },
  { name: "suffix", burst: "a\rnext message\r", message: "a", suffix: "next message" },
  { name: "up-first", burst: "a\x1b[A\r", answer: "sum" },
  { name: "down-second", burst: "a\x1b[B\r", answer: "plus" },
  { name: "other", burst: "a\t\ttotal\r", answer: "total" },
  { name: "free-selected", free: true, burst: "a\tnew name\r", answer: "new name" },
  { name: "number", delay: Approvals.armMs + 1, burst: "2", answer: "plus" },
  { name: "chat-paste", burst: "\x1b[200~a\x1b[201~\r", message: "a" },
  { name: "paste", burst: "a\x1b[200~total\x1b[201~All\r", answer: "totalAll" },
  { name: "escape", burst: "a\x1b", escaped: true },
  { name: "multiple", count: 2, burst: "a\r", message: "a" },
  { name: "summary", burst: "\x13\x1b[Ba", explicit: true, answer: "sum" },
  { name: "agent", burst: "\x1b[1;5C\x1b[1;5C\x1ba", explicit: true, answer: "sum" }
] as const

for (const scenario of cases) {
  test(`offline pending ask preserves intent through the PTY (${scenario.name})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-asks-"))
    const socket = join(cwd, "control.sock")
    const events = join(cwd, "events.jsonl")
    const tui = await Tui.start({
      command: `${bunCommand} ${quote(join(import.meta.dir, "asks-fixture.tsx"))}`,
      cwd,
      env: {
        TUI_ASK_CONTROL: socket,
        TUI_ASK_EVENTS: events,
        SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions"),
        TUI_ASK_COUNT: String("count" in scenario ? scenario.count : 1),
        TUI_ASK_FREE: "free" in scenario ? "1" : "0"
      },
      cols: 120,
      rows: 36
    })
    try {
      await tui.until((screen) => screen.includes("Ask Smithers"))
      await tui.press("start\r")
      await tui.until((screen) => screen.includes(`Summary ◆${"count" in scenario ? scenario.count : 1}`))
      await control(socket, 10_000 + Approvals.armMs)
      if ("delay" in scenario) {
        await tui.press("a")
        await tui.until((screen) => screen.includes("enter Answer"))
        await control(socket, 10_000 + Approvals.armMs + scenario.delay)
      }
      const before = await control(socket)
      await tui.press(scenario.burst)
      if ("explicit" in scenario) {
        await tui.until((screen) => screen.includes("enter Answer"))
        await control(socket, 10_000 + 2 * Approvals.armMs + 1)
        await tui.press(key.enter)
      }
      // Wait for every parsed key, including suffixes, rather than relying on press()'s pacing.
      const parser = new StdinParser({ armTimeouts: false })
      let expectedKeys = before.events.filter((event) => event.kind === "key").length
      try {
        parser.push(Buffer.from(scenario.burst + ("explicit" in scenario ? key.enter : "")))
        parser.flushTimeout(Infinity)
        parser.drain((event) => {
          if (event.type === "key") expectedKeys++
        })
      } finally {
        parser.destroy()
      }
      let snapshot = await control(socket)
      const deadline = performance.now() + 5_000
      while (
        snapshot.events.filter((event) => event.kind === "key").length < expectedKeys &&
        performance.now() < deadline
      ) {
        await setTimeout(10)
        snapshot = await control(socket)
      }
      if (process.env.SMITHERS_3666_ARTIFACT_DIR) {
        const output = process.env.SMITHERS_3666_ARTIFACT_DIR
        mkdirSync(output, { recursive: true })
        copyFileSync(events, join(output, `${scenario.name}.jsonl`))
        writeFileSync(join(output, `${scenario.name}.screen.txt`), tui.screen())
        writeFileSync(join(output, `${scenario.name}.snapshot.json`), JSON.stringify(snapshot, null, 2))
      }
      expect(snapshot.events.filter((event) => event.kind === "key")).toHaveLength(expectedKeys)
      const messages = snapshot.events.filter((event) => event.kind === "message").map((event) => event.text)
      const answers = snapshot.events.filter((event) => event.kind === "answer").map((event) => event.answer)
      expect(messages).toEqual(
        "suffix" in scenario
          ? ["start", scenario.message, scenario.suffix]
          : "message" in scenario
          ? ["start", scenario.message]
          : ["start"]
      )
      expect(answers).toEqual("answer" in scenario ? [scenario.answer] : [])
      expect(snapshot.pending).toHaveLength("answer" in scenario ? 0 : "count" in scenario ? scenario.count : 1)
      if ("delay" in scenario) {
        const keys = snapshot.events.filter((event) => event.kind === "key")
        expect(keys.findLast((event) => event.name === "a")?.at).toBe(10_000 + Approvals.armMs)
        expect(keys.at(-1)?.at).toBe(10_000 + Approvals.armMs + scenario.delay)
      }
      if ("suffix" in scenario) await tui.until((screen) => screen.includes(scenario.suffix))
      if ("escaped" in scenario) expect(tui.screen()).not.toContain("enter Answer")
    } finally {
      await tui.stop()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 30_000)
}
