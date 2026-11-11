import * as Audience from "@smthrs/build-cli/Audience"
import type { ControlSchema } from "@smthrs/control"
import { afterEach, expect, it, vi } from "vitest"
import * as Bridge from "../src/cli/ControlBridge.ts"
import { createRunsCli } from "../src/cli/ControlCommands.ts"

afterEach(() => vi.restoreAllMocks())
it("bounds agent log pulls, closes the iterator, and retains the connection in its next-page command", async () => {
  let consumed = 0
  let closed = false
  vi.spyOn(Bridge, "hasRecords").mockReturnValue(true)
  vi.spyOn(Bridge, "events").mockImplementation(() =>
    (async function*() {
      try {
        for (let sequence = 1; sequence <= 101; sequence++) {
          consumed++
          yield {
            sequence,
            occurredAt: sequence,
            kind: "control.agent.cell-printed",
            runId: "run-one",
            payload: { text: "event" }
          } satisfies ControlSchema.ControlEvent
        }
      } finally {
        closed = true
      }
    })()
  )
  let stdout = ""
  let code = 0
  await createRunsCli({ presentation: Audience.resolve({ audience: "agent", env: {} }) }).serve([
    "logs",
    "run-one",
    "--root",
    "/fixture",
    "--format",
    "jsonl"
  ], {
    stdout: (text) => {
      stdout += text
    },
    exit: (status) => {
      code = status
    }
  })
  expect(code).toBe(0)
  expect(consumed).toBe(100)
  expect(closed).toBe(true)
  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line))
  expect(lines.filter((line) => line.type === "chunk")).toHaveLength(100)
  expect(JSON.stringify(lines.at(-1))).toContain("--after 100")
  expect(JSON.stringify(lines.at(-1))).toContain("--root /fixture")
})

const serve = async (argv: ReadonlyArray<string>) => {
  let stdout = ""
  let code = 0
  await createRunsCli({ presentation: Audience.resolve({ audience: "agent", env: {} }) }).serve([...argv], {
    stdout: (text) => {
      stdout += text
    },
    exit: (status) => {
      code = status
    }
  })
  return { code, lines: stdout.trim().split("\n").map((line) => JSON.parse(line)) }
}

it("continues a page that ends inside an expanded journal entry at the entry's next event", async () => {
  // One promotion at sequence 7 expands into itself and two deliveries.
  const expansion: Array<ControlSchema.ControlEvent> = [
    { cursor: { sequence: 7, offset: 0 }, kind: "flows/notifications/Promoted" },
    { cursor: { sequence: 7, offset: 1 }, kind: "control.steer.delivered" },
    { cursor: { sequence: 7 }, kind: "control.steer.delivered" }
  ].map((row) => ({ ...row, sequence: 7, occurredAt: 7, runId: "run-one", payload: {} }))
  const starts: Array<ControlSchema.WatchCursor | undefined> = []
  vi.spyOn(Bridge, "hasRecords").mockReturnValue(true)
  vi.spyOn(Bridge, "events").mockImplementation((_run, _follow, _options, _runtime, after) => {
    starts.push(after)
    const rest = after?.offset === undefined ? expansion : expansion.slice(after.offset + 1)
    return (async function*() {
      yield* rest
    })()
  })
  const first = await serve(["logs", "run-one", "--limit", "1", "--format", "jsonl"])
  expect(first.code).toBe(0)
  expect(JSON.stringify(first.lines.at(-1))).toContain("--after 7 --after-offset 0")
  const second = await serve(["logs", "run-one", "--after", "7", "--after-offset", "0", "--format", "jsonl"])
  expect(second.code).toBe(0)
  expect(starts).toEqual([undefined, { sequence: 7, offset: 0 }])
  expect(second.lines.filter((line) => line.type === "chunk").map((line) => line.data.cursor)).toEqual([
    { sequence: 7, offset: 1 },
    { sequence: 7 }
  ])
})

it("refuses --after-offset without the sequence it continues", async () => {
  vi.spyOn(Bridge, "hasRecords").mockReturnValue(true)
  const refused = await serve(["logs", "run-one", "--after-offset", "0", "--format", "jsonl"])
  expect(refused.code).toBe(2)
  expect(JSON.stringify(refused.lines)).toContain("--after-offset requires --after")
})
