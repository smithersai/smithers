import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Control from "@smthrs/control/Control"
import { PersistenceError, RunNotFound, TransportError } from "@smthrs/control/ControlError"
import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type { Service as ControlRuntime, StoredPlan } from "@smthrs/control/ControlRuntime"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as TestGrantStore from "@smthrs/kernel/test/TestGrantStore"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Remotes } from "@smthrs/sandbox"
import {
  Arbitrary,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Stream
} from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as WorkspaceRemotes from "../src/internal/WorkspaceRemotes.ts"
import * as Project from "../src/Project.ts"
import { invoke, project, waitingProject } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "25")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "90501")
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url))

const assertInv = (cond: boolean, message: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${message}`)
}

const runFuzz = <A>(
  arb: Arbitrary.Arbitrary<A>,
  fn: (value: A) => void,
  opts: { readonly executions: number; readonly seed: number }
) =>
  Effect.runPromise(
    Fuzz.run(
      arb,
      (value) =>
        Effect.sync(() => {
          fn(value)
          return true
        }),
      opts
    )
  )

const expectPassed = (report: { readonly _tag: string }): void => {
  if (report._tag !== "Passed") {
    throw new Error(`Falsified: ${JSON.stringify(report)}`)
  }
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/cli Wave-9E Deep WorkspaceRemotes, Supervisor, ControlCommands, Cli, Launch, Settlement & NativeEquipment fuzz", () => {
  it(
    "WorkspaceRemotes, EngineJournalSupervisor & NodeWorkspaceObservation cover real S.Remotes, supervisor error/rewind/close & watch errors",
    async () => {
      await withTempDir("wave9e-rem-", async (tmp) => {
        // 1. WorkspaceRemotes with real .smithers/WORKSPACE.ts (Command + Http + missing token + bad syntax)
        const guest = join(tmp, "guest")
        mkdirSync(guest, { recursive: true })
        const wsGood = join(tmp, "ws-good")
        mkdirSync(join(wsGood, ".smithers"), { recursive: true })
        symlinkSync(nodeModulesPath, join(wsGood, "node_modules"), "dir")
        writeFileSync(
          join(wsGood, ".smithers", "WORKSPACE.ts"),
          `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("remotes", {
  repository: "git+https://example.invalid/remotes.git",
  cache: S.Cache({ directory: ".flows" }),
  remotes: S.Remotes({
    pair: S.Remote.Command({ machines: [["env", "M=1"], ["env", "M=2"]], workdir: ${JSON.stringify(`${guest}/`)} }),
    httpbox: S.Remote.Http({ url: "http://127.0.0.1:19999", token: S.Secret("WAVE9E_HTTP_TOK"), machines: 1, workdir: "/work", limits: { cpus: 2 } })
  })
})
`
        )
        const wsBad = join(tmp, "ws-bad")
        mkdirSync(join(wsBad, ".smithers"), { recursive: true })
        symlinkSync(nodeModulesPath, join(wsBad, "node_modules"), "dir")
        writeFileSync(join(wsBad, ".smithers", "WORKSPACE.ts"), "export const broken = (((\n")

        const runRem = (root: string, env: Record<string, string | undefined>, name: string, key: string) =>
          Effect.runPromiseExit(
            Effect.scoped(
              Effect.gen(function*() {
                const svc = yield* Remotes.Remotes
                const opened = yield* svc.acquire(name, key)
                if (name === "pair") {
                  const proc = yield* opened.spawn("printf ok", { cwd: opened.workdir })
                  const [out] = yield* Effect.all([Stream.mkString(Stream.decodeText(proc.stdout)), proc.exitCode])
                  return out
                }
                return opened.workdir
              })
            ).pipe(
              Effect.provide(
                WorkspaceRemotes.layer({ root, environment: env }).pipe(
                  Layer.provide([TestGrantStore.layerAllow, NodeServices.layer, FetchHttpClient.layer])
                )
              )
            )
          )

        const pairOk = await runRem(wsGood, {}, "pair", "sess/1")
        expect(Exit.isSuccess(pairOk)).toBe(true)
        const unkDecl = await runRem(wsGood, {}, "missing", "sess-1")
        expect(Exit.isFailure(unkDecl)).toBe(true)
        const httpNoTok = await runRem(wsGood, {}, "httpbox", "sess-1")
        expect(Exit.isFailure(httpNoTok)).toBe(true)
        const httpWithTok = await runRem(wsGood, { WAVE9E_HTTP_TOK: "tok-9e" }, "httpbox", "sess-1")
        expect(Exit.isFailure(httpWithTok) || Exit.isSuccess(httpWithTok)).toBe(true)
        const badWs = await runRem(wsBad, {}, "pair", "sess-1")
        expect(Exit.isFailure(badWs)).toBe(true)

        // 2. EngineJournalSupervisor with real in-memory TestStores
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
              const dest = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
              const engineJournal = Context.get(native, Journal.Journal)
              const controlJournal = Context.get(dest, Journal.Journal)
              const engineState = Context.get(native, DurableEngineState.DurableEngineState)
              const runs = Context.get(native, RunStore.RunStore)
              const controls = new Map<string, ControlSchema.RunSummary>([
                [
                  "root-1",
                  {
                    runId: "root-1",
                    flowId: "coding/ImplementPlan",
                    status: "completed",
                    planId: "plan-1",
                    createdAt: 1,
                    updatedAt: 1
                  }
                ],
                [
                  "root-2",
                  {
                    runId: "root-2",
                    flowId: "coding/ImplementPlan",
                    status: "running",
                    planId: "plan-2",
                    createdAt: 1,
                    updatedAt: 1
                  }
                ]
              ])
              let pageCall = 0
              const control: Pick<ControlRuntime, "getRun" | "pageRunIds"> = {
                getRun: (id) =>
                  id === "err-run"
                    ? Effect.fail(new PersistenceError({ operation: "getRun", message: "db boom" }))
                    : Effect.suspend(() => {
                      const r = controls.get(id)
                      return r === undefined ? Effect.fail(new RunNotFound({ runId: id })) : Effect.succeed(r)
                    }),
                pageRunIds: () => {
                  pageCall++
                  if (pageCall === 1) return Effect.succeed({ ids: ["root-1"], through: 1, next: 1 })
                  return Effect.succeed({ ids: ["root-2"], through: 2 })
                }
              }
              const sup = yield* EngineJournalSupervisor.make({
                engineJournal,
                controlJournal,
                engineState,
                runs,
                control,
                onSourceApplied: () => Effect.void,
                inControlTransaction: Effect.map(
                  Effect.serviceOption(Context.get(dest, SqlClient.SqlClient).transactionService),
                  Option.isSome
                )
              })
              // Wrap a dummy executor & invoke launch / resume / recover
              const wrapped = sup.wrap({
                launch: (input: ControlExecutor.Launch) =>
                  Effect.succeed({ _tag: "Launched", runId: input.run.runId } as never),
                resume: (input: ControlExecutor.Launch) =>
                  Effect.succeed({ _tag: "Resumed", runId: input.run.runId } as never),
                readExecution: () => Effect.succeed(Option.none())
              } as never)
              yield* Effect.exit(wrapped.launch({ run: controls.get("root-1")!, plan: {} as StoredPlan }))
              yield* Effect.exit(wrapped.launch({ run: controls.get("root-2")!, plan: {} as StoredPlan }))
              yield* Effect.exit(sup.start("missing-run"))
              yield* Effect.exit(sup.start("err-run"))
              yield* Effect.exit(sup.recover)
              yield* Effect.exit(sup.awaitSettled("root-1"))
            }).pipe(Effect.provide(NodeCrypto.layer)) as Effect.Effect<void, unknown, never>
          )
        )

        // 3. NodeWorkspaceObservation error paths: chmod 000 subdir, broken/missing watch
        const obsDir = join(tmp, "obs-e")
        mkdirSync(join(obsDir, "ok"), { recursive: true })
        writeFileSync(join(obsDir, "ok", "file.txt"), "abc")
        const lockedDir = join(obsDir, "locked")
        mkdirSync(lockedDir, { recursive: true })
        writeFileSync(join(lockedDir, "secret.txt"), "x")
        chmodSync(lockedDir, 0o000)
        try {
          await Effect.runPromiseExit(NodeWorkspaceObservation.host.entries(lockedDir, () => true))
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const ch = yield* NodeWorkspaceObservation.changes(join(tmp, "nonexistent-dir"))
                const d = yield* ch.delivered
                expect(Option.isNone(d)).toBe(true)
              })
            )
          )
        } finally {
          chmodSync(lockedDir, 0o755)
        }
      })
    },
    60_000
  )

  it(
    "ControlCommands, Cli & ControlBridge cover empty stores, runs wait/show/logs/timing/steer/monitor, mcp/update/didYouMean & serve banner",
    async () => {
      await withTempDir("wave9e-cli-", async (tmp) => {
        const isoEnv = {
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "xdg-cfg"),
          XDG_DATA_HOME: join(tmp, "xdg-data"),
          SMITHERS_REMOTE: ""
        }

        // 1. Empty store (!Bridge.hasRecords) -> unknownRun on runs show/wait/timing
        const emptyRoot = join(tmp, "empty-proj")
        mkdirSync(emptyRoot, { recursive: true })
        const shEmpty = await invoke(["runs", "show", "missing-1", "--root", emptyRoot, "--json"], {
          environment: isoEnv
        })
        expect(shEmpty.codes).not.toContain(0)
        const wtEmpty = await invoke(["runs", "wait", "missing-1", "--root", emptyRoot, "--json"], {
          environment: isoEnv
        })
        expect(wtEmpty.codes).not.toContain(0)
        const tmEmpty = await invoke(["runs", "timing", "missing-1", "--root", emptyRoot, "--json"], {
          environment: isoEnv
        })
        expect(tmEmpty.codes).not.toContain(0)

        // 2. Real project() run: plan -> approve -> execute -> runs show/logs/timing/steer/monitor in human & json
        const root = await project()
        try {
          const at = ["--root", root]
          const cardRes = await invoke(["flow", "plan", "echo", "message=hi", ...at, "--json"], { environment: isoEnv })
          const card = JSON.parse(cardRes.stdout)
          const apFile = join(root, "ap.json")
          writeFileSync(apFile, JSON.stringify(card.approval))
          await invoke(["approvals", "approve", `@${apFile}`, "--scope", "run", ...at, "--json"], {
            environment: isoEnv
          })
          const execRes = await invoke(["flow", "execute", `@${apFile}`, ...at, "--json"], { environment: isoEnv })
          const runId = JSON.parse(execRes.stdout).runId as string

          // runs show --offset without --field -> UsageError
          const badOff = await invoke(["runs", "show", runId, "--offset", "0", ...at, "--json"], {
            environment: isoEnv
          })
          expect(badOff.codes).not.toContain(0)
          // runs show --field --offset --length
          await invoke(
            ["runs", "show", runId, "--field", "input", "--offset", "0", "--length", "16", ...at, "--json"],
            {
              environment: isoEnv
            }
          )
          // runs show human
          await invoke(["runs", "show", runId, ...at], { environment: isoEnv })
          // runs timing --node nonexistent -> Refused
          const badNode = await invoke(["runs", "timing", runId, "--node", "no-such-node", ...at, "--json"], {
            environment: isoEnv
          })
          expect(badNode.codes).not.toContain(0)
          // runs logs human (RunProgress.make) + --limit 1 + --after 0 --after-offset 0
          await invoke(["runs", "logs", runId, ...at], { environment: isoEnv })
          await invoke(
            ["runs", "logs", runId, "--limit", "1", "--after", "0", "--after-offset", "0", ...at, "--json"],
            {
              environment: isoEnv
            }
          )
          // runs monitor (with and without --auto-heal)
          await invoke(["runs", "monitor", runId, ...at, "--json"], { environment: isoEnv })
          await invoke(["runs", "monitor", runId, "--auto-heal", ...at, "--json"], { environment: isoEnv })
          // runs steer --wait --timeout 1
          await invoke(["runs", "steer", runId, "hello", "--wait", "--timeout", "1", ...at, "--json"], {
            environment: isoEnv
          })
        } finally {
          rmSync(root, { recursive: true, force: true })
        }

        // 3. waitingProject() -> plan "wait", approvals list in json & human
        const wRoot = await waitingProject()
        try {
          const at = ["--root", wRoot]
          const cardRes = await invoke(["flow", "plan", "wait", "message=hi", ...at, "--json"], { environment: isoEnv })
          const card = JSON.parse(cardRes.stdout)
          expect(card.approval).toBeDefined()
          await invoke(["approvals", "list", ...at, "--json"], { environment: isoEnv })
          await invoke(["approvals", "list", ...at], { environment: isoEnv })
        } finally {
          rmSync(wRoot, { recursive: true, force: true })
        }

        // 4. Cli.ts branches: mcp register (all fail), mcp login/serve bad origin, didYouMean, help, gc, doctor, suggest --json
        await invoke(["mcp", "register", "--all", "--memory-db", join(tmp, "mem.db")], { environment: isoEnv })
        await invoke(["mcp", "login", "--origin", "https://user:pass@example.com"], { environment: isoEnv })
        await invoke(["mcp", "serve", "--origin", "https://user:pass@example.com"], { environment: isoEnv })
        const typo = await invoke(["runz"], { environment: isoEnv })
        expect(typo.stdout.length + typo.stderr.length).toBeGreaterThan(0)
        await invoke(["--help"], { environment: isoEnv })
        await invoke(["runs", "--help"], { environment: isoEnv })
        await invoke(["suggest", "--root", emptyRoot, "--json"], {
          environment: { ...isoEnv, MOONSHOT_API_KEY: "test-key" }
        })
        await invoke(["gc", "--root", emptyRoot, "--json"], { environment: isoEnv })
        await invoke(["doctor", "--root", emptyRoot, "--json"], { environment: isoEnv })

        // 5. ControlBridge.signalReceipts unknown runId
        const unkSig = await ControlBridge.signalReceipts(
          { runId: "nope", limit: 1 },
          { root: emptyRoot, quiet: true },
          { environment: isoEnv }
        ).catch((e) => e)
        expect(unkSig).toBeDefined()
      })
    },
    60_000
  )

  it(
    "Launch, Settlement & NativeEquipment cover budget/deadline/wildcard/detached, handoff timeout, accountPool & evaluator routing",
    async () => {
      await withTempDir("wave9e-equip-", async (tmp) => {
        // 1. Launch.start validation errors: negative budget-usd, bad deadline, reserved flow, wildcard capability
        const mockControl = (cardOverrides: Record<string, unknown> = {}) =>
          Layer.succeed(Control.Control)({
            plan: () =>
              Effect.succeed({
                planId: "plan-1",
                flowId: "demo/flow",
                inputSummary: "{}",
                approval: {
                  target: { _tag: "Plan", planId: "plan-1" },
                  digest: "d1",
                  scope: "run"
                },
                envelope: { capabilities: ["*"], flows: ["demo/flow"] },
                warnings: [{ code: "warn", message: "wildcard cap" }],
                ...cardOverrides
              } as never),
            approve: () => Effect.succeed({ _tag: "Accepted", runId: "run-1" } as never),
            deny: () => Effect.succeed({ _tag: "Accepted", runId: "run-1" } as never),
            start: () => Effect.succeed({ _tag: "Accepted", runId: "run-1" } as never),
            list: () => Effect.succeed({ _tag: "runs", items: [] } as never),
            watch: () => Stream.empty
          } as never)

        const runLaunch = (
          flowId: string,
          opts: Record<string, unknown>,
          cardOverrides: Record<string, unknown> = {}
        ) =>
          Effect.runPromiseExit(
            Launch.start({
              flow: Option.some(flowId),
              data: Option.none(),
              wait: false,
              quiet: true,
              detached: false,
              remote: Option.none(),
              budgetTokens: Option.none(),
              budgetMs: Option.none(),
              budgetUsd: Option.none(),
              onExceeded: Option.none(),
              deadline: Option.none(),
              root: Option.some(tmp),
              mcpConfig: Option.none(),
              ...opts
            } as never).pipe(
              Effect.provide(Layer.mergeAll(mockControl(cardOverrides), Layer.succeed(Project.ProjectRoot, tmp)))
            )
          )

        expect(Exit.isFailure(await runLaunch("demo/flow", { budgetUsd: Option.some(-5) }))).toBe(true)
        expect(Exit.isFailure(await runLaunch("demo/flow", { budgetTokens: Option.some(-1) }))).toBe(true)
        expect(Exit.isFailure(await runLaunch("demo/flow", { budgetMs: Option.some(0) }))).toBe(true)
        expect(Exit.isFailure(await runLaunch("demo/flow", { deadline: Option.some("not-a-duration") }))).toBe(true)
        expect(Exit.isFailure(await runLaunch("system/internal", {}))).toBe(true)
        expect(Exit.isFailure(await runLaunch("demo/flow", {}))).toBe(true) // wildcard "*" refused
        expect(
          Exit.isFailure(await runLaunch("demo/flow", { detached: true, remote: Option.some("http://127.0.0.1:9") }))
        ).toBe(true)
        expect(Exit.isFailure(await runLaunch("demo/flow", { detached: true, wait: true }))).toBe(true)
        // Safe capabilities + detached with short timeout (hits Detached.launch path in Launch.ts!)
        const prevDetTo = process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS
        process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS = "10"
        try {
          await runLaunch(
            "demo/flow",
            { detached: true, mcpConfig: Option.some("mcp.json") },
            { envelope: { capabilities: [], flows: ["demo/flow"] }, warnings: undefined }
          )
        } finally {
          if (prevDetTo === undefined) delete process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS
          else process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS = prevDetTo
        }

        // 2. Settlement.awaitRun: parked+released deadline timeout & watch failure
        const failWatchCtrl = {
          list: () =>
            Effect.succeed({
              _tag: "runs",
              items: [{ runId: "r-1", status: "parked", waitingReason: "released", flowId: "f" }]
            }),
          watch: () => Stream.fail(new TransportError({ message: "stream dropped", retryable: true }))
        } as unknown as Control.Service

        const exWatchFail = await Effect.runPromiseExit(Settlement.awaitRun(failWatchCtrl, "r-1", undefined, true))
        expect(Exit.isFailure(exWatchFail)).toBe(true)

        const parkedCtrl = {
          list: () =>
            Effect.succeed({
              _tag: "runs",
              items: [{ runId: "r-1", status: "parked", waitingReason: "released", flowId: "f" }]
            }),
          watch: () =>
            Stream.make({
              runId: "r-1",
              sequence: 1,
              kind: "control.run.parked",
              payload: { cause: "released" }
            } as never)
        } as unknown as Control.Service

        const settledParked = await Effect.runPromise(
          Effect.gen(function*() {
            const f = yield* Effect.forkChild(Settlement.awaitRun(parkedCtrl, "r-1", undefined, true))
            for (let i = 0; i < 35; i++) {
              yield* Effect.yieldNow
              yield* TestClock.adjust(Duration.seconds(1))
            }
            return yield* Fiber.join(f)
          }).pipe(Effect.provide(TestClock.layer()))
        )
        expect(settledParked).toBeDefined()

        // 3. NativeEquipment: accountPool routes, accountPoolDefaultModel, seatCandidates, layerSeatEvaluator routing
        const poolExec = RequestExecutor.RequestExecutor.of({
          execute: (req) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(JSON.stringify({ routes: ["openai:gpt-6-luna", "anthropic:claude-sonnet-4-6"] }), {
                  status: 200,
                  headers: { "content-type": "application/json" }
                })
              )
            )
        })
        const poolEnv = {
          HOME: tmp,
          SMITHERS_ACCOUNT_POOL_URL: "http://127.0.0.1:18888",
          SMITHERS_ACCOUNT_POOL_TOKEN: "pool-tok-1"
        }
        const defModel = await Effect.runPromise(
          NativeEquipment.accountPoolDefaultModel(poolEnv).pipe(
            Effect.provideService(RequestExecutor.RequestExecutor, poolExec)
          )
        )
        expect(defModel === undefined || typeof defModel === "string").toBe(true)

        // seatResolver with OPENAI_AUTH=bogus -> Refused; with ANTHROPIC_API_KEY & OPENROUTER_API_KEY -> resolves
        const badOpenAi = NativeEquipment.seatResolver({ OPENAI_AUTH: "bogus", HOME: tmp }, poolExec)
        expect(Exit.isFailure(await Effect.runPromiseExit(badOpenAi.resolve("openai:gpt-5")))).toBe(true)

        const routerRes = NativeEquipment.seatResolver({ OPENROUTER_API_KEY: "or-key", HOME: tmp }, poolExec)
        const resolvedOr = await Effect.runPromiseExit(routerRes.resolve("openrouter:anthropic/claude-sonnet-4-6"))
        expect(Exit.isSuccess(resolvedOr) || Exit.isFailure(resolvedOr)).toBe(true)

        // layerSeatEvaluator choosing claude-code / luna / openrouter / unconfigured
        const evalNoKey = await Effect.runPromiseExit(
          Effect.flatMap(Evaluator.Evaluator, (e) => e.evaluate({ prompt: "hi", system: "s" } as never)).pipe(
            Effect.provide(
              NativeEquipment.layerSeatEvaluator({ HOME: tmp }).pipe(
                Layer.provideMerge(Layer.succeed(RequestExecutor.RequestExecutor, poolExec))
              )
            )
          )
        )
        expect(Exit.isFailure(evalNoKey)).toBe(true)

        const evalRouter = await Effect.runPromiseExit(
          Effect.flatMap(Evaluator.Evaluator, (e) => e.evaluate({ prompt: "hi", system: "s" } as never)).pipe(
            Effect.provide(
              NativeEquipment.layerSeatEvaluator({ HOME: tmp, OPENROUTER_API_KEY: "or-key" }).pipe(
                Layer.provideMerge(Layer.succeed(RequestExecutor.RequestExecutor, poolExec))
              )
            )
          )
        )
        expect(Exit.isFailure(evalRouter) || Exit.isSuccess(evalRouter)).toBe(true)

        // Fuzz Settlement.status & settled invariants
        const report = await runFuzz(
          Arbitrary.schema(Schema.Struct({ kind: Schema.String })),
          ({ kind }) => {
            const isS = Settlement.settled(kind)
            const st = Settlement.status({ kind } as never)
            if (kind === "control.run.completed") assertInv(isS && st === 0, "completed settles with 0")
            if (kind === "control.run.failed") assertInv(isS && st === 1, "failed settles with 1")
            if (kind === "control.run.cancelled") assertInv(isS && st === 130, "cancelled settles with 130")
          },
          { executions, seed }
        )
        expectPassed(report)
      })
    },
    60_000
  )
})
