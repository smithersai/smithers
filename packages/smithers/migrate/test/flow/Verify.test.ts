/**
 * Verification, against real processes and a real flows directory. The
 * commands are `node -e` stand-ins so the test needs no toolchain, but they are
 * genuinely spawned: exit codes, output tails, and the timeout all come from a
 * real child process.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Verify from "@smthrs/migrate/flow/Verify"
import * as Report from "@smthrs/migrate/Report"
import * as Units from "@smthrs/migrate/Units"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unconfinedNode } from "../fixtures/helpers.ts"

/** The explicit unconfined choice: this suite's subject is what a command reports. */
const platform = unconfinedNode

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

/** The shape a migrated flow module has: one default-exported flow. */
const discoverable = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

export default Flow.make("demo", {
  description: "A demonstration flow.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: Schema.Struct({ topic: Schema.String }),
  success: Schema.String,
  body: ({ topic }) => Node.succeed(topic)
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

describe("Verify.run confines every command it starts", () => {
  const marking = (name: string): string => nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(name)}, '')`)

  it.effect("starts no command, and says why, when the host provides no confinement", () =>
    Effect.gen(function*() {
      const root = projectWithFlow("unconfined", discoverable)

      const result = yield* Verify.run({
        root,
        commands: {
          install: marking("installed"),
          format: Units.argv("node", "-e", "require('node:fs').writeFileSync('formatted', '')"),
          typecheck: [marking("typechecked")],
          test: marking("tested"),
          flowsDir: "flows"
        }
      })

      for (const command of [result.install, result.format, result.typecheck[0], result.tests]) {
        expect(command?.exitCode).toBe(127)
        expect(command?.stderrTail).toContain("process confinement is required to run a verification command")
      }
      for (const name of ["installed", "formatted", "typechecked", "tested"]) {
        expect(existsSync(join(root, name))).toBe(false)
      }
      // Discovery reads files in this process and starts nothing, so it still answers.
      expect(result.discovery?.exitCode).toBe(0)
      expect(Verify.verdict(result)).toBe("fail")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("hands each command to the confinement with a profile that opens the project and seals what exists", () => {
    const calls: Array<{ readonly command: string; readonly profile: KernelProcessConfinement.Profile }> = []
    const recording = Layer.succeed(KernelProcessConfinement.ProcessConfinement)({
      confine: (command, profile) =>
        Effect.sync(() => {
          calls.push({ command: command.command, profile })
          return command
        })
    })
    return Effect.gen(function*() {
      const root = projectWithFlow("profile", discoverable)
      mkdirSync(join(root, ".git"))
      mkdirSync(join(root, ".smithers-migrate"))
      const install = nodeCommand("process.exit(0)")

      const result = yield* Verify.run({
        root,
        commands: {
          install,
          format: Units.argv("node", "-e", ""),
          typecheck: [Units.argv("node", "-e", ""), Units.argv("node", "-e", "")],
          test: Units.argv("node", "-e", ""),
          flowsDir: "flows"
        },
        // A path that is missing, one that leaves the root, one that is
        // absolute and elsewhere, and the root itself seal nothing.
        sealed: [".smithers-migrate", "not-there", "../elsewhere", tmpdir(), ".", ".smithers-migrate"]
      })

      expect(Verify.verdict(result)).toBe("pass")
      expect(calls.map((call) => call.command)).toEqual([install, "node", "node", "node", "node"])
      for (const call of calls) {
        expect(call.profile).toEqual({
          workspaceRoot: root,
          reads: ["."],
          writes: ["."],
          // `.jj` is sealed whenever it exists; this project has none.
          readOnly: [".git", ".smithers-migrate"],
          network: "open"
        })
      }
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, recording)))
  })

  it.effect("seals a path the host could not probe, so the mechanism refuses rather than leaves it open", () => {
    const profiles: Array<KernelProcessConfinement.Profile> = []
    const recording = Layer.succeed(KernelProcessConfinement.ProcessConfinement)({
      confine: (command, profile) =>
        Effect.sync(() => {
          profiles.push(profile)
          return command
        })
    })
    // The fault: the probe of `.jj` fails, as on a directory the host may not stat.
    const unprobeable = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        exists: (path: string) =>
          path.endsWith(".jj")
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "exists",
              description: "the probe was refused",
              pathOrDescriptor: path
            }))
            : fs.exists(path)
      }))
    ).pipe(Layer.provide(NodeServices.layer))
    return Effect.gen(function*() {
      const root = projectWithFlow("unprobeable", discoverable)

      yield* Verify.run({
        root,
        commands: { typecheck: [Units.argv("node", "-e", "")], flowsDir: "flows" }
      })

      // `.git` was probed and is absent; `.jj` could not be probed.
      expect(profiles.map((profile) => profile.readOnly)).toEqual([[".jj"]])
    }).pipe(Effect.provide(unprobeable), Effect.provide(Layer.merge(NodeServices.layer, recording)))
  })

  it.effect("removes version-control metadata a command created, and fails the verification", () =>
    Effect.gen(function*() {
      // No mechanism can seal a path that is not there. A checkpoint that
      // found this `.git` would run the monitor its configuration names.
      const root = projectWithFlow("planted", discoverable)
      mkdirSync(join(root, ".jj"))
      const plant = nodeCommand(
        "const fs = require('node:fs'); fs.mkdirSync('.git'); " +
          "fs.writeFileSync('.git/config', '[core]\\n\\tfsmonitor = touch planted\\n'); " +
          "fs.writeFileSync('.jj/written-by-a-command', '')"
      )

      const result = yield* Verify.run({
        root,
        commands: { typecheck: [Units.argv("node", "-e", "")], test: plant, flowsDir: "flows" }
      })

      expect(result.tests?.exitCode, result.tests?.stderrTail).toBe(0)
      expect(existsSync(join(root, ".git"))).toBe(false)
      // What was there before the commands is the operator's, and stays.
      expect(existsSync(join(root, ".jj", "written-by-a-command"))).toBe(true)
      expect(result.typecheck.map((command) => command.exitCode)).toEqual([0, 1])
      expect(result.typecheck[1]?.command).toBe("version-control metadata")
      expect(result.typecheck[1]?.stderrTail).toContain("created .git at the project root, and the host removed it")
      expect(Verify.verdict(result)).toBe("fail")

      // A run that plants nothing reports nothing.
      const clean = yield* Verify.run({ root, commands: { typecheck: [], flowsDir: "flows" } })
      expect(clean.typecheck).toEqual([])
    }).pipe(Effect.provide(platform)))

  it.effect("reports a confinement's refusal as the command's failure and starts nothing", () =>
    Effect.gen(function*() {
      const root = projectWithFlow("refused", discoverable)

      const result = yield* Verify.run({
        root,
        commands: { typecheck: [], test: marking("tested"), flowsDir: "flows" }
      })

      expect(result.tests?.exitCode).toBe(127)
      expect(result.tests?.stderrTail).toContain("bwrap is not on PATH")
      expect(existsSync(join(root, "tested"))).toBe(false)
      expect(Verify.failures(result)).toEqual([`\`${marking("tested")}\` exited 127`])
    }).pipe(Effect.provide(Layer.merge(
      NodeServices.layer,
      Layer.succeed(KernelProcessConfinement.ProcessConfinement)({
        confine: () =>
          Effect.fail(PlatformError.systemError({
            _tag: "NotFound",
            module: "ProcessConfinement",
            method: "confine",
            description: "bwrap is not on PATH (install the bubblewrap package)"
          }))
      })
    ))))
})
