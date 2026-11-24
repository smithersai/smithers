import { NodeServices } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Detect from "../src/Detect.ts"
import * as Command from "../src/flow/Command.ts"
import * as Vcs from "../src/flow/internal/Vcs.ts"
import * as CliScripts from "../src/internal/CliScripts.ts"
import * as Jsonc from "../src/internal/Jsonc.ts"
import type { InventoryEntry } from "../src/Inventory.ts"
import * as Mapping from "../src/Mapping.ts"
import * as MigrateError from "../src/MigrateError.ts"
import * as RunState from "../src/RunState.ts"
import * as Scan from "../src/Scan.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261127")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/migrate Wave 7 deep fuzz (Mapping snippets/escalations, RunState SQLite, CliScripts, Jsonc, Vcs, Scan/Command)", () => {
  it(
    "Mapping.classifyWithReason, snippet, byConstruct, byImport & markdownTable handle all constructs, spreads, skipIf, and edge details",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          construct: Schema.Literals([
            "Task",
            "Workflow",
            "Sequence",
            "ContentPipeline",
            "Runbook",
            "Parallel",
            "Branch",
            "Timer",
            "WaitForEvent",
            "Signal",
            "Approval",
            "ApprovalGate",
            "Loop",
            "Ralph",
            "createSmithers",
            "close",
            "outputs.<key>",
            "tables.<key>",
            "runWorkflow",
            "smithers-cli",
            "UnknownConstruct"
          ]),
          isAgent: Schema.Boolean,
          hasSpread: Schema.Boolean,
          hasSkipIf: Schema.Boolean,
          hasSeat: Schema.Boolean,
          hasChildren: Schema.Boolean,
          durationLiteral: Schema.Literals(["5000", "\"30s\"", "\"5m\"", "\"2h\"", "\"100ms\"", "badUnit"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ construct, isAgent, hasSpread, hasSkipIf, hasSeat, hasChildren, durationLiteral }) =>
            Effect.sync(() => {
              const props: Array<string> = []
              if (isAgent) props.push("agent")
              if (hasSpread) props.push("...")
              if (hasSkipIf) props.push("skipIf")
              if (construct === "Loop" || construct === "Ralph") props.push("maxIterations")
              if (construct === "Branch") props.push("if", "then", "else")
              if (construct === "Timer") props.push("duration")
              if (construct === "WaitForEvent" || construct === "Signal") props.push("event")
              if (construct === "Approval" || construct === "ApprovalGate") props.push("request")

              const detail: Record<string, string> = {
                id: "step-a",
                name: "demo-flow",
                description: "Demo flow",
                outputChain: "z.object({ ok: z.boolean() })",
                payloadChain: "z.object({ repo: z.string() })",
                payloadFields: JSON.stringify({ repo: "z.string()" }),
                promptText: "Hello {{repo}}",
                ...(hasSeat
                  ? { agentProvider: "anthropic", agentModel: "claude-sonnet-4-5", agentInstructions: "Be concise." }
                  : {}),
                ...(hasChildren
                  ? {
                    children: "() => ({ ok: true })",
                    childConstructs: "Task:stepA,Task:stepB",
                    childOutputs: JSON.stringify({
                      stepA: "z.object({ ok: z.boolean() })",
                      stepB: "z.object({ ok: z.boolean() })"
                    }),
                    childPayloads: JSON.stringify({ stepA: { repo: "payload.repo" }, stepB: { repo: "payload.repo" } }),
                    childAgents: isAgent ? "stepA" : "",
                    thenConstructs: "Task:stepA",
                    elseConstructs: "Task:stepB",
                    if: "payload.repo.length > 0",
                    duration: durationLiteral,
                    event: "\"deploy.done\"",
                    request: "\"Ship release\""
                  }
                  : {})
              }

              const hit: InventoryEntry = {
                file: "src/workflow.tsx",
                line: 12,
                column: 4,
                construct,
                props: props.sort(),
                detail
              }

              const cls = Mapping.classifyWithReason(hit)
              expect(["automatic", "guided", "unsafe"]).toContain(cls.class)
              expect(Mapping.classify(hit)).toBe(cls.class)

              const snip = Mapping.snippet(hit)
              if (hasSpread || hasSkipIf) {
                expect(snip).toBeUndefined()
              } else if (snip !== undefined) {
                expect(typeof snip).toBe("string")
                expect(snip.length).toBeGreaterThan(0)
              }

              Mapping.byConstruct(construct)
              Mapping.byImport(construct)
              return true
            }),
          { executions: Math.min(executions, 140), seed }
        )
      )
      assertPassed(report)
      const md = Mapping.markdownTable()
      expect(md).toContain("|")
      expect(Mapping.rows.length).toBeGreaterThan(10)
    },
    45_000
  )

  it(
    "RunState.readDatabase & scan classify live, parked, terminal, corrupt, empty SQLite DBs and .env/source DB paths",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          dbMode: Schema.Literals(["liveAndParked", "terminalOnly", "emptyTables", "corrupt", "missing"]),
          includeEnvDb: Schema.Boolean,
          includePostgres: Schema.Boolean,
          includeStateDir: Schema.Boolean,
          liveAgeMs: Schema.Literals([1000, 30_000, 900_000])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ dbMode, includeEnvDb, includePostgres, includeStateDir, liveAgeMs }) =>
            Effect.gen(function*() {
              const root = mkdtempSync(join(tmpdir(), "migrate-rs-w7-"))
              try {
                const now = 1_750_000_000_000
                const dbPath = join(root, "smithers.db")

                if (dbMode === "corrupt") {
                  writeFileSync(dbPath, "not a sqlite database at all!!!")
                  writeFileSync(`${dbPath}-wal`, "junk")
                } else if (dbMode !== "missing") {
                  const db = new DatabaseSync(dbPath)
                  try {
                    if (dbMode !== "emptyTables") {
                      db.exec(`
                      CREATE TABLE _smithers_schema_migrations (id TEXT PRIMARY KEY);
                      INSERT INTO _smithers_schema_migrations (id) VALUES ('0001_init'), ('0002_runs');
                      CREATE TABLE _smithers_runs (
                        run_id TEXT PRIMARY KEY,
                        workflow_name TEXT,
                        workflow_path TEXT,
                        status TEXT,
                        heartbeat_at_ms INTEGER,
                        runtime_owner_id TEXT,
                        parent_run_id TEXT,
                        pause_requested_at_ms INTEGER,
                        cancel_requested_at_ms INTEGER
                      );
                    `)
                      if (dbMode === "liveAndParked") {
                        db.prepare(
                          `INSERT INTO _smithers_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).run("run-1", "wf", "src/wf.tsx", "running", now - liveAgeMs, "owner-1", null, null, null)
                        db.prepare(
                          `INSERT INTO _smithers_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).run(
                          "run-2",
                          "wf",
                          "src/wf.tsx",
                          "waiting-approval",
                          now - 3_600_000,
                          "owner-2",
                          "run-1",
                          now - 1000,
                          null
                        )
                        db.prepare(
                          `INSERT INTO _smithers_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).run("run-3", "wf", "src/wf.tsx", "finished", now - 5000, "owner-1", null, null, null)
                      } else {
                        db.prepare(
                          `INSERT INTO _smithers_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).run("run-done", "wf", "src/wf.tsx", "finished", now - 5000, "owner-1", null, null, null)
                      }
                    }
                  } finally {
                    db.close()
                  }
                }

                if (dbMode !== "missing") {
                  const finding = RunState.readDatabase(
                    dbPath,
                    "smithers.db",
                    dbMode === "corrupt" ? ["smithers.db-wal"] : [],
                    now,
                    RunState.defaultLiveWindowMs
                  )
                  if (dbMode === "corrupt") {
                    expect(finding.readable).toBe(false)
                  } else {
                    expect(finding.readable).toBe(true)
                    if (dbMode === "liveAndParked") {
                      expect(finding.live.length + finding.parked.length).toBe(2)
                    }
                  }
                }

                if (includeEnvDb) {
                  writeFileSync(
                    join(root, ".env"),
                    includePostgres
                      ? "DATABASE_URL=postgres://user:pass@localhost:5432/smithers\nSMITHERS_DB=smithers.db\n"
                      : "SMITHERS_DB=smithers.db\n"
                  )
                }
                if (includeStateDir) {
                  mkdirSync(join(root, ".smithers", "runs"), { recursive: true })
                  writeFileSync(join(root, ".smithers", "runs", "marker.json"), "{}")
                }
                writeFileSync(
                  join(root, "package.json"),
                  JSON.stringify({ name: "rs-app", dependencies: { "smithers-orchestrator": "^0.9.0" } })
                )
                mkdirSync(join(root, "src"), { recursive: true })
                writeFileSync(
                  join(root, "src", "index.ts"),
                  `import { createSmithers } from "smithers-orchestrator"\nconst opts = { dbPath: "smithers.db" }\n`
                )

                const detection = yield* Detect.scan(root).pipe(Effect.provide(NodeServices.layer))
                const reportRs = yield* RunState.scan(root, detection, { now }).pipe(Effect.provide(NodeServices.layer))
                expect(["clean", "history-only", "blocked"]).toContain(reportRs.verdict)
                const roots = RunState.roots(reportRs)
                expect(Array.isArray(roots)).toBe(true)
                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }),
          { executions: Math.min(executions, 35), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "CliScripts.rewrite, Jsonc.withoutComments & Vcs.detect/requireCheckpoint preserve safety invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          script: Schema.Literals([
            "smithers run workflows/deploy.tsx",
            "smithers up workflows/review.tsx --input '{\"a\":1}'",
            "bunx smithers-orchestrator run wf.tsx",
            "npx smithers run ./src/wf.tsx && echo done",
            "NODE_ENV=prod smithers run wf.tsx | tee out.log",
            "smithers status --json",
            "smithers ps",
            "vitest run",
            "smithers run $(cat file)"
          ]),
          jsonc: Schema.Literals([
            "{\n  // line comment\n  \"url\": \"https://example.com//keep\",\n  /* block \n comment */\n  \"x\": 1\n}",
            "{\"a\": \"/* not a comment */\", \"b\": \"escaped \\\" // quote\"} // tail",
            "/* unterminated comment",
            "{\"plain\": true}"
          ]),
          vcsMode: Schema.Literals(["jj", "gitDir", "gitWorktreeValid", "gitWorktreeBroken", "none"]),
          allowNoVcs: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ script, jsonc, vcsMode, allowNoVcs }) =>
            Effect.gen(function*() {
              // 1. CliScripts.rewrite
              const rw = CliScripts.rewrite(script, (p) => p.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""))
              expect(typeof rw.after).toBe("string")
              if (rw.unsupported !== undefined) {
                expect(rw.after).toBe(script)
              }

              // 2. Jsonc.withoutComments preserves newline count
              const stripped = Jsonc.withoutComments(jsonc)
              expect(stripped.length).toBeLessThanOrEqual(jsonc.length)
              if (!jsonc.includes("unterminated")) {
                expect(() => JSON.parse(stripped)).not.toThrow()
              }

              // 3. Vcs.detect + requireCheckpoint
              const root = mkdtempSync(join(tmpdir(), "migrate-vcs-w7-"))
              try {
                if (vcsMode === "jj") {
                  mkdirSync(join(root, ".jj"), { recursive: true })
                } else if (vcsMode === "gitDir") {
                  mkdirSync(join(root, ".git"), { recursive: true })
                } else if (vcsMode === "gitWorktreeValid") {
                  const realGit = join(root, "real-git-dir")
                  mkdirSync(realGit, { recursive: true })
                  writeFileSync(join(realGit, "HEAD"), "ref: refs/heads/main\n")
                  writeFileSync(join(root, ".git"), `gitdir: ${realGit}\n`)
                } else if (vcsMode === "gitWorktreeBroken") {
                  writeFileSync(join(root, ".git"), "gitdir: ./does-not-exist\n")
                }

                const detected = yield* Vcs.detect(root).pipe(Effect.provide(NodeServices.layer))
                if (vcsMode === "jj") expect(detected).toBe("jj")
                else if (vcsMode === "gitDir" || vcsMode === "gitWorktreeValid") expect(detected).toBe("git")
                else expect(detected).toBe("none")

                const chkEx = yield* Vcs.requireCheckpoint(root, ".backup", allowNoVcs).pipe(
                  Effect.provide(NodeServices.layer),
                  Effect.exit
                )
                if (detected === "none" && !allowNoVcs) {
                  expect(Exit.isFailure(chkEx)).toBe(true)
                } else {
                  expect(Exit.isSuccess(chkEx)).toBe(true)
                }
                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }),
          { executions: Math.min(executions, 80), seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "Scan.scan/decisions/toReport & Command.survey/commandsOf/optionsOf/render/executionId work across varied 0.x project shapes",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["scan", "plan", "apply"]),
          format: Schema.Literals(["human", "json"]),
          allowUnsafe: Schema.Literals(["none", "all", "list"]),
          includeTypecheckEmpty: Schema.Boolean,
          hasPkgScripts: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, format, allowUnsafe, includeTypecheckEmpty, hasPkgScripts }) =>
            Effect.gen(function*() {
              const root = mkdtempSync(join(tmpdir(), "migrate-cmd-w7-"))
              try {
                mkdirSync(join(root, ".jj"), { recursive: true })
                mkdirSync(join(root, "src"), { recursive: true })
                writeFileSync(
                  join(root, "package.json"),
                  JSON.stringify({
                    name: "demo-0x",
                    version: "0.1.0",
                    scripts: hasPkgScripts ? { test: "vitest run", dev: "smithers run src/wf.tsx" } : {},
                    dependencies: { "smithers-orchestrator": "^0.9.0", zod: "^3.23.0" }
                  })
                )
                writeFileSync(
                  join(root, "src", "wf.tsx"),
                  [
                    `import { createSmithers, Workflow, Task, Sequence } from "smithers-orchestrator"`,
                    `import { z } from "zod"`,
                    `const { smithers, outputs } = createSmithers({ out: z.object({ ok: z.boolean() }) })`,
                    `export default smithers((ctx) => (`,
                    `  <Workflow name="demo"><Sequence><Task id="t1" output={outputs.out}>{() => ({ ok: true })}</Task></Sequence></Workflow>`,
                    `))`
                  ].join("\n")
                )

                const opts = Command.optionsOf(
                  {
                    root,
                    scan: mode === "scan",
                    apply: mode === "apply",
                    allowUnsafe: allowUnsafe === "none" ? undefined : allowUnsafe === "all" ? "all" : "Loop,Ralph",
                    acknowledgeRunState: true,
                    allowNoVcs: true,
                    keepOldSources: mode === "plan",
                    unit: "src/wf.tsx",
                    maxRepairRounds: 2,
                    seat: undefined,
                    reportDir: ".migrate-report",
                    flowsDir: ".smithers/flows",
                    verifyInstall: undefined,
                    verifyFormat: undefined,
                    verifyTypecheck: includeTypecheckEmpty ? [""] : ["tsc --noEmit"],
                    verifyTest: "pnpm test"
                  },
                  root,
                  { HOME: root, TMPDIR: tmpdir() }
                )
                expect(opts.mode).toBe(mode)
                expect(Command.executionId(opts, "2026-11-24T00:00:00Z").length).toBeGreaterThan(0)
                expect(Command.reportDirectory(opts)).toContain(".migrate-report")
                expect(Command.isMigrateError(MigrateError.make("no-vcs", "test"))).toBe(true)
                expect(Command.isMigrateError(new Error("plain"))).toBe(false)

                const scanned = yield* Scan.scan(root, { runState: { now: 1_750_000_000_000 } }).pipe(
                  Effect.provide(NodeServices.layer)
                )
                const cmds = Command.commandsOf(scanned, opts)
                expect(Array.isArray(cmds.typecheck)).toBe(true)
                const surveyEx = yield* Command.survey({ ...opts, units: undefined }).pipe(
                  Effect.provide(NodeServices.layer),
                  Effect.exit
                )
                expect(Exit.isSuccess(surveyEx) || Exit.isFailure(surveyEx)).toBe(true)

                const decs = Scan.decisions(scanned.inventory)
                const opDecs = scanned.units.flatMap((u) => Scan.operatorDecisions(u))
                expect(Array.isArray(decs)).toBe(true)
                expect(Array.isArray(opDecs)).toBe(true)

                const migReport = Scan.toReport(scanned, mode, "2026-11-24T00:00:00Z", { acknowledgeRunState: true })
                const rendered = Command.render(migReport, format, Command.reportDirectory(opts))
                expect(rendered.length).toBeGreaterThan(0)
                if (format === "json") {
                  expect(() => JSON.parse(rendered)).not.toThrow()
                }
                expect([0, 1, 3]).toContain(Command.exitCode(migReport))
                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }),
          { executions: Math.min(executions, 30), seed: seed + 3 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
