import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GitSubmoduleExec from "../src/GitSubmoduleExec.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const sha = (digit: string): string => digit.repeat(40)

/** A git superproject whose index pins each `path` as a gitlink. */
const superproject = async (gitlinks: ReadonlyArray<string>): Promise<string> => {
  const root = await temporary("smthrs-submodule-edges-")
  git(root, ["init", "-q"])
  gitlinks.forEach((path, index) => {
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${sha(String(index + 1))},${path}`])
  })
  return root
}

const single = (root: string, path: string, environment: Readonly<Record<string, string | undefined>> = {}) =>
  GitSubmoduleExec.plan({ root, packagePath: "", rule: "Git.Submodule", attrs: { path } as never, environment })

const selected = (
  root: string,
  packagePath: string,
  config: string,
  paths: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = {}
) =>
  GitSubmoduleExec.plan({
    root,
    packagePath,
    rule: "Git.Submodules",
    attrs: { config: { _tag: "File", path: config }, paths } as never,
    environment
  })

const gitmodules = (root: string, file: string, body: string) =>
  Fs.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true }).then(() =>
    Fs.writeFile(NodePath.join(root, file), body)
  )

describe("Git submodule planning edges", () => {
  it("plans a single gitlink when the workspace has no .gitmodules at all", async () => {
    const root = await superproject(["vendor/one"])
    const plan = await single(root, "//vendor/one")
    expect(plan).toEqual({
      paths: ["vendor/one"],
      gitlinks: [{ path: "vendor/one", sha: sha("1"), state: "missing" }],
      sources: []
    })
    expect(GitSubmoduleExec.isMaterialized(plan)).toBe(false)
  })

  it("refuses a selected path the index does not pin as a gitlink", async () => {
    const root = await superproject(["vendor/one"])
    const plan = await single(root, "//vendor/other")
    expect(plan.gitlinks).toEqual([])
    expect(plan.sources).toEqual([])
    expect(plan.refusal).toBe("Git submodule vendor/other has no stage-0 gitlink in the repository index")
  })

  it("refuses a gitlink path occupied by a regular file as an unreadable HEAD", async () => {
    const root = await superproject(["vendor/one"])
    await Fs.mkdir(NodePath.join(root, "vendor"))
    await Fs.writeFile(NodePath.join(root, "vendor", "one"), "not a checkout")
    const plan = await single(root, "//vendor/one")
    expect(plan.gitlinks).toEqual([{ path: "vendor/one", sha: sha("1"), state: "mismatch" }])
    expect(plan.refusal).toBe(
      `Git submodule vendor/one worktree HEAD is not readable does not match pinned gitlink ${sha("1")}`
    )
  })

  it("reads a package-nested .gitmodules, skips blank entries, and deduplicates one local source", async () => {
    const root = await superproject(["pkg/four", "pkg/one", "pkg/three", "pkg/two"])
    const source = NodePath.join(root, "mirrors", "shared")
    await Fs.mkdir(source, { recursive: true })
    git(source, ["init", "-q"])
    await gitmodules(
      root,
      "pkg/.gitmodules",
      [
        `[submodule "one"]`,
        `\tpath = one`,
        `\turl = ../one.git`,
        `\tbranch = main`,
        `[submodule "blank"]`,
        `\tpath =`,
        `\turl = ${source}`,
        `[submodule "two"]`,
        `\tpath = two`,
        `\turl =`,
        `[submodule "three"]`,
        `\tpath = three`,
        `\turl = ${source}`,
        `[submodule "four"]`,
        `\tpath = four`,
        `\turl = file://${source}`,
        ""
      ].join("\n")
    )
    const plan = await selected(root, "pkg", ".gitmodules", ["*"])
    expect(plan.refusal).toBeUndefined()
    expect(plan.paths).toEqual(["pkg/four", "pkg/one", "pkg/three", "pkg/two"])
    expect(plan.gitlinks.map((link) => [link.path, link.state])).toEqual([
      ["pkg/four", "missing"],
      ["pkg/one", "missing"],
      ["pkg/three", "missing"],
      ["pkg/two", "missing"]
    ])
    // The relative url and the blank url name no host directory; three and four share one.
    expect(plan.sources).toEqual([source])
  })

  it("refuses selector globs that match no declared submodule path", async () => {
    const root = await superproject(["pkg/one"])
    await gitmodules(root, "pkg/.gitmodules", `[submodule "one"]\n\tpath = one\n\turl = ../one.git\n`)
    const plan = await selected(root, "pkg", ".gitmodules", ["third_party/*"])
    expect(plan).toEqual({
      paths: [],
      gitlinks: [],
      sources: [],
      refusal: `Git.Submodules paths ["third_party/*"] match no entries in pkg/.gitmodules`
    })
  })

  it("refuses a committed local url naming a path that does not exist", async () => {
    const root = await superproject(["vendor/one"])
    const missing = NodePath.join(root, "mirrors", "gone")
    await gitmodules(root, ".gitmodules", `[submodule "one"]\n\tpath = vendor/one\n\turl = ${missing}\n`)
    const plan = await single(root, "//vendor/one")
    expect(plan.sources).toEqual([])
    expect(plan.refusal).toBe(`Git submodule vendor/one url names local path ${missing}, which does not exist`)
  })

  it("ignores operator-listed source directories that do not exist", async () => {
    const mirrors = await temporary("smthrs-submodule-listed-")
    const source = NodePath.join(mirrors, "one.git")
    await Fs.mkdir(source)
    git(source, ["init", "-q", "--bare"])
    const root = await superproject(["vendor/one"])
    await gitmodules(root, ".gitmodules", `[submodule "one"]\n\tpath = vendor/one\n\turl = ${source}\n`)
    const gone = NodePath.join(mirrors, "gone")
    const onlyGone = await single(root, "//vendor/one", { [GitSubmoduleExec.submoduleSourcesVariable]: gone })
    expect(onlyGone.refusal).toContain("outside the workspace")
    const plan = await single(root, "//vendor/one", {
      [GitSubmoduleExec.submoduleSourcesVariable]: [gone, "relative/ignored", mirrors].join(NodePath.delimiter)
    })
    expect(plan.refusal).toBeUndefined()
    expect(plan.sources).toEqual([source])
  })

  it("admits a workspace-local source when the home directory does not exist", async () => {
    const root = await superproject(["vendor/one"])
    const source = NodePath.join(root, "mirrors", "one")
    await Fs.mkdir(source, { recursive: true })
    git(source, ["init", "-q"])
    await gitmodules(root, ".gitmodules", `[submodule "one"]\n\tpath = vendor/one\n\turl = ${source}\n`)
    const previous = process.env["HOME"]
    process.env["HOME"] = NodePath.join(root, "no-such-home")
    try {
      const plan = await single(root, "//vendor/one")
      expect(plan.refusal).toBeUndefined()
      expect(plan.sources).toEqual([source])
    } finally {
      if (previous === undefined) delete process.env["HOME"]
      else process.env["HOME"] = previous
    }
  })
})

describe("Git submodule materialization", () => {
  const link = (state: GitSubmoduleExec.Gitlink["state"]): GitSubmoduleExec.Gitlink => ({
    path: `vendor/${state}`,
    sha: sha("a"),
    state
  })

  it("is materialized only when every selected gitlink matches", () => {
    expect(GitSubmoduleExec.isMaterialized({ paths: [], gitlinks: [], sources: [] })).toBe(true)
    expect(GitSubmoduleExec.isMaterialized({ paths: [], gitlinks: [link("matching")], sources: [] })).toBe(true)
    for (const state of ["missing", "empty", "mismatch"] as const) {
      expect(GitSubmoduleExec.isMaterialized({ paths: [], gitlinks: [link("matching"), link(state)], sources: [] }))
        .toBe(false)
    }
  })
})
