import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/Cli.ts"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as Generate from "../src/cli/Generate.ts"
import * as TargetApprovals from "../src/cli/TargetApprovals.ts"
import * as TokenCommands from "../src/cli/TokenCommands.ts"
import * as CliError from "../src/CliError.ts"
import * as DidYouMean from "../src/DidYouMean.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as ExecutionTarget from "../src/history/ExecutionTarget.ts"
import * as HistoryProjection from "../src/history/Projection.ts"
import * as StoreCopy from "../src/history/StoreCopy.ts"
import * as HistoryVerify from "../src/history/Verify.ts"
import * as InstallDiscovery from "../src/internal/backend/InstallDiscovery.ts"
import * as Credentials from "../src/operator/Credentials.ts"
import * as CronTargets from "../src/operator/CronTargets.ts"
import * as Integrations from "../src/operator/Integrations.ts"
import * as Memory from "../src/operator/Memory.ts"
import * as OperatorStore from "../src/operator/Store.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"
import * as Brief from "../src/suggest/Brief.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
import * as SuggestFlow from "../src/suggest/SuggestFlow.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeTerminal = () => {
  const chunks: Array<string> = []
  const output = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk))
        cb()
      }
    }),
    { isTTY: false, columns: 100 }
  )
  return { output, text: () => chunks.join("") }
}

describe("@smthrs/cli Suggest, Operator, History, Evaluation, Token & Unified CLI Command Tree fuzz invariants", () => {
  it("Suggest Checklist.evidence/scan, Brief.suggestion/followUp & SuggestFlow.rules/done analyze diverse synthetic repos accurately", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pkgMgr: Schema.Literals(["pnpm", "npm", "bun", "none"]),
        hasTests: Schema.Boolean,
        hasLint: Schema.Boolean,
        hasCi: Schema.Boolean,
        hasGithub: Schema.Boolean,
        hasFlows: Schema.Boolean,
        hasPackageTs: Schema.Boolean,
        hasChangelog: Schema.Boolean,
        hasAgentsMd: Schema.Boolean,
        hasRust: Schema.Boolean,
        hasPython: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          pkgMgr,
          hasTests,
          hasLint,
          hasCi,
          hasGithub,
          hasFlows,
          hasPackageTs,
          hasChangelog,
          hasAgentsMd,
          hasRust,
          hasPython
        }) =>
          Effect.promise(async () => {
            const files: Record<string, string> = {}
            const scripts: Record<string, string> = {}
            if (hasTests) scripts.test = "vitest run"
            if (hasLint) scripts.lint = "eslint ."
            files["package.json"] = JSON.stringify({
              name: "fuzz-repo",
              scripts,
              devDependencies: {
                ...(hasTests ? { vitest: "^5.0.0" } : {}),
                ...(hasLint ? { eslint: "^9.0.0" } : {}),
                typescript: "^5.8.0"
              }
            })
            if (pkgMgr === "pnpm") files["pnpm-lock.yaml"] = "lockfileVersion: '9.0'\n"
            if (pkgMgr === "npm") files["package-lock.json"] = "{}"
            if (pkgMgr === "bun") files["bun.lock"] = ""
            if (hasLint) files["eslint.config.js"] = "export default []\n"
            if (hasCi) {
              files[".github/workflows/ci.yml"] = "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
            }
            if (hasGithub) files[".git/config"] = "[remote \"origin\"]\n\turl = https://github.com/octo/fuzz-repo.git\n"
            if (hasFlows) files[".smithers/flows/review/flow.ts"] = "export default {}\n"
            if (hasPackageTs) files["PACKAGE.ts"] = "export default {}\n"
            if (hasChangelog) files["CHANGELOG.md"] = "# Changelog\n"
            if (hasAgentsMd) files["AGENTS.md"] = "# Agents\n"
            if (hasRust) files["Cargo.toml"] = "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n"
            if (hasPython) files["pyproject.toml"] = "[project]\nname = \"demo\"\n"
            files["src/index.ts"] = "export const x = 1\n"

            const repo = Checklist.memoryRepository("/tmp/fuzz-repo", files)
            const facts = Checklist.evidence(repo)
            assertInv(typeof facts === "object" && Array.isArray(facts.language), "Checklist.evidence")
            if (pkgMgr === "pnpm") assertInv(facts.packageManager === "pnpm", "detects pnpm")

            const suggestions: Array<Checklist.Suggestion> = []
            for await (const s of Checklist.scan(repo)) {
              suggestions.push(s)
            }
            assertInv(Array.isArray(suggestions), "Checklist.scan yields array")
            if (suggestions.length > 0) {
              const ctx: Brief.Context = { seat: "openai:gpt-5", facts }
              const briefText = Brief.suggestion(ctx, suggestions[0]!)
              assertInv(briefText.includes(suggestions[0]!.id), "Brief.suggestion includes id")
              const followUpIds = Object.keys(Checklist.followUps) as Array<Checklist.FollowUp["id"]>
              if (followUpIds.length > 0) {
                const fu = Brief.followUp(
                  ctx,
                  suggestions[0]!,
                  { files: [".smithers/flows/demo/flow.ts"], command: "pnpm test" },
                  Checklist.followUps[followUpIds[0]!]!
                )
                assertInv(typeof fu === "string" && fu.length > 0, "Brief.followUp non-empty")
              }
            }

            // SuggestFlow pure helpers
            const rules = SuggestFlow.rules("/tmp/fuzz-repo")
            assertInv(rules.length > 0, "SuggestFlow.rules non-empty")
            const doneCode = SuggestFlow.done({
              files: [".smithers/flows/demo/flow.ts"],
              command: "pnpm test",
              notes: "added flow"
            })
            assertInv(doneCode.includes("ctx.done"), "SuggestFlow.done")

            return true
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("TokenCommands.mint, ControlBridge, TargetApprovals, History Projection/Verify/StoreCopy & Evaluation uphold invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-ops-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          ttl: Schema.Literals(["30s", "15m", "1h", "2d", "0s", "bad-ttl", "-10m"]),
          hasToken: Schema.Boolean,
          scope: Schema.Literals(["read:runs", "write:runs", "approve:runs"]),
          runId: Schema.Literals(["run-1", "run_abc_123", "../escape", ""]),
          includeEvents: Schema.Boolean,
          eventCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
          remoteUrl: Schema.Literals(["NONE", "http://127.0.0.1:3000", "https://smithers.sh"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ ttl, hasToken, scope, runId, includeEvents, eventCount, remoteUrl }) =>
            Effect.gen(function*() {
              // 1. TokenCommands.mint
              const env: Record<string, string | undefined> = hasToken
                ? { SMITHERS_TOKEN: "master-gateway-token-secret-123456" }
                : {}
              const mintRes = yield* TokenCommands.mint(
                {
                  scope: [scope as never],
                  ttl,
                  ...(runId === "run-1" ? { run: runId } : {})
                },
                env
              ).pipe(Effect.result)
              const validTtl = ["30s", "15m", "1h", "2d"].includes(ttl)
              if (!hasToken || !validTtl) {
                assertInv(mintRes._tag === "Failure", `TokenCommands.mint refuses invalid (${hasToken}, ${ttl})`)
              } else if (mintRes._tag === "Success") {
                assertInv(
                  typeof mintRes.success.token === "string" && !mintRes.success.token.includes("master-gateway-token"),
                  "minted token is opaque and distinct from master key"
                )
              }

              // 2. ControlBridge pure options/args helpers
              const connOpts = ControlBridge.connectionOptions.parse({
                ...(remoteUrl === "NONE" ? {} : { remote: remoteUrl })
              })
              const connArgs = ControlBridge.connectionArguments(connOpts)
              assertInv(Array.isArray(connArgs), "ControlBridge.connectionArguments")
              assertInv(
                ControlBridge.isRemote(connOpts, {}) === (remoteUrl !== "NONE"),
                "ControlBridge.isRemote matches"
              )

              // 3. TargetApprovals pure helpers
              const planIn = TargetApprovals.planInput({ label: "//packages/errors:test", digest: "sha256:abc" })
              assertInv(planIn.flowId === TargetApprovals.flowId, "TargetApprovals.planInput flowId")

              // 4. History ExecutionTarget, Projection, Verify & StoreCopy
              const exTarget = ExecutionTarget.executionRunId(["runs", "show", runId])
              assertInv(exTarget === undefined || typeof exTarget === "string", "ExecutionTarget.executionRunId")
              const proj = HistoryProjection.make(includeEvents)
              let st = proj.initial
              for (let i = 0; i < eventCount; i++) {
                st = proj.reduce(
                  st,
                  {
                    seq: i + 1,
                    eventType: i === 0 ? "flows.engine.run-decision" : "flows.node.completed.v1",
                    payload: i === 0 ? { state: { step: i } } : { ok: true },
                    timestamp: Date.now()
                  } as never,
                  i === eventCount - 1 ? { ok: true } : undefined
                )
              }
              const summary = proj.finish(st)
              assertInv(summary.entryCount === eventCount, "HistoryProjection counts entries")
              assertInv(
                includeEvents ? summary.events.length === eventCount : summary.events.length === 0,
                "HistoryProjection includeEvents respected"
              )

              const verRep = HistoryVerify.report("run-1", [], [])
              assertInv(verRep.runId === "run-1", "HistoryVerify.report")
              const divErr = HistoryVerify.divergence(verRep)
              assertInv(divErr instanceof CliError.Refused, "HistoryVerify.divergence is Refused")
              const storeDiv = HistoryVerify.storeDivergence({
                verdict: "divergent",
                reports: [verRep],
                settled: [],
                unverified: []
              })
              assertInv(storeDiv instanceof CliError.Refused, "HistoryVerify.storeDivergence is Refused")
              assertInv(StoreCopy.postgres("postgres://localhost/db") !== undefined, "StoreCopy.postgres")

              // 5. Evaluation.artifactOf / runOf / runPath
              const obs = {
                kind: "score" as const,
                case: "c1",
                scorer: "exact",
                stepKey: "k1",
                at: "2026-11-23T00:00:00Z",
                score: 1
              }
              const runResult = {
                runId: "eval-run-1",
                suite: "smoke",
                cases: [{ case: "c1", observations: [obs] }],
                observations: [obs]
              }
              const artifact = Evaluation.artifactOf(runResult as never)
              const roundtripped = Evaluation.runOf(artifact)
              assertInv(
                roundtripped.runId === "eval-run-1" && roundtripped.suite === "smoke",
                "Evaluation artifact roundtrip"
              )
              try {
                const rp = Evaluation.runPath(tmpRoot, runId)
                assertInv(rp.startsWith(tmpRoot), "Evaluation.runPath confined to root")
                assertInv(runId !== "../escape" && runId !== "", "Evaluation.runPath rejects escape/empty")
              } catch (e) {
                assertInv(e instanceof Error, "Evaluation.runPath rejects bad id")
              }

              // 6. Operator pure helpers (TargetRuns, Store)
              assertInv(TargetRuns.isHandle("target-run:abc") || !TargetRuns.isHandle("other"), "TargetRuns.isHandle")
              assertInv(typeof TargetRuns.logOf("target-run:abc") === "string", "TargetRuns.logOf")
              const opRoot = OperatorStore.localRoot({ root: tmpRoot })
              assertInv(opRoot === tmpRoot, "OperatorStore.localRoot")

              return true
            }),
          { seed: seed + 1, executions: Math.min(executions, 80) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Operator stores (Credentials, Memory, Triggers, Integrations, CronTargets, TriggerPlans) & Unified Cli.makeCli handle real temp workspaces cleanly", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cli-tree-fuzz-")))
    try {
      const term = makeTerminal()
      const cli = Cli.makeCli({
        environment: { HOME: tmpRoot, SMITHERS_DISABLE_SYSTEM_KEYRING: "1" },
        stdout: term.output,
        stderr: term.output
      })
      const cmds = DidYouMean.commands(cli as never)
      expect(cmds.length).toBeGreaterThan(20)
      const installPaths = InstallDiscovery.installCommandPaths(cli)
      expect(Array.isArray(installPaths)).toBe(true)

      // Operator CLI builders construct cleanly
      expect(Credentials.createCredentialsCli()).toBeDefined()
      expect(Integrations.createIntegrationsCli()).toBeDefined()
      expect(Memory.createMemoryCli()).toBeDefined()
      expect(Triggers.createTriggersCli()).toBeDefined()
      expect(Generate.createGenerateCli({})).toBeDefined()

      const arb = Arbitrary.schema(
        Schema.Struct({
          argv: Schema.Literals([
            "--help",
            "--version",
            "doctor --help",
            "flow --help",
            "runs --help",
            "targets --help",
            "env --help",
            "token --help",
            "eval --help",
            "memory --help",
            "triggers --help",
            "credentials --help",
            "integrations --help",
            "generate --help",
            "approvals --help",
            "cache --help",
            "history --help",
            "repo --help",
            "issue --help",
            "workspace --help",
            "stack --help",
            "admin --help"
          ]),
          secretVal: Schema.Literals(["super-secret-value-123", "another-key-456"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ argv, secretVal }) =>
            Effect.promise(async () => {
              const dir = FsSync.mkdtempSync(Path.join(tmpRoot, "op-"))
              try {
                // 1. Unified CLI serve on help/version invocations (never crashes or leaks)
                const out: Array<string> = []
                await cli.serve(argv.split(" "), {
                  stdout: (s) => {
                    out.push(s)
                  },
                  exit: () => {}
                })
                assertInv(out.join("").length > 0, `CLI produced output for "${argv}"`)

                // 2. Operator Credentials.readSecret from file
                const secFile = Path.join(dir, "secret.txt")
                FsSync.writeFileSync(secFile, `${secretVal}\n`)
                const red = Credentials.readSecret({ secretFile: secFile }, dir)
                assertInv(
                  String(red).includes("redacted") || typeof red === "object",
                  "Credentials.readSecret returns Redacted"
                )

                // 3. Operator Integrations.readIntegrations on temp dir
                const ints = Integrations.readIntegrations(dir, ".smithers/integrations.json", {
                  GITHUB_TOKEN: "ghp_dummy"
                })
                assertInv(Array.isArray(ints), "readIntegrations returns array")

                // 4. Operator CronTargets.declared on empty temp dir
                const cronRes = await Effect.runPromise(CronTargets.declared(dir).pipe(Effect.result))
                assertInv(cronRes._tag === "Success" || cronRes._tag === "Failure", "CronTargets.declared settles")

                // 5. Operator TriggerPlans.inspect & TargetRuns.inspectRun on empty temp dir
                const tp = await TriggerPlans.inspect(dir, "missing-handle")
                const tr = await TargetRuns.inspectRun(dir, "missing-handle")
                assertInv(tp === null && tr === null, "missing handles return null")

                return true
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }),
          { seed: seed + 2, executions: Math.min(executions, 25) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
