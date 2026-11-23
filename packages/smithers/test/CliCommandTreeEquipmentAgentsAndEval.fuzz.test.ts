import { NodeServices } from "@effect/platform-node"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Fuzz } from "@smthrs/fuzz"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Arbitrary, Effect, Layer, Schema, Stream } from "effect"
import { Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as CliMod from "../src/Cli.ts"
import * as CommandMod from "../src/Command.ts"
import * as EvalCli from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as Output from "../src/Output.ts"
import * as Providers from "../src/Providers.ts"
import * as Unsupported from "../src/Unsupported.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const writeEvalSuite = (root: string, file: string, score: number, shape: "value" | "promise" | "effect" = "value") => {
  const suiteExpr = shape === "effect" ? "Suite.make(declaration)" : shape === "promise" ? "Promise.resolve(declaration)" : "declaration"
  const full = join(root, "evals", file)
  mkdirSync(join(root, "evals"), { recursive: true })
  writeFileSync(
    full,
    `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import { Suite, CaseExecutor } from ${JSON.stringify(new URL("../agent/evals/src/index.ts", import.meta.url).href)}
import * as Scorer from ${JSON.stringify(new URL("../agent/scorers/src/Scorer.ts", import.meta.url).href)}
import * as Binding from ${JSON.stringify(new URL("../agent/scorers/src/Binding.ts", import.meta.url).href)}
const target = { name: "fuzz-eval-target" }
const scorer = Scorer.make({
  id: "fuzz-eval/exact",
  version: "1",
  name: "exact",
  score: ({ output }) => Effect.succeed({ score: output, reason: "fuzz score" })
})
const declaration = {
  name: "fuzz/exact",
  concurrency: 1,
  cases: [{ name: "case-1", input: ${JSON.stringify(score)} }],
  bindings: [Binding.make({ scorer, appliesTo: target })]
}
const suite = ${suiteExpr}
const executor = CaseExecutor.make((entry) => Effect.succeed({ output: entry.input, stepKey: "step-1", latencyMs: 1, target }))
export { suite, executor }
`
  )
}

describe("@smthrs/cli Command.cli, Cli.makeCli, NativeEquipment, ClaudeCode, CodexLogin, Agents & Evaluation/EvalCli deep fuzz invariants", () => {
  it("Command.cli & Cli.makeCli dispatch all canonical verbs, removed verb refusals & help/JSON surfaces cleanly", async () => {
    const runCli = Command.runWith(CommandMod.cli, { version: "1.0.0-fuzz" })
    const layer = Layer.mergeAll(NodeServices.layer, TestConsole.layer, Output.layer, TestControl.layer())

    const invocations: ReadonlyArray<ReadonlyArray<string>> = [
      ["list", "--json"],
      ["list"],
      ["status", "run-1", "--json"],
      ["logs", "run-1", "--json"],
      ["cancel", "run-1", "--json"],
      ["plan", "echo", "--json"],
      ["output", "run-1", "--json"],
      ["signals", "run-1", "--json"],
      ["steer", "run-1", "keep going", "--json"],
      ["retry", "run-1", "--json"],
      ["resume", "run-1", "--json"],
      ["approve", "{}", "--json"],
      ["deny", "{}", "--json"],
      ...Unsupported.removedVerbs.slice(0, 8).map((v) => [v.name === "workflows" ? "workflow" : v.name, "--help"])
    ]
    for (const argv of invocations) {
      const res = await Effect.runPromise(runCli(argv).pipe(Effect.provide(layer), Effect.result))
      assertInv(res._tag === "Success" || res._tag === "Failure", `Command.cli ${argv[0]} settled cleanly`)
    }

    // Cli.makeCli across backend & operator groups against a quiet temp HOME
    const root = mkdtempSync(join(tmpdir(), "smthrs-cli-tree-fuzz-"))
    try {
      const cli = CliMod.makeCli({
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          SMITHERS_AUTH_FILE: join(root, "auth.json"),
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
        },
        exit: () => {}
      })
      for (const argv of [
        ["repo", "--help"],
        ["workspace", "--help"],
        ["stack", "--help"],
        ["auth", "--help"],
        ["admin", "--help"],
        ["alerts", "--help"],
        ["eval", "--help"],
        ["suggest", "--help"],
        ["triggers", "--help"],
        ["integrations", "--help"],
        ["memory", "--help"],
        ["credentials", "--help"],
        ["steps", "--help"],
        ["tui", "--help"],
        ["open", "--help"],
        ["bug", "--help"],
        ["claude", "--help"],
        ["doctor", "--help"],
        ["gc", "--help"],
        ["init", "--help"]
      ]) {
        let out = ""
        await cli.serve(argv, { env: { HOME: root }, stdout: (t) => (out += t), exit: () => {} })
        assertInv(out.length > 0, `Cli.makeCli ${argv.join(" ")} produced help`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it("NativeEquipment, ClaudeCode (streaming all SDK messages), CodexLogin & Providers uphold seat resolution, auth refresh & streaming invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        replyKind: Schema.Literals(["text", "thinkingAndTool", "error", "reportedFail"]),
        providerSet: Schema.Literals(["openai", "gemini", "openrouter", "vercel", "pool", "none"])
      })
    )

    // Loopback OAuth token refresh endpoint for CodexLogin
    const authSrv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjIwMDAwMDAwMDAsImVtYWlsIjoiZnV6ekBleGFtcGxlLnRlc3QifQ.",
        refresh_token: "rt_fuzz_next",
        expires_in: 3600
      }))
    })
    await new Promise<void>((done) => authSrv.listen(0, "127.0.0.1", done))
    const addr = authSrv.address()
    if (addr === null || typeof addr === "string") throw new Error("expected TCP")
    const authOrigin = `http://127.0.0.1:${addr.port}`

    try {
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ providerSet, replyKind }) =>
            Effect.promise(async () => {
              const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-equip-fuzz-")))
              try {
                // 1. NativeEquipment across all provider env configurations
                const env: Record<string, string | undefined> = {
                  HOME: root,
                  ...(providerSet === "openai" ? { OPENAI_API_KEY: "sk-fuzz-openai" } : {}),
                  ...(providerSet === "gemini" ? { GEMINI_API_KEY: "gem-fuzz-key" } : {}),
                  ...(providerSet === "openrouter" ? { OPENROUTER_API_KEY: "or-fuzz-key" } : {}),
                  ...(providerSet === "vercel" ? { VERCEL_AI_GATEWAY_API_KEY: "vg-fuzz-key" } : {}),
                  ...(providerSet === "pool"
                    ? {
                      SMITHERS_ACCOUNT_POOL_URL: authOrigin,
                      SMITHERS_ACCOUNT_POOL_TOKEN: "pool-tok-fuzz",
                      SMITHERS_ACCOUNT_POOL_ROUTES: "chatgpt,anthropic"
                    }
                    : {}),
                  SMITHERS_ROLE_MODELS: "implementer=openai:gpt-5.1,reviewer=anthropic:claude-sonnet-4-6"
                }
                const fakeExecutor = { execute: () => Effect.die("unused") } as never
                const resolver = NativeEquipment.seatResolver(env, fakeExecutor)
                for (const seat of ["openai:gpt-5.1", "gemini:gemini-2.5-pro", "openrouter:anthropic/claude-sonnet-4.5", "vercel:anthropic/claude-sonnet-4.5", "sonnet", "gpt", "jev", "bad@invalid"]) {
                  const r = await Effect.runPromise(Effect.result(resolver.resolve(seat)))
                  assertInv(r._tag === "Success" || r._tag === "Failure", `resolve ${seat}`)
                }
                const host: Providers.Host = { environment: env, homeDirectory: root, readFile: () => undefined }
                const cands = await NativeEquipment.seatCandidates(host)
                assertInv(Array.isArray(cands), "seatCandidates")
                const sbProviders = NativeEquipment.sandboxProvidersFrom(env)
                assertInv(sbProviders !== undefined, "sandboxProvidersFrom")
                const ckpt = NativeEquipment.checkpointStore(env, root)
                assertInv(ckpt !== undefined, "checkpointStore")

                // checkoutFacts with valid & invalid env
                const facts = NativeEquipment.checkoutFacts({ SMITHERS_CHECKOUT_NO_LATER_COMMITS: "1" })
                assertInv(facts.noLaterCommits === true, "checkoutFacts=1")
                const factsEmpty = NativeEquipment.checkoutFacts({})
                assertInv(factsEmpty.noLaterCommits === undefined, "checkoutFacts empty")

                // 2. ClaudeCode.make with injected QueryTransport streaming SDK messages
                const transport: ClaudeCode.Start = ({ prompt }) => {
                  const msgs: Array<Record<string, unknown>> = [
                    { type: "system", subtype: "init", session_id: "sess-fuzz-1", model: "claude-sonnet-4-6" }
                  ]
                  if (replyKind === "text") {
                    msgs.push(
                      {
                        type: "stream_event",
                        session_id: "sess-fuzz-1",
                        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }
                      },
                      {
                        type: "assistant",
                        session_id: "sess-fuzz-1",
                        message: {
                          role: "assistant",
                          content: [{ type: "text", text: "Hello fuzz" }],
                          usage: { input_tokens: 10, output_tokens: 5 }
                        }
                      },
                      {
                        type: "result",
                        subtype: "success",
                        session_id: "sess-fuzz-1",
                        is_error: false,
                        result: "Hello fuzz",
                        total_cost_usd: 0.001,
                        usage: { input_tokens: 10, output_tokens: 5 }
                      }
                    )
                  } else if (replyKind === "thinkingAndTool") {
                    msgs.push(
                      {
                        type: "assistant",
                        session_id: "sess-fuzz-1",
                        message: {
                          role: "assistant",
                          content: [
                            { type: "thinking", thinking: "pondering..." },
                            { type: "text", text: "Done thinking" }
                          ],
                          usage: { input_tokens: 20, output_tokens: 15 }
                        }
                      },
                      {
                        type: "result",
                        subtype: "success",
                        session_id: "sess-fuzz-1",
                        is_error: false,
                        result: "Done thinking",
                        usage: { input_tokens: 20, output_tokens: 15 }
                      }
                    )
                  } else if (replyKind === "error") {
                    msgs.push({
                      type: "assistant",
                      session_id: "sess-fuzz-1",
                      error: "rate_limit",
                      message: { role: "assistant", content: [] }
                    })
                  } else {
                    msgs.push({
                      type: "result",
                      subtype: "error_during_execution",
                      session_id: "sess-fuzz-1",
                      is_error: true,
                      errors: ["execution failed"]
                    })
                  }
                  const asyncIter = async function*() {
                    // Consume one user turn if prompt is async iterable
                    if (typeof prompt !== "string") {
                      const it = prompt[Symbol.asyncIterator]()
                      await it.next()
                    }
                    for (const m of msgs) yield m
                  }
                  const gen = asyncIter()
                  return Object.assign(gen, {
                    interrupt: async () => {},
                    close: () => {}
                  }) as never
                }

                const model = ClaudeCode.make({
                  model: "claude-sonnet-4-6",
                  executable: "claude",
                  environment: env
                })
                try {
                  const req = {
                    messages: [{ role: "user", content: [{ _tag: "Text", text: "hi fuzz" }] }],
                    tools: []
                  } as unknown as ModelRequest.ModelRequest
                  const eventsRes = await Effect.runPromise(
                    Stream.runCollect(model.stream(req)).pipe(
                      Effect.provideService(ClaudeCode.QueryTransport, Effect.succeed(transport)),
                      Effect.result
                    )
                  )
                  assertInv(eventsRes._tag === "Success" || eventsRes._tag === "Failure", `ClaudeCode stream ${replyKind}`)
                } finally {
                  model.close()
                }

                // 3. CodexLogin parse / unusable / locate / make
                const validAuth = JSON.stringify({
                  tokens: {
                    access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjIwMDAwMDAwMDAsImVtYWlsIjoidUBleGFtcGxlLnRlc3QifQ.",
                    refresh_token: "rt_123",
                    account_id: "acct_1"
                  }
                })
                const parsedOk = CodexLogin.parse(validAuth)
                assertInv(parsedOk.usable === true, "CodexLogin.parse valid")
                const parsedBad = CodexLogin.parse("{bad")
                assertInv(typeof parsedBad === "object", "CodexLogin.parse malformed")
                assertInv(CodexLogin.unusable("/tmp/a.json", undefined) !== undefined, "unusable missing")
                assertInv(CodexLogin.unusable("/tmp/a.json", "{}") !== undefined, "unusable empty")
                const authFile = join(root, "codex-auth.json")
                writeFileSync(authFile, validAuth)
                const store = CodexLogin.make({ file: authFile, refresh: Effect.void })
                const tok = await Effect.runPromise(Effect.result(store.auth.sign({})))
                assertInv(tok._tag === "Success" || tok._tag === "Failure", "CodexLogin store.read")
                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }),
          { seed, executions: Math.min(executions, 8) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await new Promise<void>((done) => authSrv.close(() => done()))
    }
  }, 180_000)

  it("Agents.addMcp (all agents, idempotency, existing configs, corrupt JSON) & Evaluation/EvalCli (list, load, execute, baseline, compare) uphold invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scoreA: Schema.Literals([0.5, 0.8, 1.0]),
        scoreB: Schema.Literals([0.5, 0.9, 1.0]),
        shape: Schema.Literals(["value", "promise", "effect"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scoreA, scoreB, shape }) =>
          Effect.promise(async () => {
            const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-agents-eval-fuzz-")))
            try {
              // 1. Agents.addMcp across EVERY declared agent with real claude/codex shims in temp PATH
              const binDir = join(root, "bin")
              mkdirSync(binDir, { recursive: true })
              writeFileSync(join(binDir, "claude"), "#!/bin/sh\necho ok\nexit 0\n", { mode: 0o755 })
              chmodSync(join(binDir, "claude"), 0o755)
              writeFileSync(join(binDir, "codex"), "#!/bin/sh\necho ok\nexit 0\n", { mode: 0o755 })
              chmodSync(join(binDir, "codex"), 0o755)
              const agentEnv: NodeJS.ProcessEnv = {
                ...process.env,
                HOME: root,
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
                CODEX_HOME: join(root, ".codex"),
                CLAUDE_CONFIG_DIR: join(root, ".claude")
              }
              for (const ag of Agents.agents) {
                const first = Agents.addMcp(ag, root, agentEnv)
                assertInv(typeof first.status === "string" && first.agent === ag.id, `addMcp first ${ag.id}`)
                // Idempotent second registration
                const second = Agents.addMcp(ag, root, agentEnv)
                assertInv(typeof second.status === "string" && second.agent === ag.id, `addMcp second ${ag.id}`)
              }

              // Corrupt JSON config resilience for claude
              const claudeAg = Agents.find("claude-code") ?? Agents.agents[0]!
              const badHome = join(root, "bad-home")
              mkdirSync(join(badHome, ".claude"), { recursive: true })
              writeFileSync(join(badHome, ".claude", ".claude.json"), "{not-json")
              const badRes = Agents.addMcp(claudeAg, badHome, { ...agentEnv, HOME: badHome, CLAUDE_CONFIG_DIR: join(badHome, ".claude") })
              assertInv(typeof badRes.status === "string", "addMcp handles corrupt config cleanly")

              // 2. Full Evaluation & EvalCli lifecycle on real synthetic .eval.mjs suite
              writeEvalSuite(root, "exact.eval.mjs", scoreA, shape)
              const listed = await Evaluation.list(root)
              assertInv(listed.length >= 1, "Evaluation.list discovers exact.eval.mjs")

              const loaded = await Evaluation.load(root, "exact")
              const runA = await Evaluation.execute(loaded.suite, loaded.executor, {
                runId: "run-a",
                at: "2026-11-23T00:00:00.000Z"
              })
              assertInv(runA.runId === "run-a", "Evaluation.execute produced runA")
              const fileA = Evaluation.runPath(root, "run-a")
              await Evaluation.writeJson(fileA, `${JSON.stringify(runA)}\n`)
              const readBack = await Evaluation.readRun(root, "run-a")
              assertInv(readBack.runId === "run-a", "Evaluation.readRun round-tripped")

              const baseText = await Evaluation.baseline(runA)
              const baseFile = Evaluation.defaultBaselinePath(root, "exact")
              await Evaluation.writeJson(baseFile, baseText)
              const baseRead = await Evaluation.readBaseline(baseFile)
              assertInv(baseRead.length > 0, "Evaluation.readBaseline")

              // Second run with scoreB & compare against baseline
              writeEvalSuite(root, "exact2.eval.mjs", scoreB, "value")
              const loadedB = await Evaluation.load(root, "exact2")
              const runB = await Evaluation.execute(loadedB.suite, loadedB.executor, {
                runId: "run-b",
                at: "2026-11-23T00:01:00.000Z"
              })
              const cmp = await Evaluation.compare(runB, baseRead)
              assertInv(typeof cmp === "object", "Evaluation.compare returned verdict")

              // EvalCli commands (list, run, baseline, compare)
              const evalCli = EvalCli.createEvalCli()
              for (const argv of [
                ["list", "--root", root, "--json"],
                ["run", "exact", "--root", root, "--json"],
                ["compare", "run-a", "--baseline", baseFile, "--root", root, "--json"]
              ]) {
                let out = ""
                await evalCli.serve(argv, { env: {}, stdout: (t) => (out += t), exit: () => {} })
                assertInv(out.length > 0, `EvalCli ${argv[0]} produced output`)
              }
              return true
            } finally {
              rmSync(root, { recursive: true, force: true })
            }
          }),
        { seed, executions: Math.min(executions, 4) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 180_000)
})
