/**
 * Verification, against real processes and a real flows directory. The
 * commands are `node -e` stand-ins so the test needs no toolchain, but they are
 * genuinely spawned: exit codes, output tails, and the timeout all come from a
 * real child process.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Verify from "@smthrs/migrate/flow/Verify"
import * as Report from "@smthrs/migrate/Report"
import * as Effect from "effect/Effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const platform = NodeServices.layer

const temporaries: Array<string> = []
const scratch = (name: string): string => {
  const target = mkdtempSync(join(tmpdir(), `migrate-verify-${name}-`))
  temporaries.push(target)
  return target
}
process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

/** A project whose `flows/` directory holds one discoverable flow. */
const projectWithFlow = (name: string, descriptor: string): string => {
  const root = scratch(name)
  mkdirSync(join(root, "flows", "demo"), { recursive: true })
  writeFileSync(join(root, "flows", "demo", "flow.ts"), descriptor)
  return root
}

const discoverable = `import { Flow } from "@smthrs/core"
import * as Schema from "effect/Schema"

export default Flow.make({
  description: "A demonstration flow.",
  input: Schema.Struct({ topic: Schema.String }),
  output: Schema.String,
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
})
`

const nodeCommand = (script: string): string => `node -e ${JSON.stringify(script)}`

describe("Verify.run", () => {
  it.effect("runs every command, records its exit code, and passes when all of them agree", () =>
    Effect.gen(function*() {
      const root = projectWithFlow("pass", discoverable)

      const result = yield* Verify.run({
        root,
        commands: {
          install: nodeCommand("process.stdout.write('installed')"),
          format: nodeCommand("process.stdout.write('formatted')"),
          typecheck: [nodeCommand("process.stdout.write('typechecked')")],
          test: nodeCommand("process.stdout.write('tested')"),
          flowsDir: "flows"
        }
      })

      expect(result.install?.exitCode).toBe(0)
      expect(result.install?.stdoutTail).toBe("installed")
      expect(result.typecheck).toHaveLength(1)
      expect(result.tests?.stdoutTail).toBe("tested")
      expect(result.discovery?.exitCode).toBe(0)
      expect(Verify.verdict(result)).toBe("pass")
      expect(Verify.failures(result)).toEqual([])
    }).pipe(Effect.provide(platform)))

  it.effect("reports a failing command rather than throwing, and fails the verdict", () =>
    Effect.gen(function*() {
      const root = projectWithFlow("fail", discoverable)

      const result = yield* Verify.run({
        root,
        commands: {
          typecheck: [nodeCommand("process.stderr.write('flow.ts(3,1): error TS2304'); process.exit(2)")],
          flowsDir: "flows"
        }
      })

      expect(result.typecheck[0]?.exitCode).toBe(2)
      expect(result.typecheck[0]?.stderrTail).toContain("error TS2304")
      expect(Verify.verdict(result)).toBe("fail")
      expect(Verify.failures(result)[0]).toContain("exited 2")
    }).pipe(Effect.provide(platform)))

  it.effect("redacts credentials a command prints before the report captures them", () =>
    Effect.gen(function*() {
      const root = projectWithFlow("redact", discoverable)

      // Each secret is assembled inside the child, so only its output, and not
      // the command line the report also records, carries the whole value.
      const result = yield* Verify.run({
        root,
        commands: {
          typecheck: [
            nodeCommand("process.stderr.write('Authorization: Bearer ' + 'abc123' + 'def456ghi789'); process.exit(1)")
          ],
          test: nodeCommand("process.stdout.write('OPENAI_API_KEY=' + 'live-' + '9f8e7d6c5b4a')"),
          flowsDir: "flows"
        }
      })
      const directory = scratch("redact-report")
      const report = new Report.MigrationReport({
        ...Report.empty(root, "apply", "2026-09-10T00:00:00.000Z"),
        verification: result
      })
      const written = yield* Report.write(directory, report)

      expect(result.tests?.stdoutTail).toBe("OPENAI_API_KEY=[REDACTED]")
      expect(result.typecheck[0]?.stderrTail).toBe("Authorization: Bearer [REDACTED_TOKEN]")
      for (const path of written) {
        const text = readFileSync(path, "utf8")
        expect(text).not.toContain("live-9f8e7d6c5b4a")
        expect(text).not.toContain("abc123def456ghi789")
      }
    }).pipe(Effect.provide(platform)))

  it.effect("skips install and format with a reason, and a skip is not a failure", () =>
    Effect.gen(function*() {
      const root = projectWithFlow("skip", discoverable)

      const result = yield* Verify.run({ root, commands: { typecheck: [], flowsDir: "flows" } })

      expect(result.install?.skipped).toBe("no lockfile names an install command")
      expect(result.format?.skipped).toBe("the project configures no formatter")
      expect(result.tests?.skipped).toBe("the project declares no test command")
      expect(Verify.verdict(result)).toBe("pass")
    }).pipe(Effect.provide(platform)))

  it.effect("fails discovery when the migrated flow carries no description", () =>
    Effect.gen(function*() {
      const root = projectWithFlow(
        "nodescription",
        discoverable.replace("  description: \"A demonstration flow.\",\n", "")
      )

      const result = yield* Verify.run({ root, commands: { typecheck: [], flowsDir: "flows" } })

      expect(result.discovery?.exitCode).toBe(1)
      expect(result.discovery?.stdoutTail).toContain("description")
      expect(Verify.verdict(result)).toBe("fail")
    }).pipe(Effect.provide(platform)))

  it.effect("fails discovery when the flows directory does not exist yet", () =>
    Effect.gen(function*() {
      const result = yield* Verify.run({
        root: scratch("noflows"),
        commands: { typecheck: [], flowsDir: "flows" }
      })

      expect(result.discovery?.exitCode).toBe(1)
      expect(result.discovery?.stdoutTail).toContain("does not exist")
    }).pipe(Effect.provide(platform)))

  it.live("records an instant spawn failure as such, not as a full timeout", () =>
    Effect.gen(function*() {
      const missingRoot = join(scratch("spawn-failure"), "does-not-exist")
      const budget = 60_000

      const result = yield* Verify.run({
        root: missingRoot,
        commands: { typecheck: [nodeCommand("process.exit(0)")], flowsDir: "flows" }
      }, { command: budget })

      expect(result.typecheck[0]?.exitCode).toBe(127)
      expect(result.typecheck[0]?.durationMs).toBeLessThan(budget)
      expect(result.typecheck[0]?.stderrTail).not.toContain(`exceeded ${budget}ms`)
    }).pipe(Effect.provide(platform)))

  it.live("cuts a command off at its budget and reports it as a failure", () =>
    Effect.gen(function*() {
      const root = projectWithFlow("timeout", discoverable)

      const result = yield* Verify.run({
        root,
        commands: {
          typecheck: ["node -e \"setTimeout(() => {}, 60000)\""],
          flowsDir: "flows"
        }
      }, { command: 500 })

      expect(result.typecheck[0]?.exitCode).toBe(124)
      expect(result.typecheck[0]?.stderrTail).toContain("exceeded 500ms")
      expect(Verify.verdict(result)).toBe("fail")
    }).pipe(Effect.provide(platform)))
})
