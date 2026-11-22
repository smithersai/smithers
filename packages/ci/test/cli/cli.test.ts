import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { existsSync, realpathSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { layer } from "../../src/cli/Host.vibe"
import { main } from "../../src/cli/main.vibe"
import { parts as onMain } from "../../src/cli/parts.ts"
import { exitCodes, failureExitCodes, flags } from "../../src/contract/Command.ts"
import { changesMachine, ci as ciOf, Inventory } from "../../src/contract/Inventory.ts"
import { type Failure, type GeneratedFile, writtenFiles } from "../../src/contract/Parts.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import * as TargetMap from "../../src/contract/TargetMap.ts"
import { unjailed } from "../../src/replay/Jail.ts"
import { cannotRecord } from "../../src/replay/Reads.ts"
import { fullDisk, generated, inProcess } from "./inProcess.vibe"
import { parts } from "./parts.vibe"
import {
  bin,
  changed,
  commit,
  git,
  head,
  type Outcome,
  passingJustfile,
  program,
  read,
  recorder,
  remove,
  repository,
  skipBecause,
  snapshot,
  spawn,
  spawnWith,
  temporary,
  workspace
} from "./repo.ts"

type Chosen = typeof parts

/** The lines a host with no jail, or no recorder of reads, adds to a replay's progress: their words before the reason. */
const hostNotes = [unjailed("x").split(": ")[0], cannotRecord("x").split(" (")[0]].map((words) =>
  `smithers-ci: ${words}`
)

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

/** No judge key and an empty home: no signed-in model either, so a judgment fails `model-unavailable`. */
const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }
const host = layer(environment)

const repo = (subjects?: ReadonlyArray<string>): string => keep(repository(subjects))
const scratch = (): string => keep(temporary("scratch"))

const runIn = async (args: ReadonlyArray<string>, root: string, chosen: Chosen, faulty?: typeof fullDisk) => {
  const sink = recorder()
  const code = await inProcess(args, root, chosen, sink.service as never, environment, faulty)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() } satisfies Outcome
}

const ways = {
  "in process": (args: ReadonlyArray<string>, root: string): Promise<Outcome> => runIn(args, root, parts),
  "as a process": (args: ReadonlyArray<string>, root: string): Promise<Outcome> => spawn(program, args, root)
}

/** What a replay is asked for unless the flags say otherwise. */
const measuring = { trial: true, applied: true, warm: true, reruns: 1, stallMinutes: 10 }

const commandNames = ["", "apply", "inventory", "replay"] as const
const flagNames = Object.keys(flags) as ReadonlyArray<keyof typeof flags>
const sample = (flag: keyof typeof flags, out: string): ReadonlyArray<string> =>
  ({
    commits: ["--commits", "2"],
    mode: ["--mode", "fast"],
    jobs: ["--jobs", "3"],
    cache: ["--cache", "https://cache.example.invalid"],
    job: ["--job", "justfile:test"],
    targets: ["--targets", "//packages/ci/..."],
    out: ["--out", out],
    json: ["--json"],
    "allow-root": ["--allow-root"],
    check: ["--check"],
    "allow-docker": ["--allow-docker"],
    "no-trial": ["--no-trial"],
    "no-apply-check": ["--no-apply-check"],
    cold: ["--cold"],
    reruns: ["--reruns", "3"],
    "stall-minutes": ["--stall-minutes", "5"]
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
      // The default command's help lists its own flags; a flag of one command alone is in that command's help.
      for (const flag of flagNames) {
        const on: ReadonlyArray<string> = flags[flag].on
        expect(help.stdout.includes(`--${flag}`), `--${flag}`).toBe(on.includes(""))
      }
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
          // A fresh repository has none of the generated files, so the check finds them missing.
          if (accepted) expect(outcome.code, outcome.stderr).toBe(flag === "check" ? exitCodes.mismatch : exitCodes.ok)
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
      ["--stall-minutes 0", ["--stall-minutes", "0"], "a number of minutes above 0"],
      ["--reruns -1", ["--reruns", "-1"], "0 or more"],
      ["a --mode outside normal, fast and both", ["--mode", "slow"], "slow"],
      ["a --cache that is not a URL", ["--cache", "cache"], "http or https URL"],
      ["a --cache that is not http", ["apply", "--cache", "ftp://cache.example.invalid"], "http or https URL"],
      ["an empty --out", ["--out", ""], "a file path"],
      ["a --targets that names no pattern", ["replay", "--targets", " , "], "Smithers build patterns"]
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
      const files = writtenFiles(await generated(root, parts, environment))
      const before = snapshot(root)
      const outcome = await exec([], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(outcome.stdout).toContain("× faster")
      expect(outcome.stdout).toContain("3 commits · 0 mismatches")
      expect(outcome.stdout).toContain(
        `smithers-ci apply would write ${files.length} files. This run wrote nothing to the repository.`
      )
      expect(requestOf(outcome.stderr)).toEqual({ root, commits: 20, modes: ["normal"], ...measuring })
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
      const patterns = "//packages/ci/..., //apps/site:check,"
      const args = ["--commits", "2", "--mode", "both", "--jobs", "3", "--cache", cache, "--targets", patterns]
      const outcome = await exec([
        ...args,
        "--no-trial",
        "--no-apply-check",
        "--cold",
        "--reruns",
        "0",
        "--stall-minutes",
        "2.5",
        "--out",
        page,
        "--json",
        "--allow-docker"
      ], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(requestOf(outcome.stderr)).toEqual({
        root,
        trial: false,
        warm: false,
        reruns: 0,
        stallMinutes: 2.5,
        commits: 2,
        modes: ["normal", "fast"],
        jobs: 3,
        cache,
        targets: ["//packages/ci/...", "//apps/site:check"],
        allowDocker: true
      })
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
      expect(requestOf(outcome.stderr)).toEqual({ root, commits: 20, modes: ["fast"], ...measuring })
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
        "job justfile:ci (justfile justfile, needs justfile:test)",
        ""
      ])
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("prints an inventory that decodes with --json", async () => {
      const outcome = await exec(["inventory", "--json"], repo())
      expect(outcome.code).toBe(exitCodes.ok)
      expect(decode(Inventory, outcome.stdout).jobs.map((job) => job.id)).toEqual([
        "justfile:build",
        "justfile:test",
        "justfile:ci"
      ])
    })

    it("says why a step that runs a script of several commands stays one step", async () => {
      const root = keep(temporary("scripts"))
      git(root, "init", "--quiet", "--initial-branch=main")
      commit(root, "base", {
        ".github/workflows/ci.yml": [
          "on: [push]",
          "jobs:",
          "  check:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - run: node -e 0",
          "      - run: npm run check",
          "      - run: npm run build",
          "  timed:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - run: npm run check",
          "        timeout-minutes: 5",
          "  first:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - run: npm run check",
          "      - run: node -e 0",
          ""
        ].join("\n"),
        "package.json": JSON.stringify({
          name: "fixture",
          scripts: {
            check: "npm run lint && npm run types",
            lint: "node -e 0",
            types: "node -e 0",
            prebuild: "node -e 0",
            build: "npm run lint && npm run types"
          }
        })
      })
      const listed = await exec(["inventory"], root)
      expect(listed.code, listed.stderr).toBe(exitCodes.ok)
      const lines = listed.stdout.split("\n")
      /** The lines of a job, after its heading. */
      const job = (name: string): ReadonlyArray<string> => {
        const rest = lines.slice(lines.findIndex((line) => line.startsWith(`job ci.yml:${name} `)) + 1)
        const end = rest.findIndex((line) => line.startsWith("job "))
        return (end < 0 ? rest : rest.slice(0, end)).filter((line) => !line.startsWith("  unsupported "))
      }
      // A script that is split says nothing: the step is listed as the repository wrote it.
      expect(job("check")).toEqual([
        "  $ node -e 0",
        "  $ npm run check",
        "  $ npm run build",
        "    stays one step: the script has the hook `prebuild`, which the package manager runs with it"
      ])
      // A time limit is for the whole script: five minutes for each of its scripts would be another limit.
      expect(job("timed")).toEqual([
        "  $ npm run check",
        "    stays one step: the step has a time limit, which is for the whole script"
      ])
      // A job's first step starts the place its steps leave values for each other in.
      expect(job("first").filter((line) => line !== "")).toEqual([
        "  $ npm run check",
        "    stays one step: the step is the first of its job and others follow it, and what it leaves for them is " +
        "kept for the whole script",
        "  $ node -e 0"
      ])
      const document = decode(Inventory, (await exec(["inventory", "--json"], root)).stdout)
      // The scripts of `package.json` are listed too; the workflow's jobs are the CI.
      const workflow = document.jobs.filter((entry) => entry.source === "github-actions")
      expect(workflow.map((entry) => entry.steps.map((step) => [step.command, step.whole?.feature]))).toEqual([
        [["node -e 0", undefined], ["npm run check", undefined], ["npm run build", "script-hook"]],
        [["npm run check", "script-limit"]],
        [["npm run check", "script-first"], ["node -e 0", undefined]]
      ])
      // The CI `apply` writes has one step per script of the chain, each after the one before it.
      const applied = await exec(["apply"], root)
      expect(applied.code, applied.stderr).toBe(exitCodes.ok)
      const written = read(`${root}/.smithers/WORKSPACE.smithers`)
      const stepsOf = [...written.matchAll(/^const (step\d+) = [\s\S]*?^\}\)$/gm)].map((match) => match[0])
      const shells = stepsOf.map((text) => JSON.parse(/shell: (".*"),$/m.exec(text)?.[1] ?? "\"\"") as string)
      const path = "PATH=\"$PWD/node_modules/.bin:$PATH\""
      const lint = shells.findIndex((shell) => shell.includes(`${path} npm run lint`))
      const types = shells.findIndex((shell) => shell.includes(`${path} npm run types`))
      expect(lint).toBeGreaterThan(0)
      expect(types).toBe(lint + 1)
      expect(stepsOf[types]).toContain(`data: [step${lint}]`)
      // Only the chain that was split is run link by link: every other step runs the command the repository wrote.
      expect(shells.filter((shell) => shell.includes(path))).toHaveLength(2)
      expect(shells.filter((shell) => shell.includes("npm run check"))).toHaveLength(2)
      expect(shells.filter((shell) => shell.includes("npm run build"))).toHaveLength(1)
    })

    it("exits 3 with one line outside a repository", async () => {
      const directory = scratch()
      const outcome = await exec(["inventory"], directory)
      expect(outcome).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        // The directory as the system names it: macOS's temporary directory is under a link, /var to /private/var.
        stderr: `smithers-ci: inventory: ${realpathSync(directory)} is not a git repository with a commit\n`
      })
    })
  })

  describe.concurrent("apply", () => {
    it("writes exactly the generated files", async () => {
      const root = repo()
      const files = writtenFiles(await generated(root, parts, environment, "https://cache.example.invalid"))
      expect(files.find((file) => file.path.endsWith("smithers-ci.yml"))?.content).toContain("cache.example.invalid")
      const before = snapshot(root)
      const outcome = await exec(["apply", "--cache", "https://cache.example.invalid"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(files.length).toBeGreaterThan(0)
      expect(changed(before, snapshot(root))).toEqual([...pathsOf(files)].sort())
      for (const file of files) expect(read(`${root}/${file.path}`)).toBe(file.content)
      for (const file of files) expect(outcome.stdout).toContain(`wrote ${file.path}\n`)
      expect(outcome.stdout).not.toContain(".gitignore")
      expect(outcome.stdout).toContain(`smithers-ci: wrote ${files.length} files`)
      // A second apply writes the same files over its own and has nothing to add to .gitignore.
      const applied = snapshot(root)
      const again = await exec(["apply", "--cache", "https://cache.example.invalid"], root)
      expect(again.code, again.stderr).toBe(exitCodes.ok)
      expect(again.stdout).not.toContain(".gitignore")
      expect(again.stdout).toContain(`smithers-ci: wrote ${files.length} files`)
      expect(changed(applied, snapshot(root))).toEqual([])
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

  it("exits 3 with one line naming the file when a replayed commit holds a name that is not UTF-8", async (context) => {
    const root = repo()
    // The Latin-1 bytes of "café.txt". Smithers build reads every name of a checkout as UTF-8 and stops at this one.
    try {
      writeFileSync(Buffer.from(`${root}/caf\xe9.txt`, "latin1"), "ok\n")
    } catch (error) {
      // APFS, and any file system that keeps names as UTF-8, refuses the name: no repository here can hold it.
      if ((error as NodeJS.ErrnoException).code !== "EILSEQ") throw error
      skipBecause(context, "this file system refuses a file name that is not UTF-8 (EILSEQ)")
    }
    git(root, "add", "--all")
    git(root, "commit", "--quiet", "--message", "latin-1")
    const head = git(root, "rev-parse", "--short=7", "HEAD").trim()
    const outcome = await spawn(bin, ["replay", "--commits", "1", "--mode", "normal"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
    expect(outcome.stdout).toBe("")
    expect(outcome.stderr.trim().split("\n").at(-1)).toBe(
      `smithers-ci: replay: the file "caf\\351.txt" at ${head} has a name that is not UTF-8, which Smithers build cannot read; rename the file to replay this repository`
    )
  })

  it("exits 2 with one line, before anything runs, when SMTHRS_OBSERVE_WITH names no recorder", async () => {
    const outcome = await spawnWith(bin, ["--help"], repo(), { SMTHRS_OBSERVE_WITH: "s-trace" })
    expect(outcome.code).toBe(exitCodes.usage)
    expect(outcome.stdout).toBe("")
    // The value is never repeated: the program prints no variable's value.
    expect(outcome.stderr.trim().split("\n")).toEqual([
      "smithers-ci: SMTHRS_OBSERVE_WITH must be smthrs-observe or strace, or unset. Run smithers-ci --help for the commands and flags."
    ])
    for (const value of ["strace", "smthrs-observe", ""]) {
      expect((await spawnWith(bin, ["--help"], repo(), { SMTHRS_OBSERVE_WITH: value })).code).toBe(exitCodes.ok)
    }
  })

  it("prints the inventory and applies the generated files", async () => {
    const root = repo()
    const inventory = await spawn(bin, ["inventory", "--json"], root)
    expect(inventory.code, inventory.stderr).toBe(exitCodes.ok)
    expect(decode(Inventory, inventory.stdout).jobs).toHaveLength(3)
    const files = writtenFiles(await generated(root, onMain, environment))
    const before = snapshot(root)
    const apply = await spawn(bin, ["apply"], root)
    expect(apply.code, apply.stderr).toBe(exitCodes.ok)
    // The generated files and nothing else: the repository's `.gitignore` is left as it is.
    expect(changed(before, snapshot(root))).toEqual([...pathsOf(files)].sort())
  })

  it("replays a commit end to end with every part on main, and writes nothing to the repository", async () => {
    const root = repo()
    commit(root, "a CI that passes here", { justfile: passingJustfile })
    const before = snapshot(root)
    // The commit before this one has a CI that passes on no machine without Zig: the count starts from nothing.
    const outcome = await spawn(bin, ["--commits", "1", "--json", "--cold"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const at = `smithers-ci: 1/1 ${head(root).slice(0, 7)}`
    // What the replay did, in order. A host with no jail or no recorder adds a line that says so, which is not this
    // case's subject.
    const progress = outcome.stderr.trim().split("\n").filter((line) =>
      !hostNotes.some((note) => line.startsWith(note))
    )
    expect(progress).toEqual([
      `smithers-ci: checking which jobs pass on this machine at ${head(root).slice(0, 7)}`,
      `${at} baseline`,
      `${at} normal`,
      // The newest commit once more, as `apply` leaves the repository.
      `${at} with the files apply writes`
    ])
    const report = decode(ReplayReport, outcome.stdout)
    expect(report.repository).toBe(basename(root))
    expect(report.commits).toHaveLength(1)
    expect(report.commits[0]!.commit).toBe(head(root))
    expect(report.commits[0]!.baseline.ok).toBe(true)
    expect(report.commits[0]!.normal.ok).toBe(true)
    expect(report.speedupCommits).toBe(1)
    expect(report.mismatches).toBe(0)
    expect(report.notReplayed).toBeUndefined()
    expect(await main(["apply", "--commits", "1"], root, environment)).toBe(exitCodes.usage)
    expect(changed(before, snapshot(root))).toEqual([])
    // A step starts with a home of its own, so on a machine with Zig the first `zig build` fills Zig's cache
    // before it looks for a build file: two minutes of work on a busy machine.
  }, 900_000)

  it("provides the select part's services, with no judge configured", async () => {
    const root = repo()
    const record = { ok: true, counts: { hit: 0, ran: 0, failed: 0, skipped: 0 }, results: [], commit: head(root) }
    expect(await Effect.runPromise(Effect.provide(onMain.rows(root, record), host))).toEqual([])
    expect(await Effect.runPromise(Effect.provide(onMain.score([]), host))).toEqual([])
    const features = {
      extensions: [".zig"],
      fileChanges: { d3: 1, d14: 1, d56: 1 },
      failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
      project: "ci",
      testCount: 1,
      graphDistance: 1
    }
    const row = { commit: "c", target: "//ci:test", features, attempts: [true], failed: false, flaky: false }
    const failure = await Effect.runPromise(Effect.provide(Effect.flip(onMain.score([row])), host))
    expect([failure.code, failure.part]).toEqual(["model-unavailable", "select"])
  })
})

describe.concurrent("smithers-ci on a workspace", () => {
  it("applies one target per package for a step that runs a task over the workspace", async () => {
    const root = keep(workspace())
    const outcome = await runIn(["apply"], root, parts)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    // The target map is the program's own document: it is among the generated files and not in the repository.
    const mapFile = (await generated(root, parts, environment)).find((file) => file.path === TargetMap.path)
    expect(mapFile?.written).toBe(false)
    expect(existsSync(`${root}/${TargetMap.path}`)).toBe(false)
    const map = decode(TargetMap.TargetMap, mapFile?.content as string)
    // One step of the workflow became two targets, and the map names the step for both.
    expect(map.targets.map((target) => [target.label, target.step])).toEqual([
      ["//:ci.yml-test-1-a", "ci.yml:test:1"],
      ["//:ci.yml-test-1-b", "ci.yml:test:1"]
    ])
    expect(TargetMap.labelsOf(map, "ci.yml:test", "ci.yml:test:1", {})).toHaveLength(2)
    const targets = read(`${root}/.smithers/WORKSPACE.smithers`)
    // Package a's target reads a; package b depends on a, so its target reads both and runs both. Each is run as
    // a runner runs a step, so its command is the one word the step's runner text is given.
    expect(targets).toContain(`__smithers_ci_step '\\\\''npm run test --workspace=a --if-present'\\\\'''",`)
    expect(targets).toContain(
      `__smithers_ci_step '\\\\''npm run test --workspace=a --workspace=b --if-present'\\\\'''",`
    )
    expect(targets).toContain(
      `data: [S.glob("//*"), S.glob("//.github/**"), S.glob("//packages/*"), S.glob("//packages/a/**")]`
    )
    expect(targets).toContain(`S.glob("//packages/a/**"), S.glob("//packages/b/**")]`)
  })

  it("passes the decompose part to the replay", async () => {
    const seen: Array<string> = []
    const chosen: Chosen = {
      ...parts,
      run: (request, given) =>
        Effect.gen(function*() {
          const inventory = yield* given.read(request.root)
          const split = given.decompose === undefined
            ? undefined
            : yield* given.decompose(request.root, ciOf(inventory))
          seen.push(...(split?.jobs.flatMap((job) => job.steps.map((step) => step.id)) ?? []))
          return yield* parts.run(request, given)
        })
    }
    const outcome = await runIn(["replay", "--commits", "1"], keep(workspace()), chosen)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(seen).toEqual(["ci.yml:test:1:a", "ci.yml:test:1:b"])
  })
})

describe.concurrent("smithers-ci reading for a replay", () => {
  /** A replay that reports the repository name its own reader gave it. */
  const named: Chosen["run"] = (request, given) =>
    Effect.gen(function*() {
      const inventory = yield* given.read(request.root)
      return { ...(yield* parts.run(request, given)), repository: inventory.repository }
    })
  const here: Chosen["read"] = (root) =>
    Effect.map(parts.read(root), (inventory) => ({ ...inventory, repository: "read for this machine" }))

  it("gives a replay the reader for this machine, and the commands that write nothing the plain one", async () => {
    const root = repo()
    const outcome = await runIn(["replay", "--commits", "1", "--json"], root, { ...parts, run: named, readHere: here })
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(decode(ReplayReport, outcome.stdout).repository).toBe("read for this machine")
    const listed = await runIn(["inventory", "--json"], root, { ...parts, readHere: here })
    expect(decode(Inventory, listed.stdout).repository).toBe(basename(root))
  })

  it("gives a replay the plain reader when there is no other", async () => {
    const root = repo()
    const outcome = await runIn(["replay", "--commits", "1", "--json"], root, {
      ...parts,
      run: named,
      readHere: undefined
    })
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(decode(ReplayReport, outcome.stdout).repository).toBe(basename(root))
  })

  it("reads for this machine with the parts on main", () => {
    expect(onMain.readHere).toBeDefined()
    expect(onMain.readHere).not.toBe(onMain.read)
  })
})

describe.concurrent("smithers-ci with a faulty part or host", () => {
  const failing = (failure: Failure): Chosen => ({ ...parts, read: () => Effect.fail(failure) })

  for (const code of Object.keys(failureExitCodes) as ReadonlyArray<Failure["code"]>) {
    const exit = failureExitCodes[code]
    it(`exits ${exit} with one line when a part fails with ${code}`, async () => {
      const outcome = await runIn(["inventory"], repo(), failing({ code, message: "it broke", part: "inventory" }))
      // A model that cannot be reached is the person's to fix, so its line names no part of the program.
      const where = code === "model-unavailable" ? "" : "inventory: "
      expect(outcome).toEqual({ code: exit, stdout: "", stderr: `smithers-ci: ${where}it broke\n` })
    })
  }

  it("exits 3 and lists the jobs when nothing of the CI can be reproduced, for apply and for a replay", async () => {
    const read = await Effect.runPromise(Effect.provide(parts.read(repo()), host))
    const blocked: Chosen = {
      ...parts,
      read: () =>
        Effect.succeed({
          ...read,
          jobs: read.jobs.map((job) => ({ ...job, unsupported: [{ feature: "condition", detail: "if: always()" }] }))
        })
    }
    for (const args of [["apply"], ["--commits", "1"]]) {
      const root = repo()
      const before = snapshot(root)
      const outcome = await runIn(args, root, blocked)
      expect(outcome.code).toBe(exitCodes.unsupported)
      expect(outcome.stdout).toBe("")
      expect(outcome.stderr.split("\n").slice(0, 2)).toEqual([
        "smithers-ci: inventory: 0 of 3 CI jobs can be reproduced on this machine",
        "  justfile:build  runs only when a condition holds that a replay cannot check"
      ])
      expect(changed(before, snapshot(root))).toEqual([])
    }
  })

  it("replays a CI whose every job installs what this machine has, and says apply writes nothing", async () => {
    const root = repo()
    const read = await Effect.runPromise(Effect.provide(parts.read(root), host))
    const reason = { feature: changesMachine, detail: "installs zsh with apt-get" }
    const marked = { ...read, jobs: read.jobs.map((job) => ({ ...job, unsupported: [reason] })) }
    const outcome = await runIn(["--commits", "1"], root, {
      ...parts,
      read: () => Effect.succeed(marked),
      readHere: () => Effect.succeed(read)
    })
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain(
      "smithers-ci apply would write nothing: every job here changes the machine, so it stays in your CI as it is."
    )
  })

  it("hands --cache to the generate part", async () => {
    const root = repo()
    const echo: Chosen = {
      ...parts,
      files: (_inventory, options) =>
        Effect.succeed([{ path: "cache.txt", content: `# Generated by smithers-ci.\n${options?.cache}\n` }])
    }
    expect((await runIn(["apply", "--cache", "https://cache.example.invalid"], root, echo)).code).toBe(exitCodes.ok)
    expect(read(`${root}/cache.txt`)).toBe("# Generated by smithers-ci.\nhttps://cache.example.invalid\n")
    expect((await runIn(["apply"], root, echo)).code).toBe(exitCodes.ok)
    expect(read(`${root}/cache.txt`)).toBe("# Generated by smithers-ci.\nundefined\n")
  })

  it("exits 4 and names the file when apply cannot write it", async () => {
    // No plan is asked for: Smithers build's plan writes the files into a copy first, and a full disk stops it there
    // (test/cli/applyPlanned.test.ts), before apply writes any file of its own.
    const outcome = await runIn(["apply"], repo(), { ...parts, planned: undefined }, fullDisk)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toMatch(/^smithers-ci: cli: could not write \S+: .*no space left on device/)
    expect(outcome.stderr).not.toContain("into a copy")
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
    expect(outcome.stderr).toMatch(/smithers-ci: report: could not render the report: .+ \(SyntaxError\)/)
  })

  it("names what a renderer threw when it is no Error, never [object Object]", async () => {
    const thrown: Chosen = {
      ...parts,
      text: () => {
        throw { _tag: "Unrenderable", field: "speedup" }
      }
    }
    const outcome = await runIn(["replay"], repo(), thrown)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toContain("could not render the report: Unrenderable, field: speedup")
    expect(outcome.stderr).not.toContain("[object Object]")
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

  it("lists an inventory as it was read when its steps cannot be split here, or none of it is CI", async () => {
    const root = repo()
    const read = (await runIn(["inventory"], root, parts)).stdout
    const unsplit = await runIn(["inventory"], root, {
      ...parts,
      decompose: () => Effect.fail({ code: "not-a-repository", message: "no git", part: "decompose" })
    })
    expect(unsplit).toEqual({ code: exitCodes.ok, stdout: read, stderr: "" })
    // A splitter is never asked about a repository with no job that runs on a change.
    const asked: Array<string> = []
    const none = await runIn(["inventory"], root, {
      ...parts,
      read: (at) => Effect.map(parts.read(at), (inventory) => ({ ...inventory, jobs: [] })),
      decompose: (at, given) => {
        asked.push(at)
        return parts.decompose(at, given)
      }
    })
    expect(none.code).toBe(exitCodes.ok)
    expect(asked).toEqual([])
  })

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
    // Two jobs of one workflow that set the same tool up give one line.
    const setUp = bun.toolchains[1]!
    const twice = await lines({ ...bun, toolchains: [setUp, { ...setUp, job: "ci.yml:lint" }] })
    expect(twice.filter((line) => line.startsWith("toolchain "))).toEqual([
      "toolchain bun 1.3.0 (.github/workflows/ci.yml)"
    ])
    expect(bunLines.some((line) => line.startsWith("  unsupported "))).toBe(true)
    const zigLines = await lines(moved)
    expect(zigLines).toContain(`  $ ${step.command}`)
    expect(zigLines).toContain("  $ zig build app  (in packages/app)")
    expect(zigLines.some((line) => line.includes("needs justfile:build"))).toBe(true)
  })
})
