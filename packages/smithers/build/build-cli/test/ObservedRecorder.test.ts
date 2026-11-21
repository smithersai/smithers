/**
 * A run names what recorded the files its observed steps read: in its
 * summary, in the line a person reads under the counts, and in the
 * `--results-file` record. Each recorder the host can answer with is
 * supplied through the execution services, as a program that stands where
 * the recorder does; the command line runs with a stand-in strace on `PATH`.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import type * as Executor from "../src/Executor.ts"
import type * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import type * as Reporter from "../src/Reporter.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const directory = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-recorder-")))
  temporary.push(root)
  return root
}

const program = async (file: string, body: string): Promise<string> => {
  await Fs.mkdir(Path.dirname(file), { recursive: true })
  await Fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

/** Stands where strace does: answers `-V`, and runs the command after `--` with an empty trace. */
const straceBody = [
  "[ \"$1\" = -V ] && { echo 'strace -- version 6.8'; exit 0; }",
  "while [ \"$1\" != \"-o\" ]; do shift; done",
  ": > \"$2\"",
  "while [ \"$1\" != \"--\" ]; do shift; done",
  "shift",
  "exec \"$@\""
].join("\n")

/** Stands where smthrs-observe does: runs the command, then writes the line it ends a whole trace with. */
const observeBody = "trace=$1\nshift 2\n\"$@\"\nstatus=$?\necho \"1 +++ complete +++\" >> \"$trace\"\nexit $status"

const posixIt = it.skipIf(process.platform === "win32")

describe("the recorder a run names", () => {
  const fixture = async () => {
    const base = await directory()
    const root = Path.join(base, "ws")
    await Fs.mkdir(root, { recursive: true })
    await Fs.writeFile(Path.join(root, "input.txt"), "pass\n")
    const index = PackageIndex.make({
      root,
      workspace: S.Workspace("recorded", {
        repository: "git+https://example.invalid/recorded.git",
        cache: S.Cache({ directory: ".flows" }),
        host: S.Host({ bins: ["sh"] })
      }),
      factory: undefined,
      packages: [{
        file: "PACKAGE.ts",
        packagePath: "",
        value: S.Package({
          targets: {
            observed: S.Shell.Test({
              sandbox: "none",
              data: [S.glob("**")],
              shell: "/bin/cat input.txt > /dev/null",
              observe: true
            }),
            plain: S.Shell.Test({ sandbox: "none", data: [S.glob("**")], shell: "/bin/cat input.txt > /dev/null" })
          }
        })
      }]
    })
    const logs: Array<string> = []
    const options = (name: string) => ({
      index,
      cacheDirectory: ".flows",
      verb: "auto" as const,
      patterns: [`//:${name}`],
      environment: { PATH: "/usr/bin:/bin" },
      log: (line: string) => {
        logs.push(line)
      }
    })
    /** Runs one target with the host answering `observer`, and gives the run's summary. */
    const run = async (name: string, observer: ObservedReads.Observer): Promise<Executor.Summary> => {
      logs.length = 0
      const services: ExecutionServices = { ...executionServicesLive, observer: () => observer }
      return Effect.runPromise(
        executeEffect(await plan(options(name)), options(name)).pipe(Effect.provideService(ExecutionServices, services))
      )
    }
    return { base, logs, run }
  }

  posixIt("is named only by a run with a step that asks to be observed", async () => {
    const { logs, run } = await fixture()
    const summary = await run("plain", { reason: "strace is not installed" })
    expect(summary.counts.ran).toBe(1)
    expect(summary).not.toHaveProperty("recorder")
    expect(logs.filter((line) => line.startsWith("recorder:"))).toEqual([])
  })

  posixIt("is none, with the reason, where nothing can record", async () => {
    const { logs, run } = await fixture()
    const summary = await run("observed", { reason: "strace is not installed" })
    expect(summary.counts.ran).toBe(1)
    expect(summary.recorder).toEqual({ name: "none", why: "strace is not installed" })
    expect(logs).toContain("recorder: none (strace is not installed)")
  })

  posixIt("is strace, and says why when smthrs-observe was built for the host", async () => {
    const { base, logs, run } = await fixture()
    const tracer = await program(Path.join(base, "tools", "strace"), straceBody)
    const alone = await run("observed", { tracer })
    expect(alone.counts.ran).toBe(1)
    expect(alone.recorder).toEqual({ name: "strace" })
    expect(logs).toContain("recorder: strace")
    const why = "SMTHRS_OBSERVE_WITH=strace asks for strace"
    const asked = await run("observed", { tracer, why })
    expect(asked.recorder).toEqual({ name: "strace", why })
    expect(logs).toContain(`recorder: strace (${why})`)
  })

  posixIt("is smthrs-observe where it records", async () => {
    const { base, logs, run } = await fixture()
    const supervisor = await program(Path.join(base, "tools", "smthrs-observe"), observeBody)
    const summary = await run("observed", { tracer: supervisor, supervisor: true })
    expect(summary.counts.ran).toBe(1)
    expect(summary.recorder).toEqual({ name: "smthrs-observe" })
    expect(logs).toContain("recorder: smthrs-observe")
  })
})

describe("the command line", () => {
  const terminal = (): Reporter.Terminal & { readonly text: () => string } => {
    let out = ""
    return {
      write: (text) => {
        out += text
      },
      isTTY: false,
      columns: 100,
      text: () => out
    }
  }

  const withEnvironment = async <A>(
    values: Readonly<Record<string, string>>,
    body: () => Promise<A>
  ): Promise<A> => {
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
    Object.assign(process.env, values)
    try {
      return await body()
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  // On Linux for x86_64 and aarch64 smthrs-observe is built for the machine, so the record says why strace records.
  it.runIf(process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"))(
    "writes the recorder, and why strace recorded, into the results file and the summary",
    async () => {
      const base = await directory()
      const root = Path.join(base, "ws")
      await Fs.mkdir(root, { recursive: true })
      await Fs.writeFile(
        Path.join(root, "WORKSPACE.ts"),
        `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("recorded", {
  repository: "git+https://example.invalid/recorded.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] })
})
`
      )
      await Fs.writeFile(
        Path.join(root, "PACKAGE.ts"),
        `import { Smithers as S } from "@smthrs/targets"
const observed = S.Shell.Test({ sandbox: "none", data: [S.glob("**")], shell: "/bin/cat input.txt > /dev/null", observe: true })
export const Package = S.Package({ targets: { observed } })
`
      )
      await Fs.writeFile(Path.join(root, "input.txt"), "pass\n")
      const tools = Path.join(base, "tools")
      await program(Path.join(tools, "strace"), straceBody)
      const environment = { SMTHRS_OBSERVE_WITH: "strace", PATH: [tools, "/usr/bin", "/bin"].join(Path.delimiter) }
      const stdout = terminal()
      const stderr = terminal()
      let envelope = ""
      let exitCode = 0
      await withEnvironment(environment, () =>
        makeCli({
          environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
          stdout,
          stderr
        }).serve(
          [
            ...normalizeArgv(["ci", "//:observed", "--results-file", "results.json", "--format", "json"]),
            "--workspace",
            root
          ],
          {
            exit: (code) => {
              exitCode = code
            },
            stdout: (text) => {
              envelope += text
            }
          }
        ))
      expect(exitCode, envelope + stderr.text()).toBe(0)
      const recorder = { name: "strace", why: "SMTHRS_OBSERVE_WITH=strace asks for strace" }
      const record = JSON.parse(await Fs.readFile(Path.join(root, "results.json"), "utf8"))
      expect(record).toMatchObject({ ok: true, counts: { ran: 1 }, recorder })
      expect(JSON.parse(envelope).recorder).toEqual(recorder)
    }
  )
})
