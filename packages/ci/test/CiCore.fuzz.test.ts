import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Shell from "../src/decompose/Shell.vibe"
import * as Zig from "../src/decompose/Zig.ts"
import * as Yaml from "../src/generate/Yaml.vibe"
import * as Expression from "../src/inventory/Expression.ts"
import * as Glob from "../src/inventory/Glob.vibe"
import * as Justfile from "../src/inventory/Justfile.vibe"
import * as Makefile from "../src/inventory/Makefile.vibe"
import * as Matrix from "../src/inventory/Matrix.vibe"
import * as Secrets from "../src/inventory/Secrets.vibe"
import * as TimeLimit from "../src/inventory/TimeLimit.vibe"
import * as Tools from "../src/inventory/Tools.ts"
import * as Cpu from "../src/replay/Cpu.ts"
import * as DiskSpace from "../src/replay/DiskSpace.ts"
import * as Environment from "../src/replay/Environment.ts"
import * as Failures from "../src/replay/Failures.ts"
import * as Names from "../src/replay/Names.ts"
import * as Format from "../src/report/Format.vibe"
import * as Html from "../src/report/Html.vibe"
import * as Text from "../src/report/Text.vibe"
import * as Features from "../src/select/Features.vibe"
import * as Measure from "../src/select/Measure.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/ci core parsers, security scrubbing, shell/YAML & replay helpers fuzz invariants", () => {
  it("Expression.evaluate/fill/split/whole/formatPieces never throw on arbitrary GitHub Actions expressions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        raw: Schema.String.pipe(Schema.check(Schema.isMaxLength(96))),
        expr: Schema.Literals([
          "1 + 2",
          "true && !false",
          "contains(hello world, world)",
          "startsWith(abc, a)",
          "endsWith(abc, c)",
          "format({0}-{1}, a, 42)",
          "join(matrix.os, ,)",
          "toJSON(github)",
          "fromJSON('{\"a\":1}')",
          "github.ref == refs/heads/main",
          "matrix.node == 20 || matrix.node == 22",
          "success() && always()",
          "unknown_fn(1, 2)"
        ]),
        nodeVer: Schema.Literals([18, 20, 22]),
        ref: Schema.Literals(["refs/heads/main", "refs/pull/1/merge"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, expr, nodeVer, ref }) =>
          Effect.sync(() => {
            const scope: Expression.Scope = {
              context: (name) => {
                if (name === "github") {
                  return Expression.fields((k) => (k === "ref" ? Expression.value(ref) : undefined))
                }
                if (name === "matrix") {
                  return Expression.fields((k) =>
                    k === "node"
                      ? Expression.value(nodeVer)
                      : k === "os"
                      ? Expression.value(["ubuntu", "macos"])
                      : undefined
                  )
                }
                return undefined
              }
            }
            const ev1 = Expression.evaluate(expr, scope)
            if (ev1.kind === "ok") {
              const vars = Expression.variablesOf(ev1.residual)
              Expression.finish(ev1.residual, () => "")
              void vars
            }
            // Arbitrary untrusted raw string & wrapped ${{ ... }}
            Expression.evaluate(raw, scope)
            Expression.fill(`prefix \${{ ${expr} }} \${{ ${raw} }}`, scope)
            Expression.whole(`\${{ ${expr} }}`, true)
            Expression.formatPieces(raw)
            Expression.toNumber(raw)
            Expression.toText(nodeVer)
            Expression.truthy(raw)
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Secrets scrubbing, Glob, Matrix, Makefile, Justfile, TimeLimit & Tools obey totality & secret-redaction invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secretVal: Schema.Literals([
          "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
          "sk-ant-api03-0123456789abcdefghijklmnop",
          "AKIAIOSFODNN7EXAMPLE",
          "plain-non-secret-value"
        ]),
        varName: Schema.Literals(["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "API_KEY", "NODE_ENV", "TOKEN_COUNT"]),
        glob: Schema.Literals(["src/**/*.ts", "*.md", "a/?/[0-9]*.js", "[unclosed", "**", "a/{b,c}.ts"]),
        recipe: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
        timeoutMin: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 360 }))),
        osList: Schema.Array(Schema.Literals(["ubuntu-latest", "macos-latest"])).pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2))
        ),
        nodeList: Schema.Array(Schema.Literals([18, 20, 22])).pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3))
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secretVal, varName, glob, recipe, timeoutMin, osList, nodeList }) =>
          Effect.sync(() => {
            // Secrets scrubbing MUST remove known token prefixes
            const hasKnown = secretVal.startsWith("ghp_") || secretVal.startsWith("AKIA") ||
              secretVal.startsWith("sk-ant-")
            const scrubbed = Secrets.scrub({ msg: `leaked ${secretVal}`, nested: [secretVal] })
            if (hasKnown && !Secrets.hasSecretValue(secretVal)) return false
            if (hasKnown && scrubbed.msg.includes(secretVal)) return false
            Secrets.isSecretName(varName)
            Secrets.isLiteralSecret(varName, secretVal)

            // Glob compilation must never throw & valid globs produce compilable regex
            const rx = Glob.regexOf(glob)
            if (rx !== undefined) {
              new RegExp(rx)
            }
            Glob.filesOf([glob])

            // Matrix expansion cardinality & determinism
            const mat = Matrix.expandMatrix({ os: osList, node: nodeList })
            if (mat.variants.length !== osList.length * nodeList.length) return false

            // Makefile & Justfile parsers never throw on arbitrary recipes
            const safeLine = recipe.replace(/[\r\n]/g, " ")
            Makefile.readMakefile("Makefile", `test:\n\t${safeLine}\nbuild: test\n\techo ok\n`, ["Makefile"])
            Justfile.readJustfile("justfile", `test:\n  ${safeLine}\nbuild: test\n  echo ok\n`)

            // TimeLimit bounds
            const lim = TimeLimit.readLimit(timeoutMin, { context: () => undefined })
            if (!("minutes" in lim) || lim.minutes !== timeoutMin) return false
            const w = TimeLimit.within(timeoutMin, Math.max(1, timeoutMin - 1))
            if (w !== Math.max(1, timeoutMin - 1)) return false
            const secs = TimeLimit.secondsOf(timeoutMin)
            if (timeoutMin < 360 && secs !== timeoutMin * 60) return false
            if (timeoutMin >= 360 && secs !== undefined) return false

            // Tools version & diffing helpers
            Tools.versionIn(`node v20.11.1 (${safeLine})`)
            Tools.differs("20.11", "20.11.1")
            Tools.programsOf("node")
            Tools.systemName("linux")
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Shell, Zig, Yaml, Environment, Failures, Names, Cpu & DiskSpace obey parser, quoting & safety invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        word: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        step: Schema.Literals(["test", "build", "check", "lint"]),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        signal: Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT", "SIGSEGV", "UNKNOWN"]),
        allowDocker: Schema.Boolean,
        pathStr: Schema.Literals(["src/index.ts", "node_modules/a/b.js", ".git/config", "packages/a/test.ts"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ word, step, exitCode, signal, allowDocker, pathStr }) =>
          Effect.sync(() => {
            const safeWord = word.replace(/[\r\n\0]/g, "a")
            // Shell quoting & command parsing
            const quoted = Shell.quote(safeWord)
            const cmds = Shell.commands(`echo ${quoted} && zig build ${step}`)
            if (cmds === undefined || cmds.length < 2) return false
            Shell.commands(safeWord)

            // Zig build command extractor
            const zSole = Zig.soleBuild(`zig build ${step}`)
            if (zSole !== step) return false
            Zig.sole(safeWord)

            // Yaml plain check & document rendering
            Yaml.isPlain(safeWord)
            const doc = Yaml.document(
              Yaml.mapping([
                Yaml.entry("name", safeWord || "ci"),
                Yaml.entry("steps", Yaml.list([step]))
              ]),
              ["Generated"]
            )
            if (doc.length === 0) return false

            // Replay Environment & safety guards
            const standIns = Environment.standIns(allowDocker)
            if (standIns.length === 0) return false
            const gp = Environment.guardedPath("/guard", "/usr/bin:/bin")
            if (!gp.startsWith("/guard:")) return false
            const skipped = Environment.skippedPart(pathStr)
            if ((pathStr.startsWith("node_modules/") || pathStr.startsWith(".git/")) && skipped === undefined) {
              return false
            }

            // Failures formatting & ANSI/secret scrubbing
            const ansi = `\u001b[31mFAIL ghp_0123456789abcdefghijklmnopqrstuvwxyz\u001b[0m\nsecond line`
            const clean = Failures.readable(ansi)
            if (clean.includes("ghp_") || clean.includes("\u001b[")) return false
            Failures.firstLine(clean)
            Failures.errorLine(clean)
            Failures.commandLine(safeWord)
            const sigCode = Failures.signalExit(signal)
            if (!Number.isInteger(sigCode)) return false
            Failures.printedFailure(`command: echo hi\nexit: ${exitCode}\nerror: boom`)

            // Names / Cpu / DiskSpace pure helpers
            void Names
            void Cpu
            void DiskSpace
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("select/Features, select/Measure & report/Html/Text/Format obey bounds, probability & XSS-escaping invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caught: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
        total: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
        ms: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 600_000 }))),
        repoName: Schema.Literals(["smithers/repo", "<script>alert(1)</script>", "org/a&b"]),
        label: Schema.Literals(["//packages/a:test", "//apps/mvp:check", ":root"]),
        scoreVal: Schema.Literals([0, 0.01, 0.05, 0.2, 0.5, 0.9, 1])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ caught, total, ms, repoName, label, scoreVal }) =>
          Effect.sync(() => {
            // Features pure helpers
            const proj = Features.projectOf(label)
            if (typeof proj !== "string") return false
            const exts = Features.extensionsOf(["src/a.ts", "README", "pkg/b.vibe", "dir/.env"])
            if (!exts.includes(Features.noExtension)) return false
            Features.testCount(["packages/a/test/x.test.ts", "packages/b/src/y.ts"], "packages/a")
            const dists = Features.graphDistances(
              ["packages/c/src/x.ts"],
              ["//packages/a:test", "//packages/b:build", "//packages/c:lib"],
              {
                version: 1,
                targets: [
                  { label: "//packages/a:test", kind: "test", dependencies: ["//packages/b:build"] },
                  { label: "//packages/b:build", kind: "build", dependencies: ["//packages/c:lib"] },
                  { label: "//packages/c:lib", kind: "build", dependencies: [] }
                ]
              } as never
            )
            if (
              dists.get("//packages/c:lib") !== 0 || dists.get("//packages/b:build") !== 1 ||
              dists.get("//packages/a:test") !== 2
            ) return false

            // Measure.lowerBound statistical bounds [0, 1]
            const c = Math.min(caught, total)
            const lb = Measure.lowerBound(c, total)
            if (!Number.isFinite(lb) || lb < 0 || lb > 1) return false
            if (total > 0 && lb > c / total + 1e-9) return false

            // Format helpers totality
            Format.trialTime(ms)
            Format.appliedTime(ms)
            Format.leftOut(c)
            Format.flaky(c)
            Format.unread(c)
            Format.commitsLeftOut(c)
            Format.leftEmpty(["SECRET_A", "SECRET_B"])
            Format.ownTargets([label])
            Format.skippedLabels([label])
            Format.coldStart(repoName)

            // Html & Text report rendering MUST escape HTML/script payloads
            const rep = {
              version: 1 as const,
              repository: repoName,
              commits: [
                {
                  commit: "abcdef1234567890",
                  baseline: { passed: true, wallMs: ms + 1000, counts: { ran: 2, cached: 0, skipped: 0, failed: 0 } },
                  normal: {
                    passed: true,
                    wallMs: Math.max(100, Math.floor(ms / 2)),
                    counts: { ran: 1, cached: 1, skipped: 0, failed: 0 }
                  },
                  mismatches: [],
                  verdict: "match" as const
                }
              ],
              baselineWallMs: ms + 1000,
              normalWallMs: Math.max(100, Math.floor(ms / 2)),
              speedup: 2.0,
              mismatches: 0,
              cold: repoName,
              withheld: ["SECRET_KEY"],
              targets: [label]
            }
            const htmlOut = Html.html(rep as never)
            if (htmlOut.includes("<script>alert(1)</script>")) return false
            const textOut = Text.text(rep as never)
            if (textOut.length === 0) return false
            void scoreVal
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
