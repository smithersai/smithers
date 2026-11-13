import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect } from "effect"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { prepareHistoryRun, reconcileHistory } from "../src/cli/HistoryCommands.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { invoke } from "./support/unified-cli.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-history-dispatch-"))
  roots.push(root)
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(join(root, ".flows/engine.db"), root)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
  const db = new DatabaseSync(join(root, ".flows/engine.db"))
  try {
    db.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES(?,?,?,?)")
      .run("run-1", "suspended", 0, JSON.stringify({ flowName: "echo", payload: { message: "saved" } }))
    const insert = db.prepare(
      "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?,'fixture',?,0,?,?,?)"
    )
    for (let seq = 1; seq <= 3; seq++) {
      insert.run(
        seq,
        `event-${seq}`,
        seq,
        "flows.engine.run-decision",
        JSON.stringify({ state: { message: `saved-${seq}` } }),
        JSON.stringify({ lineageId: "lineage/root" })
      )
    }
  } finally {
    db.close()
  }
  return root
}
const read = (command: string, root: string, flags: Array<string> = []) =>
  invoke(["runs", command, "run-1", "--root", root, ...flags, "--json"])

describe("historical dispatch through real read-only storage", () => {
  it.each(["inspect", "replay"])("reads the exact historical frame through %s", async (command) => {
    const root = await fixture()
    const result = await read(command, root, ["--at", "2", "--lineage", "lineage/root", "--limit", "2"])
    expect(result.codes, result.stdout).toEqual([])
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      position: { runId: "run-1", frame: { seq: 2, lineageId: "lineage/root" } },
      state: { message: "saved-2" },
      entryCount: 2
    })
    if (command === "replay") expect(output.events.map((entry: { seq: number }) => entry.seq)).toEqual([1, 2])
    else expect(output).not.toHaveProperty("events")
  })

  it.each(["inspect", "replay"])(
    "resolves a relative project and defaults to its latest frame for %s",
    async (command) => {
      const root = await fixture()
      const result = await read(command, relative(process.cwd(), root))
      expect(result.codes, result.stdout).toEqual([])
      expect(JSON.parse(result.stdout)).toMatchObject({
        position: { frame: { seq: 3 } },
        entryCount: 3,
        state: { message: "saved-3" }
      })
    }
  )

  it.each(["inspect", "replay"])(
    "supports the explicit empty frame and enforces the read budget for %s",
    async (command) => {
      const root = await fixture()
      const zero = await read(command, root, ["--at", "0", "--lineage", "lineage/root"])
      expect(JSON.parse(zero.stdout)).toMatchObject({ position: { frame: { seq: 0 } }, entryCount: 0 })
      const limited = await read(command, root, ["--limit", "2"])
      expect(limited.codes).toEqual([2])
      expect(limited.stdout).toContain("exceeds --limit 2")
      const missing = await read(command, root, ["--lineage", "different"])
      expect(missing.codes).toEqual([1])
      expect(missing.stdout).toContain("no addressable")
    }
  )

  it.each(["inspect", "replay"])("does not create a database when %s has no history", async (command) => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-no-history-"))
    roots.push(root)
    const result = await read(command, root)
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("No execution history")
    expect(await readdir(root)).toEqual([])
  })

  it.each(["fork", "rewind"])("refuses retired %s without touching the project", async (command) => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-retired-history-"))
    roots.push(root)
    for (const flags of [[], ["--at", "0"], ["--yes"], ["--preview"], ["--whole-repo"]]) {
      const result = await read(command, root, flags)
      expect(result.codes).toEqual([1])
      expect(result.stdout).toContain("COMMAND_NOT_FOUND")
    }
    expect(await readdir(root)).toEqual([])
  })

  it.each(["inspect", "replay"])("refuses remote %s before opening local storage", async (command) => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-remote-history-"))
    roots.push(root)
    for (
      const connection of [
        { flags: ["--remote", "https://control.invalid"], environment: {} },
        { flags: [], environment: { SMITHERS_REMOTE: "https://control.invalid" } }
      ]
    ) {
      const result = await invoke(["runs", command, "run-1", "--root", root, ...connection.flags, "--json"], {
        environment: connection.environment
      })
      expect(result.codes).toEqual([1])
      expect(result.stdout).toContain("--remote is not supported")
    }
    expect(await readdir(root)).toEqual([])
  })

  it("reconciles an empty local project and prepares its original execution root without a stand-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-prepare-history-"))
    roots.push(root)
    await reconcileHistory({ root, quiet: false }, { environment: {} })
    expect(await prepareHistoryRun("unknown", { root, quiet: false }, { environment: {} })).toEqual({
      executionRoot: root
    })
    expect(await readdir(root)).toEqual([])
    expect(NodeControl.executionDatabasePath(root)).toBe(join(root, ".flows/engine.db"))
  })
})
