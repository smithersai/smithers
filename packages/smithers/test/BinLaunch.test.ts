/** Real executable contracts, scheduled in the bounded CLI worker pool. */
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  launch,
  packageRoot,
  processBudget,
  refusal,
  run,
  scriptedHost,
  shim,
  stageCanonicalUnservableSeat,
  stageUnservableSeat
} from "./support/bin.ts"
import { spawnNodeSync } from "./support/node-child.ts"

describe("an attached launch's exit status", processBudget, () => {
  it("the installed bin door preserves up failure and terminal cancel status", () => {
    const cwd = stageUnservableSeat()
    rmSync(join(cwd, ".smithers", "flows", "failing", "flow.mdx"))
    writeFileSync(
      join(cwd, ".smithers", "flows", "failing", "flow.ts"),
      readFileSync(new URL("./fixtures/bin-failing/flow.ts", import.meta.url))
    )
    symlinkSync(join(packageRoot, "node_modules"), join(cwd, "node_modules"), "dir")
    const invoke = (...args: Array<string>) =>
      spawnNodeSync([
        "--no-warnings",
        "--import",
        scriptedHost,
        shim,
        ...args,
        "--root",
        cwd,
        "--json"
      ], {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        env: {
          ...process.env,
          HOME: cwd,
          SMITHERS_OPENAI_AUTH: "chatgpt",
          CODEX_HOME: join(cwd, "codex"),
          PATH: `${join(cwd, "codex")}:${process.env.PATH ?? ""}`
        }
      })
    try {
      const failed = invoke("up", "failing")
      expect(failed.error).toBeUndefined()
      expect(failed.status, failed.stderr).toBe(1)
      expect(failed.stdout, failed.stderr).not.toBe("")
      const receipt = JSON.parse(failed.stdout)
      expect(receipt.status).toBe("failed")
      const db = new DatabaseSync(join(cwd, ".flows", "control.db"))
      try {
        const row = db.prepare("SELECT state_json FROM flows_runs WHERE run_id=?").get(receipt.runId)!
        const state = { ...JSON.parse(String(row.state_json)), runId: "terminal-cancelled", status: "cancelled" }
        db.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES(?, 'cancelled', ?, ?)")
          .run(state.runId, Date.now(), JSON.stringify(state))
      } finally {
        db.close()
      }
      // A terminal receipt needs no driver; pin its process status at the bin boundary.
      const cancelled = invoke("runs", "cancel", "terminal-cancelled")
      expect(cancelled.error).toBeUndefined()
      expect(cancelled.status, cancelled.stderr).toBe(130)
      expect(JSON.parse(cancelled.stdout)).toMatchObject({ _tag: "Terminal", status: "cancelled" })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
  it("exits 1 for a run that settled failed, and still prints the receipt", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json", "--verbose"])

      expect(launched.stdout, launched.stderr).not.toBe("")
      expect(launched.error).toBeUndefined()
      expect(launched.status).toBe(1)
      // The `--json` contract does not move: stdout is one document, the
      // launch receipt, and `runId` is the only place a caller learns the run.
      // The run's own lifecycle warnings are diagnostics and belong on stderr;
      // written to stdout they land inside the document a pipeline parses.
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      const receipt = JSON.parse(launched.stdout) as { readonly runId?: unknown }
      expect(receipt.runId).toMatch(/^run-/)
      expect(launched.stderr).toContain("An agent run failed")

      // And the status the exit code claims is the status the control plane
      // recorded, read back by a second process.
      const listed = launch(cwd, ["ps", "--json"])
      expect(listed.status).toBe(0)
      const runs = (JSON.parse(listed.stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      expect(runs.find((entry) => entry.runId === receipt.runId)?.status).toBe("failed")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * The failed body settles the run itself, and the engine then re-surfaces the
   * same failure to the driver. A second terminal write lost the claim and
   * logged a settlement error for a status that was already recorded (#3262).
   */
  it("settles a failed launch with one terminal write and no settlement error", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      expect(launched.stderr).not.toContain("ClaimLost")
      expect(launched.stderr).not.toContain("A terminal control status could not be written")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * One refusal is one operator line.
   *
   * The billing refusal in the release validation printed two WARN stacks for one
   * failure (observation N1): the run's own `An agent run failed`, and
   * `engine-store: the settlement of agent/run could not be encoded through
   * its own codec`. The second is not a second failure. It fires because the
   * `agent/run` flow declares `error: Schema.Unknown` and the body fails with
   * an `Error` instance, which is not a JSON value, so EVERY agent failure
   * degraded its durable settlement into a projection and told the operator
   * about it in a second stack trace. The cause is the same one the first line
   * already named.
   */
  it("prints one operator-facing warning for one refusal", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json", "--verbose"])

      expect(launched.error, launched.stderr).toBeUndefined()
      expect(launched.status).toBe(1)
      const warnings = launched.stderr.split("\n").filter((line) => line.includes("WARN"))

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("An agent run failed")
      expect(launched.stderr).not.toContain("could not be encoded through its own codec")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * The same refusal from a canonical `Flow.make` + `AgentAction` flow (#3118).
   * Its root and its action's child both settle, and a wake queued before
   * that settlement drains after the scoped handler is gone: it must not be
   * reported as parked work for an unregistered flow, nor may the body's
   * failure be written to the control run twice.
   */
  it("prints one operator-facing warning for one canonical agent refusal", () => {
    const cwd = stageCanonicalUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json", "--verbose"])

      expect(launched.error, launched.stderr).toBeUndefined()
      expect(launched.status, launched.stderr).toBe(1)
      const warnings = launched.stderr.split("\n").filter((line) => line.includes("WARN"))
      expect(warnings, launched.stderr).toHaveLength(1)
      expect(warnings[0]).toContain("An agent run failed")
      expect(launched.stderr).not.toContain("which is not registered in this process")
      expect(launched.stderr).not.toContain("could not start on the engine")
      expect(launched.stderr).not.toContain("A terminal control status could not be written")
      expect(launched.stderr).not.toContain("could not be encoded through its own codec")
      expect(launched.stderr.split("\n").filter((line) => line.includes("ERROR"))).toEqual([])

      const engine = new DatabaseSync(join(cwd, ".flows", "engine.db"), { readOnly: true })
      try {
        const rows = engine.prepare(
          "SELECT status FROM flows_runs WHERE json_extract(state_json, '$.flowName') IS NOT 'smithers/health/Discovery'"
        ).all() as unknown as ReadonlyArray<
          { readonly status: string }
        >
        expect(rows).toHaveLength(2)
        expect(rows.map((row) => row.status)).toEqual(["failed", "failed"])
      } finally {
        engine.close()
      }
      const control = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
      try {
        const failures = control.prepare(
          "SELECT run_id FROM flows_journal_events WHERE event_type = 'control.run.failed'"
        ).all()
        expect(failures).toEqual([{ run_id: (JSON.parse(launched.stdout) as { readonly runId: string }).runId }])
      } finally {
        control.close()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /** Every run decision the engine journal holds for a run, in order. */
  const engineDecisions = (cwd: string, runId: string): ReadonlyArray<string> => {
    const handle = new DatabaseSync(join(cwd, ".flows", "engine.db"), { readOnly: true })
    try {
      return (handle.prepare(
        "SELECT payload_json FROM flows_journal_events WHERE run_id = ? " +
          "AND event_type = 'flows.engine.run-decision' ORDER BY seq"
      ).all(runId) as unknown as ReadonlyArray<{ readonly payload_json: string }>)
        .map((row) => String((JSON.parse(row.payload_json) as { decision?: unknown }).decision))
    } finally {
      handle.close()
    }
  }

  /** One run's engine row, as the next process finds it. */
  const engineRun = (cwd: string, runId: string): { status: string; finished_at_ms: number | null } | undefined => {
    const handle = new DatabaseSync(join(cwd, ".flows", "engine.db"), { readOnly: true })
    try {
      return handle.prepare(
        "SELECT status, finished_at_ms FROM flows_runs WHERE run_id = ?"
      ).get(runId) as unknown as { status: string; finished_at_ms: number | null } | undefined
    } finally {
      handle.close()
    }
  }

  /** How many turns the control journal recorded for a run. */
  const turnsOpened = (cwd: string, runId: string): number => {
    const handle = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
    try {
      return (handle.prepare(
        "SELECT COUNT(*) AS turns FROM flows_journal_events WHERE run_id = ? " +
          "AND event_type = 'control.agent.turn-opened'"
      ).get(runId) as unknown as { readonly turns: number }).turns
    } finally {
      handle.close()
    }
  }

  /**
   * What the launching process leaves in `engine.db` when it exits.
   *
   * The control settlement and the engine's terminal write are two writes, and
   * this process returns on the first. In the release validation it then closed its
   * scope and interrupted its own executor 10 to 14 ms before the second one
   * landed, leaving the row `suspended`/`released`; every later process that
   * composed an executor claimed that row and re-drove the run. The pin is at
   * the process boundary because the promise is about what is on disk after
   * the process is gone.
   */
  it("leaves a terminal engine row behind, with no interrupt-released decision", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId

      const row = engineRun(cwd, runId)
      expect(row?.status).toBe("failed")
      expect(row?.finished_at_ms).not.toBeNull()
      expect(engineDecisions(cwd, runId)).not.toContain("interrupt-released")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("is not claimed, re-driven, or re-opened by the next process over the same project", () => {
    const cwd = stageUnservableSeat()
    try {
      const first = launch(cwd, ["up", "failing", "--json"])
      expect(first.status).toBe(1)
      const runId = (JSON.parse(first.stdout) as { readonly runId: string }).runId
      const decisions = engineDecisions(cwd, runId)
      const turns = turnsOpened(cwd, runId)

      // A second `smithers` over the same `.flows`, which composes its own
      // executor exactly as every local verb does.
      const second = launch(cwd, ["up", "failing", "--json"])
      expect(second.status).toBe(1)
      expect((JSON.parse(second.stdout) as { readonly runId: string }).runId).not.toBe(runId)

      expect(engineDecisions(cwd, runId)).toEqual(decisions)
      expect(decisions).not.toContain("stolen-and-activated")
      expect(turnsOpened(cwd, runId)).toBe(turns)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * `run --resume` against a run that has already settled.
   *
   * `Control.resume` answers `{"_tag":"Terminal","runId":...,"status":...}`
   * and there is no settlement event left to wait for, so the verb reported
   * nothing and exited 0 for a run its own document called `failed`.
   */
  it("exits 1 from `run --resume` against a run that already settled failed", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId

      const resumed = launch(cwd, ["run", "--resume", runId, "--json"])

      expect(resumed.status).toBe(1)
      expect(JSON.parse(resumed.stdout)).toMatchObject({ _tag: "Terminal", runId, status: "failed" })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * The `--json` stdout contract for the verb the smoke caught breaking it.
   *
   * `smthrs up hello -d --json` wrote 1773 bytes to stdout and none to
   * stderr: a runtime `WARN` block first and the receipt last, so a pipeline
   * parsing the document read a syntax error. `bin.ts` provides
   * `Logger.LogToStderr` for exactly that; this holds the detached shape to it.
   */
  it("writes one JSON document and nothing else to stdout when detached", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "-d", "--json"])

      expect(launched.status).toBe(0)
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      const receipt = JSON.parse(launched.stdout) as { readonly detached?: unknown; readonly runId?: unknown }
      expect(receipt.detached).toBe(true)
      expect(receipt.runId).toMatch(/^run-/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("exits 1 from `run` too, which is the same attached launch", () => {
    const cwd = stageUnservableSeat()
    try {
      const planned = launch(cwd, ["plan", "failing", "--json"])
      expect(planned.status).toBe(0)
      const approval = JSON.stringify(
        (JSON.parse(planned.stdout) as { readonly approval: unknown }).approval
      )
      expect(launch(cwd, ["approve", approval, "--scope", "run", "--json"]).status).toBe(0)

      const launched = launch(cwd, ["run", approval, "--json"])

      expect(launched.status).toBe(1)
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      expect((JSON.parse(launched.stdout) as { readonly runId?: unknown }).runId).toMatch(/^run-/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The project `smthrs init` scaffolds, launched exactly as it was written.
 *
 * The release rehearsal ran the two commands the scaffold's own
 * doc comment promises: `smthrs init hello`, then `smthrs up hello` in
 * that directory. It got exit 1 with `Run run-1 was accepted but the
 * executor did not take it`, a `control.db` row still `accepted` under
 * `ownerId {pid: 0}`, an `engine.db` with no row at all, and
 * `smthrs status run-1` answering forever. Only `smthrs cancel` ended it.
 *
 * Nothing here stubs the seat: the scaffold is generated by the real binary
 * and launched by the real binary over real SQLite files.
 */

/**
 * What `smthrs signal` tells an operator when the run is parked on something
 * else.
 *
 * The release validation ran `smthrs signal run-3 '{"name":"go", ...}'` against a
 * run parked on a 150 second timer. It exited 1 with `go: ` on stderr: the
 * refusal declared a `name` field, which shadows `Error.prototype.name`, and
 * declared no message, so `bin.ts` `report` printed the operator's own word
 * followed by nothing (defect D3).
 *
 * The park is written onto the two databases rather than driven, because
 * parking a real run needs a model turn and this host has no provider. The
 * rows are the ones a timer park leaves: `suspended` with `waiting_reason`
 * `timer` and a deadline still ahead, on both the engine row and the control
 * summary.
 */
describe("smthrs signal against a run parked on something else", processBudget, () => {
  const parkOnTimer = (cwd: string, runId: string): void => {
    const wakeAtMs = Date.now() + 150_000
    const engine = new DatabaseSync(join(cwd, ".flows", "engine.db"))
    try {
      engine.prepare(
        `UPDATE flows_runs SET status = 'suspended', waiting_reason = 'timer', waiting_wake_at_ms = ?,
           finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
           heartbeat_at_ms = NULL, claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL,
           claimed_at_ms = NULL, state_json = json_remove(state_json, '$.result')
         WHERE run_id = ?`
      ).run(wakeAtMs, runId)
    } finally {
      engine.close()
    }
    const control = new DatabaseSync(join(cwd, ".flows", "control.db"))
    try {
      // The control run's status lives in the summary document, which is what
      // `SqlControlRuntime.getRun` parses, and the two spellings differ: the
      // column carries the run store's `suspended`, the document carries the
      // control status `parked` that store status maps to (SqlControlRuntime's
      // status table). Writing `suspended` into the document produced a
      // summary the control runtime refuses to decode.
      control.prepare(
        `UPDATE flows_runs SET status = 'suspended', waiting_reason = 'timer', waiting_wake_at_ms = ?,
           finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
           heartbeat_at_ms = NULL, state_json = json_set(state_json, '$.status', 'parked')
         WHERE run_id = ?`
      ).run(wakeAtMs, runId)
    } finally {
      control.close()
    }
  }

  it("names the refusal and says what is open, instead of echoing the signal's name", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId
      parkOnTimer(cwd, runId)

      const signalled = launch(cwd, ["runs", "signal", runId, JSON.stringify({ name: "go", payload: {} }), "--json"])

      expect(signalled.status).toBe(1)
      const error = JSON.parse(signalled.stdout)
      expect(error.code).toBe("NoMatchingWait")
      expect(error.message).toBe(
        `no wait point named "go" is open on run ${runId}. ` +
          `Read \`smthrs runs show ${runId}\` to see what that run is waiting for.`
      )
      expect(signalled.stderr).toBe("")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
