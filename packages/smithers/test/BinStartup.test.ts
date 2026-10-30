/** Real executable contracts, scheduled in the bounded CLI worker pool. */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  executable,
  freePort,
  inEmptyDirectory,
  keyless,
  launch,
  processBudget,
  refusal,
  run,
  runIn,
  temporaryDirectoryPrefix
} from "./support/bin.ts"
import { childEnvironment } from "./support/node-child.ts"

describe("keyless host startup", processBudget, () => {
  it("boots the real serve entry without a gateway key", async () => {
    const port = await freePort()
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    const child = spawn(process.execPath, ["--no-warnings", executable, "serve", "--port", String(port)], {
      cwd,
      env: childEnvironment({
        HOME: cwd,
        PATH: process.env.PATH,
        CI: "1",
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
      }),
      stdio: ["ignore", "pipe", "pipe"]
    })
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    try {
      child.stdout.resume()
      child.stderr.resume()
      let ready = false
      for (let attempt = 0; attempt < 240; attempt++) {
        if (child.exitCode !== null) throw new Error(`host exited: ${child.exitCode}`)
        try {
          ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
        } catch { /* still starting */ }
        if (ready) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(ready).toBe(true)
    } finally {
      child.kill("SIGTERM")
      await closed
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  // A host that cannot reach a completion has nothing to judge, so a verb that
  // lists, diagnoses, or reads a log works in a project that has never had a
  // gateway key. The whole read surface is here rather than one sample,
  // because the regression this replaces hit every one of them at once.
  it.each([
    [["ls", "--json"]],
    [["workflow", "list", "--json"]],
    [["ps", "--json"]],
    [["status", "--json"]],
    [["flow", "list", "--json"]],
    [["runs", "list", "--json"]],
    [["approvals", "list", "--json"]],
    [["doctor", "--json"]],
    [["gc", "--json"]],
    [["down", "--json"]],
    [["runs", "cancel-all", "--json"]]
  ])("runs %j with no gateway key at all", (args) => {
    inEmptyDirectory((cwd) => {
      const result = keyless(cwd, args)
      const output = result.stdout + result.stderr
      expect(output).not.toContain(refusal)
      expect(result.status, output).toBe(0)
      expect(() => JSON.parse(result.stdout)).not.toThrow()
    })
  })

  // The five verbs that start or resume a run, by both spellings that reach
  // them, plus the two aliases. A decision restarts the run it answers on this
  // process's own executor, which is why `approve` and `deny` are launches.
  it.each([
    [["up", "demo"]],
    [["run", "{}"]],
    [["run", "run-1", "--resume"]],
    [["resume", "run-1"]],
    [["approve", "{}"]],
    [["deny", "{}"]],
    [["flow", "start", "demo"]],
    [["flow", "execute", "{}"]],
    [["runs", "resume", "run-1"]],
    [["approvals", "approve", "{}"]],
    [["approvals", "deny", "{}"]]
  ])("validates %j without requiring a gateway key", (args) => {
    inEmptyDirectory((cwd) => {
      const result = keyless(cwd, args)
      const output = result.stdout + result.stderr
      expect(result.status, output).not.toBeNull()
      expect(output).not.toContain(refusal)
    })
  })

  it("keeps reading a project a keyless launch refused to touch", () => {
    inEmptyDirectory((cwd) => {
      expect(keyless(cwd, ["up", "demo"]).status).not.toBe(0)
      const listed = keyless(cwd, ["ls", "--json"])
      expect(listed.status, listed.stdout + listed.stderr).toBe(0)
      expect(JSON.parse(listed.stdout)).toMatchObject({ _tag: "flows", items: [] })
    })
  })
})

describe("canonical verb ownership", processBudget, () => {
  it("documents run as the default approval scope in the executable schema", () => {
    const result = run(["approvals", "approve", "--schema", "--json"])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).options.properties.scope.default).toBe("run")
  })

  it("registers the documented MCP entry using the current executable", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["mcp", "add", "--agent", "claude", "--json"])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual([{
        agent: "claude",
        path: join(cwd, ".claude.json"),
        status: "written"
      }])
      expect(JSON.parse(readFileSync(join(cwd, ".claude.json"), "utf8"))).toEqual({
        mcpServers: { smithers: { command: process.execPath, args: [executable, "--mcp"] } }
      })
      expect(existsSync(join(cwd, ".flows"))).toBe(false)
      const repeated = runIn(cwd, ["mcp", "add", "--agent", "claude", "--json"])
      expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0)
      expect(JSON.parse(repeated.stdout)[0].status).toBe("unchanged")
    })
  })

  it.each(
    [
      [["memory", "get"], "key"],
      [["memory", "set", "key"], "value"]
    ] as const
  )("uses canonical validation for incomplete %j", (args, field) => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, [...args, "--json"])
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: expect.arrayContaining([expect.objectContaining({ path: field, missing: true })])
      })
      expect(readdirSync(cwd)).toEqual([])
    })
  })
})

describe("observing verbs", processBudget, () => {
  it.each(
    [
      [["runs", "list"], 0, { items: [] }],
      [["runs", "show", "absent-run"], 1, { code: "run_not_found" }],
      [["runs", "logs", "absent-run"], 0, []],
      [["approvals", "list"], 0, []]
    ] as const
  )("%j creates no files in an empty project", (args, status, body) => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, [...args, "--json"], { SMITHERS_REMOTE: "" })
      expect(result.status, result.stdout + result.stderr).toBe(status)
      expect(JSON.parse(result.stdout)).toMatchObject(body)
      expect(readdirSync(cwd)).toEqual([])
    })
  })
})

describe("legacy fork routing", processBudget, () => {
  it.each([
    ["resume", "fork-run", "--silent"],
    ["--audience", "human", "resume", "fork-run"],
    ["run", "fork-run", "--resume", "--verbose"]
  ])("prepares the retained workspace with presentation flags: %j", (...args) => {
    inEmptyDirectory((cwd) => {
      mkdirSync(join(cwd, ".flows"))
      const workspace = join(cwd, "missing-fork-workspace")
      const database = new DatabaseSync(join(cwd, ".flows", "engine.db"))
      try {
        database.exec(
          "CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT NOT NULL); CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY, workspace TEXT NOT NULL)"
        )
        database.prepare("INSERT INTO smthrs_history_workspaces VALUES (?, ?)").run("fork-run", workspace)
      } finally {
        database.close()
      }
      // Only History.prepare reports this retained-workspace error. It must
      // run after parsing and before the default executor opens its layers.
      const result = runIn(cwd, args, { SMITHERS_AUDIENCE: "human", SMITHERS_REMOTE: "" })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Run workspace no longer exists: ${workspace}`)
      expect(existsSync(join(cwd, ".flows", "control.db"))).toBe(false)
    })
  })
})

describe("bulk cancellation", processBudget, () => {
  it.each([
    { args: ["down"] },
    { args: ["--json", "down"] },
    { args: ["--json", "--quiet", "down"] },
    { args: ["runs", "cancel-all", "--json"] }
  ])("$args cancels an older live run after 101 newer terminal records", ({ args }) => {
    inEmptyDirectory((cwd) => {
      mkdirSync(join(cwd, ".flows"))
      const environment = { SMITHERS_REMOTE: "", SMITHERS_AUDIENCE: "human" }
      const initialized = runIn(cwd, ["--json", "ps"], environment)
      expect(initialized.status, initialized.stderr).toBe(0)
      const seeded = new DatabaseSync(join(cwd, ".flows", "control.db"))
      try {
        const insert = seeded.prepare(
          "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, ?, ?, ?)"
        )
        insert.run(
          "older-live-run",
          "suspended",
          1,
          JSON.stringify({
            runId: "older-live-run",
            flowId: "demo/ship",
            status: "parked",
            createdAt: 1,
            updatedAt: 1
          })
        )
        // Control-launched runs sort before unindexed engine children,
        // even when the child is older than all the terminal history.
        const indexRun = seeded.prepare("INSERT INTO control_runs (run_id, created_seq) VALUES (?, ?)")
        for (let index = 0; index < 101; index++) {
          const runId = `terminal-${index}`
          indexRun.run(runId, index + 1)
          insert.run(
            runId,
            "completed",
            index + 2,
            JSON.stringify({
              runId,
              flowId: "demo/ship",
              status: "completed",
              createdAt: index + 2,
              updatedAt: index + 2
            })
          )
        }
      } finally {
        seeded.close()
      }
      const firstPage = JSON.parse(runIn(cwd, ["--json", "ps"], environment).stdout)
      expect(firstPage.items).toHaveLength(100)
      expect(firstPage.items.every((run: { status: string }) => run.status === "completed")).toBe(true)
      expect(firstPage.nextCursor).toBeDefined()
      const result = runIn(cwd, args, environment)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).cancelled).toEqual([{
        runId: "older-live-run",
        receipt: { _tag: "Terminal", status: "cancelled", runId: "older-live-run" }
      }])
      const database = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
      try {
        expect(database.prepare("SELECT status FROM flows_runs WHERE run_id = ?").get("older-live-run"))
          .toEqual({ status: "cancelled" })
        expect(database.prepare("SELECT COUNT(*) AS count FROM flows_runs WHERE status = 'completed'").get())
          .toEqual({ count: 101 })
      } finally {
        database.close()
      }
    })
  })
})
