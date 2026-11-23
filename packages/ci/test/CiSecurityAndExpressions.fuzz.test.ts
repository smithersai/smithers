import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Expression from "../src/inventory/Expression.ts"
import * as Environment from "../src/replay/Environment.ts"
import * as Failures from "../src/replay/Failures.ts"
import * as Jail from "../src/replay/Jail.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/ci Expression, Jail, Environment & Failures fuzz invariants", () => {
  it("Expression.evaluate, fill, split, whole, formatPieces, contextNames, toNumber, toText, truthy & finish never crash and preserve partial-eval equivalence", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        lhs: Schema.Union([
          Schema.String.check(Schema.isMaxLength(16)),
          Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
          Schema.Boolean,
          Schema.Null
        ]),
        rhs: Schema.Union([
          Schema.String.check(Schema.isMaxLength(16)),
          Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
          Schema.Boolean,
          Schema.Null
        ]),
        op: Schema.Literals(["==", "!=", "<", "<=", ">", ">=", "&&", "||"]),
        fnKind: Schema.Literals([
          "contains",
          "startsWith",
          "endsWith",
          "format",
          "join",
          "toJSON",
          "fromJSON",
          "hashFiles",
          "success",
          "always",
          "failure",
          "cancelled"
        ]),
        dynamic: Schema.Boolean,
        rawExpr: Schema.String.check(Schema.isMaxLength(64))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ lhs, rhs, op, fnKind, dynamic, rawExpr }) =>
          Effect.sync(() => {
            const safeLhs = typeof lhs === "string" ? lhs.replaceAll("'", "") : lhs
            const safeRhs = typeof rhs === "string" ? rhs.replaceAll("'", "") : rhs
            const scope: Expression.Scope = {
              context: (name) => {
                if (name === "inputs") {
                  return Expression.fields((field) => {
                    if (field === "a") {
                      return dynamic
                        ? Expression.variable("v-a", "inputs.a")
                        : Expression.value(safeLhs)
                    }
                    if (field === "b") return Expression.value(safeRhs)
                    if (field === "arr") return Expression.value([safeLhs, safeRhs])
                    if (field === "json") return Expression.value(JSON.stringify({ x: safeLhs }))
                    return undefined
                  })
                }
                if (name === "secrets") return Expression.unknown("secret value")
                return undefined
              },
              status: {
                always: true,
                success: true,
                failure: false,
                cancelled: false
              },
              hashFiles: () => Expression.value("deadbeef")
            }

            const num = Expression.toNumber(safeLhs)
            if (typeof num !== "number") return false
            const txt = Expression.toText(safeLhs)
            if (typeof txt !== "string") return false
            const tr = Expression.truthy(safeLhs)
            if (typeof tr !== "boolean") return false

            const exprText = `inputs.a ${op} inputs.b`
            const evalRes = Expression.evaluate(exprText, scope)
            if (evalRes.kind === "ok") {
              const finished = Expression.finish(evalRes.residual, () => safeLhs)
              const staticScope: Expression.Scope = {
                ...scope,
                context: (name) =>
                  name === "inputs"
                    ? Expression.fields((field) => (field === "a"
                      ? Expression.value(safeLhs)
                      : field === "b"
                      ? Expression.value(safeRhs)
                      : undefined)
                    )
                    : undefined
              }
              const staticRes = Expression.evaluate(exprText, staticScope)
              if (finished.kind === "ok" && staticRes.kind === "ok" && staticRes.residual.kind === "literal") {
                if (JSON.stringify(finished.value) !== JSON.stringify(staticRes.residual.value)) return false
              }
              const vars = Expression.variablesOf(evalRes.residual)
              if (!Array.isArray(vars)) return false
            }

            const fnExpr = fnKind === "contains"
              ? "contains(inputs.arr, inputs.b)"
              : fnKind === "startsWith"
              ? "startsWith(inputs.a, inputs.b)"
              : fnKind === "endsWith"
              ? "endsWith(inputs.a, inputs.b)"
              : fnKind === "format"
              ? "format('v={0},b={1}', inputs.a, inputs.b)"
              : fnKind === "join"
              ? "join(inputs.arr, ',')"
              : fnKind === "toJSON"
              ? "toJSON(inputs.arr)"
              : fnKind === "fromJSON"
              ? "fromJSON(inputs.json)"
              : fnKind === "hashFiles"
              ? "hashFiles('package.json')"
              : `${fnKind}()`
            const fnEval = Expression.evaluate(fnExpr, scope)
            if (typeof fnEval.kind !== "string") return false

            const template = `prefix \${{ ${exprText} }} middle \${{ ${rawExpr.replaceAll("}}", "")} }} suffix`
            const filled = Expression.fill(template, scope)
            if (typeof filled.kind !== "string") return false
            const splitParts = Expression.split(template)
            if (!Array.isArray(splitParts.pieces) || typeof splitParts.rest !== "string") return false
            const wholeExpr = Expression.whole(`\${{ ${exprText} }}`)
            if (wholeExpr !== exprText) return false
            const bareExpr = Expression.whole(exprText, true)
            if (bareExpr !== exprText) return false
            const fmt = Expression.formatPieces(rawExpr)
            if (fmt !== undefined && !Array.isArray(fmt)) return false
            const ctxNames = Expression.contextNames(exprText)
            if (ctxNames === undefined || !ctxNames.includes("inputs")) return false

            const adv = Expression.evaluate(rawExpr, scope)
            if (typeof adv.kind !== "string") return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Jail & Environment enforce seccomp keyring BPF filter, credential/socket masking, push refusal, and stand-in PATH guards", async () => {
    const bpf1 = Jail.keyringFilter()
    const bpf2 = Jail.keyringFilter()
    expect(bpf1.length).toBeGreaterThan(0)
    expect(bpf1.length % 8).toBe(0)
    expect(Buffer.compare(bpf1, bpf2)).toBe(0)

    const arb = Arbitrary.schema(
      Schema.Struct({
        allowDocker: Schema.Boolean,
        hasScope: Schema.Boolean,
        hasJail: Schema.Boolean,
        homeDir: Schema.Literals(["/home/alice", "/Users/bob", "/root"]),
        customTmp: Schema.Literals(["/tmp", "/var/tmp/smithers"]),
        dockerHost: Schema.NullOr(Schema.Literals(["unix:///var/run/docker.sock", "tcp://127.0.0.1:2375"])),
        stepPath: Schema.NullOr(Schema.Literals(["/usr/local/bin:/usr/bin", "/opt/bin"])),
        filePath: Schema.Literals(["src/index.ts", "node_modules/pkg/a.js", ".git/HEAD", ".cache/x", "apps/mvp/a.ts"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ allowDocker, hasScope, hasJail, homeDir, customTmp, dockerHost, stepPath, filePath }) =>
          Effect.sync(() => {
            const sockets = Jail.daemonSockets(1000, dockerHost === null ? {} : { DOCKER_HOST: dockerHost })
            if (!Array.isArray(sockets) || sockets.length === 0) return false
            if (dockerHost?.startsWith("unix://") && !sockets.includes("/var/run/docker.sock")) return false

            const temps = Jail.temporaryOf(customTmp)
            if (!temps.includes("/tmp") || !temps.includes(customTmp)) return false
            if (new Set(temps).size !== temps.length) return false

            const unj = Jail.unjailed("bwrap missing", allowDocker)
            if (!unj.includes("bwrap missing")) return false

            const inst = Jail.installOf("/home/alice/.nvm/versions/node/v22/bin/node", (d) => d.endsWith("v22"))
            if (typeof inst !== "string" || inst.length === 0) return false

            const jailCfg: Jail.Jail | undefined = hasJail
              ? {
                bwrap: "/usr/bin/bwrap",
                masks: [
                  { path: `${homeDir}/.ssh`, directory: true },
                  { path: `${homeDir}/.npmrc`, directory: false }
                ],
                tmp: "/tmp/replay-tmp",
                temporary: temps,
                visible: ["/usr/bin"],
                filter: "/tmp/seccomp.bpf",
                scope: hasScope ? "/usr/bin/perl" : undefined
              }
              : undefined

            const cmd = Jail.jailed(jailCfg, ["/tmp/work"], ["/tmp/work/node_modules"], ["echo", "hello"])
            if (cmd[0] !== "/bin/bash" || cmd[1] !== "-c") return false
            if (hasJail) {
              if (!cmd.includes("--seccomp") || !cmd.includes("--unshare-pid") || !cmd.includes("--die-with-parent")) {
                return false
              }
              if (hasScope && !cmd.includes(Jail.scopeProgram)) return false
              if (!cmd.includes(`${homeDir}/.ssh`) || !cmd.includes("/dev/null")) return false
            }

            const skipped = Environment.skippedPart(filePath)
            if (filePath.includes("node_modules") && skipped !== "node_modules") return false
            if (filePath.includes(".git") && skipped !== ".git") return false
            if (filePath.startsWith("src/") && skipped !== undefined) return false

            const standIns = Environment.standIns(allowDocker)
            const standInNames = standIns.map(([name]) => name)
            for (const g of Environment.guardedPrograms) {
              if (!standInNames.includes(g)) return false
            }
            if (!allowDocker) {
              for (const c of Environment.containerPrograms) {
                if (!standInNames.includes(c)) return false
              }
            } else {
              for (const c of Environment.containerPrograms) {
                if (standInNames.includes(c)) return false
              }
            }

            const gPath = Environment.guardedPath("/tmp/guard", stepPath ?? undefined)
            if (!gPath.startsWith("/tmp/guard")) return false

            const place: Environment.Place = {
              home: "/tmp/place/home",
              tmp: "/tmp/place/tmp",
              guard: "/tmp/place/guard"
            }
            const daemonEnv = Environment.daemonEnvironment(
              allowDocker,
              dockerHost === null ? {} : { DOCKER_HOST: dockerHost }
            )
            if (!allowDocker && "DOCKER_HOST" in daemonEnv) return false
            if (allowDocker && dockerHost !== null && daemonEnv["DOCKER_HOST"] !== dockerHost) return false

            const stepEnv = Environment.stepEnvironment(
              {
                ...(stepPath === null ? {} : { PATH: stepPath }),
                CUSTOM_FLAG: "1"
              },
              place
            )
            if (stepEnv["HOME"] !== place.home) return false
            if (stepEnv["CUSTOM_FLAG"] !== "1") return false
            if (stepEnv["GIT_TERMINAL_PROMPT"] !== "0") return false
            if (stepPath !== null && !String(stepEnv["PATH"]).startsWith(place.guard)) return false

            const sw = Environment.softwareEnvironment({ JAVA_HOME: "/usr/lib/jvm", SECRET_TOKEN: "ghp_nope" })
            if ("SECRET_TOKEN" in sw) return false

            const reaperDarwin = Environment.reaperProgram(() => "/nonexistent", "darwin", "arm64")
            if (reaperDarwin !== undefined) return false
            const reaperMissing = Environment.reaperProgram(() => "/nonexistent", "linux", "x64")
            if (reaperMissing !== undefined) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Failures scrubbing, errorLine extraction, signalExit, retry/flaky tracking & printedFailure obey bounds and safety invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        targets: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
        exitCode: Schema.Literals([0, 1, 2, 127, 137, 143]),
        signal: Schema.Literals(["SIGINT", "SIGTERM", "SIGKILL", "SIGSEGV", "SIGABRT", "UNKNOWN"]),
        minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
        rawStderr: Schema.String.check(Schema.isMaxLength(160)),
        rawStdout: Schema.String.check(Schema.isMaxLength(160)),
        hasAnsi: Schema.Boolean,
        hasErrorKeyword: Schema.Boolean,
        sameFailureTwice: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ targets, exitCode, signal, minutes, rawStderr, rawStdout, hasAnsi, hasErrorKeyword, sameFailureTwice }) =>
          Effect.sync(() => {
            const limit = Failures.printedLimitOf(targets)
            if (limit <= 0) return false

            const ansiPrefix = hasAnsi ? "\u001b[31m" : ""
            const ansiSuffix = hasAnsi ? "\u001b[0m" : ""
            const stderr = hasErrorKeyword
              ? `${ansiPrefix}Error: ${rawStderr}${ansiSuffix}`
              : exitCode === 127
              ? "sh: 1: nonexistent_tool_xyz: not found"
              : `${ansiPrefix}${rawStderr}${ansiSuffix}`

            const cleaned = Failures.readable(stderr)
            if (cleaned.includes("\u001b[")) return false

            const fl = Failures.firstLine(cleaned)
            if (fl.includes("\n")) return false

            const tail = Failures.diagnosticTail(`${stderr}\n${rawStdout}`, 80)
            if (typeof tail !== "string") return false

            const errLine = Failures.errorLine(stderr)
            if (typeof errLine !== "string") return false

            const reason = Failures.reasonOf({ exitCode, stderr, stdout: rawStdout })
            if (typeof reason !== "string" || reason.length === 0) return false
            if (exitCode === 127 && !hasErrorKeyword && !reason.includes("not installed")) return false

            const np = Failures.noProgress(minutes)
            if (!Failures.madeNoProgress({ error: np })) return false
            if (Failures.madeNoProgress({ error: "regular failure" })) return false

            const sigExit = Failures.signalExit(signal)
            if (signal === "SIGKILL" && sigExit !== 137) return false
            if (signal === "SIGTERM" && sigExit !== 143) return false
            if (signal === "SIGINT" && sigExit !== 130) return false

            const mark1 = Failures.failureMark({ exitCode: 1, error: "Error: boom\nstack" })
            const mark2 = Failures.failureMark({ exitCode: 1, error: "\u001b[31mError: boom\u001b[0m\nother" })
            if (mark1 !== mark2) return false

            const last: Failures.LastFailures = new Map()
            const baseResult = {
              label: "//pkg:test",
              key: "k-1",
              status: "failed" as const,
              durationMs: 10,
              exitCode: 1,
              error: "Error: deterministic failure"
            }
            Failures.remember(last, [baseResult])
            const nextResult = sameFailureTwice
              ? { ...baseResult }
              : { ...baseResult, error: "Error: different failure" }
            if (Failures.failedAsBefore(last, nextResult) !== sameFailureTwice) return false

            const cmd = Failures.commandLine("pnpm test --filter foo\nsecond line")
            if (cmd.includes("\n")) return false

            const pf = Failures.printedFailure(`$ pnpm test\n${stderr}\nexit code 1`)
            if (typeof pf !== "object" || pf === null) return false

            const sentence = Failures.sentenceOf({
              step: "test",
              reason: "tests failed",
              exitCode: 1
            })
            if (!sentence.includes("test") || !sentence.includes("tests failed")) return false

            const noJob = Failures.noJobPassed("abc1234567", {
              step: "build",
              reason: "compile error",
              exitCode: 2
            })
            if (!noJob.includes("abc1234")) return false

            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
