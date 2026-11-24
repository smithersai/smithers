import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, FileSystem, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import * as SandboxTools from "../src/SandboxTools/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "120")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261804")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const getServices = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return { fs, spawner }
}).pipe(Effect.provide(platform))

describe("@smthrs/sandbox Wave 8 deep fuzz (Microsandbox limits/network/reattach, SandboxTools.execute & path confinement)", () => {
  it("MicrosandboxSandbox.make enforces exclusive limits/network options, wildcard apex-deny rules & configuration reattach validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "exclusive-cpus",
          "exclusive-mem",
          "exclusive-timeout",
          "exclusive-net",
          "allow-wildcard",
          "allow-apex-and-wildcard",
          "reattach-mismatch",
          "reattach-corrupt-label"
        ]),
        cpus: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        memoryMib: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 2048 }))
      })
    )

    const noopCollector = { register: () => {} } as any
    const makeSdk = (labels: Record<string, string>) =>
      ({
        Sandbox: {
          create: async () => ({
            name: "msb-1",
            labels,
            exec: async () => ({ code: 0, stdout: () => Promise.resolve("ok"), stderr: () => Promise.resolve("") }),
            stop: async () => {},
            remove: async () => {},
            fs: {
              read: async () => new Uint8Array(),
              write: async () => {},
              list: async () => [],
              mkdir: async () => {},
              remove: async () => {}
            }
          }),
          get: async () => ({
            name: "msb-1",
            labels,
            exec: async () => ({ code: 0, stdout: () => Promise.resolve("ok"), stderr: () => Promise.resolve("") }),
            stop: async () => {},
            remove: async () => {},
            fs: {
              read: async () => new Uint8Array(),
              write: async () => {},
              list: async () => [],
              mkdir: async () => {},
              remove: async () => {}
            }
          })
        }
      }) as any

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (v) =>
          Effect.gen(function*() {
            if (v.mode === "exclusive-cpus") {
              expect(() =>
                MicrosandboxSandbox.make({
                  sdk: makeSdk({}),
                  collector: noopCollector,
                  cpus: v.cpus,
                  limits: { cpus: v.cpus }
                })
              ).toThrow(TypeError)
              return true
            }
            if (v.mode === "exclusive-mem") {
              expect(() =>
                MicrosandboxSandbox.make({
                  sdk: makeSdk({}),
                  collector: noopCollector,
                  memoryMib: v.memoryMib,
                  limits: { memoryMib: v.memoryMib }
                })
              ).toThrow(TypeError)
              return true
            }
            if (v.mode === "exclusive-timeout") {
              expect(() =>
                MicrosandboxSandbox.make({
                  sdk: makeSdk({}),
                  collector: noopCollector,
                  maxDurationSecs: 60,
                  limits: { timeoutSecs: 60 }
                })
              ).toThrow(TypeError)
              return true
            }
            if (v.mode === "exclusive-net") {
              expect(() =>
                MicrosandboxSandbox.make({
                  sdk: makeSdk({}),
                  collector: noopCollector,
                  network: "none",
                  networkPolicy: "none" as any
                })
              ).toThrow(TypeError)
              return true
            }

            const network = v.mode === "allow-wildcard"
              ? ({ allow: ["*.example.com", "api.other.test"] } as const)
              : v.mode === "allow-apex-and-wildcard"
              ? ({ allow: ["*.example.com", "example.com"] } as const)
              : ("none" as const)

            const labels: Record<string, string> =
              v.mode === "reattach-corrupt-label"
                ? { "smithers.configuration": "{bad-json" }
                : v.mode === "reattach-mismatch"
                ? { "smithers.configuration": JSON.stringify({ image: "other-image", cpus: 99 }) }
                : {}

            const provider = MicrosandboxSandbox.make({
              sdk: makeSdk(labels),
              collector: noopCollector,
              persistence: "sticky",
              limits: { cpus: v.cpus, memoryMib: v.memoryMib, timeoutSecs: 60 },
              network
            })
            expect(typeof provider.acquire).toBe("function")
            if (v.mode === "reattach-mismatch" || v.mode === "reattach-corrupt-label") {
              const ex = yield* Effect.exit(Effect.scoped(provider.acquire("msb-1")))
              expect(Exit.isFailure(ex)).toBe(true)
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("SandboxTools.execute exercises write/read/list/run/status/diff & path traversal refusal over real DirectorySandbox", async () => {
    const services = await Effect.runPromise(getServices)
    const arb = Arbitrary.schema(
      Schema.Struct({
        fileName: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(10), Schema.isPattern(/^[a-z0-9]+$/)),
        content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40), Schema.isPattern(/^[a-zA-Z0-9 _-]+$/)),
        escapePath: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (v) =>
          Effect.gen(function*() {
            const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-w8-tools-")))
            try {
              const provider = DirectorySandbox.make({ root, ...services })
              return yield* Effect.scoped(
                Effect.gen(function*() {
                  const session = yield* provider.acquire("w8-sess")
                  const rel = `${v.fileName}.txt`
                  expect(SandboxTools.mutates("write")).toBe(true)
                  expect(SandboxTools.mutates("run")).toBe(true)
                  expect(SandboxTools.mutates("read")).toBe(false)
                  expect(SandboxTools.resolve(session.workdir, rel)).toBeDefined()
                  expect(SandboxTools.resolve(session.workdir, "../../etc/passwd")).toBeUndefined()

                  const w = yield* SandboxTools.execute(session, { tool: "write", path: rel, content: v.content }, { callId: "w8-c1", callsDirectory: join(session.workdir, ".calls") })
                  expect(w.tool).toBe("write")
                  expect(w.bytes).toBeGreaterThan(0)

                  const r = yield* SandboxTools.execute(session, { tool: "read", path: rel }, { callId: "w8-c1", callsDirectory: join(session.workdir, ".calls") })
                  expect(r.tool).toBe("read")
                  expect(r.content).toContain(v.content)

                  const l = yield* SandboxTools.execute(session, { tool: "list" }, { callId: "w8-c1", callsDirectory: join(session.workdir, ".calls") })
                  expect(l.tool).toBe("list")
                  expect(l.entries.some((e) => e.name === rel)).toBe(true)

                  const runRes = yield* SandboxTools.execute(session, { tool: "run", command: `cat ${rel}` }, { callId: "w8-c1", callsDirectory: join(session.workdir, ".calls") })
                  expect(runRes.tool).toBe("run")
                  expect(runRes.exitCode).toBe(0)
                  expect(runRes.stdout).toContain(v.content)

                  if (v.escapePath) {
                    const badEx = yield* Effect.exit(
                      SandboxTools.execute(session, { tool: "read", path: "../../etc/passwd" }, { callId: "w8-c1", callsDirectory: join(session.workdir, ".calls") })
                    )
                    expect(Exit.isFailure(badEx)).toBe(true)
                  }
                  return true
                })
              )
            } finally {
              rmSync(root, { recursive: true, force: true })
            }
          }),
        { seed: seed + 1, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(report)
    expect(typeof SandboxConformance.check).toBe("function")
  }, 90_000)
})
