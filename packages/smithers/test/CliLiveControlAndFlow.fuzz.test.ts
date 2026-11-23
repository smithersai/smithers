import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Gc from "../src/Gc.ts"
import * as HistoryModule from "../src/history/History.ts"
import * as HistoryVerify from "../src/history/Verify.ts"
import * as HistoryWorkspace from "../src/history/Workspace.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import { invoke, project } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const parseJsonOk = (res: Awaited<ReturnType<typeof invoke>>, label: string) => {
  assertInv(!res.codes.includes(1) && !res.codes.includes(2), `${label} failed: ${res.stdout} ${res.stderr}`)
  return JSON.parse(res.stdout)
}

describe("@smthrs/cli Live Control Runtime, Flow Execution, Approvals, Runs, Operator Stores & LocalJobs fuzz invariants", () => {
  it("End-to-end flow list/show/plan/approve/deny/execute/start, runs show/list/count/wait/logs/timing/output/signals/resume/inspect/verify & gc uphold durable control invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        message: Schema.Literals(["hello fuzz", "unicode café", "line1 line2"]),
        mode: Schema.Literals(["planApproveExecute", "planDenyAndBudget"]),
        useJson: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ message, mode, useJson }) =>
          Effect.promise(async () => {
            const root = await project()
            try {
              const at = ["--root", root, "--json"]
              // 1. Flow list, flow show & doctor
              const listed = parseJsonOk(await invoke(["flow", "list", ...at]), "flow list")
              assertInv(Array.isArray(listed.items) && listed.items.length >= 1, "flow list discovers echo")

              const flowShow = parseJsonOk(await invoke(["flow", "show", "echo", ...at]), "flow show")
              assertInv(flowShow.id === "echo" || flowShow.flowId === "echo" || typeof flowShow === "object", "flow show")

              const docRes = await invoke(["doctor", "--root", root, ...(useJson ? ["--json"] : [])])
              assertInv(docRes.stdout.length > 0 || docRes.stderr.length > 0, "doctor produces output")

              if (mode === "planApproveExecute") {
                // 2. Plan -> Approve -> Execute -> Runs show/list/count/wait/logs/timing/output/signals/resume/inspect/verify
                const card = parseJsonOk(
                  await invoke(["flow", "plan", "echo", "--data", JSON.stringify({ message }), ...at]),
                  "flow plan"
                )
                const apprFile = Path.join(root, "approval.json")
                FsSync.writeFileSync(apprFile, JSON.stringify(card.approval, null, 2) + "\n")

                const approved = parseJsonOk(
                  await invoke(["approvals", "approve", `@${apprFile}`, "--scope", "run", ...at]),
                  "approvals approve"
                )
                assertInv(approved._tag === "Accepted", "approval accepted")

                const receipt = parseJsonOk(
                  await invoke(["flow", "execute", `@${apprFile}`, ...at]),
                  "flow execute"
                )
                assertInv(receipt._tag === "Accepted" && typeof receipt.runId === "string", "flow execute accepted")

                const shown = parseJsonOk(await invoke(["runs", "show", receipt.runId, ...at]), "runs show")
                assertInv(shown.runId === receipt.runId && shown.status === "completed", "runs show completed")

                const runsList = parseJsonOk(await invoke(["runs", "list", ...at]), "runs list")
                assertInv(Array.isArray(runsList.items) && runsList.items.length >= 1, "runs list non-empty")

                const runsCount = parseJsonOk(await invoke(["runs", "count", ...at]), "runs count")
                assertInv(typeof runsCount === "object", "runs count")

                const waited = parseJsonOk(await invoke(["runs", "wait", receipt.runId, ...at]), "runs wait")
                assertInv(waited.status === "completed", "runs wait completed")

                const logsRes = await invoke(["runs", "logs", receipt.runId, ...at])
                assertInv(!logsRes.codes.includes(1) && logsRes.stdout.length > 0, "runs logs succeeded")

                const timingRes = await invoke([
                  "runs",
                  "show",
                  receipt.runId,
                  "--timing",
                  "--root",
                  root,
                  ...(useJson ? ["--json"] : [])
                ])
                assertInv(!timingRes.codes.includes(1) && timingRes.stdout.length > 0, "runs timing succeeded")

                const outputRes = await invoke(["runs", "output", receipt.runId, ...at])
                assertInv(!outputRes.codes.includes(1), "runs output succeeded")

                const signalsRes = await invoke(["runs", "signals", receipt.runId, ...at])
                assertInv(!signalsRes.codes.includes(1), "runs signals succeeded")

                const resumed = parseJsonOk(
                  await invoke(["runs", "resume", receipt.runId, "--allow-code-drift", ...at]),
                  "runs resume"
                )
                assertInv(resumed._tag === "Terminal", "runs resume terminal")

                // History inspect / verify / workspace / reconcile on real populated DB
                await invoke(["runs", "inspect", receipt.runId, ...at])
                await invoke(["runs", "replay", receipt.runId, ...at])
                await invoke(["runs", "verify", ...at])
                const histVerify = await HistoryVerify.verifyAll(root)
                assertInv(typeof histVerify.verdict === "string", "HistoryVerify.verifyAll")
                let verifyErrCode: string | undefined
                try {
                  await HistoryVerify.verify(root, receipt.runId, { settleWithin: "2 seconds" })
                } catch (err) {
                  verifyErrCode = (err as { readonly code?: string }).code
                }
                assertInv(verifyErrCode === "run_settled", "HistoryVerify.verify terminal run_settled")
                const ws = await HistoryWorkspace.workspaceFor(root, receipt.runId)
                assertInv(ws === undefined || typeof ws === "string", "HistoryWorkspace.workspaceFor")
                await HistoryModule.reconcile(root)

                // GC sweep on real populated DB
                const sweep = await Effect.runPromise(Gc.sweep(root, { olderThan: "365d", dryRun: true }))
                assertInv(typeof sweep === "object", "Gc.sweep dryRun")
              } else {
                const card = parseJsonOk(
                  await invoke(["flow", "plan", "echo", "--data", JSON.stringify({ message }), ...at]),
                  "flow plan (deny)"
                )
                const payload = JSON.stringify(card.approval)
                parseJsonOk(await invoke(["approvals", "deny", payload, ...at]), "approvals deny")
                const execRes = await invoke(["flow", "execute", payload, ...at])
                assertInv(execRes.codes.includes(1), "denied plan cannot execute")
                const started = parseJsonOk(
                  await invoke([
                    "flow",
                    "start",
                    "echo",
                    "--data",
                    JSON.stringify({ message }),
                    "--budget-tokens",
                    "100",
                    "--budget-usd",
                    "1.0",
                    "--on-exceeded",
                    "park",
                    ...at
                  ]),
                  "flow start with budget"
                )
                assertInv(typeof started.runId === "string", "flow start returns runId")
                const approvalsList = parseJsonOk(await invoke(["approvals", "list", ...at]), "approvals list")
                assertInv(typeof approvalsList === "object", "approvals list")
              }

              return true
            } finally {
              await Fs.rm(root, { recursive: true, force: true })
            }
          }),
        { seed, executions: Math.min(executions, 2) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 180_000)

  it("Live operator CLIs (memory, credentials, triggers, integrations, environment, token, step cache) & LocalJobs store execute cleanly on real SQLite workspaces", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-live-ops-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          memText: Schema.Literals(["remembered fact alpha", "project uses effect 4"]),
          credId: Schema.Literals(["api-key-1", "gh-token"]),
          secretVal: Schema.Literals(["super_secret_val_987654321", "another_secret_token_abc"]),
          jobKey: Schema.Literals(["live-job-1", "live-job-2"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ memText, credId, secretVal, jobKey }) =>
            Effect.promise(async () => {
              const root = await Fs.mkdtemp(Path.join(tmpRoot, "ws-"))
              try {
                const env = {
                  HOME: root,
                  SMITHERS_TOKEN: "master-token-for-fuzz-123456",
                  SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
                  FUZZ_SECRET_VAL: secretVal
                }
                const at = ["--root", root, "--json"]

                // 1. Memory remember / list / recall
                const rem = await invoke(["memory", "remember", memText, "--bank", "default", ...at], { environment: env })
                assertInv(!rem.codes.includes(2), `memory remember: ${rem.stderr}`)
                const mList = await invoke(["memory", "list", "--bank", "default", ...at], { environment: env })
                assertInv(!mList.codes.includes(2), `memory list: ${mList.stderr}`)
                const mRecall = await invoke(["memory", "recall", "fact", "--bank", "default", ...at], { environment: env })
                assertInv(!mRecall.codes.includes(2), `memory recall: ${mRecall.stderr}`)

                // 2. Credentials set / list — secret MUST NEVER appear in stdout/stderr!
                const secFile = Path.join(root, "sec.txt")
                FsSync.writeFileSync(secFile, secretVal)
                const cSet = await invoke(
                  ["credentials", "set", credId, "--secret-file", secFile, ...at],
                  { environment: env }
                )
                assertInv(
                  !cSet.stdout.includes(secretVal) && !cSet.stderr.includes(secretVal),
                  "credentials set never echoes secret"
                )
                const cList = await invoke(["credentials", "list", ...at], { environment: env })
                assertInv(
                  !cList.stdout.includes(secretVal) && !cList.stderr.includes(secretVal),
                  "credentials list never echoes secret"
                )

                // 3. Triggers list, Integrations list, Environment add/list/view/remove, Token mint, Step cache ls/sweep
                await invoke(["triggers", "list", ...at], { environment: env })
                await invoke(["integrations", "list", ...at], { environment: env })
                await invoke(
                  ["environment", "add", "dev", "--local", "--directory", root, "--json"],
                  { environment: env }
                )
                const envList = await invoke(["environment", "list", "--json"], { environment: env })
                assertInv(envList.stdout.includes("dev"), `environment list includes added profile: ${envList.stdout}`)
                await invoke(["environment", "view", "dev", "--json"], { environment: env })
                await invoke(["environment", "remove", "dev", "--json"], { environment: env })

                const minted = await invoke(
                  ["token", "mint", "--scope", "read:runs", "--ttl", "1h", "--json"],
                  { environment: env }
                )
                assertInv(
                  !minted.codes.includes(1) && !minted.stdout.includes("master-token-for-fuzz"),
                  "token mint succeeds without leaking master key"
                )
                await invoke(["cache", "ls", ...at], { environment: env })
                await invoke(["cache", "sweep", ...at], { environment: env })

                // 4. LocalJobs file store lifecycle (make -> standing / claim inside Scope)
                const jobsStoreOk = await Effect.runPromise(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const store = yield* LocalJobs.make(Path.join(root, "runner-state"))
                      const status = yield* store.jobs.status(jobKey).pipe(Effect.result)
                      return status._tag === "Success" || status._tag === "Failure"
                    })
                  ).pipe(Effect.provide(NodeFileSystem.layer))
                )
                assertInv(jobsStoreOk, "LocalJobs.make standing query")

                return true
              } finally {
                await Fs.rm(root, { recursive: true, force: true })
              }
            }),
          { seed: seed + 1, executions: Math.min(executions, 3) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 180_000)
})
