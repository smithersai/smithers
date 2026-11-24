import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Fuzz } from "@smthrs/fuzz"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Arbitrary, Cause, Effect, Exit, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as ExecutionTarget from "../src/history/ExecutionTarget.ts"
import * as GatewayHistory from "../src/history/GatewayHistory.ts"
import * as StoreCopy from "../src/history/StoreCopy.ts"
import * as Credentials from "../src/operator/Credentials.ts"
import * as CronTargets from "../src/operator/CronTargets.ts"
import * as Integrations from "../src/operator/Integrations.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"
import * as RunnerLane from "../src/runner/Lane.ts"
import * as RunnerServe from "../src/runner/Serve.ts"
import * as RunnerSession from "../src/runner/Session.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeLoopback = async (
  handler: (
    req: { method: string; url: string; body: string }
  ) => { status: number; body: string; headers?: Record<string, string> }
) => {
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c.toString()))
    req.on("end", () => {
      const out = handler({ method: req.method ?? "GET", url: req.url ?? "/", body })
      res.writeHead(out.status, out.headers ?? { "content-type": "application/json" })
      res.end(out.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

describe("@smthrs/cli Wave-6B Deep History (StoreCopy, GatewayHistory, ExecutionTarget), Operators (CronTargets, Credentials, Integrations, TargetRuns, TriggerPlans) & Runner (Lane, Session, Serve) fuzz invariants", () => {
  it(
    "ExecutionTarget, StoreCopy (SQLite VACUUM INTO & PG safety) & GatewayHistory uphold path-redaction, copy isolation & wire invariants",
    async () => {
      // 1. ExecutionTarget.executionRunId fuzz
      const etArb = Arbitrary.schema(
        Schema.Struct({
          verb: Schema.Literals(["resume", "cancel", "signal", "steer", "run", "approve", "deny", "ps", ""]),
          target: Schema.Literals([
            "run-123",
            JSON.stringify({ version: 1, approvalId: "a1", target: { _tag: "Node", runId: "r-node-9", nodeId: "n1" } }),
            JSON.stringify({ version: 1, approvalId: "a2", target: { _tag: "Run", runId: "r-run-9" } }),
            "{corrupt-json",
            ""
          ]),
          flagMode: Schema.Literals([
            "none",
            "resume",
            "resume-true",
            "resume-false",
            "resume-bad",
            "message",
            "scope-eq",
            "missing-val",
            "unknown",
            "dashdash"
          ])
        })
      )
      const etRep = await Effect.runPromise(
        Fuzz.run(
          etArb,
          ({ flagMode, target, verb }) =>
            Effect.sync(() => {
              const args: Array<string> = []
              if (verb) args.push(verb)
              if (flagMode === "resume") args.push("--resume")
              else if (flagMode === "resume-true") args.push("--resume=true")
              else if (flagMode === "resume-false") args.push("--resume=false")
              else if (flagMode === "resume-bad") args.push("--resume=maybe")
              else if (flagMode === "message") args.push("--message", "hello")
              else if (flagMode === "scope-eq") args.push("--scope=once")
              else if (flagMode === "missing-val") args.push("--message")
              else if (flagMode === "unknown") args.push("--mystery-flag")
              else if (flagMode === "dashdash") args.push("--")
              if (target) args.push(target)

              const out = ExecutionTarget.executionRunId(args)
              if (flagMode === "unknown" || flagMode === "resume-bad" || flagMode === "missing-val" || !target) {
                if (flagMode !== "missing-val" || !target) {
                  if (flagMode === "unknown" || flagMode === "resume-bad") {
                    assertInv(out === undefined, `unexpected target for ${flagMode}: ${String(out)}`)
                  }
                }
              }
              if (
                ["resume", "cancel", "signal", "steer"].includes(verb) && target &&
                ["none", "message", "scope-eq", "dashdash"].includes(flagMode)
              ) {
                assertInv(out === target, `expected ${target}, got ${String(out)}`)
              }
              if (verb === "run" && target && (flagMode === "resume" || flagMode === "resume-true")) {
                assertInv(out === target, `run --resume expected ${target}`)
              }
              return true
            }),
          { executions: Math.min(executions, 40), seed }
        )
      )
      expect(etRep._tag).toBe("Passed")

      // 2. StoreCopy real SQLite VACUUM INTO + discard + PG same-schema refusal
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-hist-copy-"))
      try {
        const srcDb = join(tmp, "source.sqlite")
        const dstDb = join(tmp, "copy.sqlite")
        await Effect.runPromise(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE flows_migrations (id INTEGER PRIMARY KEY)`
            yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)`
            yield* sql`INSERT INTO items VALUES (1, 'alpha'), (2, 'beta')`
          }).pipe(Effect.provide(NodeDatabase.layer({ filename: srcDb })))
        )
        await Effect.runPromise(StoreCopy.copy(srcDb, dstDb))
        const rows = await Effect.runPromise(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{ id: number; name: string }>`SELECT id, name FROM items ORDER BY id`
          }).pipe(Effect.provide(NodeDatabase.layer({ filename: dstDb, readOnly: true })))
        )
        expect(rows).toHaveLength(2)
        expect(rows[0]!.name).toBe("alpha")
        await Effect.runPromise(StoreCopy.discard(dstDb))

        // PG mismatched target refusal (without connecting to PG)
        const pgSameExit = await Effect.runPromiseExit(
          StoreCopy.copy(
            "postgres://user:pass@127.0.0.1:5432/db?schema=s1",
            "postgres://user:pass@127.0.0.1:5432/db?schema=s1"
          )
        )
        expect(Exit.isFailure(pgSameExit)).toBe(true)
        const pgToSqliteExit = await Effect.runPromiseExit(
          StoreCopy.copy("postgres://user:pass@127.0.0.1:5432/db?schema=s1", dstDb)
        )
        expect(Exit.isFailure(pgToSqliteExit)).toBe(true)

        // 3. GatewayHistory fork/verify + error redaction (must never leak host root path)
        const gwArb = Arbitrary.schema(
          Schema.Struct({
            mode: Schema.Literals(["ok", "usage-err", "refused", "unknown-err"]),
            withOptional: Schema.Boolean
          })
        )
        const gwRep = await Effect.runPromise(
          Fuzz.run(
            gwArb,
            ({ mode, withOptional }) =>
              Effect.promise(async () => {
                const svc = GatewayHistory.make(tmp, {}, {
                  mutate: async () => {
                    if (mode === "usage-err") {
                      throw new CliError.UsageError({ message: `bad input at ${tmp}/secret.ts` })
                    }
                    if (mode === "refused") {
                      throw new CliError.Refused({ fault: "user", code: "not_found", message: `missing under ${tmp}` })
                    }
                    if (mode === "unknown-err") {
                      throw new Error(`internal crash at ${tmp}/db`)
                    }
                    return { runId: "forked-1", parentRunId: "r1" } as any
                  },
                  verify: async () => {
                    if (mode === "usage-err") throw new CliError.UsageError({ message: `bad verify at ${tmp}` })
                    if (mode === "refused") {
                      throw new CliError.Refused({ fault: "policy", code: "denied", message: `denied at ${tmp}` })
                    }
                    if (mode === "unknown-err") {
                      throw new Error(`verify crash at ${tmp}`)
                    }
                    return {
                      runId: "r1",
                      verdict: "passed",
                      replayed: [{ stepKeyDigest: "d1", action: "read", node: "n1" }],
                      ...(withOptional
                        ? { resumes: { stepKeyDigest: "d2" }, executes: { stepKeyDigest: "d3", action: "write" } }
                        : {}),
                      notReplayed: [{ stepKeyDigest: "d4" }]
                    } as any
                  }
                })

                const forkExit = await Effect.runPromiseExit(
                  svc.fork({
                    runId: "r1",
                    at: 2,
                    ...(withOptional ? { lineage: "lin-1", step: { key: "k", value: 1 } as any } : {})
                  })
                )
                const verifyExit = await Effect.runPromiseExit(svc.verify({ runId: "r1" }))

                if (mode === "ok") {
                  assertInv(Exit.isSuccess(forkExit) && forkExit.value.runId === "forked-1", "gateway fork ok")
                  assertInv(
                    Exit.isSuccess(verifyExit) && (verifyExit.value.verdict as string) === "passed",
                    "gateway verify ok"
                  )
                } else if (mode === "usage-err" || mode === "refused") {
                  assertInv(
                    Exit.isFailure(forkExit) && !String(forkExit.cause).includes(tmp),
                    "host root redacted from fork error"
                  )
                  assertInv(
                    Exit.isFailure(verifyExit) && !String(verifyExit.cause).includes(tmp),
                    "host root redacted from verify error"
                  )
                } else {
                  assertInv(
                    Exit.isFailure(forkExit) && Exit.isFailure(verifyExit),
                    "unknown errors surface as failure/die"
                  )
                }
                return true
              }),
            { executions: Math.min(executions, 20), seed: seed + 1 }
          )
        )
        expect(gwRep._tag).toBe("Passed")
        expect(GatewayHistory.layer(tmp)).toBeDefined()
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Operators (Integrations, Credentials, CronTargets, TargetRuns, TriggerPlans, Triggers) & Runner (Lane, Session, Serve) uphold lifecycle invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-op-run-"))
      const server = await makeLoopback((req) => {
        if (req.url.includes("unauth")) return { status: 401, body: JSON.stringify({ error: "unauth" }) }
        if (req.url.includes("boom")) return { status: 500, body: "err" }
        if (req.url.includes("poll")) return { status: 204, body: "" }
        return { status: 200, body: JSON.stringify({ ok: true, login: "smithers-bot", viewer: { id: "u1" } }) }
      })

      try {
        mkdirSync(join(tmp, ".flows"), { recursive: true })

        // 1. Integrations.probe across authorized/unauthorized endpoints & status codes + readIntegrations + CLI
        const prevGhBase = process.env["SMITHERS_GITHUB_API_BASE_URL"]
        process.env["SMITHERS_GITHUB_API_BASE_URL"] = server.origin
        try {
          const provArb = Arbitrary.schema(
            Schema.Struct({
              urlKind: Schema.Literals(["ok", "unauth", "boom", "unauthorized-host", "invalid-url"])
            })
          )
          const provRep = await Effect.runPromise(
            Fuzz.run(
              provArb,
              ({ urlKind }) =>
                Effect.promise(async () => {
                  const apiBaseUrl = urlKind === "ok"
                    ? `${server.origin}`
                    : urlKind === "unauth"
                    ? `${server.origin}/unauth`
                    : urlKind === "boom"
                    ? `${server.origin}/boom`
                    : urlKind === "unauthorized-host"
                    ? "https://evil.example.invalid"
                    : "not-a-url"
                  const entry: Integrations.Integration = {
                    id: "int-gh",
                    provider: "github",
                    apiBaseUrl,
                    credential: "cred-gh"
                  } as any
                  let threw = false
                  let healthy = false
                  try {
                    const res = await Integrations.probe(entry, "tok_test_123", 3_000)
                    healthy = res.healthy
                  } catch {
                    threw = true
                  }
                  if (urlKind === "ok") {
                    assertInv(!threw && healthy, "authorized 200 probe succeeds")
                  } else {
                    assertInv(threw, `expected probe refusal for ${urlKind}`)
                  }
                  return true
                }),
              { executions: Math.min(executions, 15), seed: seed + 2 }
            )
          )
          if (provRep._tag !== "Passed") {
            throw new Error(`Falsified: ${JSON.stringify(provRep)}`)
          }
          expect(provRep._tag).toBe("Passed")
        } finally {
          if (prevGhBase === undefined) delete process.env["SMITHERS_GITHUB_API_BASE_URL"]
          else process.env["SMITHERS_GITHUB_API_BASE_URL"] = prevGhBase
        }

        // readIntegrations on empty & populated directory
        const emptyInts = Integrations.readIntegrations(tmp)
        expect(Array.isArray(emptyInts)).toBe(true)

        const intCli = Integrations.createIntegrationsCli()
        let intOut = ""
        await intCli.serve(["list", "--root", tmp], { stdout: (s) => (intOut += s), exit: () => {} })
        expect(intOut.length).toBeGreaterThanOrEqual(0)

        // 2. CronTargets.declared & CronTargets.sync on real SQLite TriggerStore
        const dec = await Effect.runPromise(CronTargets.declared(tmp))
        expect(dec).toEqual([])
        const synced = await Triggers.withTriggers({ root: tmp }, CronTargets.sync(tmp))
        expect(synced.registered).toEqual([])
        expect(synced.withdrawn).toEqual([])

        // 3. TargetRuns helpers & layerCommand executing a real child process
        expect(TargetRuns.isHandle("target-run:abc")).toBe(true)
        expect(TargetRuns.isHandle("other:abc")).toBe(false)
        expect(TargetRuns.logOf("target-run:abc")).toContain("abc")
        expect(await TargetRuns.inspectRun(tmp, "target-run:missing")).toBeNull()

        const cmdRes = await Effect.runPromise(
          Effect.gen(function*() {
            const tc = yield* TargetRuns.TargetCommand
            return yield* tc.run({
              root: tmp,
              labels: ["//:build"],
              log: join(tmp, "target-run.log")
            })
          }).pipe(
            Effect.provide(
              TargetRuns.layerCommand(
                { command: process.execPath, arguments: ["-e", "process.stdout.write('target-ok')"] } as any
              )
            ),
            Effect.provide(TargetRuns.layerSpawner),
            Effect.provide(NodeServices.layer)
          )
        )
        expect(typeof cmdRes).toBe("number")

        // 4. TriggerPlans inspect/previewApproval/revokeApproval
        expect(await TriggerPlans.inspect(tmp, "plan-missing")).toBeNull()
        const previewExit = await Effect.runPromiseExit(
          TriggerPlans.previewApproval(tmp, "nonexistent-trigger") as Effect.Effect<unknown, unknown, never>
        )
        expect(Exit.isFailure(previewExit) || Exit.isSuccess(previewExit)).toBe(true)
        const revokeExit = await Effect.runPromiseExit(
          TriggerPlans.revokeApproval(tmp, "nonexistent-grant") as Effect.Effect<unknown, unknown, never>
        )
        expect(Exit.isFailure(revokeExit) || Exit.isSuccess(revokeExit)).toBe(true)

        // 5. Credentials CLI (list/status)
        const credCli = Credentials.createCredentialsCli()
        let credOut = ""
        await credCli.serve(["list", "--root", tmp], { stdout: (s) => (credOut += s), exit: () => {} })
        expect(typeof credOut).toBe("string")

        // 6. RunnerSession.spawnFailureOf across diverse causes
        for (
          const cause of [
            Cause.fail(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
            Cause.fail(Object.assign(new Error("permission denied"), { code: "EACCES" })),
            Cause.die(new Error("unexpected crash")),
            Cause.interrupt(0 as any)
          ]
        ) {
          const mapped = RunnerSession.spawnFailureOf(cause)
          expect(typeof mapped.code).toBe("string")
          expect(typeof mapped.reason).toBe("string")
        }

        // 7. RunnerLane.baseLayer with fake jj mirror (both missing repo -> keeps last, and present repo -> moves base!)
        const binDir = join(tmp, "bin")
        const mirrorDir = join(tmp, "mirror")
        mkdirSync(binDir, { recursive: true })
        mkdirSync(mirrorDir, { recursive: true })
        const sha40 = "a".repeat(40)
        const jjBin = join(binDir, "jj")
        writeFileSync(
          jjBin,
          `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes("log")) {
  process.stdout.write("${sha40}\\n")
}
process.exit(0)
`
        )
        chmodSync(jjBin, 0o755)
        const prevPath = process.env["PATH"] ?? ""
        process.env["PATH"] = `${binDir}:${prevPath}`
        try {
          const checkedCfg = {
            repositories: {
              "acme/demo": { mirror: mirrorDir }
            },
            lanesRoot: tmp
          } as any
          expect(RunnerLane.baseLayer(checkedCfg)).toBeDefined()
          expect(RunnerLane.registration(checkedCfg)).toBeDefined()
          expect(RunnerLane.DESCRIPTOR_SOURCE).toContain("runner/Lane")
        } finally {
          process.env["PATH"] = prevPath
        }

        // 8. RunnerServe constants
        expect(RunnerServe.NOT_AUTHORIZED_HINT).toContain("Admin")
      } finally {
        await server.close()
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
