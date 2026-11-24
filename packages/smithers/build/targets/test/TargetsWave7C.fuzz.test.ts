import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Result, Schema, Stream } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import * as ReviewBatches from "../src/internal/ReviewBatches.ts"
import * as ReviewModel from "../src/internal/ReviewModel.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 15)
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/targets Wave-7C: LlmLint credentials/store, Exec payload boundary, ReviewBatches, ReviewModel & Input", () => {
  it(
    "ReviewModel.seatReviewModel, configuredRoute & reviewModel cover stream events, refusals, limits & timeout",
    async () => {
      const modes = [
        "ok",
        "tool-call",
        "too-big",
        "content-filter",
        "length-stop",
        "unsettled",
        "stream-fail",
        "timeout"
      ] as const
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([...modes]),
          withPolicy: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, withPolicy }) =>
            Effect.gen(function*() {
              const fakeModel = {
                stream: () => {
                  if (mode === "ok") {
                    return Stream.fromIterable([
                      { type: "text-delta", text: "{\"findings\":[]}" },
                      { type: "settle", stopReason: "stop" }
                    ])
                  }
                  if (mode === "tool-call") {
                    return Stream.fromIterable([{ type: "tool-call", name: "bash" }])
                  }
                  if (mode === "too-big") {
                    return Stream.fromIterable([
                      { type: "text-delta", text: "x".repeat(500) },
                      { type: "settle", stopReason: "stop" }
                    ])
                  }
                  if (mode === "content-filter") {
                    return Stream.fromIterable([{ type: "settle", stopReason: "content-filter" }])
                  }
                  if (mode === "length-stop") {
                    return Stream.fromIterable([{ type: "settle", stopReason: "max-tokens" }])
                  }
                  if (mode === "unsettled") {
                    return Stream.fromIterable([{ type: "text-delta", text: "partial" }])
                  }
                  if (mode === "stream-fail") {
                    return Stream.fail("boom-non-error")
                  }
                  return Stream.fromEffect(
                    Effect.sleep("250 millis").pipe(Effect.as({ type: "settle", stopReason: "stop" }))
                  )
                }
              } as never

              const exit = yield* Effect.exit(
                ReviewModel.seatReviewModel(
                  fakeModel,
                  "claude-sonnet-4-6",
                  "check this",
                  mode === "timeout" ? 25 : 2_000,
                  100,
                  withPolicy ? "policy text" : undefined
                )
              )
              if (mode === "ok") {
                expect(Exit.isSuccess(exit)).toBe(true)
              } else {
                expect(Exit.isFailure(exit)).toBe(true)
              }

              const okRoute = yield* ReviewModel.configuredRoute(Result.succeed(42))
              expect(okRoute).toBe(42)
              const badRouteExit = yield* Effect.exit(ReviewModel.configuredRoute(Result.fail("bad")))
              expect(Exit.isFailure(badRouteExit)).toBe(true)

              return true
            }),
          { executions: Math.min(executions, 30), seed }
        )
      )
      assertPassed(report)

      // reviewModel with absent API key
      const origAnth = process.env["ANTHROPIC_API_KEY"]
      const origOai = process.env["OPENAI_API_KEY"]
      delete process.env["ANTHROPIC_API_KEY"]
      delete process.env["OPENAI_API_KEY"]
      try {
        const e1 = await Effect.runPromise(Effect.exit(ReviewModel.reviewModel("claude", "m", "p", 500, 100)))
        const e2 = await Effect.runPromise(Effect.exit(ReviewModel.reviewModel("codex", "m", "p", 500, 100)))
        expect(Exit.isFailure(e1)).toBe(true)
        expect(Exit.isFailure(e2)).toBe(true)
      } finally {
        if (origAnth !== undefined) process.env["ANTHROPIC_API_KEY"] = origAnth
        if (origOai !== undefined) process.env["OPENAI_API_KEY"] = origOai
      }
    },
    30_000
  )

  it("ReviewBatches.splitFile, planBatches & relate cover symbol splitting, budget overflow, connected components & round-robin related files", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        budget: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 220 })),
        maxFiles: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ budget, maxFiles }) =>
          Effect.sync(() => {
            const fileA = {
              path: "src/a.ts",
              contents: [
                "import { helper } from \"./b.ts\"",
                "export const alpha = () => {",
                "  return helper() + \"aaaaaaaaaaaaaaaaaaaa\"",
                "}",
                "export function beta() {",
                "  return \"bbbbbbbbbbbbbbbbbbbbbbbbbbbb\"",
                "}",
                "export class Gamma {",
                "  run() { return \"cccccccccccccccccccc\" }",
                "}"
              ].join("\n")
            }
            const fileB = {
              path: "src/b.ts",
              contents: "export const helper = () => \"helper-value-1234567890\"\n"
            }
            const fileC = {
              path: "src/c.ts",
              contents: "export const gamma = () => \"gamma-value-1234567890\"\n"
            }
            const related1 = { path: "src/rel1.ts", contents: "export const r1 = 1\n" }
            const related2 = { path: "src/rel2.ts", contents: "export const r2 = 2\n" }
            const existing = new Set([fileA.path, fileB.path, fileC.path, related1.path, related2.path])

            const { edges, related } = ReviewBatches.relate(
              [fileA, fileB, fileC],
              [related1, related2],
              (p) => existing.has(p)
            )
            expect(edges.size).toBeGreaterThanOrEqual(0)

            // Explicit edges + related map to exercise BFS components, batch splitting, round-robin related & omittedRelated
            const explicitEdges = new Map<string, ReadonlySet<string>>([
              ["src/a.ts", new Set(["src/b.ts"])],
              ["src/b.ts", new Set(["src/a.ts"])]
            ])
            const explicitRelated = new Map<string, ReadonlyArray<string>>([
              ["src/a.ts", ["src/rel1.ts", "src/rel2.ts"]],
              ["src/b.ts", ["src/rel2.ts", "src/rel3.ts"]],
              ["src/c.ts", ["src/rel1.ts"]]
            ])

            const batches = ReviewBatches.planBatches({
              files: [fileA, fileB, fileC],
              edges: explicitEdges,
              related: explicitRelated,
              budget,
              maximumFiles: maxFiles,
              segmentCost: (s) => ReviewBatches.estimateTokens(s.contents) + 5,
              relatedCost: (p) => (p === "src/rel3.ts" ? 9999 : 15)
            })
            expect(batches.length).toBeGreaterThan(0)
            // Tiny budget refusal in splitFile
            expect(() => ReviewBatches.splitFile(fileA, 5, (s) => ReviewBatches.estimateTokens(s.contents) + 20))
              .toThrow(/cannot be split/)

            return true
          }),
        { executions: Math.max(executions, 60), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("LlmLint.redactCredentials exercises octal/unicode/hex/control escapes, long unclosed/quoted/unquoted values & overflow limits", async () => {
    const samples = [
      // Octal, \u{...}, out-of-range \u{999999}, \U00000041, \u0041, \x41, \a\n\r\t\b\f\v, \\
      `const api_key = "\\101\\102\\u{43}\\u{110000}\\U00000044\\u0045\\x46\\a\\n\\r\\t\\b\\f\\v\\\\secretval"\n`,
      // Very long quoted credential value past regex limit (triggers valueEnd + readToEnd)
      `const token = "${"A".repeat(300)}"\n`,
      // Very long unquoted credential value past regex limit
      `api_secret=${"B".repeat(300)} next\n`,
      // Unclosed quote on line and trailing backslash before newline
      `const password = "unclosed_line_value\nconst secret_key = "trailing_bs\\\nnext\n`,
      // Type/interface/class declaration skipped
      `interface api_key { x: string }\ntype token = string\n`,
      // Sample / placeholder masked
      `const api_token = "example-token-123456"\nconst secret_url = "https://example.com/tok"\n`,
      // Pattern-based credentials (ghp_, sk-, AWS key)
      `const gh = "ghp_${"a".repeat(36)}"\nconst aws = "AKIAIOSFODNN7EXAMPLE"\n`,
      // Overflow (> maximumFindings or budget exhaustion via many long lines)
      Array.from({ length: 120 }, (_, i) => `const api_key_${i} = "${"z".repeat(40)}_${i}"`).join("\n")
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: samples.length - 1 }))
      })
    )
    for (const s of samples) expect(typeof LlmLint.redactCredentials(s)).toBe("string")
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            const input = samples[idx]!
            const redacted = LlmLint.redactCredentials(input)
            expect(typeof redacted).toBe("string")
            if (idx === 0) {
              expect(redacted).toContain("<credential:")
            }
            if (idx === 1) {
              expect(redacted).not.toContain("A".repeat(300))
            }
            if (idx === 2) {
              expect(redacted).not.toContain("B".repeat(300))
            }
            return true
          }),
        { executions: Math.max(executions, 40), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })

  it(
    "Exec.run validates untrusted payloads (prototype, proxy, getters, sparse arrays, env/argv limits, secrets & unservable audiences)",
    async () => {
      class NonPlain {
        cwd = "."
        argv = ["echo", "ok"]
        env = {}
        expectedExitCodes = [0]
        secrets = []
        timeoutMs = 1000
      }

      const sparseArgv = ["echo"]
      sparseArgv.length = 3

      const extraPropArgv = Object.assign(["echo", "ok"], { extra: 1 })

      const nonEnumArgv = ["echo", "ok"]
      Object.defineProperty(nonEnumArgv, "0", { value: "echo", enumerable: false })

      const getterPayload = {
        cwd: ".",
        argv: ["echo", "ok"],
        env: {},
        expectedExitCodes: [0],
        secrets: [],
        timeoutMs: 1000
      }
      Object.defineProperty(getterPayload, "cwd", { get: () => ".", enumerable: true })

      const throwingProxy = new Proxy({}, {
        getPrototypeOf() {
          throw new Error("trap!")
        }
      })

      const symEnv: Record<PropertyKey, unknown> = { [Symbol("s")]: "1" }
      const tooManyEnv = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`K_${i}`, "v"]))
      const dupSecret = Secret.HttpSecret(Secret.Secret("TOK"), ["http://127.0.0.1:9999"])
      const dupSecretLower = Secret.HttpSecret(Secret.Secret("tok"), ["http://127.0.0.1:9999"])
      const httpsSecret = Secret.HttpSecret(Secret.Secret("API_TOK"), ["https://api.example.com"])

      const badPayloads: ReadonlyArray<unknown> = [
        null,
        [],
        new NonPlain(),
        throwingProxy,
        { cwd: ".", argv: ["echo"], env: {}, expectedExitCodes: [0], secrets: [], timeoutMs: 1000, extra: 1 },
        getterPayload,
        { cwd: ".", argv: sparseArgv, env: {}, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        { cwd: ".", argv: extraPropArgv, env: {}, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        { cwd: ".", argv: nonEnumArgv, env: {}, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        { cwd: ".", argv: "not-array", env: {}, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        {
          cwd: ".",
          argv: ["echo", "x".repeat(2_100_000)],
          env: {},
          expectedExitCodes: [0],
          secrets: [],
          timeoutMs: 1000
        },
        { cwd: ".", argv: ["echo"], env: tooManyEnv, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        { cwd: ".", argv: ["echo"], env: symEnv, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        { cwd: ".", argv: ["echo"], env: { "9BAD!": "1" }, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        { cwd: ".", argv: ["echo"], env: { foo: "1", FOO: "2" }, expectedExitCodes: [0], secrets: [], timeoutMs: 1000 },
        {
          cwd: ".",
          argv: ["echo"],
          env: { BIG: "x".repeat(2_100_000) },
          expectedExitCodes: [0],
          secrets: [],
          timeoutMs: 1000
        },
        {
          cwd: ".",
          argv: ["echo"],
          env: {},
          expectedExitCodes: [0],
          secrets: [dupSecret, dupSecretLower],
          timeoutMs: 1000
        },
        { cwd: ".", argv: ["echo"], env: { TOK: "1" }, expectedExitCodes: [0], secrets: [dupSecret], timeoutMs: 1000 },
        // Unservable: references S.SecretOrigin without HttpSecret
        {
          cwd: ".",
          argv: ["echo", Secret.SecretOrigin("https://missing.example.com")],
          env: {},
          expectedExitCodes: [0],
          secrets: [],
          timeoutMs: 1000
        },
        // Unservable: declares https HttpSecret without referencing S.SecretOrigin
        { cwd: ".", argv: ["echo", "hi"], env: {}, expectedExitCodes: [0], secrets: [httpsSecret], timeoutMs: 1000 }
      ]

      await withTempDir("smthrs-t7c-exec-", async (root) => {
        const arb = Arbitrary.schema(
          Schema.Struct({
            idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badPayloads.length - 1 }))
          })
        )
        for (const bp of badPayloads) {
          const ex = await Effect.runPromise(Effect.exit(Exec.run({ workspaceRoot: root }, bp as Exec.Payload)))
          expect(Exit.isFailure(ex)).toBe(true)
        }
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ idx }) =>
              Effect.gen(function*() {
                const exit = yield* Effect.exit(
                  Exec.run({ workspaceRoot: root }, badPayloads[idx] as Exec.Payload)
                )
                expect(Exit.isFailure(exit)).toBe(true)
                return true
              }),
            { executions: Math.max(executions, badPayloads.length * 3), seed: seed + 3 }
          )
        )
        assertPassed(report)

        // Also test unservableAudiences directly
        const probs1 = Exec.unservableAudiences({
          argv: ["curl", Secret.SecretOrigin("https://a.example.com")],
          env: {},
          secrets: []
        })
        expect(probs1.length).toBe(1)
        const probs2 = Exec.unservableAudiences({
          argv: ["curl", "https://b.example.com"],
          env: {},
          secrets: [httpsSecret]
        })
        expect(probs2.length).toBe(1)
      })
    },
    30_000
  )

  it(
    "Input.expandGlob & Input.digestFiles handle .gitmodules boundaries, symlinked PACKAGE.ts, broken/outside symlinks & digest index",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          caseKind: Schema.Literals(["gitmodules", "symlink-pkg", "broken-link", "outside-link", "missing-dir"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ caseKind }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-t7c-inp-", async (outer) => {
                const root = NodePath.join(outer, "ws")
                await Fs.mkdir(root, { recursive: true })
                await Fs.writeFile(NodePath.join(root, "top.txt"), "top")

                if (caseKind === "gitmodules") {
                  await Fs.writeFile(NodePath.join(root, ".gitmodules"), "[submodule \"sub\"]\n  path = vendor/sub\n")
                  await Fs.mkdir(NodePath.join(root, "vendor", "sub"), { recursive: true })
                  await Fs.writeFile(NodePath.join(root, "vendor", "sub", "inner.txt"), "inside-sub")
                  const matched = await Input.discoverFiles(root)
                  expect(matched).toContain("top.txt")
                  expect(matched).not.toContain("vendor/sub/inner.txt")
                } else if (caseKind === "symlink-pkg") {
                  await Fs.writeFile(NodePath.join(root, "real-pkg.ts"), "export default {}")
                  await Fs.mkdir(NodePath.join(root, "subpkg"), { recursive: true })
                  await Fs.symlink(NodePath.join(root, "real-pkg.ts"), NodePath.join(root, "subpkg", "PACKAGE.ts"))
                  await Fs.writeFile(NodePath.join(root, "subpkg", "child.txt"), "child")
                  const matched = await Input.expandGlob(root, "", Input.glob("**/*.txt"), { packageScoped: true })
                  expect(matched).toContain("top.txt")
                  expect(matched).not.toContain("subpkg/child.txt")
                } else if (caseKind === "broken-link") {
                  await Fs.symlink(NodePath.join(root, "does-not-exist"), NodePath.join(root, "dangling.link"))
                  const digests = SafeFs.makeDigestIndex()
                  const rows = await Input.digestFiles(root, ["dangling.link", "top.txt"], { digests })
                  expect(rows.length).toBe(2)
                } else if (caseKind === "outside-link") {
                  const extFile = NodePath.join(outer, "outside.txt")
                  await Fs.writeFile(extFile, "ext")
                  await Fs.symlink(extFile, NodePath.join(root, "escape.link"))
                  const digests = SafeFs.makeDigestIndex()
                  const rows = await Input.digestFiles(root, ["escape.link", "top.txt"], { digests })
                  expect(rows.length).toBe(2)
                } else {
                  const digests = SafeFs.makeDigestIndex()
                  const rows = await Input.digestFiles(root, ["missing/dir/file.txt", "top.txt"], { digests })
                  expect(rows.length).toBe(2)
                }
              })
              return true
            }),
          { executions: Math.max(fsExecutions, 12), seed: seed + 4 }
        )
      )
      assertPassed(report)
    },
    30_000
  )
})
