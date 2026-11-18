import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { afterAll, describe, expect, it } from "vitest"
import { layer, main } from "../../src/cli/main.vibe"
import { parts as onMain } from "../../src/cli/parts.ts"
import { exitCodes, failureExitCodes, flags } from "../../src/contract/Command.ts"
import { Inventory } from "../../src/contract/Inventory.ts"
import type { Failure, GeneratedFile } from "../../src/contract/Parts.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { fullDisk, generated, inProcess } from "./inProcess.vibe"
import { parts } from "./parts.vibe"
import {
  bin,
  changed,
  head,
  type Outcome,
  program,
  read,
  recorder,
  remove,
  repository,
  snapshot,
  spawn,
  temporary
} from "./repo.ts"

type Chosen = typeof parts

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const repo = (subjects?: ReadonlyArray<string>): string => keep(repository(subjects))
const scratch = (): string => keep(temporary("scratch"))

const runIn = async (args: ReadonlyArray<string>, root: string, chosen: Chosen, faulty?: typeof fullDisk) => {
  const sink = recorder()
  const code = await inProcess(args, root, chosen, sink.service as never, faulty)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() } satisfies Outcome
}

const ways = {
  "in process": (args: ReadonlyArray<string>, root: string): Promise<Outcome> => runIn(args, root, parts),
  "as a process": (args: ReadonlyArray<string>, root: string): Promise<Outcome> => spawn(program, args, root)
}

const commandNames = ["", "apply", "inventory", "replay"] as const
const flagNames = Object.keys(flags) as ReadonlyArray<keyof typeof flags>
const sample = (flag: keyof typeof flags, out: string): ReadonlyArray<string> =>
  ({
    commits: ["--commits", "2"],
    mode: ["--mode", "fast"],
    jobs: ["--jobs", "3"],
    cache: ["--cache", "https://cache.example.invalid"],
    out: ["--out", out],
    json: ["--json"]
  })[flag]

const requestOf = (stderr: string): unknown => JSON.parse(/replay request: (.*)/.exec(stderr)?.[1] ?? "null")

const decode = <S extends Schema.Top>(schema: S, stdout: string) =>
  Schema.decodeUnknownSync(schema as never)(JSON.parse(stdout)) as S["Type"]

const pathsOf = (files: ReadonlyArray<GeneratedFile>): ReadonlyArray<string> => files.map((file) => file.path).sort()

describe.each(Object.entries(ways))("smithers-ci %s", (_way, exec) => {
  describe.concurrent("contract 7: commands, flags and exit codes", () => {
    it("prints help for every command and exits 0", async () => {
      const help = await exec(["--help"], repo())
      expect(help.code).toBe(exitCodes.ok)
      for (const name of ["apply", "inventory", "replay"]) expect(help.stdout).toContain(name)
      for (const flag of flagNames) expect(help.stdout).toContain(`--${flag}`)
      expect(help.stdout).toContain("Writes nothing to the repository.")
      expect(help.stdout).toContain("How many past commits to replay. Default: 20.")
      expect(help.stdout).not.toContain("--version")
      expect(help.stdout).not.toContain("--completions")
    })

    for (const command of commandNames.filter((name) => name !== "")) {
      it(`lists exactly the flags of ${command} in its help`, async () => {
        const help = await exec([command, "-h"], repo())
        expect(help.code).toBe(exitCodes.ok)
        for (const flag of flagNames) {
          const on: ReadonlyArray<string> = flags[flag].on
          expect(help.stdout.includes(`--${flag}`), `--${flag}`).toBe(on.includes(command))
        }
      })
    }

    for (const command of commandNames) {
      for (const flag of flagNames) {
        const on: ReadonlyArray<string> = flags[flag].on
        const accepted = on.includes(command)
        const where = command === "" ? "the default command" : command
        it(`${accepted ? "accepts" : "refuses with exit 2"} --${flag} on ${where}`, async () => {
          const args = [...(command === "" ? [] : [command]), ...sample(flag, `${scratch()}/report.html`)]
          const outcome = await exec(args, repo())
          if (accepted) expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
          else {
            expect(outcome.code).toBe(exitCodes.usage)
            expect(outcome.stdout).toBe("")
            expect(outcome.stderr).toContain(`--${flag}`)
            expect(outcome.stderr.trim().split("\n")).toHaveLength(1)
          }
        })
      }
    }

    const refusals: ReadonlyArray<[string, ReadonlyArray<string>, string]> = [
      ["an unknown flag", ["--bogus"], "--bogus"],
      ["an unknown flag after a command", ["replay", "--bogus"], "--bogus"],
      ["an unknown command", ["deploy"], "deploy"],
      ["an extra argument", ["apply", "now"], "now"],
      ["--version, which contract 7 does not have", ["--version"], "--version"],
      ["--commits 0", ["--commits", "0"], "1 or more"],
      ["--commits that is not a number", ["--commits", "many"], "--commits"],
      ["--jobs 0", ["replay", "--jobs", "0"], "1 or more"],
      ["a --mode outside normal, fast and both", ["--mode", "slow"], "slow"],
      ["a --cache that is not a URL", ["--cache", "cache"], "http or https URL"],
      ["a --cache that is not http", ["apply", "--cache", "ftp://cache.example.invalid"], "http or https URL"],
      ["an empty --out", ["--out", ""], "a file path"]
    ]
    for (const [what, args, named] of refusals) {
      it(`exits 2 with one line on ${what}`, async () => {
        const root = repo()
        const before = snapshot(root)
        const outcome = await exec(args, root)
        expect(outcome.code).toBe(exitCodes.usage)
        expect(outcome.stdout).toBe("")
        expect(outcome.stderr).toContain(named)
        expect(outcome.stderr).toContain("smithers-ci --help")
        expect(outcome.stderr.trim().split("\n")).toHaveLength(1)
        expect(changed(before, snapshot(root))).toEqual([])
      })
    }
  })

  describe.concurrent("the default command", () => {
    it("prints the report and leaves the repository byte-identical", async () => {
      const root = repo()
      const files = await generated(root, parts)
      const before = snapshot(root)
      const outcome = await exec([], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(outcome.stdout).toContain("× faster")
      expect(outcome.stdout).toContain("3 commits · 0 mismatches")
      expect(outcome.stdout).toContain(
        `smithers-ci apply would write ${files.length} files. This run wrote nothing to the repository.`
      )
      expect(requestOf(outcome.stderr)).toEqual({ root, commits: 20, modes: ["normal"] })
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("prints a replay report that decodes with --json, and still writes nothing", async () => {
      const root = repo()
      const before = snapshot(root)
      const outcome = await exec(["--json"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      const report = decode(ReplayReport, outcome.stdout)
      expect(report.commits).toHaveLength(3)
      expect(report.fastWallMs).toBeUndefined()
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("passes every replay flag to the replay and writes the page outside the repository", async () => {
      const root = repo()
      const page = `${scratch()}/pages/report.html`
      const before = snapshot(root)
      const cache = "https://cache.example.invalid"
      const args = ["--commits", "2", "--mode", "both", "--jobs", "3", "--cache", cache, "--out", page, "--json"]
      const outcome = await exec(args, root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(requestOf(outcome.stderr)).toEqual({ root, commits: 2, modes: ["normal", "fast"], jobs: 3, cache })
      const report = decode(ReplayReport, outcome.stdout)
      expect(report.commits).toHaveLength(2)
      expect(report.fastWallMs).toBe(100)
      expect(read(page)).toContain("<!doctype html>")
      expect(outcome.stderr).toContain(`smithers-ci: wrote ${page}`)
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("asks for fast mode alone with --mode fast", async () => {
      const root = repo()
      const outcome = await exec(["--mode", "fast"], root)
      expect(outcome.code).toBe(exitCodes.ok)
      expect(requestOf(outcome.stderr)).toEqual({ root, commits: 20, modes: ["fast"] })
    })

    it("resolves a relative --out against the repository, the one file it writes", async () => {
      const root = repo()
      const before = snapshot(root)
      const outcome = await exec(["--out", "report.html"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(changed(before, snapshot(root))).toEqual(["report.html"])
    })

    it("exits 1 when a replayed commit mismatches its baseline", async () => {
      const outcome = await exec([], repo(["first", "second [mismatch]"]))
      expect(outcome.code).toBe(exitCodes.mismatch)
      expect(outcome.stdout.startsWith("✗ 1 mismatch")).toBe(true)
    })
  })

  describe.concurrent("replay", () => {
    it("prints the replay report", async () => {
      const outcome = await exec(["replay", "--commits", "1"], repo())
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(outcome.stdout).toContain("1 commit · 0 mismatches")
      expect(outcome.stdout).not.toContain("apply would write")
    })

    it("prints the document with --json and exits 1 on a mismatch", async () => {
      const outcome = await exec(["replay", "--json"], repo(["only [mismatch]"]))
      expect(outcome.code).toBe(exitCodes.mismatch)
      expect(decode(ReplayReport, outcome.stdout).mismatches).toBe(1)
    })
  })

  describe.concurrent("inventory", () => {
    it("prints the jobs and their commands", async () => {
      const root = repo()
      const before = snapshot(root)
      const outcome = await exec(["inventory"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(outcome.stdout.split("\n").slice(1)).toEqual([
        "toolchain just (justfile)",
        "job justfile:build (justfile justfile)",
        "  $ zig build",
        "job justfile:test (justfile justfile, needs justfile:build)",
        "  $ zig build test",
        "  $ zig build check",
        ""
      ])
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("prints an inventory that decodes with --json", async () => {
      const outcome = await exec(["inventory", "--json"], repo())
      expect(outcome.code).toBe(exitCodes.ok)
      expect(decode(Inventory, outcome.stdout).jobs.map((job) => job.id)).toEqual(["justfile:build", "justfile:test"])
    })

    it("exits 2 outside a repository", async () => {
      const directory = scratch()
      const outcome = await exec(["inventory"], directory)
      expect(outcome).toEqual({
        code: exitCodes.usage,
        stdout: "",
        stderr: `smithers-ci: inventory: ${directory} is not a git repository with a commit\n`
      })
    })
  })

  describe.concurrent("apply", () => {
    it("writes exactly the generated files", async () => {
      const root = repo()
      const files = await generated(root, parts)
      const before = snapshot(root)
      const outcome = await exec(["apply", "--cache", "https://cache.example.invalid"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(files.length).toBeGreaterThan(0)
      expect(changed(before, snapshot(root))).toEqual(pathsOf(files))
      for (const file of files) expect(read(`${root}/${file.path}`)).toBe(file.content)
      for (const file of files) expect(outcome.stdout).toContain(`wrote ${file.path}\n`)
      expect(outcome.stdout).toContain(`smithers-ci: wrote ${files.length} files`)
    })
  })
})

describe.concurrent("smithers-ci on main's parts, as the installed program", () => {
  it("prints help", async () => {
    const outcome = await spawn(bin, ["--help"], repo())
    expect(outcome.code).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain("SUBCOMMANDS")
  })

  it("exits 2 on an unknown flag", async () => {
    expect((await spawn(bin, ["--bogus"], repo())).code).toBe(exitCodes.usage)
  })

  it("prints the inventory and applies the generated files", async () => {
    const root = repo()
    const inventory = await spawn(bin, ["inventory", "--json"], root)
    expect(inventory.code, inventory.stderr).toBe(exitCodes.ok)
    expect(decode(Inventory, inventory.stdout).jobs).toHaveLength(2)
    const files = await generated(root, onMain)
    const before = snapshot(root)
    const apply = await spawn(bin, ["apply"], root)
    expect(apply.code, apply.stderr).toBe(exitCodes.ok)
    expect(changed(before, snapshot(root))).toEqual(pathsOf(files))
  })

  it("exits 3 naming the replay part, which has not landed, and writes nothing", async () => {
    const root = repo()
    const before = snapshot(root)
    for (const args of [[], ["replay"]]) {
      expect(await spawn(bin, args, root)).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr: "smithers-ci: replay: the replay part is not built yet\n"
      })
    }
    expect(await main(["replay"], root)).toBe(exitCodes.unsupported)
    expect(changed(before, snapshot(root))).toEqual([])
  })

  it("provides the select part's services, with no judge configured", async () => {
    const root = repo()
    const record = { ok: true, counts: { hit: 0, ran: 0, failed: 0, skipped: 0 }, results: [], commit: head(root) }
    expect(await Effect.runPromise(Effect.provide(onMain.rows(root, record), layer))).toEqual([])
    expect(await Effect.runPromise(Effect.provide(onMain.score([]), layer))).toEqual([])
    const features = {
      extensions: [".zig"],
      fileChanges: { d3: 1, d14: 1, d56: 1 },
      failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
      project: "ci",
      testCount: 1,
      graphDistance: 1
    }
    const row = { commit: "c", target: "//ci:test", features, attempts: [true], failed: false, flaky: false }
    const failure = await Effect.runPromise(Effect.provide(Effect.flip(onMain.score([row])), layer))
    expect([failure.code, failure.part]).toEqual(["model-unavailable", "select"])
  })
})

describe.concurrent("smithers-ci with a faulty part or host", () => {
  const failing = (failure: Failure): Chosen => ({ ...parts, read: () => Effect.fail(failure) })

  for (const code of Object.keys(failureExitCodes) as ReadonlyArray<Failure["code"]>) {
    const exit = failureExitCodes[code]
    it(`exits ${exit} with one line when a part fails with ${code}`, async () => {
      const outcome = await runIn(["inventory"], repo(), failing({ code, message: "it broke", part: "inventory" }))
      expect(outcome).toEqual({ code: exit, stdout: "", stderr: "smithers-ci: inventory: it broke\n" })
    })
  }

  it("hands --cache to the generate part", async () => {
    const root = repo()
    const echo: Chosen = {
      ...parts,
      files: (_inventory, options) => Effect.succeed([{ path: "cache.txt", content: `${options?.cache}\n` }])
    }
    expect((await runIn(["apply", "--cache", "https://cache.example.invalid"], root, echo)).code).toBe(exitCodes.ok)
    expect(read(`${root}/cache.txt`)).toBe("https://cache.example.invalid\n")
    expect((await runIn(["apply"], root, echo)).code).toBe(exitCodes.ok)
    expect(read(`${root}/cache.txt`)).toBe("undefined\n")
  })

  it("exits 4 and names the file when apply cannot write it", async () => {
    const outcome = await runIn(["apply"], repo(), parts, fullDisk)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toMatch(/^smithers-ci: cli: could not write .*: .*no space left on device/)
  })

  it("exits 4 when --out cannot be written", async () => {
    const outcome = await runIn(["--out", "report.html"], repo(), parts, fullDisk)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toContain("could not write")
  })

  it("exits 4 when a renderer throws", async () => {
    const broken: Chosen = { ...parts, text: () => JSON.parse("{") as string }
    const outcome = await runIn(["replay"], repo(), broken)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toMatch(/smithers-ci: report: could not render the report: SyntaxError/)
  })

  it("refuses a part's document that breaks its contract", async () => {
    const inventory: Chosen = { ...parts, read: () => Effect.succeed({ version: 2 } as never) }
    const badInventory = await runIn(["inventory", "--json"], repo(), inventory)
    expect(badInventory.code).toBe(exitCodes.failed)
    expect(badInventory.stderr).toMatch(/^smithers-ci: inventory: /)
    const replay: Chosen = { ...parts, run: () => Effect.succeed({ version: 1 } as never) }
    const badReport = await runIn(["replay"], repo(), replay)
    expect(badReport.code).toBe(exitCodes.failed)
    expect(badReport.stderr).toMatch(/smithers-ci: replay: /)
  })

  const badPaths: ReadonlyArray<[string, ReadonlyArray<GeneratedFile>, string]> = [
    ["an empty path", [{ path: "", content: "" }], "is not inside the repository"],
    ["an absolute path", [{ path: "/etc/passwd", content: "" }], "is not inside the repository"],
    ["a drive path", [{ path: "C:\\x", content: "" }], "is not inside the repository"],
    ["a path that leaves the root", [{ path: "ci/../../x", content: "" }], "is not inside the repository"],
    ["a repeated path", [{ path: "a", content: "1" }, { path: "a", content: "2" }], "appears twice"]
  ]
  for (const [what, files, reason] of badPaths) {
    it(`refuses ${what} from the generator and writes nothing`, async () => {
      const root = repo()
      const before = snapshot(root)
      const chosen: Chosen = { ...parts, files: () => Effect.succeed(files) }
      for (const args of [["apply"], []]) {
        const outcome = await runIn(args, root, chosen)
        expect(outcome.code).toBe(exitCodes.failed)
        expect(outcome.stderr).toContain(reason)
        expect(outcome.stderr).toMatch(/^smithers-ci: generate: generated path/)
      }
      expect(changed(before, snapshot(root))).toEqual([])
    })
  }

  it("indents a command's later lines and prints no control character from the repository", async () => {
    const zig = Schema.decodeUnknownSync(Inventory)(
      JSON.parse(read(`${import.meta.dirname}/../fixtures/inventory.justfile-zig.json`))
    )
    const job = zig.jobs[0]!
    const steps = [{ ...job.steps[0]!, command: "sh -c 'set -eu\nzig build\tall'" }, {
      ...job.steps[0]!,
      id: "red",
      command: "echo \u001b[31mred\u0007"
    }]
    const inventory = { ...zig, jobs: [{ ...job, steps }] }
    const outcome = await runIn(["inventory"], repo(), { ...parts, read: () => Effect.succeed(inventory) })
    const lines = outcome.stdout.split("\n")
    expect(lines).toContain("  $ sh -c 'set -eu")
    expect(lines).toContain("    zig build\tall'")
    expect(lines).toContain("  $ echo \uFFFD[31mred\uFFFD")
    expect(outcome.stdout).not.toMatch(/\u001b|\u0007/)
  })

  it("lists toolchains, needs, working directories and unsupported features of an inventory", async () => {
    const fixture = (name: string): Inventory =>
      Schema.decodeUnknownSync(Inventory)(JSON.parse(read(`${import.meta.dirname}/../fixtures/${name}`)))
    const bun = fixture("inventory.github-actions-bun.json")
    const zig = fixture("inventory.justfile-zig.json")
    const job = zig.jobs[0]!
    const step = job.steps[0]!
    const steps = [{ ...step, cwd: "." }, { ...step, id: "app", command: "zig build app", cwd: "packages/app" }]
    const moved = { ...zig, jobs: [{ ...job, steps }] }
    const lines = async (inventory: Inventory) =>
      (await runIn(["inventory"], repo(), { ...parts, read: () => Effect.succeed(inventory) })).stdout.split("\n")
    const bunLines = await lines(bun)
    expect(bunLines).toContain("toolchain bun 1.3.0 (package.json)")
    expect(bunLines).toContain("toolchain turbo (turbo.json)")
    expect(bunLines.some((line) => line.startsWith("  unsupported "))).toBe(true)
    const zigLines = await lines(moved)
    expect(zigLines).toContain(`  $ ${step.command}`)
    expect(zigLines).toContain("  $ zig build app  (in packages/app)")
    expect(zigLines.some((line) => line.includes("needs justfile:build"))).toBe(true)
  })
})
