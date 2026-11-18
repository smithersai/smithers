import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { besidePaths, besideRefusal, check, formerPaths, ignoresFor } from "../../src/apply/index.ts"
import { applyIgnores, exitCodes } from "../../src/contract/Command.ts"
import { type Failure, type GeneratedFile, writtenFiles } from "../../src/contract/Parts.ts"
import * as TargetMap from "../../src/contract/TargetMap.ts"
import { generatedMark } from "../../src/native/index.ts"
import { unreadable } from "../native/support.vibe"
import { generated, inProcess, noBytes, noRemove, noStat } from "./inProcess.vibe"
import { parts } from "./parts.vibe"
import {
  bin,
  changed,
  commit,
  type Outcome,
  read,
  recorder,
  remove,
  repository,
  snapshot,
  spawn,
  temporary
} from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

const repo = (): string => keep(repository(["first"]))
const outside = (): string => keep(temporary("outside"))

const runIn = async (args: ReadonlyArray<string>, root: string): Promise<Outcome> => {
  const sink = recorder()
  const code = await inProcess(args, root, parts, sink.service as never, environment)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

/** The program in this process, and the published executable as a process. */
const ways = {
  "in process": (args: ReadonlyArray<string>, root: string): Promise<Outcome> => runIn(args, root),
  "as the installed program": (args: ReadonlyArray<string>, root: string): Promise<Outcome> => spawn(bin, args, root)
}

const workflow = ".github/workflows/smithers-ci.yml"
const owners = "name: mine\non: push\njobs: {}\n"
const secret = "s3cr3t-cache-token"

/** Every file under `directory`, by name. */
const filesIn = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { recursive: true, encoding: "utf8" })

describe.each(Object.entries(ways))("smithers-ci apply %s", (_way, exec) => {
  describe.concurrent("a shared cache URL", () => {
    it("exits 2 on a URL with a user name or a password, names the token variable and never prints the secret", async () => {
      for (const command of [["apply"], [], ["replay"]]) {
        const root = repo()
        const before = snapshot(root)
        const outcome = await exec([...command, "--cache", `https://ci-bot:${secret}@cache.example.invalid/v1`], root)
        expect(outcome.code).toBe(exitCodes.usage)
        expect(outcome.stdout).toBe("")
        expect(outcome.stderr).toContain("--cache")
        expect(outcome.stderr).toContain("no user name or password")
        expect(outcome.stderr).toContain("SMITHERS_CACHE_TOKEN")
        expect(outcome.stderr).toContain("https://cache.example.invalid/v1")
        expect(outcome.stderr).not.toContain(secret)
        expect(outcome.stderr).not.toContain("ci-bot")
        expect(outcome.stderr.trim().split("\n")).toHaveLength(1)
        expect(changed(before, snapshot(root))).toEqual([])
      }
    })

    it("refuses a user name alone, and prints no secret from a value that is not a URL", async () => {
      const root = repo()
      const named = await exec(["apply", "--cache", `https://${secret}@cache.example.invalid`], root)
      expect(named.code).toBe(exitCodes.usage)
      expect(named.stderr).toContain("SMITHERS_CACHE_TOKEN")
      expect(named.stderr).not.toContain(secret)
      // A URL parser reads a credential in each of these; none is an http URL as --cache wants it written.
      for (const start of ["ftp://ci-bot:", "https:/ci-bot:", "https:ci-bot:", "HTTPS:\\\\ci-bot:", "ci-bot:"]) {
        const other = await exec(["apply", "--cache", `${start}${secret}@cache.example.invalid`], root)
        expect(other.code, start).toBe(exitCodes.usage)
        expect(other.stderr, start).toContain("http or https URL")
        expect(other.stderr, start).toContain("cache.example.invalid")
        expect(other.stderr, start).not.toContain(secret)
      }
    })

    it("accepts an @ after the host part", async () => {
      const root = repo()
      const outcome = await exec(["apply", "--cache", "https://cache.example.invalid/teams/@ci?as=a@b"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(read(`${root}/${workflow}`)).toContain("https://cache.example.invalid/teams/@ci?as=a@b")
    })
  })

  describe.concurrent("--check", () => {
    const missing = [
      `${workflow} is missing: run smithers-ci apply`,
      ".smithers/WORKSPACE.smithers is missing: run smithers-ci apply",
      ".smithers/.npmignore is missing: run smithers-ci apply",
      ".gitignore lacks .flows: run smithers-ci apply"
    ]

    it("names each file apply would write, exits 1 and writes nothing", async () => {
      const root = repo()
      const before = snapshot(root)
      expect(await exec(["apply", "--check"], root)).toEqual({
        code: exitCodes.mismatch,
        stdout: missing.map((line) => `${line}\n`).join(""),
        stderr: ""
      })
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("exits 0 and writes nothing once apply has written the files, before and after they are committed", async () => {
      const root = repo()
      const applied = await exec(["apply"], root)
      expect(applied.code, applied.stderr).toBe(exitCodes.ok)
      const before = snapshot(root)
      const up = { code: exitCodes.ok, stdout: "smithers-ci: the generated files are up to date\n", stderr: "" }
      expect(await exec(["apply", "--check"], root)).toEqual(up)
      commit(root, "apply")
      expect(await exec(["apply", "--check"], root)).toEqual(up)
      expect(changed(before, snapshot(root)).filter((path) => !path.startsWith(".git/"))).toEqual([])
    })

    it("names a file edited by hand, one removed, one an earlier smithers-ci left, and a .gitignore that lost the cache", async () => {
      const root = repo()
      expect((await exec(["apply"], root)).code).toBe(exitCodes.ok)
      const edited = `${read(`${root}/.smithers/WORKSPACE.smithers`)}// mine\n`
      commit(root, "edits", {
        ".smithers/WORKSPACE.smithers": edited,
        ".gitignore": "dist\n",
        "PACKAGE.ts": `${generatedMark} Do not edit.\n`
      })
      remove(`${root}/.smithers/.npmignore`)
      const before = snapshot(root)
      expect(await exec(["apply", "--check"], root)).toEqual({
        code: exitCodes.mismatch,
        stdout: [
          ".smithers/WORKSPACE.smithers is out of date: run smithers-ci apply",
          ".smithers/.npmignore is missing: run smithers-ci apply",
          "PACKAGE.ts is no longer used: run smithers-ci apply",
          ".gitignore lacks .flows: run smithers-ci apply",
          ""
        ].join("\n"),
        stderr: ""
      })
      expect(changed(before, snapshot(root))).toEqual([])
      // apply makes each of those changes; then there is nothing left to change.
      expect((await exec(["apply"], root)).code).toBe(exitCodes.ok)
      expect((await exec(["apply", "--check"], root)).code).toBe(exitCodes.ok)
      expect(read(`${root}/.gitignore`)).toBe("dist\n.flows\n")
    })

    it("compares bytes: a byte-order mark or a changed line ending is a change apply would make", async () => {
      const root = repo()
      expect((await exec(["apply"], root)).code).toBe(exitCodes.ok)
      const text = read(`${root}/${workflow}`)
      writeFileSync(`${root}/${workflow}`, `\uFEFF${text}`)
      writeFileSync(`${root}/.smithers/.npmignore`, read(`${root}/.smithers/.npmignore`).replaceAll("\n", "\r\n"))
      const outcome = await exec(["apply", "--check"], root)
      expect(outcome.code).toBe(exitCodes.mismatch)
      expect(outcome.stdout).toBe(
        `${workflow} is out of date: run smithers-ci apply\n.smithers/.npmignore is out of date: run smithers-ci apply\n`
      )
    })

    it("refuses as apply does when a file it would replace is not one smithers-ci wrote", async () => {
      const root = repo()
      commit(root, "own workflow", { [workflow]: owners })
      const before = snapshot(root)
      const refusal = {
        code: exitCodes.unsupported,
        stdout: "",
        stderr: `smithers-ci: generate: ${workflow} was not written by smithers-ci and would be replaced\n`
      }
      expect(await exec(["apply", "--check"], root)).toEqual(refusal)
      expect(await exec(["apply"], root)).toEqual(refusal)
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("compares against the files apply writes for the same cache", async () => {
      const root = repo()
      const cache = "https://cache.example.invalid/v1"
      expect((await exec(["apply", "--cache", cache], root)).code).toBe(exitCodes.ok)
      expect(await exec(["apply", "--check"], root)).toEqual({
        code: exitCodes.mismatch,
        stdout: `${workflow} is out of date: run smithers-ci apply\n`,
        stderr: ""
      })
      expect((await exec(["apply", "--check", "--cache", cache], root)).code).toBe(exitCodes.ok)
      // The workflow runs the check with the cache it names, so it passes on the files apply wrote.
      expect(read(`${root}/${workflow}`)).toContain(`smithers-ci apply --check --cache '${cache}'`)
    })
  })

  describe.concurrent("a file the owner wrote", () => {
    it("never replaces the owner's workflow, and writes nothing", async () => {
      const root = repo()
      commit(root, "own workflow", { [workflow]: owners })
      const before = snapshot(root)
      // The default command measures what apply would write, so it refuses the same way.
      for (const args of [["apply"], ["--commits", "1"]]) {
        expect(await exec(args, root)).toEqual({
          code: exitCodes.unsupported,
          stdout: "",
          stderr: `smithers-ci: generate: ${workflow} was not written by smithers-ci and would be replaced\n`
        })
      }
      expect(read(`${root}/${workflow}`)).toBe(owners)
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("names every file it would replace, the target map included", async () => {
      const root = repo()
      commit(root, "own files", {
        [workflow]: owners,
        [TargetMap.path]: "{ \"mine\": true }\n",
        "PACKAGE.ts": "export {}\n"
      })
      const before = snapshot(root)
      const outcome = await exec(["apply"], root)
      expect(outcome.code).toBe(exitCodes.unsupported)
      expect(outcome.stderr).toBe(
        `smithers-ci: generate: ${workflow} was not written by smithers-ci and would be replaced; PACKAGE.ts was not written by smithers-ci and Smithers build would read it beside the generated files\n`
      )
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("replaces every file it generated before, and only those", async () => {
      const root = repo()
      const files = await generated(root, parts, environment)
      const stale: Record<string, string> = {}
      for (const file of files) {
        stale[file.path] = file.path === TargetMap.path
          ? `${JSON.stringify({ version: 1, targets: [] })}\n`
          : `${file.content.split("\n")[0]}\nstale\n`
      }
      commit(root, "an earlier apply", stale)
      const outcome = await exec(["apply"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      for (const file of writtenFiles(files)) expect(read(`${root}/${file.path}`), file.path).toBe(file.content)
      // The target map is the program's own document. One an earlier apply wrote goes.
      expect(existsSync(`${root}/${TargetMap.path}`)).toBe(false)
    })
  })

  describe.concurrent("files of an earlier layout", () => {
    const earlier: Readonly<Record<string, string>> = {
      "PACKAGE.ts": `${generatedMark} Do not edit.\nexport const Package = 1\n`,
      ".smithers/WORKSPACE.ts": `${generatedMark} Do not edit.\nexport const Workspace = 1\n`,
      [TargetMap.path]: `${JSON.stringify({ version: 1, targets: [] })}\n`,
      ".smithers/ci/NOT-REPRODUCED.md":
        "# Not reproduced from the original CI\n\nGenerated by smithers-ci. Do not edit.\n"
    }

    it("moves what an earlier smithers-ci wrote, and writes the same bytes the second time", async () => {
      const root = repo()
      commit(root, "an earlier apply", earlier)
      const first = await exec(["apply"], root)
      expect(first.code, first.stderr).toBe(exitCodes.ok)
      for (const path of Object.keys(earlier)) {
        expect(first.stdout, path).toContain(`removed ${path}\n`)
        expect(existsSync(`${root}/${path}`), path).toBe(false)
      }
      expect(first.stdout).toContain("wrote .smithers/WORKSPACE.smithers\n")
      expect(read(`${root}/.smithers/WORKSPACE.smithers`)).toContain("export const Package = S.Package({")
      // Nothing is left at the repository root but what was there, and the cache line in .gitignore.
      expect(readdirSync(root).sort()).toEqual([".git", ".github", ".gitignore", ".smithers", "justfile", "src"])
      const before = snapshot(root)
      const second = await exec(["apply"], root)
      expect(second.code, second.stderr).toBe(exitCodes.ok)
      expect(second.stdout).not.toContain("removed")
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("leaves a file the owner wrote where smithers-ci no longer writes", async () => {
      const root = repo()
      const owned = { [TargetMap.path]: "{ \"mine\": true }\n", ".smithers/ci/NOT-REPRODUCED.md": "# Mine\n" }
      commit(root, "own files", owned)
      const outcome = await exec(["apply"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(outcome.stdout).not.toContain("removed")
      for (const [path, content] of Object.entries(owned)) expect(read(`${root}/${path}`)).toBe(content)
    })

    it("refuses beside a build file the owner wrote, and writes nothing", async () => {
      const root = repo()
      commit(root, "own package", { "PACKAGE.vibe": "export const Package = 1\n", "PACKAGE.ts": "export {}\n" })
      const before = snapshot(root)
      expect(await exec(["apply"], root)).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr:
          "smithers-ci: generate: PACKAGE.ts, PACKAGE.vibe were not written by smithers-ci and Smithers build would read them beside the generated files\n"
      })
      expect(changed(before, snapshot(root))).toEqual([])
    })
  })

  describe.concurrent("a link in a generated path", () => {
    it("refuses a directory that is a link to outside the repository, and writes nothing anywhere", async () => {
      const root = repo()
      const elsewhere = outside()
      symlinkSync(elsewhere, join(root, ".github"))
      commit(root, "link")
      const before = snapshot(root)
      const outcome = await exec(["apply"], root)
      expect(outcome.code).toBe(exitCodes.unsupported)
      expect(outcome.stdout).toBe("")
      expect(outcome.stderr).toMatch(/^smithers-ci: generate: \.github is a link to .*, outside the repository\n$/)
      expect(filesIn(elsewhere)).toEqual([])
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("refuses a file that is a link to a missing file outside, and does not make that file", async () => {
      const root = repo()
      const elsewhere = outside()
      symlinkSync(join(elsewhere, "PACKAGE.ts"), join(root, "PACKAGE.ts"))
      commit(root, "link")
      const before = snapshot(root)
      const outcome = await exec(["apply"], root)
      expect(outcome.code).toBe(exitCodes.unsupported)
      expect(outcome.stderr).toBe(
        `smithers-ci: generate: PACKAGE.ts is a link to ${join(elsewhere, "PACKAGE.ts")}, which does not exist\n`
      )
      expect(filesIn(elsewhere)).toEqual([])
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("refuses a file that is a link to a file smithers-ci generated outside the repository", async () => {
      const root = repo()
      const elsewhere = outside()
      writeFileSync(join(elsewhere, "PACKAGE.ts"), `${generatedMark} Do not edit.\n`)
      symlinkSync(join(elsewhere, "PACKAGE.ts"), join(root, "PACKAGE.ts"))
      const outcome = await exec(["apply"], root)
      expect(outcome.code).toBe(exitCodes.unsupported)
      expect(outcome.stderr).toContain("PACKAGE.ts is a link to ")
      expect(read(join(elsewhere, "PACKAGE.ts"))).toBe(`${generatedMark} Do not edit.\n`)
    })

    it("writes through a link that stays inside the repository", async () => {
      const root = repo()
      mkdirSync(join(root, "ci", "github"), { recursive: true })
      symlinkSync(join("ci", "github"), join(root, ".github"))
      const outcome = await exec(["apply"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(read(join(root, "ci", "github", "workflows", "smithers-ci.yml"))).toContain("Generated by smithers-ci.")
    })
  })

  describe.concurrent("a path that cannot hold the file", () => {
    it("writes nothing when a directory is where a generated file must go", async () => {
      const root = repo()
      commit(root, "a directory", { [`${workflow}/README`]: "keep\n" })
      const before = snapshot(root)
      const outcome = await exec(["apply"], root)
      expect(outcome).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr: `smithers-ci: generate: ${workflow} is not a file\n`
      })
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("takes a directory at the plain workspace file's path for the owner's workspace, and writes nothing", async () => {
      const root = repo()
      commit(root, "a directory", { ".smithers/WORKSPACE.smithers/README": "keep\n" })
      const before = snapshot(root)
      const outcome = await exec(["apply"], root)
      expect(outcome).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr:
          "smithers-ci: inventory: the repository already builds with Smithers build (.smithers/WORKSPACE.smithers); there is nothing to convert\n"
      })
      expect(changed(before, snapshot(root))).toEqual([])
    })

    it("writes nothing when a file is where a directory must go, and names each such path", async () => {
      const root = repo()
      commit(root, "a file", { ".github/workflows": "not a directory\n" })
      mkdirSync(join(root, ".gitignore"))
      const before = snapshot(root)
      const outcome = await exec(["apply"], root)
      expect(outcome).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr:
          `smithers-ci: generate: .github/workflows is not a directory, so ${workflow} cannot be written; .gitignore is not a file\n`
      })
      expect(changed(before, snapshot(root))).toEqual([])
    })
  })

  describe.concurrent("the cache directory", () => {
    it("adds it to a .gitignore that lacks it, says so, and adds it once", async () => {
      const root = repo()
      commit(root, "ignore", { ".gitignore": "node_modules" })
      const first = await exec(["apply"], root)
      expect(first.code, first.stderr).toBe(exitCodes.ok)
      expect(first.stdout).toContain("added .flows to .gitignore\n")
      expect(read(`${root}/.gitignore`)).toBe("node_modules\n.flows\n")
      const second = await exec(["apply"], root)
      expect(second.code, second.stderr).toBe(exitCodes.ok)
      expect(second.stdout).not.toContain(".gitignore")
      expect(read(`${root}/.gitignore`)).toBe("node_modules\n.flows\n")
    })

    it("makes the .gitignore when there is none, and leaves one that names the directory", async () => {
      const root = repo()
      const outcome = await exec(["apply"], root)
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      expect(read(`${root}/.gitignore`)).toBe(applyIgnores.map((line) => `${line}\n`).join(""))
      const named = repo()
      commit(named, "ignore", { ".gitignore": "dist\r\n/.flows/\r\n" })
      const kept = await exec(["apply"], named)
      expect(kept.code, kept.stderr).toBe(exitCodes.ok)
      expect(kept.stdout).not.toContain(".gitignore")
      expect(read(`${named}/.gitignore`)).toBe("dist\r\n/.flows/\r\n")
    })
  })
})

describe("an earlier layout that cannot be removed", () => {
  it("exits 4 and names the file", async () => {
    const root = repo()
    commit(root, "an earlier apply", { "PACKAGE.ts": `${generatedMark} Do not edit.\n` })
    const sink = recorder()
    const code = await inProcess(["apply"], root, parts, sink.service as never, environment, noRemove)
    expect(code).toBe(exitCodes.failed)
    expect(sink.stderr()).toMatch(new RegExp(`^smithers-ci: cli: could not remove ${join(root, "PACKAGE.ts")}: `))
    expect(existsSync(join(root, "PACKAGE.ts"))).toBe(true)
  })
})

describe.concurrent("what apply checks before it writes", () => {
  const onNode = <A>(work: Effect.Effect<A, Failure, FileSystem.FileSystem | Path.Path>) =>
    Effect.runPromise(Effect.provide(Effect.result(work), NodeServices.layer))
  const files: ReadonlyArray<GeneratedFile> = [
    { path: "PACKAGE.ts", content: `${generatedMark} Do not edit.\n` },
    { path: ".smithers/ci/NOT-REPRODUCED.md", content: "# Not reproduced\n\nGenerated by smithers-ci. Do not edit.\n" }
  ]

  it("gives the lines .gitignore lacks, with its new text", () => {
    expect(ignoresFor("")).toEqual({ added: [".flows"], text: ".flows\n" })
    expect(ignoresFor("dist\n")).toEqual({ added: [".flows"], text: "dist\n.flows\n" })
    expect(ignoresFor("dist")).toEqual({ added: [".flows"], text: "dist\n.flows\n" })
    for (const line of [".flows", "/.flows", ".flows/", "  /.flows/  "]) {
      expect(ignoresFor(`dist\n${line}\n`)).toEqual({ added: [], text: `dist\n${line}\n` })
    }
  })

  it("passes absent files and files smithers-ci wrote", async () => {
    const root = repo()
    expect((await onNode(check(root, files)))._tag).toBe("Success")
    for (const file of files) {
      mkdirSync(join(root, file.path, ".."), { recursive: true })
      writeFileSync(join(root, file.path), file.content)
    }
    expect(await onNode(check(root, files))).toMatchObject({ _tag: "Success", success: { added: [".flows"] } })
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
  })

  it("counts a file it cannot read as the owner's, and refuses a .gitignore it cannot read", async () => {
    const root = repo()
    writeFileSync(join(root, "PACKAGE.ts"), files[0]!.content)
    writeFileSync(join(root, ".gitignore"), "dist\n")
    const outcome = await onNode(Effect.provide(check(root, files), unreadable))
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "unsupported",
        message: "PACKAGE.ts was not written by smithers-ci and would be replaced; .gitignore cannot be read",
        part: "generate"
      }
    })
  })

  it("refuses a path it cannot inspect", async () => {
    const root = repo()
    writeFileSync(join(root, "PACKAGE.ts"), files[0]!.content)
    const outcome = await onNode(Effect.provide(check(root, [files[0]!]), noStat))
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { message: "PACKAGE.ts is not a file" } })
  })

  it("gives the files of an earlier layout to remove, and only those smithers-ci wrote", async () => {
    const root = repo()
    expect(await onNode(check(root, files))).toMatchObject({ _tag: "Success", success: { former: [] } })
    const earlier: Readonly<Record<string, string>> = {
      ".smithers/WORKSPACE.ts": `${generatedMark} Do not edit.\n`,
      [TargetMap.path]: `${JSON.stringify({ version: 1, targets: [] })}\n`
    }
    for (const [path, content] of Object.entries(earlier)) {
      mkdirSync(join(root, path, ".."), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    // PACKAGE.ts and the notes are among the files given here, so they are written, not removed.
    expect(await onNode(check(root, files))).toMatchObject({
      _tag: "Success",
      success: { former: [".smithers/WORKSPACE.ts", TargetMap.path] }
    })
    expect(formerPaths).toEqual([
      "PACKAGE.ts",
      ".smithers/WORKSPACE.ts",
      TargetMap.path,
      ".smithers/ci/NOT-REPRODUCED.md"
    ])
    expect(besidePaths).toEqual(["PACKAGE.ts", ".smithers/WORKSPACE.ts", "PACKAGE.vibe"])
    expect(besideRefusal(["PACKAGE.ts"])).toBe(
      "PACKAGE.ts was not written by smithers-ci and Smithers build would read it beside the generated files"
    )
  })

  it("does not check a file that is not written", async () => {
    const root = repo()
    mkdirSync(join(root, TargetMap.path), { recursive: true })
    const map: GeneratedFile = { path: TargetMap.path, content: "{}", written: false }
    // A directory is where the target map would go: it is never written, so nothing is refused.
    expect(await onNode(check(root, [map]))).toMatchObject({ _tag: "Success", success: { former: [] } })
  })

  it("refuses what Smithers build would read beside the generated files", async () => {
    const notes = [files[1]!]
    const owned = repo()
    writeFileSync(join(owned, "PACKAGE.ts"), "export {}\n")
    expect(await onNode(check(owned, notes))).toMatchObject({
      _tag: "Failure",
      failure: { code: "unsupported", message: besideRefusal(["PACKAGE.ts"]), part: "generate" }
    })
    // A file that cannot be read is the owner's, where Smithers build reads; elsewhere it is left alone.
    const unread = repo()
    writeFileSync(join(unread, "PACKAGE.ts"), files[0]!.content)
    mkdirSync(join(unread, ".smithers"))
    writeFileSync(join(unread, TargetMap.path), "{}\n")
    writeFileSync(join(unread, ".gitignore"), ".flows\n")
    expect(await onNode(Effect.provide(check(unread, []), unreadable))).toMatchObject({
      _tag: "Failure",
      failure: { message: `${besideRefusal(["PACKAGE.ts"])}; .gitignore cannot be read` }
    })
    // A directory where Smithers build reads a file is refused; one where it does not is not looked at.
    const directory = repo()
    mkdirSync(join(directory, "PACKAGE.ts"))
    mkdirSync(join(directory, ".smithers", "ci", "NOT-REPRODUCED.md"), { recursive: true })
    expect(await onNode(check(directory, notes.slice(0, 0)))).toMatchObject({
      _tag: "Failure",
      failure: { message: "PACKAGE.ts is not a file" }
    })
    // A link above a generated file is named once, though an earlier file would go under it too.
    const linked = repo()
    const elsewhere = keep(temporary("outside"))
    symlinkSync(elsewhere, join(linked, ".smithers"))
    const refused = await onNode(check(linked, notes))
    expect(refused).toMatchObject({ _tag: "Failure" })
    const message = refused._tag === "Failure" ? refused.failure.message : ""
    expect(message.split("; ")).toHaveLength(1)
    expect(message).toMatch(/^\.smithers is a link to .*, outside the repository$/)
    // A file where the directory goes is named for the generated file alone.
    const flat = repo()
    writeFileSync(join(flat, ".smithers"), "a file\n")
    expect(await onNode(check(flat, notes))).toMatchObject({
      _tag: "Failure",
      failure: { message: ".smithers is not a directory, so .smithers/ci/NOT-REPRODUCED.md cannot be written" }
    })
  })

  it("says what writing the files would change, path by path, in the order apply writes them", async () => {
    const root = repo()
    expect(await onNode(check(root, files))).toMatchObject({
      _tag: "Success",
      success: {
        changes: [
          { path: "PACKAGE.ts", change: "missing" },
          { path: ".smithers/ci/NOT-REPRODUCED.md", change: "missing" },
          { path: ".gitignore", change: "ignores" }
        ]
      }
    })
    for (const file of files) {
      mkdirSync(join(root, file.path, ".."), { recursive: true })
      writeFileSync(join(root, file.path), file.content)
    }
    writeFileSync(join(root, ".gitignore"), ".flows\n")
    expect(await onNode(check(root, files))).toMatchObject({ _tag: "Success", success: { changes: [] } })
    // A generated file whose bytes cannot be read is written again.
    expect(await onNode(Effect.provide(check(root, files), noBytes))).toMatchObject({
      _tag: "Success",
      success: {
        changes: [{ path: "PACKAGE.ts", change: "differs" }, {
          path: ".smithers/ci/NOT-REPRODUCED.md",
          change: "differs"
        }]
      }
    })
  })

  it("checks paths under a root that is not there yet", async () => {
    const root = join(repo(), "missing")
    expect(await onNode(check(root, files))).toMatchObject({ _tag: "Success", success: { text: ".flows\n" } })
  })
})
