import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { main, rootOf, run } from "../../src/cli/main.vibe"
import {
  deaf,
  exitCodes as signalExitCodes,
  type Heard,
  type Listen,
  listenTo,
  type Signal
} from "../../src/cli/Signals.ts"
import { exitCodes } from "../../src/contract/Command.ts"
import { footer, uncommittedFooter } from "../../src/native/Workspace.ts"
import { ownWorkspace } from "../native/repo.ts"
import { cannotStart } from "../native/support.vibe"
import { inProcess } from "./inProcess.vibe"
import { hanging, parts } from "./parts.vibe"
import {
  alive,
  awaited,
  bin,
  changed,
  commit,
  git,
  type Outcome,
  program,
  read,
  recorder,
  remove,
  repository,
  snapshot,
  spawn,
  start,
  temporary,
  until
} from "./repo.ts"

type Chosen = typeof parts

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }
const repo = (subjects?: ReadonlyArray<string>): string => keep(repository(subjects))
const scratch = (): string => keep(temporary("scratch"))

const runIn = async (
  args: ReadonlyArray<string>,
  root: string,
  chosen: Chosen = parts,
  directory?: string
): Promise<Outcome> => {
  const sink = recorder()
  const code = await inProcess(args, root, chosen, sink.service as never, environment, undefined, directory)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

const requestOf = (stderr: string): unknown => JSON.parse(/replay request: (.*)/.exec(stderr)?.[1] ?? "null")

const notReplayed =
  "smithers-ci: the working tree has changes that are not committed; a replay runs commits, so they are not replayed\n"

describe.concurrent("smithers-ci from a directory of the repository", () => {
  const onNode = (directory: string) => Effect.runPromise(Effect.provide(rootOf(directory), NodeServices.layer))

  it("finds the repository's top directory from any directory in it, and keeps a directory in no repository", async () => {
    const root = repo()
    expect(await onNode(root)).toBe(root)
    expect(await onNode(join(root, "src"))).toBe(root)
    const outside = scratch()
    expect(await onNode(outside)).toBe(outside)
  })

  it("keeps the directory when git cannot be started", async () => {
    const root = repo()
    const found = Effect.provide(rootOf(join(root, "src")), cannotStart("git"))
    expect(await Effect.runPromise(Effect.provide(found, NodeServices.layer))).toBe(join(root, "src"))
  })

  it("reads the same inventory from a subdirectory as from the top, as a process", async () => {
    const root = repo()
    const top = await spawn(program, ["inventory"], root)
    const below = await spawn(program, ["inventory"], join(root, "src"))
    expect(below.code, below.stderr).toBe(exitCodes.ok)
    expect(below.stdout).toBe(top.stdout)
    expect(below.stdout).toContain("job justfile:ci")
  })

  it("replays the repository, not the subdirectory, and reads a relative --out from where it was started", async () => {
    const root = repo()
    const before = snapshot(root)
    const outcome = await spawn(
      program,
      ["--commits", "1", "--no-apply-check", "--out", "report.html"],
      join(root, "src")
    )
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(requestOf(outcome.stderr)).toEqual({
      root,
      commits: 1,
      modes: ["normal"],
      trial: true,
      warm: true,
      reruns: 1,
      stallMinutes: 10
    })
    expect(outcome.stderr).toContain(`smithers-ci: wrote ${join(root, "src", "report.html")}\n`)
    expect(outcome.stdout).toContain("This run wrote one file to the repository: src/report.html.")
    expect(changed(before, snapshot(root))).toEqual(["src/report.html"])
  })

  it("still says in one line that a directory is in no repository", async () => {
    const directory = scratch()
    expect(await spawn(bin, ["inventory"], directory)).toEqual({
      code: exitCodes.unsupported,
      stdout: "",
      stderr: `smithers-ci: inventory: ${directory} is not a git repository with a commit\n`
    })
    expect(await main(["inventory"], directory, environment)).toBe(exitCodes.unsupported)
    expect(await main(["replay", "--commits", "1", "--no-apply-check"], directory, environment)).toBe(
      exitCodes.unsupported
    )
    expect(await main(["--bogus"], directory, environment)).toBe(exitCodes.usage)
  })

  it("exits 2 before anything runs when SMTHRS_OBSERVE_WITH names no recorder", async () => {
    const root = repo()
    expect(await main(["inventory"], root, { ...environment, SMTHRS_OBSERVE_WITH: "s-trace" })).toBe(exitCodes.usage)
    expect(await main(["inventory"], root, { ...environment, SMTHRS_OBSERVE_WITH: "strace" })).toBe(exitCodes.ok)
  })
})

describe.concurrent("what the default command says it wrote", () => {
  it("names the --out file as the one file written when it is inside the repository", async () => {
    const root = repo()
    const before = snapshot(root)
    const outcome = await runIn(["--commits", "1", "--no-apply-check", "--out", "pages/report.html"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain(
      " files. This run wrote one file to the repository: pages/report.html."
    )
    expect(outcome.stdout).not.toContain("wrote nothing")
    expect(changed(before, snapshot(root))).toEqual(["pages/report.html"])
  })

  it("leaves .gitignore out of what apply would do when it already names the cache directory", async () => {
    const root = repo()
    commit(root, "ignore", { ".gitignore": ".flows\n" })
    const outcome = await runIn(["--commits", "1", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toMatch(
      /smithers-ci apply would write \d+ files\. This run wrote nothing to the repository\.\n$/
    )
  })

  it("says it wrote nothing when --out is outside the repository, or absent", async () => {
    const root = repo()
    const before = snapshot(root)
    const outside = await runIn(["--commits", "1", "--no-apply-check", "--out", `${scratch()}/report.html`], root)
    expect(outside.stdout).toContain("This run wrote nothing to the repository.")
    expect((await runIn(["--commits", "1", "--no-apply-check"], root)).stdout).toContain(
      "This run wrote nothing to the repository."
    )
    expect(changed(before, snapshot(root))).toEqual([])
  })
})

describe.concurrent("what the default command says the replay did", () => {
  const ownTargets: Chosen = {
    ...parts,
    run: (request, given) => Effect.map(parts.run(request, given), (report) => ({ ...report, targets: ["//..."] }))
  }

  it("says the replay ran generated targets when the workspace file is not committed", async () => {
    const root = repo()
    writeFileSync(join(root, "WORKSPACE.ts"), ownWorkspace)
    const outcome = await runIn(["--commits", "1", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout.trimEnd().endsWith(`\n\n${uncommittedFooter("WORKSPACE.ts")}`)).toBe(true)
    expect(outcome.stdout).not.toContain("ran its own targets")
    expect(outcome.stdout).not.toContain("apply would write")
    expect(outcome.stderr).toContain(notReplayed)
  })

  it("says the replay ran the repository's own targets when the report holds them", async () => {
    const root = repo()
    commit(root, "own workspace", { "WORKSPACE.ts": ownWorkspace })
    const outcome = await runIn(["--commits", "1", "--no-apply-check", "--out", "report.html"], root, ownTargets)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(
      outcome.stdout.trimEnd().endsWith(
        `\n\n${footer("WORKSPACE.ts", "This run wrote one file to the repository: report.html.")}`
      )
    ).toBe(true)
  })

  it("says the newest commit builds with Smithers build when the working tree no longer holds the file", async () => {
    const root = repo()
    commit(root, "own workspace", { "WORKSPACE.ts": ownWorkspace })
    rmSync(join(root, "WORKSPACE.ts"))
    const outcome = await runIn(["--commits", "1", "--no-apply-check"], root, ownTargets)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout.trimEnd().endsWith(`\n\n${footer(undefined)}`)).toBe(true)
    expect(outcome.stdout).not.toContain("apply would write")
  })
})

describe.concurrent("uncommitted changes", () => {
  for (const command of [[], ["replay"]]) {
    const named = command.length === 0 ? "the default command" : "replay"
    it(`are named on standard error as not replayed, by ${named}`, async () => {
      const root = repo()
      writeFileSync(join(root, "src", "0.zig"), "pub const n = 100;\n")
      const outcome = await runIn([...command, "--commits", "1", "--no-apply-check"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(outcome.stderr.startsWith(notReplayed)).toBe(true)
      expect(outcome.stdout).not.toContain("not committed")
    })

    it(`are not named by ${named} on a clean working tree`, async () => {
      const outcome = await runIn([...command, "--commits", "1", "--no-apply-check"], repo())
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(outcome.stderr).not.toContain("not committed")
    })
  }

  it("are named by the installed program too, for an untracked file", async () => {
    const root = repo()
    writeFileSync(join(root, "notes.txt"), "not committed\n")
    const outcome = await spawn(program, ["replay", "--commits", "1", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stderr.startsWith(notReplayed)).toBe(true)
  })
})

describe.concurrent("smithers-ci inventory", () => {
  it("prints the files it could not read, which belong to no job", async () => {
    const root = repo()
    const broken = ".github/workflows/tests.yml"
    commit(root, "a workflow that does not parse", {
      [broken]:
        "on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./slow-tests.sh\n   bad-indent: [\n"
    })
    for (const outcome of [await runIn(["inventory"], root), await spawn(bin, ["inventory"], root)]) {
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      const lines = outcome.stdout.split("\n")
      expect(lines[1]).toMatch(new RegExp(`^unsupported [a-z-]+: ${broken.replaceAll(".", "\\.")}: `))
      expect(lines).toContain("toolchain just (justfile)")
    }
  })

  it("prints uncommitted changes the same way", async () => {
    const root = repo()
    writeFileSync(join(root, "notes.txt"), "not committed\n")
    const outcome = await runIn(["inventory"], root)
    expect(outcome.stdout.split("\n")[1]).toBe(
      `unsupported uncommitted-changes: the working tree differs from ${git(root, "rev-parse", "HEAD").trim()}`
    )
  })
})

describe("a signal", () => {
  it("is heard once from what emits it, and not after listening stops", () => {
    const source = new EventEmitter()
    const heard: Array<Signal> = []
    const listen = listenTo(source)
    listen("SIGINT", () => heard.push("SIGINT"))
    const stop = listen("SIGTERM", () => heard.push("SIGTERM"))
    source.emit("SIGINT")
    source.emit("SIGINT")
    expect(heard).toEqual(["SIGINT"])
    stop()
    source.emit("SIGTERM")
    expect(heard).toEqual(["SIGINT"])
    expect(source.listenerCount("SIGINT") + source.listenerCount("SIGTERM")).toBe(0)
    expect(deaf("SIGINT", () => heard.push("SIGINT"))()).toBeUndefined()
    expect(signalExitCodes).toEqual({ SIGINT: 130, SIGTERM: 143 })
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`${signal} interrupts the program in this process: its directory is removed and its child stopped`, async () => {
      const marker = join(scratch(), "marker.json")
      const listeners = new Map<Heard, () => void>()
      const listen: Listen = (name, listener) => {
        listeners.set(name, listener)
        return () => void listeners.delete(name)
      }
      const chosen: Chosen = { ...parts, run: hanging(marker) }
      const running = run(["replay", "--commits", "1", "--no-apply-check"], repo(), environment, chosen, listen)
      const { directory, pid } = JSON.parse(await awaited(marker)) as { directory: string; pid: number }
      expect(existsSync(directory)).toBe(true)
      expect(alive(pid)).toBe(true)
      listeners.get(signal)!()
      expect(await running).toBe(signalExitCodes[signal])
      expect(existsSync(directory)).toBe(false)
      await until(() => !alive(pid), `process ${pid} to stop`)
      // The program stopped listening when it ended.
      expect(listeners.size).toBe(0)
    })
  }

  it("leaves a program that ends by itself with its own exit code, and stops listening", async () => {
    const listeners = new Map<Heard, () => void>()
    const listen: Listen = (name, listener) => {
      listeners.set(name, listener)
      return () => void listeners.delete(name)
    }
    expect(await run(["inventory"], repo(), environment, parts, listen)).toBe(exitCodes.ok)
    expect(listeners.size).toBe(0)
  })

  // The baseline runs the step first, then normal mode runs it again as a generated target under smthrs.
  const during = [["SIGTERM", "the baseline"], ["SIGINT", "the baseline"], ["SIGTERM", "normal mode"]] as const
  for (const [signal, phase] of during) {
    it(`${signal} sent to the real program during ${phase} leaves no directory and no child`, async () => {
      const work = scratch()
      const temp = join(work, "tmp")
      mkdirSync(temp)
      const root = keep(temporary("slow"))
      git(root, "init", "--quiet", "--initial-branch=main")
      // A jailed step has process ids of its own and can write only its copy, its home and its temporary
      // directory. So the step says there that it started, and it and its child are found among the machine's
      // processes by a name no other process has.
      const token = `slow-${basename(work)}`
      const hang = `sh -c 'sleep 600' ${token}-child &\n: > "$TMPDIR/started"\nwait\n`
      // A baseline job and normal mode each have a home of their own, named for them: the baseline's step passes.
      const once = `case "$(basename "$HOME")" in baseline-job-*) exit 0;; esac\n`
      commit(root, "first", {
        "package.json": JSON.stringify({ name: "slow", scripts: { ci: `sh ./${token}.sh` } }),
        [`${token}.sh`]: phase === "the baseline" ? hang : `${once}${hang}`
      })
      const named = (): ReadonlyArray<string> =>
        execFileSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n")
          .filter((line) => line.includes(token))
      const replays = (): ReadonlyArray<string> => readdirSync(temp).filter((name) => name.startsWith("smithers-ci-"))
      const running = start(bin, ["replay", "--commits", "1", "--no-apply-check", "--no-trial"], root, { TMPDIR: temp })
      // In a jail the step's temporary directory is the replay's own, for its job in the baseline and for its way
      // in a mode; with no jail it is the program's.
      const made = (name: string): ReadonlyArray<string> => {
        try {
          return readdirSync(join(temp, name, "tmp"))
        } catch {
          return []
        }
      }
      const started = (): boolean =>
        existsSync(join(temp, "started"))
        || replays().some((name) => made(name).some((way) => existsSync(join(temp, name, "tmp", way, "started"))))
      await until(started, "the step to start", 250_000).catch((error: Error) => {
        running.signal("SIGTERM")
        throw new Error(`${error.message}; the program printed:\n${running.printed().stderr}`)
      })
      expect(named().some((line) => line.includes(`${token}.sh`))).toBe(true)
      expect(named().some((line) => line.includes(`${token}-child`))).toBe(true)
      running.signal(signal)
      const outcome = await running.done
      expect(outcome.code, outcome.stderr).toBe(signalExitCodes[signal])
      expect(outcome.stdout).toBe("")
      expect(outcome.stderr.trim().split("\n").at(-1)).toMatch(phase === "the baseline" ? / baseline$/ : / normal$/)
      expect(replays()).toEqual([])
      await until(() => named().length === 0, "the step and its child to stop")
    }, 300_000)
  }
})
