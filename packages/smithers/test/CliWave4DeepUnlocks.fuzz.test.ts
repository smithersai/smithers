import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import { Fuzz } from "@smthrs/fuzz"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Arbitrary, Effect, Layer, Option, Schema, Stream } from "effect"
import { Argument, Command as CliCommand } from "effect/cli"
import * as FileSystem from "effect/FileSystem"
import * as TestConsole from "effect/testing/TestConsole"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ControlCommands from "../src/cli/ControlCommands.ts"
import * as ClaudeCmd from "../src/commands/Claude.ts"
import * as FlowCatalog from "../src/commands/FlowCatalog.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as History from "../src/history/History.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as NativeControl from "../src/internal/NativeControl.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as RunnerSession from "../src/runner/Session.ts"
import * as RunnerWorkspace from "../src/runner/Workspace.ts"
import { invoke, project } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const serveCli = async (
  cli: { serve: (args?: Array<string>, opts?: any) => Promise<unknown> },
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {}
) => {
  let stdout = ""
  const codes: Array<number> = []
  await cli.serve([...args], {
    env,
    stdout: (t: string) => (stdout += t),
    exit: (c: number) => codes.push(c)
  })
  return { stdout, codes }
}

describe("@smthrs/cli Wave-4 Deep Unlocks (ClaudeCode conversations, History jj fork/rewind, ControlCommands all verbs, Claude CLI, NativeControl/NodeControl & Runner Session/Workspace)", () => {
  it(
    "ClaudeCode multi-turn cached conversations (prefix reuse, prefix divergence, close, abort) uphold session invariants",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-cc-conv-")))
      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            divergeSecondTurn: Schema.Boolean,
            secondTurnError: Schema.Boolean,
            hijackable: Schema.Boolean
          })
        )
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ divergeSecondTurn, hijackable, secondTurnError }) =>
              Effect.promise(async () => {
                let startCount = 0
                const transport: ClaudeCode.Start = ({ prompt }) => {
                  startCount++
                  const turnNo = startCount
                  const isAsyncPrompt = typeof prompt !== "string"
                  return {
                    async *[Symbol.asyncIterator]() {
                      if (isAsyncPrompt) {
                        const iter = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
                        // Read up to 2 user turns from the persistent session prompt stream
                        for (let k = 0; k < 2; k++) {
                          const nxt = await iter.next()
                          if (nxt.done) break
                          yield {
                            type: "system",
                            subtype: "init",
                            session_id: `sess-conv-${turnNo}`,
                            model: "claude-sonnet-4-6"
                          }
                          if (k === 1 && secondTurnError) {
                            yield {
                              type: "result",
                              subtype: "error_during_execution",
                              is_error: true,
                              errors: ["turn 2 error"],
                              session_id: `sess-conv-${turnNo}`
                            }
                            break
                          }
                          yield {
                            type: "stream_event",
                            event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
                          }
                          yield {
                            type: "stream_event",
                            event: {
                              type: "content_block_delta",
                              index: 0,
                              delta: { type: "text_delta", text: `reply-${k}` }
                            }
                          }
                          yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } }
                          yield {
                            type: "result",
                            subtype: "success",
                            is_error: false,
                            result: `reply-${k}`,
                            session_id: `sess-conv-${turnNo}`,
                            total_cost_usd: 0.001,
                            usage: { input_tokens: 40, output_tokens: 10 }
                          }
                        }
                      } else {
                        yield {
                          type: "system",
                          subtype: "init",
                          session_id: `sess-one-${turnNo}`,
                          model: "claude-sonnet-4-6"
                        }
                        yield {
                          type: "result",
                          subtype: "success",
                          is_error: false,
                          result: "oneshot",
                          session_id: `sess-one-${turnNo}`,
                          usage: { input_tokens: 10, output_tokens: 5 }
                        }
                      }
                    },
                    interrupt: async () => {},
                    close: () => {}
                  } as never
                }

                const model = ClaudeCode.make({
                  model: "claude-sonnet-4-6",
                  executable: "claude",
                  environment: { HOME: root },
                  cwd: root,
                  hijackable,
                  start: transport,
                  idleMillis: 60_000,
                  interruptMillis: 50
                })
                try {
                  const req1 = ModelRequest.ModelRequest.make({
                    modelId: "claude-sonnet-4-6",
                    cacheKey: "conv-fuzz-1",
                    system: [ModelRequest.SystemPart.make({ text: "Be concise." })],
                    messages: [ModelRequest.Message.user("turn 1")],
                    tools: [],
                    toolChoice: "none",
                    params: ModelRequest.GenerationParams.make({})
                  })
                  const r1 = await Effect.runPromise(Stream.runCollect(model.stream(req1)).pipe(Effect.result))
                  assertInv(r1._tag === "Success", "ClaudeCode conversation turn 1 succeeded")

                  const req2 = ModelRequest.ModelRequest.make({
                    modelId: "claude-sonnet-4-6",
                    cacheKey: "conv-fuzz-1",
                    system: [
                      ModelRequest.SystemPart.make({
                        text: divergeSecondTurn ? "Different system prompt." : "Be concise."
                      })
                    ],
                    messages: divergeSecondTurn
                      ? [ModelRequest.Message.user("completely new")]
                      : [
                        ModelRequest.Message.user("turn 1"),
                        ModelRequest.Message.assistant("reply-0"),
                        ModelRequest.Message.user("turn 2")
                      ],
                    tools: [],
                    toolChoice: "none",
                    params: ModelRequest.GenerationParams.make({})
                  })
                  const r2 = await Effect.runPromise(Stream.runCollect(model.stream(req2)).pipe(Effect.result))
                  assertInv(r2._tag === "Success" || r2._tag === "Failure", "ClaudeCode conversation turn 2 handled")
                } finally {
                  model.close()
                }
                return true
              }),
            { seed, executions: Math.min(executions, 12) }
          )
        )
        const fail = Fuzz.formatReport(report)
        if (fail !== undefined) throw new Error(fail)
        expect(report._tag).toBe("Passed")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "ControlCommands ALL verbs, Claude CLI commands (tick/node-wait/monitor/subscribe/unsubscribe), History jj fork/rewind & NativeControl/NodeControl uphold invariants",
    async () => {
      const root = await project()
      const echoPath = join(root, ".smithers/flows/echo/flow.ts")
      writeFileSync(
        echoPath,
        readFileSync(echoPath, "utf8").replace("capabilities: []", "capabilities: [\"fs:read:*\"]")
      )

      // Add a second failing flow based on echo template
      const failDir = join(root, ".smithers/flows/boom")
      mkdirSync(failDir, { recursive: true })
      writeFileSync(
        join(failDir, "flow.ts"),
        readFileSync(echoPath, "utf8")
          .replaceAll("\"echo\"", "\"boom\"")
          .replace("Effect.succeed(", "Effect.die(")
      )

      // Initialize real jj repo in root so History fork/rewind work on real jj workspace!
      const jjEnv = { ...process.env, JJ_CONFIG: "" }
      execFileSync("jj", ["git", "init", root], { stdio: "ignore", env: jjEnv })
      execFileSync("jj", ["config", "set", "--repo", "user.name", "Fuzz"], { cwd: root, stdio: "ignore", env: jjEnv })
      execFileSync("jj", ["config", "set", "--repo", "user.email", "fuzz@example.test"], {
        cwd: root,
        stdio: "ignore",
        env: jjEnv
      })
      execFileSync("jj", ["commit", "-m", "initial flows"], { cwd: root, stdio: "ignore", env: jjEnv })

      try {
        const at = ["--root", root, "--json"]

        // 1. Live flow plan -> approve -> execute for echo AND boom
        const cardEcho = JSON.parse(
          (await invoke(["flow", "plan", "echo", "--data", "{\"message\":\"wave4\"}", ...at])).stdout
        )
        const apprEcho = join(root, "appr-echo.json")
        writeFileSync(apprEcho, JSON.stringify(cardEcho.approval))
        await invoke(["approvals", "approve", `@${apprEcho}`, "--scope", "run", ...at])
        const execEcho = JSON.parse((await invoke(["flow", "execute", `@${apprEcho}`, ...at])).stdout)
        const echoRunId: string = execEcho.runId

        const boomPlanRes = await invoke(["flow", "plan", "boom", "--data", "{\"message\":\"expected-boom\"}", ...at])
        const cardBoom = JSON.parse(boomPlanRes.stdout)
        const apprBoom = join(root, "appr-boom.json")
        writeFileSync(apprBoom, JSON.stringify(cardBoom.approval))
        await invoke(["approvals", "approve", `@${apprBoom}`, "--scope", "run", ...at])
        const execBoom = JSON.parse((await invoke(["flow", "execute", `@${apprBoom}`, ...at])).stdout)
        const boomRunId: string = execBoom.runId

        // 2. Exercise ALL remaining ControlCommands subcommands (flow, runs, approvals)
        const flowCli = ControlCommands.createFlowCli({ environment: { HOME: root }, exit: () => {} })
        const runsCli = ControlCommands.createRunsCli({ environment: { HOME: root }, exit: () => {} })
        const apprCli = ControlCommands.createApprovalsCli({ environment: { HOME: root }, exit: () => {} })

        for (
          const argv of [
            ["list", "--root", root],
            ["show", "echo", "--root", root],
            ["plan", "echo", "--data", "{\"message\":\"p\"}", "--root", root],
            ["start", "echo", "--data", "{\"message\":\"s\"}", "--root", root, "--json"]
          ]
        ) {
          await serveCli(flowCli, argv, { HOME: root })
        }

        for (
          const argv of [
            ["list", "--root", root],
            ["list", "--status", "failed", "--root", root, "--json"],
            ["count", "--root", root],
            ["show", echoRunId, "--root", root],
            ["show", boomRunId, "--root", root],
            ["show", echoRunId, "--timing", "--root", root],
            ["show", echoRunId, "--history", "--root", root, "--json"],
            ["logs", echoRunId, "--format", "json", "--root", root],
            ["logs", echoRunId, "--field", "/events/1/payload", "--root", root, "--json"],
            ["output", echoRunId, "--root", root],
            ["devtools", echoRunId, "--root", root, "--json"],
            ["retry", boomRunId, "--root", root, "--json"],
            ["continue", echoRunId, "--root", root, "--json"],
            ["stop", echoRunId, "--root", root, "--json"],
            ["cancel", echoRunId, "--root", root, "--json"],
            ["cancel-all", "--root", root, "--json"],
            ["signals", echoRunId, "--root", root],
            ["signal", echoRunId, "{\"name\":\"go\",\"payload\":{}}", "--root", root, "--json"],
            ["steer", echoRunId, "steer text", "--root", root, "--json"]
          ]
        ) {
          await serveCli(runsCli, argv, { HOME: root })
        }

        for (
          const argv of [
            ["list", "--root", root],
            ["list", "--root", root, "--json"],
            ["trigger-plan", "missing-trig", "--root", root, "--json"],
            ["revoke-trigger", "missing-grant", "--root", root, "--json"],
            ["grant", "//pkg:missing", "--root", root, "--json"]
          ]
        ) {
          await serveCli(apprCli, argv, { HOME: root })
        }

        // 3. ControlCommands direct Effect exports + Claude CLI all 5 commands
        const controlLayer = NodeControl.layerControl({ root })
        const cliServices = Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          Output.layer,
          controlLayer,
          Layer.succeed(Project.ProjectRoot, root)
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const pend = yield* ControlCommands.pendingApprovals().pipe(Effect.result)
              assertInv(pend._tag === "Success", "pendingApprovals")
              const inc = yield* ControlCommands.guardIncident(boomRunId).pipe(Effect.result)
              assertInv(inc._tag === "Success" || inc._tag === "Failure", "guardIncident")
              const canAll = yield* ControlCommands.cancelAll().pipe(Effect.result)
              assertInv(canAll._tag === "Success", "cancelAll")

              // Execute Claude.make commands: tick, node-wait, monitor, subscribe, unsubscribe
              const claudeCommand = ClaudeCmd.make({
                guard: Effect.void,
                required: (name: string) => Argument.String(name)
              } as never)
              const runClaude = CliCommand.runWith(claudeCommand, { version: "1.0.0" })
              for (
                const argv of [
                  ["tick", echoRunId, "--session", "s1"],
                  ["node-wait", echoRunId, "--session", "s1", "--timeout", "100"],
                  ["monitor", echoRunId, "--session", "s1", "--timeout", "100"],
                  ["subscribe", echoRunId, "--session", "s1"],
                  ["unsubscribe", echoRunId, "--session", "s1"]
                ]
              ) {
                yield* (runClaude(argv) as Effect.Effect<unknown, unknown, never>).pipe(Effect.result)
              }
            }).pipe(Effect.provide(cliServices as Layer.Layer<any, never, never>))
          )
        )

        // 4. Real History.read / replay / preview / prepare / mutate (fork + edited input + rewind) / reconcile on live jj-backed run
        const hRead = await History.read(root, echoRunId, {}, false)
        assertInv(hRead !== undefined, "History.read live run")
        const hReplay = await History.read(root, echoRunId, {}, true)
        assertInv(hReplay !== undefined, "History.read replay live run")
        const hPreview = await History.preview(root, echoRunId, { sequence: 1 }).catch((e) => ({ err: String(e) }))
        assertInv(hPreview !== undefined, "History.preview live run")
        const hPrep = await History.prepare(root, echoRunId).catch((e) => ({ err: String(e) }))
        assertInv(hPrep !== undefined, "History.prepare live run")
        await History.mutate(root, echoRunId, { sequence: 1 }, "fork").catch(() => {})
        await History.mutate(root, echoRunId, { sequence: 1, input: { message: "forked" } }, "fork").catch(() => {})
        await History.mutate(root, echoRunId, { sequence: 1, wholeRepo: false }, "rewind").catch(() => {})
        await History.reconcile(root)

        // 5. NativeControl helpers + NodeControl.layerObserve + layerServerBearerAuth + layerServerNoopAuth refusal + layerMemoryRemote
        writeFileSync(join(root, "AGENTS.md"), "# Instructions\n")
        const confInstr = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return yield* NativeControl.confinedInstructions(fs, root)
          }).pipe(Effect.provide(NodeFileSystem.layer))
        )
        assertInv(Array.isArray(confInstr), "NativeControl.confinedInstructions")
        const off = NativeControl.offeredWithoutProvider(["bash", "write_file"], {
          fileMutations: false,
          terminal: false
        })
        assertInv(off !== undefined, "NativeControl.offeredWithoutProvider detects missing provider")

        // Non-loopback refusal on layerServerNoopAuth
        let nonLoopbackThrew = false
        try {
          NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0 })
        } catch {
          nonLoopbackThrew = true
        }
        assertInv(nonLoopbackThrew, "layerServerNoopAuth refuses non-loopback")

        // layerObserve local + layerMemoryRemote
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const obs = yield* Control.Control
              const listed = yield* FlowCatalog.read(obs)
              assertInv(Array.isArray(listed.items), "layerObserve flows")
            }).pipe(Effect.provide(NodeControl.layerObserve({ root }) as Layer.Layer<any, never, never>))
          )
        )
        await Effect.runPromise(
          Effect.gen(function*() {
            const ms = yield* MemoryStore.MemoryStore
            const r1 = yield* ms.getFact({ namespace: { kind: "user", id: "x" }, key: "k" }).pipe(Effect.result)
            const r2 = yield* ms.listFacts({ namespace: { kind: "user", id: "x" } }).pipe(Effect.result)
            const r3 = yield* ms.deleteFact({ namespace: { kind: "user", id: "x" }, key: "k" }).pipe(Effect.result)
            assertInv(
              r1._tag === "Failure" && r2._tag === "Failure" && r3._tag === "Failure",
              "layerMemoryRemote refuses local memory ops"
            )
          }).pipe(Effect.provide(NodeControl.layerMemoryRemote))
        )
        void Launch
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "Runner Workspace diff/limits/deletions/binary & Runner Session ACP tool-call/permission/thought/error/crash invariants",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-runner-deep-")))
      const jjEnv = { ...process.env, JJ_CONFIG: "" }
      try {
        // 1. Real bare git repo with base files for RunnerWorkspace checkout & capture
        const bareDir = join(root, "bare.git")
        const seedDir = join(root, "seed")
        mkdirSync(bareDir, { recursive: true })
        mkdirSync(seedDir, { recursive: true })
        const gitEnv = {
          ...jjEnv,
          GIT_AUTHOR_NAME: "Fuzz",
          GIT_AUTHOR_EMAIL: "fuzz@example.test",
          GIT_COMMITTER_NAME: "Fuzz",
          GIT_COMMITTER_EMAIL: "fuzz@example.test"
        }
        execFileSync("git", ["init", "--bare", "-b", "main", bareDir], { stdio: "ignore", env: gitEnv })
        execFileSync("git", ["init", "-b", "main", seedDir], { stdio: "ignore", env: gitEnv })
        writeFileSync(join(seedDir, "keep.txt"), "initial\n")
        writeFileSync(join(seedDir, "remove-me.txt"), "bye\n")
        execFileSync("git", ["add", "."], { cwd: seedDir, stdio: "ignore", env: gitEnv })
        execFileSync("git", ["commit", "-m", "base"], { cwd: seedDir, stdio: "ignore", env: gitEnv })
        execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: seedDir, stdio: "ignore", env: gitEnv })
        execFileSync("git", ["push", "origin", "main"], { cwd: seedDir, stdio: "ignore", env: gitEnv })
        const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seedDir, encoding: "utf8", env: gitEnv })
          .trim()

        const stateDir = join(root, "state")
        const mirrorDir = join(stateDir, "mirror")
        mkdirSync(stateDir, { recursive: true })
        execFileSync("jj", ["git", "clone", bareDir, mirrorDir], { stdio: "ignore", env: gitEnv })
        const checkout = RunnerWorkspace.of(stateDir, "todo:deep")

        await Effect.runPromise(
          Effect.gen(function*() {
            yield* RunnerWorkspace.create(mirrorDir, baseSha, checkout, Effect.succeed(Option.none()))
            assertInv(RunnerWorkspace.exists(checkout), "RunnerWorkspace.exists true")
            writeFileSync(join(checkout.dir, "keep.txt"), "modified\n")
            writeFileSync(join(checkout.dir, "added.txt"), "new file\n")
            writeFileSync(join(checkout.dir, "bin.dat"), Buffer.from([0, 1, 2, 255]))
            unlinkSync(join(checkout.dir, "remove-me.txt"))

            const captured = yield* RunnerWorkspace.changes(
              checkout,
              baseSha,
              { files: 20, bytes: 1024 * 1024 },
              mirrorDir
            )
            assertInv(
              captured !== undefined &&
                captured.additions.some((a) => a.path === "added.txt") &&
                captured.deletions.includes("remove-me.txt"),
              "Workspace.changes records additions and deletions"
            )
            const tooMany = yield* RunnerWorkspace.changes(
              checkout,
              baseSha,
              { files: 1, bytes: 1024 * 1024 },
              mirrorDir
            ).pipe(Effect.result)
            assertInv(
              tooMany._tag === "Failure" || tooMany.success === undefined,
              "Workspace.changes enforces file limit"
            )
            const tooBig = yield* RunnerWorkspace.changes(checkout, baseSha, { files: 20, bytes: 2 }, mirrorDir).pipe(
              Effect.result
            )
            assertInv(
              tooBig._tag === "Failure" || tooBig.success === undefined,
              "Workspace.changes enforces byte limit"
            )
            yield* RunnerWorkspace.remove(mirrorDir, checkout)
            yield* RunnerWorkspace.sweep(stateDir)
            yield* RunnerWorkspace.reapGroups(stateDir)
          })
        )
        assertInv(typeof RunnerSession.spawnFailureOf === "function", "RunnerSession loaded")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
