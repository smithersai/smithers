import { afterAll, expect, it } from "bun:test"
import * as Effect from "effect/Effect"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Spend from "../src/spend.ts"

const roots: Array<string> = []
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "tui-spend-"))
  roots.push(root)
  return join(root, "spend")
}
const today = () => new Date().toISOString().slice(0, 10)

it("sums a UTC day across runs and survives a new ledger over the same directory", async () => {
  const root = fresh()
  const first = Spend.ledger(root)
  await Effect.runPromise(first.record({ day: today(), runId: "a", stepKey: "1", spent: 600 }))
  await Effect.runPromise(
    first.record({ day: today(), runId: "a", stepKey: "2", spent: 10, costUsd: 0.5, costSource: "estimated" })
  )
  await Effect.runPromise(first.record({ day: today(), runId: "b", stepKey: "1", spent: 400 }))
  await Effect.runPromise(first.record({ day: "2020-01-01", runId: "old", stepKey: "1", spent: 9 }))
  const second = Spend.ledger(root)
  expect(await Effect.runPromise(second.total(today()))).toBe(1010)
  expect(await Effect.runPromise(second.total("2020-01-01"))).toBe(9)
  expect(await Effect.runPromise(second.total("2019-01-01"))).toBe(0)
  expect([...(await Effect.runPromise(second.run("a")))]).toEqual([["1", { spent: 600 }], ["2", {
    spent: 10,
    costUsd: 0.5
  }]])
})

it("counts a retried record once, and tolerates only a torn final line", async () => {
  const root = fresh()
  const ledger = Spend.ledger(root)
  const entry = { day: today(), runId: "a", stepKey: "1", spent: 5 }
  await Effect.runPromise(ledger.record(entry))
  await Effect.runPromise(ledger.record(entry))
  expect(await Effect.runPromise(ledger.total(today()))).toBe(5)
  appendFileSync(join(root, `${today()}.jsonl`), "{\"day\":")
  expect(await Effect.runPromise(ledger.total(today()))).toBe(5)
  appendFileSync(join(root, `${today()}.jsonl`), "\n{\"day\":\n")
  const failure = await Effect.runPromise(Effect.flip(ledger.total(today())))
  expect(failure).toBeInstanceOf(Error)
})

it("refuses a line that is not a spend record instead of counting zero", async () => {
  const root = fresh()
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, `${today()}.jsonl`), "{\"day\":1}\n")
  await Effect.runPromise(Effect.flip(Spend.ledger(root).total(today())))
  expect(readFileSync(join(root, `${today()}.jsonl`), "utf8")).toBe("{\"day\":1}\n")
})

it.each(["-1", "\"0.5\"", "null"])("refuses a spend record whose USD is %s", async (cost) => {
  const root = fresh()
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, `${today()}.jsonl`),
    `{"day":"${today()}","runId":"a","stepKey":"1","spent":5,"costUsd":${cost}}\n`
  )
  await Effect.runPromise(Effect.flip(Spend.ledger(root).run("a")))
})

it("keeps its directory under the session directory override", () => {
  const before = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = "/tmp/x"
  try {
    expect(Spend.directory()).toBe("/tmp/x/spend")
  } finally {
    if (before === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = before
  }
})

it.each(["{\"day\":", "{\"runId\":\"é🙂", "{\"spent\":7}"])(
  "repairs a torn tail %s before recording more spend",
  async (tail) => {
    const root = fresh()
    const day = today()
    const file = join(root, `${day}.jsonl`)
    const first = { day, runId: "é🙂", stepKey: "1", spent: 5 }
    const next = { day, runId: "é🙂", stepKey: "2", spent: 7, costUsd: 0.25 }
    await Effect.runPromise(Spend.ledger(root).record(first))
    const complete = readFileSync(file, "utf8")
    appendFileSync(file, tail)
    expect(await Effect.runPromise(Spend.ledger(root).total(day))).toBe(5)
    await Effect.runPromise(Spend.ledger(root).record(next))
    expect(readFileSync(file, "utf8")).toBe(complete + JSON.stringify(next) + "\n")
    expect(await Effect.runPromise(Spend.ledger(root).total(day))).toBe(12)
    expect([...(await Effect.runPromise(Spend.ledger(root).run(first.runId)))]).toEqual([
      ["1", { spent: 5 }],
      ["2", { spent: 7, costUsd: 0.25 }]
    ])
    await Effect.runPromise(Spend.ledger(root).record(next))
    expect(await Effect.runPromise(Spend.ledger(root).total(day))).toBe(12)
  }
)

it("recovers when the first record is torn and when yesterday has a torn tail", async () => {
  const root = fresh()
  const day = today()
  const yesterday = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, `${day}.jsonl`), "{\"day\":")
  await Effect.runPromise(Spend.ledger(root).record({ day, runId: "a", stepKey: "2", spent: 7 }))
  await Effect.runPromise(Spend.ledger(root).record({ day: yesterday, runId: "a", stepKey: "1", spent: 5 }))
  appendFileSync(join(root, `${yesterday}.jsonl`), "{\"day\":")
  expect(await Effect.runPromise(Spend.ledger(root).total(day))).toBe(7)
  expect([...(await Effect.runPromise(Spend.ledger(root).run("a")))]).toEqual([
    ["1", { spent: 5 }],
    ["2", { spent: 7 }]
  ])
})

it("releases the writer lock after a filesystem failure", async () => {
  const root = fresh()
  const day = today()
  const file = join(root, `${day}.jsonl`)
  mkdirSync(file, { recursive: true })
  const entry = { day, runId: "a", stepKey: "1", spent: 5 }
  expect(await Effect.runPromise(Effect.flip(Spend.ledger(root).record(entry)))).toBeInstanceOf(Error)
  rmSync(file, { recursive: true })
  await Effect.runPromise(Spend.ledger(root).record(entry))
  expect(await Effect.runPromise(Spend.ledger(root).total(day))).toBe(5)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(`${file}.lock.sqlite`).mode & 0o777).toBe(0o600)
})

it("serializes independent writers repairing a torn tail and releases a dead writer lock", async () => {
  const root = fresh()
  const day = today()
  const entry = { day, runId: "original", stepKey: "1", spent: 5 }
  await Effect.runPromise(Spend.ledger(root).record(entry))
  const file = join(root, `${day}.jsonl`)
  appendFileSync(file, "{\"day\":")
  const before = readFileSync(file, "utf8")
  const holder = Bun.spawn([
    process.execPath,
    "--eval",
    `
    import { DatabaseSync } from "node:sqlite";
    const lock = new DatabaseSync(process.argv[1]);
    lock.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    await new Promise(resolve => process.stdin.once("data", resolve));
    lock.close();
  `,
    `${file}.lock.sqlite`
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const writers: Array<Bun.Subprocess<"ignore", "pipe", "pipe">> = []
  try {
    const held = await holder.stdout.getReader().read()
    expect(new TextDecoder().decode(held.value)).toBe("locked\n")
    const module = new URL("../src/spend.ts", import.meta.url).href
    const program = `
      import * as Spend from ${JSON.stringify(module)};
      import * as Effect from "effect/Effect";
      const ledger = Spend.ledger(process.argv[1]);
      const day = process.argv[2];
      const runId = process.argv[3];
      process.stdout.write("ready\\n");
      for (let index = 0; index < 20; index++) {
        await Effect.runPromise(ledger.record({ day, runId, stepKey: String(index), spent: 1 }));
      }
    `
    // Both packaged runtimes must participate in the same lock protocol.
    for (const [index, runtime] of [process.execPath, "node", process.execPath].entries()) {
      const writer = Bun.spawn([runtime, "--eval", program, root, day, `writer-${index}`], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe"
      })
      writers.push(writer)
      const ready = await writer.stdout.getReader().read()
      expect(new TextDecoder().decode(ready.value)).toBe("ready\n")
      expect(writer.exitCode).toBeNull()
    }
    expect(readFileSync(file, "utf8")).toBe(before)
    holder.kill("SIGKILL")
    await holder.exited
    for (const writer of writers) {
      expect(await writer.exited).toBe(0)
      expect(await new Response(writer.stderr).text()).toBe("")
    }
    expect(await Effect.runPromise(Spend.ledger(root).total(day))).toBe(65)
    const lines = readFileSync(file, "utf8").trimEnd().split("\n")
    expect(lines).toHaveLength(61)
    expect(JSON.parse(lines[0]!)).toEqual(entry)
    for (let index = 0; index < 3; index++) {
      expect((await Effect.runPromise(Spend.ledger(root).run(`writer-${index}`))).size).toBe(20)
    }
  } finally {
    holder.kill()
    for (const writer of writers) writer.kill()
    await Promise.all([holder.exited, ...writers.map((writer) => writer.exited)])
  }
}, 20_000)
