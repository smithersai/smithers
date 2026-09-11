import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"

const roots: Array<string> = []
const processTimeoutMs = 20_000
// Each journey performs four sequential fresh-process invocations. Allow
// their existing individual bounds plus cleanup, without extending a child.
const journeyTimeoutMs = 4 * processTimeoutMs + 10_000
const root = () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-memory-cli-restart-"))
  roots.push(directory)
  return directory
}
const fixture = fileURLToPath(new URL("./fixtures/MemoryRestart.ts", import.meta.url))
const bin = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
const invoke = (args: ReadonlyArray<string>) => {
  const env = { ...process.env }
  delete env.SMITHERS_REMOTE
  delete env.SMITHERS_CREDENTIAL
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", timeout: processTimeoutMs, env }))
}
const list = (directory: string) =>
  invoke([
    bin,
    "memory",
    "list",
    "--namespace",
    "global:release",
    "--root",
    directory,
    "--json"
  ])

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it("reads memory from a terminated public NodeControl composition in a fresh CLI process", () => {
  const directory = root()
  invoke([fixture, "write", directory])
  expect(list(directory)).toMatchObject([
    { key: "runbook", value: "retained across commands", provenance: { runId: "writer" } }
  ])
  expect(invoke([fixture, "control", directory])).toMatchObject({ plans: [] })
  expect(list(directory)).toHaveLength(1)
}, journeyTimeoutMs)

it("allows memory to be the first project command before opening and reopening control", () => {
  const directory = root()
  invoke([
    bin,
    "memory",
    "set",
    "runbook",
    "first command",
    "--namespace",
    "global:release",
    "--root",
    directory,
    "--json"
  ])
  const firstControl = invoke([fixture, "control", directory])
  expect(firstControl.flows.length).toBeGreaterThan(0)
  expect(invoke([fixture, "control", directory])).toEqual(firstControl)
  expect(list(directory)).toMatchObject([{ key: "runbook", value: "first command" }])
  const db = new DatabaseSync(join(directory, ".flows", "control.db"), { readOnly: true })
  try {
    const rows = db.prepare("SELECT DISTINCT migration_id / 1000 AS block FROM flows_migrations ORDER BY block").all()
    expect(rows.map((row) => row.block)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  } finally {
    db.close()
  }
}, journeyTimeoutMs)
