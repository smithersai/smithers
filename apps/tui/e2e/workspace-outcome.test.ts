/** The workspace fixture exercises the real App's delegation projection in a PTY. */
import { afterEach, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type * as Session from "../src/session.ts"
import { bunCommand, drawn, key, Tui, workerTab } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const attempts = (path: string | undefined) => path === undefined || !existsSync(path) ? "" : readFileSync(path, "utf8")
let tui: Tui | undefined
let root: string | undefined
let audit: string | undefined
let logged = ""
afterEach(async () => {
  try {
    if (tui?.alive) {
      await tui.press(key.ctrlD)
      expect(await tui.waitForExit()).toEqual({ code: 0 })
    }
    // Only what this case appended: a shared refusing shim's log already holds other cases' attempts.
    expect(attempts(audit).slice(logged.length)).toBe("")
  } finally {
    await tui?.stop()
    tui = undefined
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
    root = undefined
  }
})

const start = async () => {
  root = mkdtempSync(join(tmpdir(), "tui-workspace-outcome-"))
  const cwd = join(root, "project")
  const home = join(root, "home")
  const bin = join(root, "bin")
  const sessions = join(root, "sessions")
  for (const path of [cwd, home, bin]) mkdirSync(path)
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a - b\n")
  audit = process.env.SMITHERS_TEST_GIT_AUDIT ?? join(root, "git-attempts.log")
  logged = attempts(audit)
  // Never forward Git, even if a future App mount adds another discovery path.
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(audit)}\nexit 97\n`, { mode: 0o755 })
  const preload = join(root, "preload.ts")
  // Protect file completion before App imports/mounts; the plain project has one file.
  writeFileSync(
    preload,
    `import { mock } from "bun:test"\nmock.module(${
      JSON.stringify(join(app, "src", "files.ts"))
    }, () => ({ lister: () => () => ["math.js"] }))\n`
  )
  tui = await Tui.start({
    cwd,
    command: `${bunCommand} --preload ${quote(preload)} ${quote(join(app, "e2e", "workspace-fixture.tsx"))}`,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      SMITHERS_REPO: "fixture/workspace",
      SMITHERS_TUI_SESSION_DIR: sessions
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  const folder = () => join(sessions, readdirSync(sessions)[0]!)
  const records = (file: string): ReadonlyArray<Session.Record> =>
    readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Session.Record)
  const chat = () => records(join(folder(), readdirSync(folder()).find((name) => name.endsWith(".jsonl"))!))
  const workers = () => readdirSync(join(folder(), "workers"))
  const worker = () => records(join(folder(), "workers", workers()[0]!))
  return { cwd, chat, worker, workers }
}
const submit = async (text: string) => {
  await tui!.type(text)
  await tui!.press(key.enter)
}
const evidence = (name: string, screen: string, records: ReadonlyArray<Session.Record>) => {
  const directory = process.env.SMITHERS_TEST_EVIDENCE
  if (directory === undefined) return
  writeFileSync(join(directory, `${name}-screen.txt`), screen)
  writeFileSync(join(directory, `${name}-records.json`), JSON.stringify(records, null, 2))
}

it("shows the finished Fixer answer and edit receipt once, suppressing the saved request acknowledgement", async () => {
  const where = await start()
  await submit("delegate fix")
  const screen = await tui!.until(
    (screen) => /✓ Fixer ·/.test(screen) && screen.includes("Fixed.") && screen.includes("math.js +1 −1"),
    10_000,
    "finished worker and edit receipt"
  )
  evidence("fixer", screen, [...where.chat(), ...where.worker()])
  expect(screen).not.toContain("Requested the fix.")
  expect(screen.match(/✓ Fixer ·/g)).toHaveLength(1)
  expect(readFileSync(join(where.cwd, "math.js"), "utf8")).toBe("export const add = (a, b) => a + b\n")
  expect(where.workers()).toHaveLength(1)
  const tabs = where.chat().filter((record) => record.type === "tab").map((record) => record.tab)
  expect([...new Set(tabs.map((tab) => tab.id))]).toEqual(["fixer"])
  expect([...new Set(tabs.map((tab) => tab.status))]).toEqual(["requested", "running", "done"])
  expect(tabs.at(-1)).toMatchObject({ answer: "Fixed.", endedAt: expect.any(Number) })
  const events = where.chat().filter((record) => record.type === "event").map((record) => record.event)
  const started = events.find((event) => event._tag === "cell-call-started")
  const settled = events.find((event) => event._tag === "cell-call-settled")
  expect(started).toMatchObject({ call: { flowName: "agent.delegate", input: { id: "fixer" } } })
  expect(settled).toMatchObject({
    flowName: "agent.delegate",
    result: { outcome: "success", value: { id: "fixer", status: "requested" } }
  })
  if (started?._tag !== "cell-call-started" || settled?._tag !== "cell-call-settled") {
    throw new Error("Missing delegation")
  }
  expect(settled.identity).toEqual(started.call.identity)
  const produced = events.find((event) => event._tag === "cell-produced")
  const cellSettled = events.find((event) => event._tag === "cell-settled")
  if (produced?._tag !== "cell-produced") throw new Error("Missing delegation cell")
  expect(started.call.identity.cell).toBe(produced.cell.digest)
  expect(cellSettled).toMatchObject({
    cell: produced.cell.digest,
    outcome: { _tag: "settled", transition: { _tag: "complete", output: "Requested the fix." } }
  })
  expect(events.map((event) => event._tag)).toEqual([
    "model-requested",
    "cell-produced",
    "cell-call-started",
    "cell-call-settled",
    "cell-settled",
    "resolved"
  ])
  // The obsolete acknowledgement remains in the session: the production projection hides it.
  expect(where.chat().find((record) => record.type === "outcome")).toMatchObject({
    outcome: { _tag: "done", answer: "Requested the fix." }
  })
  const worker = where.worker()
  expect(worker.filter((record) => record.type === "outcome")).toMatchObject([
    { outcome: { _tag: "done", answer: "Fixed." } }
  ])
  const patches = worker.filter((record) => record.type === "patch")
  expect(patches).toHaveLength(1)
  expect(patches[0]).toMatchObject({ receipt: { patches: [{ path: "math.js" }] } })
  const edit = worker.find((record) => record.type === "event" && record.event._tag === "cell-call-started")
  if (edit?.type !== "event" || edit.event._tag !== "cell-call-started") throw new Error("Missing edit call")
  expect(patches[0]!.receipt.call).toBe(JSON.stringify([
    edit.event.call.identity.session,
    edit.event.call.identity.frame,
    edit.event.call.identity.cell,
    edit.event.call.identity.ordinal,
    edit.event.call.identity.declaration,
    edit.event.call.identity.layers
  ]))
  // Reissuing the same request keeps the settled worker, rather than launching again.
  await submit("delegate fix")
  await tui!.until(
    () => where.chat().filter((record) => record.type === "outcome").length === 2,
    5_000,
    "deduplicated request"
  )
  // Assert the drawn second turn, not whichever frame the journal happened to settle on.
  const repeated = await tui!.until(
    (screen) => screen.split("delegate fix").length - 1 === 2,
    5_000,
    "second request drawn"
  )
  expect(repeated.match(/✓ Fixer ·/g)).toHaveLength(1)
  expect(repeated).not.toContain("Requested the fix.")
  expect(where.worker().filter((record) => record.type === "outcome")).toHaveLength(1)
  const requests = where.chat().filter((record) => record.type === "event" && record.event._tag === "cell-call-settled")
  expect(requests).toMatchObject([
    { event: { identity: { frame: 1 }, result: { value: { status: "requested" } } } },
    { event: { identity: { frame: 2 }, result: { value: { status: "done" } } } }
  ])
  // A second ordinary chat turn remains available after the background result.
  await submit("hello")
  await tui!.until((screen) => screen.includes("Still here.") && screen.includes("Fixed."), 5_000, "ordinary chat")
  await tui!.press(key.tab)
  await tui!.press(key.enter)
  await tui!.until(workerTab("Fixer"), 5_000, "open finished worker")
  expect(tui!.screen()).toContain("Continue Fixer")
  expect(where.workers()).toHaveLength(1)
}, 45_000)

it("keeps investigation unresolved and deduplicated while ordinary chat answers", async () => {
  const where = await start()
  await submit("investigate")
  await tui!.until((screen) => /[◐◓◑◒] Investigation ·/.test(screen), 10_000, "running investigation")
  expect(tui!.screen()).not.toContain("Requested the investigation.")
  await submit("hello")
  const screen = await tui!.until(
    (screen) => screen.includes("Still here.") && /[◐◓◑◒] Investigation ·/.test(screen),
    5_000,
    "chat during unresolved worker"
  )
  expect(screen.match(/[◐◓◑◒] Investigation ·/g)).toHaveLength(1)
  expect(where.workers()).toHaveLength(1)
  const tabs = where.chat().filter((record) => record.type === "tab").map((record) => record.tab)
  expect([...new Set(tabs.map((tab) => tab.status))]).toEqual(["requested", "running"])
  expect(tabs.at(-1)).not.toHaveProperty("endedAt")
  expect(where.worker().some((record) => record.type === "outcome")).toBe(false)
  evidence("investigation", screen, where.chat())
}, 35_000)
