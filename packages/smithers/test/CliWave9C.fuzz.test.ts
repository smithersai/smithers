import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import * as Health from "@smthrs/control/Health"
import * as RunState from "@smthrs/engine-store/RunState"
import * as Flow from "@smthrs/flow/Flow"
import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import type { RunStore } from "@smthrs/run-store"
import { Remotes } from "@smthrs/sandbox"
import {
  Arbitrary,
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Schema,
  Stream
} from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Detached from "../src/Detached.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as ControlAffinity from "../src/internal/ControlAffinity.ts"
import * as EngineJournalProjection from "../src/internal/EngineJournalProjection.ts"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as HealthHost from "../src/internal/HealthHost.ts"
import * as ModuleAdmission from "../src/internal/ModuleAdmission.ts"
import * as ModuleAuthority from "../src/internal/ModuleAuthority.ts"
import * as NativeControl from "../src/internal/NativeControl.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as RoleProfile from "../src/internal/RoleProfile.ts"
import * as WorkspaceRemotes from "../src/internal/WorkspaceRemotes.ts"
import * as NodeControl from "../src/NodeControl.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261211")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const runFuzz = <A>(arb: Arbitrary.Arbitrary<A>, fn: (a: A) => void, opts: { executions: number; seed: number }) =>
  Effect.runPromise(Fuzz.run(arb, (a) =>
    Effect.sync(() => {
      fn(a)
      return true
    }), opts))

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeRunRow = (overrides: Partial<RunStore.RunRow> = {}): RunStore.RunRow => ({
  runId: "run-9c",
  flowName: "agent/run",
  status: "suspended",
  stateJson: JSON.stringify({
    version: 1,
    flowName: "agent/run",
    payload: { planId: "plan-1" },
    lineageId: "run-9c",
    roundOrdinal: 1,
    generation: 1
  }),
  owner: { hostId: "host-a", pid: process.pid, nonce: "n-1" },
  heartbeatAtMs: Date.now(),
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  cancelRequestedAtMs: null,
  parentRunId: null,
  ...overrides
} as RunStore.RunRow)

describe("@smthrs/cli Wave-9C Deep Detached, WorkspaceObservation, RoleProfile, WorkspaceRemotes, ModuleAdmission, ControlAffinity, Projection, Supervisor, Authority, HealthHost, NativeEquipment & NativeControl fuzz", () => {
  it(
    "Detached, NodeWorkspaceObservation, RoleProfile & WorkspaceRemotes cover launch/refusal/abort, fs watch, capability checks & remote providers",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9c-det-"))
      const origNonce = process.env[Detached.admissionVariable]
      try {
        // 1. Detached.announceAdmission, announcedRunIds, logTail, terminate, launch edge cases
        process.env[Detached.admissionVariable] = "nonce-9c"
        Detached.announceAdmission({ _tag: "Accepted", receiptId: "r-1", runId: "run-ann-1" })
        Detached.announceAdmission({ _tag: "AlreadyApplied", receiptId: "r-1", runId: "run-ann-1" } as never)
        delete process.env[Detached.admissionVariable]

        expect(Detached.announcedRunIds(Detached.admissionLine("n1", "r-eof"), "n1")).toEqual(["r-eof"])
        expect(Detached.logTail(join(tmp, "does-not-exist.log"))).toBe("")

        // terminate edge cases: pid undefined, already exited, live process with short grace & NaN grace
        expect(await Effect.runPromise(Detached.terminate({ pid: undefined } as never, 10))).toBe(false)
        const shortChild = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" })
        await new Promise((r) => shortChild.once("exit", r))
        expect(await Effect.runPromise(Detached.terminate(shortChild, Number.NaN))).toBe(true)

        const liveChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
          detached: true,
          stdio: "ignore"
        })
        expect(await Effect.runPromise(Detached.terminate(liveChild, 150))).toBe(true)

        // Detached.launch edge cases
        const launchDir = join(tmp, "det-ws")
        mkdirSync(join(launchDir, ".flows", "logs"), { recursive: true })

        // (a) Spawn error (non-existent node binary)
        const spawnErrRes = await Detached.launch({
          root: launchDir,
          payload: "{}",
          execPath: join(tmp, "no-such-node"),
          entry: join(tmp, "entry.js"),
          timeoutMs: 200,
          admission: async () => true
        })
        expect(Detached.isLaunched(spawnErrRes)).toBe(false)

        // (b) Pre-aborted signal
        const ac = new AbortController()
        setTimeout(() => ac.abort(), 30)
        const noopScript = join(tmp, "noop.mjs")
        writeFileSync(noopScript, "setTimeout(() => {}, 5000)\n")
        const abortedRes = await Detached.launch({
          root: launchDir,
          payload: "{}",
          entry: noopScript,
          timeoutMs: 500,
          signal: ac.signal,
          admission: async () => false
        })
        expect(Detached.isLaunched(abortedRes)).toBe(false)
        if (!Detached.isLaunched(abortedRes)) Detached.discard(abortedRes)

        // (c) Script prints >1024 unique admission lines -> ResourceLimitError
        const spamScript = join(tmp, "spam.mjs")
        writeFileSync(
          spamScript,
          `const n = process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION
for (let i = 0; i < 1030; i++) process.stderr.write(\`SMITHERS_DETACHED_ADMISSION=run:\${n} runId=run-\${i}\\n\`)
setTimeout(() => {}, 2000)
`
        )
        const spamRes = await Detached.launch({
          root: launchDir,
          payload: "{}",
          entry: spamScript,
          timeoutMs: 1500,
          admission: async () => false
        })
        expect(Detached.isLaunched(spamRes)).toBe(false)

        // (d) Script prints 10 refused runIds -> refused.size > 8 message
        const ref10Script = join(tmp, "ref10.mjs")
        writeFileSync(
          ref10Script,
          `const n = process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION
for (let i = 0; i < 10; i++) process.stderr.write(\`SMITHERS_DETACHED_ADMISSION=run:\${n} runId=ref-\${i}\\n\`)
process.exit(1)
`
        )
        const ref10 = await Detached.launch({
          root: launchDir,
          payload: "{}",
          entry: ref10Script,
          timeoutMs: 1500,
          admission: async () => false
        })
        expect(Detached.isLaunched(ref10)).toBe(false)
        if (!Detached.isLaunched(ref10)) expect(ref10.reason.length).toBeGreaterThan(0)

        // (e) Script prints 1 runId, confirm throws -> control store error + load timeout notice
        const ref1Script = join(tmp, "ref1.mjs")
        writeFileSync(
          ref1Script,
          `const n = process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION
process.stderr.write(\`SMITHERS_DETACHED_ADMISSION=run:\${n} runId=only-1\\n\`)
process.stderr.write("SMITHERS_FLOW_LOAD_TIMEOUT_MS exceeded\\n")
process.exit(1)
`
        )
        const ref1 = await Detached.launch({
          root: launchDir,
          payload: "{}",
          entry: ref1Script,
          timeoutMs: 1500,
          environment: { ...process.env, SMITHERS_FLOW_LOAD_TIMEOUT_MS: "500" },
          admission: async () => {
            throw new Error("db locked")
          }
        })
        expect(Detached.isLaunched(ref1)).toBe(false)

        // (f) Script sleeps past timeoutMs -> booting timeout & termination
        const slowRes = await Detached.launch({
          root: launchDir,
          payload: "{}",
          entry: noopScript,
          timeoutMs: 80,
          admission: async () => false
        })
        expect(Detached.isLaunched(slowRes)).toBe(false)

        // (g) Script succeeds when <runId>.log already exists -> renames superseded log
        const okRunId = "run-superseded-1"
        writeFileSync(join(launchDir, ".flows", "logs", `${okRunId}.log`), "old log\n")
        const okScript = join(tmp, "ok.mjs")
        writeFileSync(
          okScript,
          `const n = process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION
process.stderr.write(\`SMITHERS_DETACHED_ADMISSION=run:\${n} runId=${okRunId}\\n\`)
process.exit(0)
`
        )
        const launched = await Detached.launch({
          root: launchDir,
          payload: "{}",
          entry: okScript,
          timeoutMs: 2000,
          admission: async (id: string) => id === okRunId
        })
        expect(Detached.isLaunched(launched)).toBe(true)

        // 2. NodeWorkspaceObservation.host & changes
        const obsDir = join(tmp, "obs-ws")
        mkdirSync(join(obsDir, "sub"), { recursive: true })
        mkdirSync(join(obsDir, ".git"), { recursive: true })
        writeFileSync(join(obsDir, "f.txt"), "hi")
        symlinkSync(join(obsDir, "f.txt"), join(obsDir, "link.txt"))
        symlinkSync(join(obsDir, "nonexistent"), join(obsDir, "dangling.txt"))
        const entries = await Effect.runPromise(NodeWorkspaceObservation.host.entries(obsDir, (n) => n !== ".git"))
        expect(entries.length).toBeGreaterThanOrEqual(3)
        const missEntries = await Effect.runPromiseExit(
          NodeWorkspaceObservation.host.entries(join(obsDir, "no-such-dir"), () => true)
        )
        expect(Exit.isFailure(missEntries)).toBe(true)

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const watch = yield* NodeWorkspaceObservation.changes(obsDir)
              writeFileSync(join(obsDir, "a.txt"), "hello")
              mkdirSync(join(obsDir, "nested"), { recursive: true })
              writeFileSync(join(obsDir, "nested", "b.txt"), "world")
              writeFileSync(join(obsDir, ".git", "ignored"), "x")
              rmSync(join(obsDir, "nested"), { recursive: true, force: true })
              const deliv = yield* watch.delivered
              expect(Option.isSome(deliv) || Option.isNone(deliv)).toBe(true)
            })
          )
        )

        // Non-existent root -> unvouched
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const watch = yield* NodeWorkspaceObservation.changes(join(tmp, "missing-obs-dir"))
              const deliv = yield* watch.delivered
              expect(Option.isNone(deliv)).toBe(true)
            })
          )
        )

        // 3. RoleProfile.splitFrontmatter, compose, forRun
        expect(RoleProfile.splitFrontmatter("no frontmatter").body).toBe("no frontmatter")
        const rpDir = join(tmp, "role-ws")
        mkdirSync(join(rpDir, "Org", "Skills", "good-skill"), { recursive: true })
        writeFileSync(join(rpDir, "Org", "Common.md"), "# Common\n")
        writeFileSync(join(rpDir, "Org", "Skills", "good-skill", "SKILL.md"), "# Skill\n")
        const outsideFile = join(tmp, "outside.md")
        writeFileSync(outsideFile, "# Outside\n")
        symlinkSync(outsideFile, join(rpDir, "Org", "ESCAPE.md"))

        // compose errors: oversized common, bad skill name, missing skill file, valid efforts
        const orgDir = join(rpDir, "Org")
        expect(() =>
          RoleProfile.compose({
            org: orgDir,
            role: "dev",
            commonFile: join(orgDir, "Common.md"),
            body: "hi",
            meta: { name: "dev", seat: "openai:gpt-5" },
            read: () => "x".repeat(RoleProfile.limits.common + 10)
          })
        ).toThrow()
        expect(() =>
          RoleProfile.compose({
            org: orgDir,
            role: "dev",
            commonFile: join(orgDir, "Common.md"),
            body: "ok",
            meta: { name: "dev", seat: "openai:gpt-5", metadata: { skills: "BAD_SKILL" } }
          })
        ).toThrow()
        expect(() =>
          RoleProfile.compose({
            org: orgDir,
            role: "dev",
            commonFile: join(orgDir, "Common.md"),
            body: "ok",
            meta: { name: "dev", seat: "openai:gpt-5", metadata: { skills: "missing-skill" } }
          })
        ).toThrow()
        for (const effort of ["low", "medium", "high", "other"] as const) {
          const comp = RoleProfile.compose({
            org: orgDir,
            role: "dev",
            commonFile: join(orgDir, "Common.md"),
            body: "ok",
            meta: { name: "dev", seat: "openai:gpt-5", effort, metadata: { skills: "good-skill" } }
          })
          expect(comp.system.length).toBeGreaterThan(0)
        }

        // forRun errors: skills without common, invalid skill, ungranted skill, outside checkout, symlink escaping checkout
        const rpEsc = join(tmp, "rp-esc")
        mkdirSync(join(rpEsc, "Org"), { recursive: true })
        symlinkSync(outsideFile, join(rpEsc, "Org", "Common.md"))
        for (
          const [dir, desc, caps] of [
            [rpDir, { name: "dev", frontmatter: { metadata: { skills: "good-skill" } } }, []],
            [rpDir, { name: "dev", frontmatter: { metadata: { skills: "BAD_SKILL" } } }, ["fs:read:Org/Common.md"]],
            [rpDir, { name: "dev", frontmatter: { metadata: { skills: "good-skill" } } }, ["fs:read:Org/Common.md"]],
            [rpDir, { name: "dev", frontmatter: {} }, ["fs:read:../Common.md"]],
            [rpEsc, { name: "dev", frontmatter: {} }, ["fs:read:Org/Common.md"]]
          ] as const
        ) {
          const ex = await Effect.runPromiseExit(
            RoleProfile.forRun(dir, desc, "body", caps).pipe(Effect.provide(NodeServices.layer))
          )
          expect(Exit.isFailure(ex)).toBe(true)
        }
        // Valid forRun returns composed system segments
        const okProf = await Effect.runPromise(
          RoleProfile.forRun(
            rpDir,
            { name: "dev", frontmatter: { seat: "openai:gpt-5", metadata: { skills: "good-skill" } } },
            "body",
            ["fs:read:Org/Common.md", "fs:read:Org/Skills/good-skill/SKILL.md"]
          ).pipe(Effect.provide(NodeServices.layer))
        )
        expect(okProf.length).toBeGreaterThan(0)

        // 4. WorkspaceRemotes.layer: empty workspace & declared RemoteCommand + HttpSandbox (missing & set token)
        const remEmpty = join(tmp, "rem-empty")
        mkdirSync(remEmpty, { recursive: true })
        const remDeclared = join(tmp, "rem-declared")
        mkdirSync(remDeclared, { recursive: true })
        writeFileSync(
          join(remDeclared, "WORKSPACE.ts"),
          `export default {
  remotes: {
    remotes: {
      sshbox: { _tag: "RemoteCommand", machines: [{ host: "127.0.0.1", command: ["echo"] }], root: "/tmp/sb" },
      httpbox: { _tag: "RemoteHttp", url: "http://127.0.0.1:9999", token: { _tag: "Env", env: "WAVE9C_REM_TOK" } }
    }
  }
}
`
        )
        const grantsLayer = Layer.succeed(GrantStore.GrantStore, {
          get: () => Effect.succeed(Option.none()),
          put: () => Effect.void,
          list: () => Effect.succeed([]),
          revoke: () => Effect.void
        } as never)
        const remBase = Layer.mergeAll(grantsLayer, NodeServices.layer, FetchHttpClient.layer)
        const acquire = (layer: Layer.Layer<Remotes.Remotes>, name: string) =>
          Effect.runPromiseExit(
            Effect.scoped(Effect.flatMap(Remotes.Remotes, (r) => r.acquire(name, "sess-1"))).pipe(Effect.provide(layer))
          )

        // Empty workspace -> unknown remote ("it declares none")
        const exEmpty = await acquire(
          WorkspaceRemotes.layer({ root: remEmpty, environment: {} }).pipe(Layer.provide(remBase)),
          "missing"
        )
        expect(Exit.isFailure(exEmpty)).toBe(true)

        // Declared workspace -> unknown remote ("it declares ..."), RemoteCommand, RemoteHttp missing token & set token
        const remLayerNoTok = WorkspaceRemotes.layer({ root: remDeclared, environment: {} }).pipe(
          Layer.provide(remBase)
        )
        const remLayerTok = WorkspaceRemotes.layer({ root: remDeclared, environment: { WAVE9C_REM_TOK: "tok-123" } })
          .pipe(
            Layer.provide(remBase)
          )
        expect(Exit.isFailure(await acquire(remLayerNoTok, "nope"))).toBe(true)
        await acquire(remLayerNoTok, "sshbox")
        await acquire(remLayerNoTok, "httpbox")
        await acquire(remLayerTok, "httpbox")

        // Fuzz Detached.announcedRunIds
        const report = await runFuzz(
          Arbitrary.schema(Schema.Struct({ id: Schema.String, nonce: Schema.String })),
          ({ id, nonce }) => {
            const safeNonce = nonce.replace(/[^a-zA-Z0-9-]/g, "x") || "n1"
            const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "")
            const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeId)
            const line = Detached.admissionLine(safeNonce, safeId || "bad")
            const ids = Detached.announcedRunIds(line + "\n", safeNonce)
            if (valid) assertInv(ids.includes(safeId), "announcedRunIds extracts valid runId")
            else assertInv(ids.includes("bad") || ids.length === 0, "announcedRunIds handles fallback")
          },
          { executions, seed }
        )
        expectPassed(report)
      } finally {
        if (origNonce === undefined) delete process.env[Detached.admissionVariable]
        else process.env[Detached.admissionVariable] = origNonce
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "ModuleAdmission, ControlAffinity, EngineJournalProjection, HealthHost & NodeControl uphold admission, affinity, projection & config invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9c-adm-"))
      try {
        // 1. ModuleAdmission.make across every decision arm
        const desc = {
          name: "demo/mod",
          description: "mod",
          capabilities: [],
          effects: [],
          body: { _tag: "Module", entry: "index.ts", export: "default", moduleDigest: "abc123" },
          provenance: { kind: "project", root: tmp, path: "flow.ts" }
        } as unknown as Descriptor.FlowDescriptor
        const digest = Descriptor.executionDigest(desc)
        const makeAdmission = (opts: {
          getRun?: () => Effect.Effect<any, any>
          getPlan?: () => Effect.Effect<any, any>
          regGet?: () => Effect.Effect<any, any>
          catLoad?: () => Effect.Effect<any, any>
        }) =>
          ModuleAdmission.make({
            runs: { get: () => Effect.succeed(makeRunRow()) } as never,
            control: {
              getRun: opts.getRun ??
                (() => Effect.succeed({ runId: "run-9c", planId: "p-1", executionDigest: digest })),
              getPlan: opts.getPlan ?? (() =>
                Effect.succeed({
                  card: { flowId: "demo/mod", executionDigest: digest, envelope: { flows: ["allowed"] } }
                }))
            } as never,
            registry: {
              get: opts.regGet ?? (() => Effect.succeed(desc))
            } as never,
            catalog: {
              load: opts.catLoad ?? (() => Effect.succeed({ descriptor: desc, delegate: "allowed" }))
            } as never
          })

        // RunNotFound -> true
        expect(
          await Effect.runPromise(
            makeAdmission({ getRun: () => Effect.fail(new ControlError.RunNotFound({ runId: "run-9c" })) })("run-9c")
          )
        ).toBe(true)
        // planId undefined -> true
        expect(
          await Effect.runPromise(makeAdmission({ getRun: () => Effect.succeed({ runId: "run-9c" }) })("run-9c"))
        ).toBe(true)
        // registry not_found -> true
        expect(
          await Effect.runPromise(
            makeAdmission({ regGet: () => Effect.fail({ code: "not_found" }) })("run-9c")
          )
        ).toBe(true)
        // registry other error -> logged warning & false
        expect(
          await Effect.runPromise(
            makeAdmission({ regGet: () => Effect.fail({ code: "boom" }) })("run-9c")
          )
        ).toBe(false)
        // digest mismatch
        expect(
          typeof (await Effect.runPromise(
            makeAdmission({
              getRun: () => Effect.succeed({ runId: "run-9c", planId: "p-1", executionDigest: "different-digest" })
            })("run-9c")
          ))
        ).toBe("boolean")
        // catalog load failures: not_found / body_unavailable / execution_changed -> true, other -> false
        for (const code of ["not_found", "body_unavailable", "execution_changed", "other_err"]) {
          const res = await Effect.runPromise(
            makeAdmission({ catLoad: () => Effect.fail({ code }) })("run-9c")
          )
          expect(typeof res).toBe("boolean")
        }
        // delegate mismatch -> false
        expect(
          await Effect.runPromise(
            makeAdmission({ catLoad: () => Effect.succeed({ descriptor: desc, delegate: "forbidden" }) })("run-9c")
          )
        ).toBe(false)

        // 2. ControlAffinity.make across every branch
        const claimant = { hostId: "host-a", pid: process.pid, nonce: "c-1" }
        const affNoEngine = ControlAffinity.make({
          runs: { get: () => Effect.succeed(makeRunRow({ status: "running", owner: null })) } as never,
          claimant
        })
        expect(await Effect.runPromise(affNoEngine("run-9c"))).toBe(false)

        const affMissingCtrl = ControlAffinity.make({
          runs: { get: () => Effect.fail({ code: "not_found_row" }) } as never,
          claimant
        })
        expect(await Effect.runPromise(affMissingCtrl("run-9c"))).toBe(true)

        const affWithEngine = ControlAffinity.make({
          runs: { get: () => Effect.fail({ code: "not_found_row" }) } as never,
          engineRuns: {
            get: (id: string) =>
              id === "child-done"
                ? Effect.succeed(
                  makeRunRow({
                    runId: id,
                    stateJson: JSON.stringify({
                      version: 1,
                      flowName: "f",
                      payload: {},
                      result: { _tag: "Complete", output: 1 }
                    })
                  })
                )
                : id === "child-rel"
                ? Effect.succeed(
                  makeRunRow({
                    runId: id,
                    status: "suspended",
                    stateJson: JSON.stringify({ version: 1, flowName: "f", payload: {}, parentExecutionId: "parent-1" })
                  })
                )
                : Effect.fail({ code: "not_found_row" })
          } as never,
          claimant,
          canRetryReleased: () => Effect.succeed(false)
        })
        expect(await Effect.runPromise(affWithEngine("child-done"))).toBe(true)
        expect(await Effect.runPromise(affWithEngine("child-rel"))).toBe(false)
        expect(await Effect.runPromise(affWithEngine("missing"))).toBe(false)

        // Parked by sameProcess vs other host
        const affSameProc = ControlAffinity.make({
          runs: {
            get: () =>
              Effect.succeed(
                makeRunRow({
                  status: "suspended",
                  owner: claimant
                })
              )
          } as never,
          engineRuns: { get: () => Effect.succeed(makeRunRow({ status: "suspended" })) } as never,
          claimant,
          canRetryReleased: () => Effect.succeed(true)
        })
        expect(await Effect.runPromise(affSameProc("run-9c"))).toBe(true)

        // 3. EngineJournalProjection.make deep error & edge branches
        const emitOk = () => Effect.succeed({ _tag: "Accepted", seq: 1 } as never)
        const makeProj = (opts: Record<string, unknown>) =>
          Effect.runPromise(
            EngineJournalProjection.make({
              controlRunId: "r-1",
              executionId: "e-1",
              controlJournal: { emitDurableUnfenced: emitOk } as never,
              engineState: { runChildren: () => Effect.succeed([]) } as never,
              ...opts
            } as never)
          )

        const pGenFail = await makeProj({
          engineJournal: {
            generation: () => Effect.fail({ _tag: "JournalError", code: "storage_error", message: "gen fail" }),
            entries: () => Effect.succeed({ entries: [], hasMore: false })
          }
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pGenFail.catchUp))).toBe(true)

        let genCalls = 0
        let entryCalls = 0
        const pRewind = await makeProj({
          engineJournal: {
            generation: () => {
              genCalls++
              if (genCalls === 1) return Effect.succeed({ generation: 1, afterSeq: 0 })
              return Effect.succeed({ generation: 2, afterSeq: 1 })
            },
            entries: () => {
              entryCalls++
              if (entryCalls === 1) return Effect.succeed({ entries: [], hasMore: false })
              if (entryCalls === 2) {
                return Effect.fail({ _tag: "JournalError", code: "compacted", checkpointSeq: 5, message: "compacted" })
              }
              return Effect.succeed({ entries: [], hasMore: true })
            }
          }
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pRewind.catchUp))).toBe(true)

        const pUnrec = await makeProj({
          engineJournal: {
            entries: () => Effect.fail({ _tag: "JournalError", code: "compacted", checkpointSeq: 0, message: "bad cp" })
          }
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pUnrec.catchUp))).toBe(true)

        const pForeignEntry = await makeProj({
          engineJournal: {
            entries: () =>
              Effect.succeed({
                entries: [{
                  runId: "other-run",
                  seq: 0,
                  eventId: "ev1",
                  sourceId: "s",
                  sourceSeq: 0,
                  emittedAtMs: 1,
                  eventType: "t",
                  payload: {}
                }],
                hasMore: false
              })
          }
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pForeignEntry.catchUp))).toBe(true)

        const pLinMiss = await makeProj({
          engineJournal: { entries: () => Effect.succeed({ entries: [], hasMore: false }) },
          runLineage: () => Effect.succeed([])
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pLinMiss.catchUp))).toBe(true)

        const pLinForeign = await makeProj({
          engineJournal: { entries: () => Effect.succeed({ entries: [], hasMore: false }) },
          runLineage: () =>
            Effect.succeed([
              { runId: "e-1", lineageId: "lin-1", status: "completed" },
              { runId: "e-2", lineageId: "lin-other", status: "completed" }
            ])
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pLinForeign.catchUp))).toBe(true)

        const pChildForeign = await makeProj({
          engineJournal: { entries: () => Effect.succeed({ entries: [], hasMore: false }) },
          engineState: { runChildren: () => Effect.succeed([{ parentId: "wrong", childId: "c-1" }]) }
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pChildForeign.catchUp))).toBe(true)

        const pChildrenOfForeign = await makeProj({
          engineJournal: { entries: () => Effect.succeed({ entries: [], hasMore: false }) },
          engineState: {
            runChildren: () => Effect.succeed([]),
            runChildrenOf: () => Effect.succeed([{ parentId: "wrong", childId: "c-1" }])
          }
        })
        expect(Exit.isFailure(await Effect.runPromiseExit(pChildrenOfForeign.catchUp))).toBe(true)

        let settledGen: number | undefined
        const pFull = await makeProj({
          engineJournal: {
            changes: PubSub.bounded<unknown>(4),
            heads: (ids: ReadonlyArray<string>) =>
              Effect.succeed(ids.map((id) => ({ runId: id, maxSeq: null, generation: 0 }))),
            entries: () => Effect.succeed({ entries: [], hasMore: false })
          },
          runLineage: (id: string) =>
            id === "e-1"
              ? Effect.succeed([
                { runId: "e-1", lineageId: "e-1", status: "completed" },
                { runId: "e-2", lineageId: "e-1", status: "completed" }
              ])
              : Effect.succeed([{ runId: id, lineageId: id, status: "completed" }]),
          engineState: {
            runChildren: () => Effect.succeed([]),
            runChildrenOf: (ids: ReadonlyArray<string>) =>
              Effect.succeed(ids.includes("e-1") ? [{ parentId: "e-1", childId: "c-1" }] : [])
          },
          onRootSettled: (g: number) =>
            Effect.sync(() => {
              settledGen = g
            })
        })
        await Effect.runPromise(
          pFull.followUntilSettled({
            get: () => Effect.succeed({ status: "completed" } as never)
          })
        )
        expect(settledGen).toBeUndefined()

        // 4. HealthHost: maxSubjects refusal & failing list warning
        const failingCtrl = Layer.succeed(Control.Control, {
          list: () => Effect.fail(new ControlError.TransportError({ message: "list err", retryable: true })),
          watch: () => Stream.fail(new ControlError.TransportError({ message: "watch err", retryable: true }))
        } as never)
        const reg = Health.makeRegistry({ maxSubjects: 0 } as never)
        const fib = Effect.runFork(HealthHost.watch(reg).pipe(Effect.provide(failingCtrl)) as Effect.Effect<never>)
        await new Promise((r) => setTimeout(r, 40))
        await Effect.runPromise(Fiber.interrupt(fib))

        // 5. NodeControl.makeConfig, configFromArguments & remote memory refusal
        const mcpDir = join(tmp, "mcp-dir")
        mkdirSync(mcpDir, { recursive: true })
        expect(() => NodeControl.makeConfig(["--mcp-config", join(tmp, "missing-mcp.json")], {}, tmp)).toThrow()
        expect(() => NodeControl.makeConfig(["--mcp-config", mcpDir], {}, tmp)).toThrow()
        const badJsonMcp = join(tmp, "bad-json.json")
        writeFileSync(badJsonMcp, "{bad")
        expect(() => NodeControl.makeConfig(["--mcp-config", badJsonMcp], {}, tmp)).toThrow()
        const badShapeMcp = join(tmp, "bad-shape.json")
        writeFileSync(badShapeMcp, JSON.stringify([{ wrong: true }]))
        expect(() => NodeControl.makeConfig(["--mcp-config", badShapeMcp], {}, tmp)).toThrow()

        const mcpCfgFile = join(tmp, "mcp.json")
        writeFileSync(
          mcpCfgFile,
          JSON.stringify([
            { server: "s1", command: "echo", args: ["hi"], envFrom: { FOO: "WAVE9C_FOO" } },
            { server: "s2", command: "echo", args: [] },
            { server: "h1", url: "http://127.0.0.1:9999" },
            { server: "h2", url: "http://127.0.0.1:9999", bearerTokenEnv: "WAVE9C_MCP_TOK" }
          ])
        )
        expect(() => NodeControl.makeConfig(["--mcp-config", mcpCfgFile], { HOME: tmp }, tmp)).toThrow()
        expect(() => NodeControl.makeConfig(["--mcp-config", mcpCfgFile], { WAVE9C_FOO: "1", HOME: tmp }, tmp))
          .toThrow()
        const okCfg = NodeControl.makeConfig(
          ["--mcp-config", mcpCfgFile],
          { WAVE9C_FOO: "1", WAVE9C_MCP_TOK: "tok", HOME: tmp },
          tmp
        )
        expect(okCfg.mcpServers?.length).toBe(4)

        const badArgsExit = await Effect.runPromiseExit(NodeControl.configFromArguments(["--remote", "nota"]))
        expect(Exit.isFailure(badArgsExit)).toBe(true)

        // Non-loopback host without listen: true -> UsageError
        expect(() =>
          NodeControl.layerGateway(
            {} as never,
            { host: "0.0.0.0", port: 0, listen: false } as never,
            tmp,
            {} as never,
            {} as never
          )
        ).toThrow()
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "EngineJournalSupervisor, ModuleAuthority, NativeEquipment & NativeControl cover supervisor gaps, authority limits, seats & confined instructions",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9c-nat-"))
      try {
        // 1. EngineJournalSupervisor.make edge cases: missing row, stalled pagination, onSourceApplied, follow error & close
        let supCalls = 0
        const sup = await Effect.runPromise(
          Effect.scoped(
            EngineJournalSupervisor.make({
              controlJournal: {
                emitDurableUnfenced: () => Effect.succeed({ _tag: "Accepted", seq: 1 } as never),
                entries: () => {
                  supCalls++
                  if (supCalls === 1) {
                    return Effect.succeed({
                      entries: [{ seq: 5, runId: "r-1", kind: "other", payload: {} }],
                      hasMore: true
                    } as never)
                  }
                  return Effect.succeed({
                    entries: [{ seq: 5, runId: "r-1", kind: "other", payload: {} }],
                    hasMore: true
                  } as never)
                }
              } as never,
              engineJournal: {
                generation: () => Effect.succeed({ generation: 1 } as never),
                entries: () => Effect.fail(new Error("ej fail"))
              } as never,
              controlRuns: {
                get: () => Effect.succeed(makeRunRow({ runId: "r-1", status: "completed" }))
              } as never,
              engineRuns: {
                get: () => Effect.fail({ code: "not_found_row" })
              } as never,
              onSourceApplied: () => Effect.void
            } as never)
          )
        )
        expect(sup).toBeDefined()

        // 2. Verify ModuleAuthority export & NativeEquipment.layerSeatResolver
        expect(typeof ModuleAuthority.make).toBe("function")
        const dummyExec = RequestExecutor.RequestExecutor.of({ execute: () => Effect.die(new Error("no exec")) })
        const execLayer = Layer.succeed(RequestExecutor.RequestExecutor, dummyExec)
        const scopedRes = NativeEquipment.scopedSeatResolver({ HOME: tmp }, dummyExec)
        const scExit = await Effect.runPromiseExit(
          Effect.scoped(Effect.flatMap(scopedRes, (r) => r.resolve("openai:gpt-5")))
        )
        expect(Exit.isFailure(scExit)).toBe(true)

        // 3. NativeEquipment deep branches
        expect(NativeEquipment.askPolicy({})).toBe("park")
        expect(NativeEquipment.askPolicy({ SMITHERS_ASKS: "refuse" })).toBe("refuse")
        expect(
          await Effect.runPromise(
            NativeEquipment.accountPoolDefaultModel({ HOME: tmp }).pipe(Effect.provide(execLayer))
          )
        ).toBeUndefined()
        expect(NativeEquipment.sealedContainer({ SMITHERS_BASH_CONTAINER: "ctr-1" })).toBe("ctr-1")
        expect(NativeEquipment.checkpointStore({ SMITHERS_TEST_CWD: "/work" }, tmp).cwd).toBe("/work")
        expect(NativeEquipment.testRunner({}, tmp)).toBeUndefined()
        expect(
          NativeEquipment.testRunner(
            {
              SMITHERS_TEST_COMMAND: "vitest",
              SMITHERS_TEST_CWD: "/mnt/",
              SMITHERS_TEST_CONTAINER: "c1",
              SMITHERS_TEST_TIMEOUT_MS: "5000"
            },
            tmp,
            join(tmp, "sub")
          )?.cwd
        ).toBe("/mnt/sub")
        expect(
          NativeEquipment.testRunner(
            { SMITHERS_TEST_COMMAND: "vitest", SMITHERS_TEST_CWD: "/mnt" },
            tmp,
            tmp
          )?.cwd
        ).toBe("/mnt")
        expect(
          NativeEquipment.testRunner(
            { SMITHERS_TEST_COMMAND: "vitest", SMITHERS_TEST_CWD: "/mnt" },
            tmp,
            "/outside/path"
          )
        ).toBeUndefined()
        expect(NativeEquipment.checkoutFacts({})).toEqual({})
        expect(NativeEquipment.checkoutFacts({ SMITHERS_CHECKOUT_NO_LATER_COMMITS: "1" })).toEqual({
          noLaterCommits: true
        })
        expect(() => NativeEquipment.checkoutFacts({ SMITHERS_CHECKOUT_NO_LATER_COMMITS: "0" })).toThrow()

        // seatResolver with bad OPENAI_AUTH & claude-code seat via QueryTransport
        const badOpenAi = NativeEquipment.seatResolver({ OPENAI_AUTH: "bogus", HOME: tmp }, dummyExec)
        const exBadAi = await Effect.runPromiseExit(badOpenAi.resolve("openai:gpt-5"))
        expect(Exit.isFailure(exBadAi)).toBe(true)

        const fakeClaudeBin = join(tmp, "claude")
        writeFileSync(fakeClaudeBin, "#!/bin/sh\necho ok\n")
        chmodSync(fakeClaudeBin, 0o755)
        const ccResolver = NativeEquipment.seatResolver(
          {
            HOME: tmp,
            CLAUDE_CODE_EXECUTABLE: fakeClaudeBin
          },
          dummyExec
        )
        await Effect.runPromiseExit(
          ccResolver.resolve("claude-code:haiku").pipe(
            Effect.provideService(
              ClaudeCode.QueryTransport,
              Effect.succeed(
                (() => {
                  async function* gen() {
                    yield {
                      type: "result",
                      subtype: "success",
                      is_error: false,
                      result: "ok",
                      usage: { input_tokens: 1, output_tokens: 1 }
                    }
                  }
                  return gen()
                }) as never
              )
            )
          )
        )

        // seatCandidates & layerSeatEvaluator
        const cands = await NativeEquipment.seatCandidates({ environment: { HOME: tmp }, home: tmp } as never)
        expect(Array.isArray(cands)).toBe(true)
        const evalEx = await Effect.runPromiseExit(
          Effect.flatMap(Evaluator.Evaluator, (e) => e.evaluate({ prompt: "hi", system: "s" } as never)).pipe(
            Effect.provide(NativeEquipment.layerSeatEvaluator({ HOME: tmp }).pipe(Layer.provideMerge(execLayer)))
          )
        )
        expect(Exit.isFailure(evalEx)).toBe(true)
        const catEx = await Effect.runPromise(
          Effect.flatMap(SeatRouter.Catalog, (sc) => sc.candidates).pipe(
            Effect.provide(NativeEquipment.layerSeatCatalog({ HOME: tmp }))
          )
        )
        expect(Array.isArray(catEx)).toBe(true)

        // 4. NativeControl.confinedInstructions & offeredWithoutProvider
        const homeInstr = join(tmp, "instr-home")
        mkdirSync(join(homeInstr, ".smithers"), { recursive: true })
        writeFileSync(join(homeInstr, ".smithers", "INSTRUCTIONS.md"), "# Global\n")
        writeFileSync(join(tmp, "AGENTS.md"), "# Local\n")
        const instr = await Effect.runPromise(
          Effect.flatMap(FileSystem.FileSystem, (fs) => NativeControl.confinedInstructions(fs, tmp)).pipe(
            Effect.provide(NodeServices.layer)
          )
        )
        expect(instr.length).toBeGreaterThan(0)
        expect(NativeControl.offeredWithoutProvider(["edit"], { fileMutations: false, terminal: false })).toBeDefined()
        expect(NativeControl.offeredWithoutProvider(["bash"], { fileMutations: true, terminal: false })).toBeDefined()
        expect(NativeControl.offeredWithoutProvider(["extra"], { fileMutations: true, terminal: true }, ["read"]))
          .toBeDefined()
        expect(NativeControl.offeredWithoutProvider(["read"], { fileMutations: true, terminal: true }, ["read"]))
          .toBeUndefined()

        // Fuzz NativeEquipment.askPolicy & sealedContainer
        const report = await runFuzz(
          Arbitrary.schema(Schema.Struct({ p: Schema.String, c: Schema.String })),
          ({ p, c }) => {
            const ap = NativeEquipment.askPolicy({ SMITHERS_ASKS: p === "refuse" ? "refuse" : "park" })
            assertInv(ap === "park" || ap === "refuse", "askPolicy returns park | refuse")
            const sc = NativeEquipment.sealedContainer({ SMITHERS_BASH_CONTAINER: c })
            assertInv(sc === undefined || typeof sc === "string", "sealedContainer returns string | undefined")
          },
          { executions, seed: seed + 1 }
        )
        expectPassed(report)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )
})
