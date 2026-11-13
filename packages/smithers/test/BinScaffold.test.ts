/** Real executable contracts, scheduled in the bounded CLI worker pool. */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Providers from "../src/Providers.ts"
import {
  executable,
  launch,
  processBudget,
  refusal,
  run,
  scriptedHost,
  temporaryDirectoryPrefix,
  waitOut
} from "./support/bin.ts"
import { spawnNodeSync } from "./support/node-child.ts"

describe("the smthrs init scaffold, launched as written", processBudget, () => {
  /** The provider credentials a scaffold reads, and the refusal reads back. */
  const seatVariables = [
    ...Providers.starterSeats.map(([variable]) => variable),
    "SMITHERS_OPENAI_AUTH"
  ]

  /**
   * This process's environment with every provider credential removed.
   *
   * The maintainer's shell exports some of these, so a case that inherited the
   * environment would prove nothing on one machine and something else on the
   * next.
   */
  const withoutSeats = (): Record<string, string> => {
    const environment: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || seatVariables.includes(name)) continue
      environment[name] = value
    }
    return environment
  }

  /** An empty repository: what an operator runs `smthrs init` in. */
  const stageEmptyProject = (): string => {
    const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    mkdirSync(join(cwd, ".git"))
    return cwd
  }

  const smithers = (
    cwd: string,
    args: ReadonlyArray<string>,
    environment: Record<string, string>
  ) =>
    spawnNodeSync(["--no-warnings", "--import", scriptedHost, executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 600_000,
      env: environment
    })

  /** Both the native module and its control wrapper must settle on failure. */
  const engineRuns = (cwd: string): ReadonlyArray<{ runId: string; status: string }> => {
    const file = join(cwd, ".flows", "engine.db")
    if (!existsSync(file)) return []
    const handle = new DatabaseSync(file, { readOnly: true })
    try {
      return handle.prepare(
        "SELECT run_id AS runId, status FROM flows_runs WHERE COALESCE(json_extract(state_json, '$.flowName'), '') NOT IN ('smithers/health/Discovery', 'smithers/memory/TtlGc') AND COALESCE(json_extract(state_json, '$.flowName'), '') NOT LIKE 'smithers/health/Discovery/%' ORDER BY run_id"
      )
        .all() as unknown as ReadonlyArray<{ runId: string; status: string }>
    } finally {
      handle.close()
    }
  }

  it("passes doctor immediately after init with a fresh Smithers home", () => {
    const cwd = stageEmptyProject()
    const home = mkdtempSync(join(tmpdir(), "smithers-doctor-home-"))
    try {
      const environment = { ...withoutSeats(), SMITHERS_HOME: home }
      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
      const result = smithers(cwd, ["doctor", "--json"], environment)
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; level: string; detail: string }> }
      expect(report.checks.filter((check) => check.level === "fail")).toEqual([])
      expect(result.status).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("reports a missing smithers-jj-export as a failed registry check", () => {
    const cwd = stageEmptyProject()
    const home = mkdtempSync(join(tmpdir(), "smithers-doctor-home-"))
    try {
      const environment = { ...withoutSeats(), SMITHERS_HOME: home }
      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
      const missing = join(home, "no-such-smithers-jj-export")
      const result = smithers(cwd, ["doctor", "--json"], {
        ...environment,
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: missing
      })
      expect(result.status).toBe(1)
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; level: string; detail: string }> }
      const registry = report.checks.find((check) => check.name === "registry")!
      expect(registry.level).toBe("fail")
      expect(registry.detail).toContain(`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${missing}`)
      expect(registry.detail).toContain(
        "cargo build --locked --release --package smithers-ffi --bin smithers-jj-export"
      )
      // The rest of the report still runs.
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "node" })]))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  // A registry that cannot discover flows dies while the control host's stores
  // are still opening. The failure must reach the operator as the discovery
  // error, not as the interruption of the stores it cut short (#1924).
  it.each([["flow", "list"], ["runs", "list"]])(
    "`%s %s` names a flows root discovery cannot read",
    (...verb) => {
      const cwd = stageEmptyProject()
      const home = mkdtempSync(join(tmpdir(), "smithers-helper-home-"))
      try {
        const environment = { ...withoutSeats(), SMITHERS_HOME: home }
        // A flows root that is a file cannot be scanned.
        mkdirSync(join(cwd, ".smithers"))
        writeFileSync(join(cwd, ".smithers", "flows"), "not a directory\n")
        // Observing verbs open the host only over an existing store.
        mkdirSync(join(cwd, ".flows"), { recursive: true })
        new DatabaseSync(join(cwd, ".flows", "control.db")).close()
        const result = smithers(cwd, [...verb, "--format", "json"], environment)
        expect(result.status).toBe(1)
        const output = result.stdout + result.stderr
        expect(output).not.toContain("All fibers interrupted")
      } finally {
        rmSync(cwd, { recursive: true, force: true })
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it("writes a seat the host can resolve, chosen from the provider environment", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = { ...withoutSeats(), OPENAI_API_KEY: "sk-not-used-by-init" }

      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)

      const flow = readFileSync(join(cwd, ".smithers", "flows", "hello", "flow.ts"), "utf8")
      expect(flow).toContain("model: \"openai:gpt-6-sol\"")
      expect(flow).toContain("Credentials stay in the environment.")
      expect(flow).not.toContain(environment.OPENAI_API_KEY)
      expect(flow).not.toContain("sk-not-used-by-init")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("settles a missing-seat launch as failed and names its credential", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = withoutSeats()
      const initialized = smithers(cwd, ["init", "hello", "--json"], environment)
      expect(initialized.status).toBe(0)
      expect(readFileSync(join(cwd, ".smithers", "flows", "hello", "flow.ts"), "utf8"))
        .toContain("model: \"anthropic:claude-sonnet-4-5\"")

      const launched = smithers(cwd, ["up", "hello", "--json"], environment)

      expect(launched.status).toBe(1)
      expect(JSON.parse(launched.stdout)).toMatchObject({
        status: "failed",
        cause: "Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat"
      })
      expect(launched.stderr).toBe("")

      // Admission commits before the executor is consulted (df753aff66), so
      // a refused launch keeps its run and receipt and settles the run as
      // failed: an ended row, not an ownerless one waiting to be reclaimed.
      const listed = smithers(cwd, ["ps", "--json"], environment)
      expect(listed.status).toBe(0)
      const runs = (JSON.parse(listed.stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      expect(runs).toEqual([expect.objectContaining({ flowId: "hello", status: "failed" })])
      // The native module resolves its seat at dispatch. Both engine rows
      // settle failed; neither remains available for a recovery sweep.
      const engine = engineRuns(cwd)
      expect(engine).toHaveLength(2)
      expect(engine.every((run) => run.status === "failed")).toBe(true)

      // `--older-than 0s` is refused, because "delete everything" wearing the
      // spelling of a retention policy is the flag's most destructive value.
      // A sweep therefore has to name a real window and wait it out.
      const refused = smithers(cwd, ["gc", "--older-than", "0s", "--dry-run", "--json"], environment)
      expect(refused.status).toBe(2)
      expect(JSON.parse(refused.stdout).message).toContain("--older-than must be a duration")
      waitOut(1_100)
      const swept = smithers(cwd, ["gc", "--older-than", "1s", "--dry-run", "--json"], environment)
      expect(swept.status).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("is not claimed or re-driven by a later executor boot", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = withoutSeats()
      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
      expect(smithers(cwd, ["up", "hello", "--json"], environment).status).toBe(1)
      const initial = JSON.parse(smithers(cwd, ["ps", "--json"], environment).stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }
      // The refused launch keeps its admission as a failed run (df753aff66).
      expect(initial.items).toEqual([expect.objectContaining({ status: "failed" })])
      const refused = initial.items[0]!.runId
      const initialEngine = engineRuns(cwd)
      expect(initialEngine).toHaveLength(2)
      expect(initialEngine.every((run) => run.status === "failed")).toBe(true)

      // A second `smithers` over the same `.flows` composes its own executor,
      // exactly as every local verb does, and sweeps for stale rows as it
      // boots.
      const second = smithers(cwd, ["up", "hello", "--json"], environment)
      expect(second.status).toBe(1)

      const laterEngine = engineRuns(cwd)
      expect(laterEngine).toHaveLength(4)
      expect(laterEngine.every((run) => run.status === "failed")).toBe(true)
      expect(laterEngine.filter((run) => initialEngine.some((before) => before.runId === run.runId))).toEqual(
        initialEngine
      )
      const runs = (JSON.parse(smithers(cwd, ["ps", "--json"], environment).stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      // The boot left the first failed run failed, and the second launch was
      // refused as its own run under a new key.
      expect(runs.map((run) => run.status)).toEqual(["failed", "failed"])
      expect(runs.filter((run) => run.runId === refused)).toEqual([expect.objectContaining({ status: "failed" })])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The same two commands against a funded seat.
 *
 * This is the claim `smthrs init`'s own doc comment makes: "`smthrs up
 * <name>` works in the directory `init` just created". The only way to
 * hold it is to run the scaffolded prompt on a real provider. It costs a real
 * agent run of three to four minutes, so it runs only where the ChatGPT seat
 * the CLI suite already stages is actually signed in: export
 * `SMITHERS_LIVE_MODEL_TESTS=1 SMITHERS_OPENAI_AUTH=chatgpt` after
 * `codex login --device-auth` to take it.
 */
const chatgptSeat = process.env["SMITHERS_LIVE_MODEL_TESTS"] === "1" &&
  process.env["SMITHERS_OPENAI_AUTH"] === "chatgpt" && (() => {
    const status = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 10_000 })
    return status.status === 0 && /Logged in using ChatGPT/i.test(`${status.stdout}${status.stderr}`)
  })()

describe.skipIf(!chatgptSeat)("the smthrs init scaffold on a funded seat", { timeout: 900_000 }, () => {
  it("runs to completed, from `init` to a terminal row in both databases", () => {
    const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    // A real repository, not a bare `.git` directory: the engine snapshots the
    // workspace through `jj`, which refuses a directory that looks like a git
    // repository and is not one.
    expect(spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" }).status).toBe(0)
    try {
      const environment = { ...process.env } as Record<string, string>
      const initialized = spawnNodeSync([
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        "init",
        "hello",
        "--json"
      ], {
        cwd,
        encoding: "utf8",
        timeout: 600_000,
        env: environment
      })
      expect(initialized.status).toBe(0)
      expect((JSON.parse(initialized.stdout) as { readonly seat: string }).seat).toBe("openai:gpt-6-sol")

      const launched = spawnNodeSync([
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        "up",
        "hello",
        "--json"
      ], {
        cwd,
        encoding: "utf8",
        timeout: 800_000,
        env: environment
      })

      expect(launched.status).toBe(0)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId
      for (const database of ["control.db", "engine.db"]) {
        const handle = new DatabaseSync(join(cwd, ".flows", database), { readOnly: true })
        try {
          const row = handle.prepare(
            "SELECT status, finished_at_ms FROM flows_runs WHERE run_id = ?"
          ).get(runId) as unknown as { status: string; finished_at_ms: number | null }
          expect(row.status, database).toBe("completed")
          expect(row.finished_at_ms, database).not.toBeNull()
        } finally {
          handle.close()
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
