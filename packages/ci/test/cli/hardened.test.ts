/**
 * What the program refuses, and what it never does, with a stranger's repository in front of it: a `--cache` URL
 * that carries a credential or a line end, a report page written through a link of the repository, a generated
 * file written into a file another checkout shares, a job id that moves the terminal's cursor, and a `node` of the
 * checkout as the Node that runs `smthrs`. And what it says about `apply` after a replay.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { delimiter, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { cacheUrlOf } from "../../src/cli/Cli.vibe"
import { layer } from "../../src/cli/Host.vibe"
import { checkoutOf, nodeProgram } from "../../src/cli/Install.ts"
import { run as runMain } from "../../src/cli/main.vibe"
import { exitCodes } from "../../src/contract/Command.vibe"
import { leftRunning } from "../../src/contract/Inventory.vibe"
import type { ReplayParts, ReplayRequest } from "../../src/contract/Parts.vibe"
import { Progress } from "../../src/replay/index.vibe"
import { inProcess } from "./inProcess.vibe"
import { parts, run as replayed } from "./parts.vibe"
import { type Outcome, recorder, remove, repository, temporary } from "./repo.ts"

type Chosen = typeof parts

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const environment = { HOME: keep(temporary("hardened-home")), PATH: process.env["PATH"] }
const host = layer(environment)

/** A repository by its real location, as git names it. */
const repo = (): string => realpathSync(keep(repository(["first"])))
const scratch = (): string => realpathSync(keep(temporary("hardened")))

/** The parts with no plan asked of Smithers build: these cases are about what the program itself does. */
const unplanned: Chosen = { ...parts, planned: undefined }

const runIn = async (
  args: ReadonlyArray<string>,
  root: string,
  chosen: Chosen = unplanned,
  faulty?: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem>,
  directory?: string
): Promise<Outcome> => {
  const sink = recorder()
  const code = await inProcess(args, root, chosen, sink.service as never, environment, faulty, directory)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

/** Every file under `directory`, by path from it. */
const filesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .sort()

/**
 * The real file system, except that the real location of `path` itself cannot be found once the files are
 * generated, and parts that say so: the reader needs it, and what the program does after reading is the case.
 */
const noRealPathOf = (path: string) => {
  const armed = { on: false }
  const chosen: Chosen = {
    ...unplanned,
    files: (split, options) =>
      Effect.flatMap(Effect.sync(() => void (armed.on = true)), () => parts.files(split, options))
  }
  const faulty = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const blind: FileSystem.FileSystem = {
        ...fs,
        realPath: (asked: string) =>
          armed.on && asked === path
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: asked
            }))
            : fs.realPath(asked)
      }
      return blind
    })
  )
  return { chosen, faulty }
}

describe("--cache", () => {
  it("is an http or https URL as a URL parser reads it, with no space and no control character", () => {
    expect(cacheUrlOf("https://cache.example.invalid/ac")?.host).toBe("cache.example.invalid")
    expect(cacheUrlOf("HTTP://cache.example.invalid")?.protocol).toBe("http:")
    for (
      const value of [
        "cache",
        "ftp://cache.example.invalid",
        "https:/cache.example.invalid",
        "https:cache.example.invalid",
        "file:///etc/passwd",
        "https://cache.example.invalid/a\nb",
        "https://cache.example.invalid/a\r\nb",
        "https://cache.example.invalid/\tb",
        "https://cache.example.invalid/\u0000",
        "https://cache.example.invalid/\u0085x",
        " https://cache.example.invalid",
        "https://cache.example.invalid/a b"
      ]
    ) expect(cacheUrlOf(value), JSON.stringify(value)).toBeUndefined()
  })

  it("is refused with a user name or a password, however the URL's slashes are written, and never printed", async () => {
    const root = repo()
    for (
      const value of [
        "https://someone:hunter2@cache.example.invalid/ac",
        "https:///someone:hunter2@cache.example.invalid/ac",
        "https://someone@cache.example.invalid/ac"
      ]
    ) {
      for (const args of [["apply", "--cache", value], ["--cache", value, "--commits", "1"]]) {
        const outcome = await runIn(args, root)
        expect(outcome.code, value).toBe(exitCodes.usage)
        expect(outcome.stderr, value).toContain("a URL with no user name or password")
        expect(outcome.stderr, value).not.toContain("hunter2")
        expect(outcome.stderr, value).not.toContain("someone")
        expect(outcome.stdout).toBe("")
      }
    }
    expect(existsSync(join(root, ".smithers"))).toBe(false)
  })

  it("is refused with a line end, which would break the line the workflow holds it on", async () => {
    const root = repo()
    const outcome = await runIn(["apply", "--cache", "https://cache.example.invalid/a\n      - run: id"], root)
    expect(outcome.code).toBe(exitCodes.usage)
    expect(outcome.stderr).toContain("an http or https URL")
    expect(outcome.stderr.trim().split("\n")).toHaveLength(1)
    expect(existsSync(join(root, ".smithers"))).toBe(false)
  })
})

describe("--out", () => {
  const page = "<!doctype html>"

  it("is not written through a link of the repository, and the replay does not start", async () => {
    const root = repo()
    const outside = scratch()
    const theirs = join(outside, "bashrc")
    writeFileSync(theirs, "the person's own\n")
    symlinkSync(theirs, join(root, "report.html"))
    symlinkSync(outside, join(root, "out"))
    mkdirSync(join(root, "real"))
    symlinkSync("real", join(root, "inside"))
    for (
      const [out, link] of [
        ["report.html", "report.html"],
        ["out/report.html", "out"],
        ["out/deeper/report.html", "out"],
        // A link that stays inside the repository is one too: where it leads is not what the person named.
        ["inside/report.html", "inside"]
      ] as const
    ) {
      const outcome = await runIn(["--out", out, "--commits", "1"], root)
      expect(outcome.code, out).toBe(exitCodes.failed)
      expect(outcome.stderr, out).toBe(
        `smithers-ci: cli: could not write ${join(root, out)}: ${link} is a link, and the report is not written `
          + "through a link in the repository\n"
      )
      expect(outcome.stdout, out).toBe("")
    }
    expect(readFileSync(theirs, "utf8")).toBe("the person's own\n")
    expect(filesUnder(outside)).toEqual(["bashrc"])
    expect(readdirSync(join(root, "real"))).toEqual([])
  })

  it("is not written through a link the replay left in its path, after the report is printed", async () => {
    const root = repo()
    const outside = scratch()
    const linking: Chosen = {
      ...unplanned,
      run: <R>(request: ReplayRequest, given: ReplayParts<R>) =>
        Effect.flatMap(Effect.sync(() => symlinkSync(outside, join(root, "pages"))), () => replayed(request, given))
    }
    const outcome = await runIn(["--out", "pages/report.html", "--commits", "1"], root, linking)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toContain(
      `smithers-ci: cli: could not write ${join(root, "pages/report.html")}: pages is a link, and the report is not `
        + "written through a link in the repository"
    )
    // The replay ran and its report is printed: only the page is lost, and the footer does not claim it.
    expect(outcome.stdout).toContain("This run wrote nothing to the repository.")
    expect(filesUnder(outside)).toEqual([])
  })

  it("says the page is in the repository by where it really is, whatever link the program was started through", async () => {
    const root = repo()
    const elsewhere = scratch()
    const through = join(elsewhere, "checkout")
    symlinkSync(root, through)
    // Started in the repository through a link to it: the path is spelled outside the repository, and is inside.
    const inside = await runIn(["--out", "report.html", "--commits", "1"], root, unplanned, undefined, through)
    expect(inside.code, inside.stderr).toBe(exitCodes.ok)
    expect(inside.stdout).toContain("This run wrote one file to the repository: report.html.")
    expect(readFileSync(join(root, "report.html"), "utf8")).toContain(page)
    symlinkSync(elsewhere, join(root, "exports"))
    const guarded = await runIn(["--out", join(through, "exports", "run.html"), "--commits", "1"], root)
    expect(guarded.code).toBe(exitCodes.failed)
    expect(guarded.stderr).toContain("exports is a link")
    expect(existsSync(join(elsewhere, "run.html"))).toBe(false)
    // A new directory inside it, which is made for the page.
    const deeper = await runIn(["--out", "pages/new/report.html", "--commits", "1"], root)
    expect(deeper.code, deeper.stderr).toBe(exitCodes.ok)
    expect(deeper.stdout).toContain(
      `This run wrote one file to the repository: ${join("pages", "new", "report.html")}.`
    )
    // A link outside the repository is the person's own, and is followed: the page is where it leads.
    const pages = join(elsewhere, "pages")
    mkdirSync(pages)
    symlinkSync(pages, join(elsewhere, "link"))
    const outside = await runIn(["--out", join(elsewhere, "link", "report.html"), "--commits", "1"], root)
    expect(outside.code, outside.stderr).toBe(exitCodes.ok)
    expect(outside.stdout).toContain("This run wrote nothing to the repository.")
    expect(readFileSync(join(pages, "report.html"), "utf8")).toContain(page)
  })

  it("reports the same external final-link destination that it writes", async () => {
    const root = repo()
    const output = join(scratch(), "out.html")
    const report = join(root, "report.html")
    writeFileSync(report, "old", { mode: 0o640 })
    symlinkSync(report, output)
    const outcome = await runIn(["--out", output, "--commits", "1"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain("This run wrote one file to the repository: report.html.")
    expect(outcome.stderr).toContain(`wrote ${report}`)
    expect(readFileSync(report, "utf8")).toContain(page)
    expect(statSync(report).mode & 0o777).toBe(0o640)
  })

  it("cleans up only its own staging file when writing the report fails", async () => {
    const root = repo()
    const report = join(root, "report.html")
    writeFileSync(report, "old")
    for (const failure of ["inspect", "collision", "rename"]) {
      let stage = ""
      const faulty = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const denied = (method: string, path: string) =>
            Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method,
              pathOrDescriptor: path
            }))
          return FileSystem.FileSystem.of({
            ...fs,
            lstat: (path) => failure === "inspect" && path === report ? denied("lstat", path) : fs.lstat(path),
            open: (path, options) => {
              if (options?.flag === "wx") {
                stage = path
                if (failure === "collision") writeFileSync(path, "reserved")
              }
              return fs.open(path, options)
            },
            rename: (from, to) => failure === "rename" ? denied("rename", from) : fs.rename(from, to)
          })
        })
      )
      const outcome = await runIn(["--out", report, "--commits", "1"], root, unplanned, faulty)
      expect(outcome.code, failure).toBe(exitCodes.failed)
      expect(outcome.stderr).toContain(`could not write ${report}`)
      expect(readFileSync(report, "utf8")).toBe("old")
      if (failure === "collision") expect(readFileSync(stage, "utf8")).toBe("reserved")
      if (failure === "rename") expect(existsSync(stage)).toBe(false)
    }
  })

  it("is written, and placed by its name, where the repository's real location cannot be found", async () => {
    const root = repo()
    const { chosen, faulty } = noRealPathOf(root)
    const outcome = await runIn(["--out", "pages/report.html", "--commits", "1"], root, chosen, faulty)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain(`This run wrote one file to the repository: ${join("pages", "report.html")}.`)
    expect(readFileSync(join(root, "pages", "report.html"), "utf8")).toContain(page)
  })
})

describe("apply", () => {
  const workflow = ".github/workflows/smithers-ci.yml"

  it("replaces a generated file and never writes into it, so a file another checkout shares stays as it was", async () => {
    const root = repo()
    expect((await runIn(["apply"], root)).code).toBe(exitCodes.ok)
    const first = readFileSync(join(root, workflow), "utf8")
    // A copy of the checkout made with hard links: one file, two names.
    const other = join(scratch(), "smithers-ci.yml")
    chmodSync(join(root, workflow), 0o600)
    linkSync(join(root, workflow), other)
    expect(statSync(other).ino).toBe(statSync(join(root, workflow)).ino)
    const again = await runIn(["apply", "--cache", "https://cache.example.invalid/ac"], root)
    expect(again.code, again.stderr).toBe(exitCodes.ok)
    const second = readFileSync(join(root, workflow), "utf8")
    expect(second).toContain("https://cache.example.invalid/ac")
    expect(second).not.toBe(first)
    expect(readFileSync(other, "utf8")).toBe(first)
    expect(statSync(other).ino).not.toBe(statSync(join(root, workflow)).ino)
    // The new file is an ordinary one, and nothing it was written through is left beside it.
    expect(statSync(join(root, workflow)).mode & 0o777).toBe(0o600)
    expect(filesUnder(root).filter((file) => file.endsWith(".smithers-ci"))).toEqual([])
  })

  it("writes no file into a directory that became a link after the paths were checked", async () => {
    const root = repo()
    const outside = scratch()
    // What a program beside this one could do between the check and the write, done here where the plan is asked.
    const linking: Chosen = {
      ...parts,
      planned: () => Effect.sync(() => (symlinkSync(outside, join(root, ".smithers")), []))
    }
    const outcome = await runIn(["apply"], root, linking)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toMatch(
      /smithers-ci: cli: could not write \S+\.smithers\S+: \S+ is now \S+, and no generated file is written through a link/
    )
    expect(filesUnder(outside)).toEqual([])
  })

  it("writes its files where the repository's real location cannot be found", async () => {
    const root = repo()
    const { chosen, faulty } = noRealPathOf(root)
    const outcome = await runIn(["apply"], root, chosen, faulty)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(existsSync(join(root, workflow))).toBe(true)
  })
})

describe("what the default command says apply would do", () => {
  it("counts the files for a job on a Linux runner that leaves a program running, which apply writes", async () => {
    const root = repo()
    const read = await Effect.runPromise(Effect.provide(parts.read(root), host))
    const reason = { feature: leftRunning, detail: "starts a server in the background" }
    const marked = { ...read, jobs: read.jobs.map((job) => ({ ...job, unsupported: [reason] })) }
    const outcome = await runIn(["--commits", "1"], root, { ...unplanned, read: () => Effect.succeed(marked) })
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toMatch(/smithers-ci apply would write \d+ files\./)
    expect(outcome.stdout).not.toContain("apply would write nothing")
  })
})

describe("a job id a workflow chose", () => {
  const moving = "evil\u001b]0;title\u0007\u001b[2J\u009bid"

  it("reaches the terminal with no control sequence in a refusal of --job", async () => {
    const root = repo()
    const read = await Effect.runPromise(Effect.provide(parts.read(root), host))
    const named = { ...read, jobs: read.jobs.map((job, index) => index === 0 ? { ...job, id: moving } : job) }
    const outcome = await runIn(["replay", "--job", "nope", "--commits", "1"], root, {
      ...unplanned,
      read: () => Effect.succeed(named)
    })
    expect(outcome.code).toBe(exitCodes.usage)
    expect(outcome.stderr).toContain("--job nope names no job of this CI; its jobs are evil�id, ")
    expect(outcome.stderr).not.toContain("\u001b")
    expect(outcome.stderr).not.toContain("\u0007")
  })

  it("reaches the terminal with no control sequence in a replay's progress", async () => {
    const sink = recorder()
    await Effect.runPromise(
      Effect.gen(function*() {
        const progress = yield* Progress
        yield* progress.say(`running ${moving}`)
      }).pipe(
        Effect.provide(layer({}, undefined, repo()) as Layer.Layer<never>),
        Effect.provideService(Console.Console, sink.service as never)
      )
    )
    expect(sink.stderr()).toBe("smithers-ci: running evil�id\n")
  })

  it("reaches the terminal with no control sequence when the program stops on an error that names it", async () => {
    const said: Array<string> = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: ReadonlyArray<unknown>) => {
      said.push(args.map(String).join(" "))
    })
    try {
      const dying: Chosen = { ...unplanned, read: () => Effect.die(new Error(`no job ${moving}`)) }
      expect(await runMain(["inventory"], repo(), environment, dying)).toBe(exitCodes.failed)
    } finally {
      spy.mockRestore()
    }
    const line = said.find((one) => one.includes("stopped on an error of its own"))
    expect(line).toContain("no job evil�id")
    expect(line).not.toContain("\u001b")
  })
})

describe("the Node that runs smthrs, under Bun", () => {
  const bun = { bun: "1.3.0" }
  /** A directory that holds a program named `node`. */
  const withNode = (directory: string = scratch()): string => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "node"), "#!/bin/sh\n", { mode: 0o755 })
    chmodSync(join(directory, "node"), 0o755)
    return directory
  }

  it("is never a file of the checkout the program runs in, by its whole name or through a link", () => {
    const checkout = scratch()
    const theirs = withNode(join(checkout, "node_modules", ".bin"))
    const real = withNode()
    // A package script's path names the checkout's own directory of programs first, by its whole name.
    expect(nodeProgram(`${theirs}${delimiter}${real}`, bun, process.execPath, checkout)).toBe(join(real, "node"))
    expect(nodeProgram(theirs, bun, process.execPath, checkout)).toBeUndefined()
    // A directory outside the checkout whose node is a link into it.
    const linked = scratch()
    symlinkSync(join(theirs, "node"), join(linked, "node"))
    expect(nodeProgram(`${linked}${delimiter}${real}`, bun, process.execPath, checkout)).toBe(join(real, "node"))
    // With no checkout named, and with one that is not there, the first node on the path is the one.
    expect(nodeProgram(`${theirs}${delimiter}${real}`, bun, process.execPath)).toBe(join(theirs, "node"))
    expect(nodeProgram(real, bun, process.execPath, join(checkout, "gone"))).toBe(join(real, "node"))
    // A directory whose name only starts as the checkout's does is another directory.
    const beside = withNode(`${checkout}-tools`)
    made.push(beside)
    expect(nodeProgram(beside, bun, process.execPath, checkout)).toBe(join(beside, "node"))
  })

  it("is looked for outside the checkout that holds the directory the program was started in", () => {
    const checkout = scratch()
    mkdirSync(join(checkout, ".git"))
    mkdirSync(join(checkout, "packages", "a"), { recursive: true })
    expect(checkoutOf(join(checkout, "packages", "a"))).toBe(checkout)
    expect(checkoutOf(checkout)).toBe(checkout)
    // In no checkout, the directory itself is all that is known to be a stranger's.
    const plain = join(scratch(), "a", "b")
    mkdirSync(plain, { recursive: true })
    expect(checkoutOf(plain)).toBe(plain)
  })
})
