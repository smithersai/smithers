/**
 * `owners --diff <base>` judges a change under the ownership the base
 * revision declared. Every case commits a real repository, changes it the way
 * a pull request would, and reads the answer through the command.
 */
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const hasJj = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("owners-base", {
  repository: "git+https://example.invalid/owners-base.git",
  cache: S.Cache({ directory: ".flows" }),
  discovery: { prune: ["vendor"] },
  owners: { owners: ["team:platform"] },
  teams: S.Teams({ platform: ["will"] }),
})
`

const libPackage = `import { Smithers as S } from "@smthrs/targets"
import extra from "./extra.json" with { type: "json" }
import { policy } from "./policy.mjs"
import { team } from "./team.js"
const owners: ReadonlyArray<string> = [...team, ...extra.owners]
export const Package = S.Package({
  owners: { owners, agents: { deny: policy.deny } },
  targets: { srcs: S.Filegroup({ srcs: S.glob(["**"]) }) },
})
`

const packageOwnedBy = (owner: string, options = "") =>
  `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({
  owners: { owners: [${JSON.stringify(owner)}]${options} },
  targets: { srcs: S.Filegroup({ srcs: S.glob(["**"]) }) },
})
`

const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-owners-base-")))
  temporaryDirectories.push(root)
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", packageOwnedBy("rooty"))
  await write(root, "lib/PACKAGE.ts", libPackage)
  await write(root, "lib/team.ts", "export const team: ReadonlyArray<string> = [\"libby\"]\n")
  await write(root, "lib/policy.mjs", "export const policy = { deny: [\"migrations/**\"] }\n")
  await write(root, "lib/extra.json", "{ \"owners\": [\"team:platform\"] }\n")
  await write(root, "lib/query.sql", "select 1;\n")
  await write(root, "lib/migrations/001.sql", "create table t (id int);\n")
  await write(root, "data/PACKAGE.ts", packageOwnedBy("dan", ", noparent: true"))
  await write(root, "data/load.ts", "export {}\n")
  await write(root, "vendor/PACKAGE.ts", packageOwnedBy("vendored"))
  return root
}

const git = (root: string, ...args: ReadonlyArray<string>): void => {
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: root,
    stdio: "ignore"
  })
}

/** Commits the fixture as the base a later `--diff HEAD` reads. */
const commit = {
  git: (root: string): void => {
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
  },
  jj: (root: string): void => {
    execFileSync("jj", ["git", "init", "--no-colocate", root], { stdio: "ignore" })
    execFileSync("jj", ["--no-pager", "commit", "-m", "base"], { cwd: root, stdio: "ignore" })
  }
}

interface Answer {
  readonly touched_paths: ReadonlyArray<{
    readonly path: string
    readonly package: string
    readonly agent_policy: string
  }>
  readonly required_approvers: ReadonlyArray<string>
}

const owners = async (root: string, args: ReadonlyArray<string>): Promise<Answer> => {
  const result = await serve(root, ["owners", ...args, "--format", "json"])
  expect(result.exitCode, result.output).toBe(0)
  return JSON.parse(result.output) as Answer
}

const policies = (answer: Answer) =>
  Object.fromEntries(answer.touched_paths.map((entry) => [entry.path, entry.agent_policy]))

describe.each(["git", "jj"] as const)("owners --diff against a %s base", (vcs) => {
  it.skipIf(vcs === "jj" && !hasJj)(
    "reports the base's owners and agent policy for a change that rewrites its own declaration",
    async () => {
      const root = await fixture()
      commit[vcs](root)
      await write(root, "lib/PACKAGE.ts", packageOwnedBy("mallory", ", agents: { default: \"auto-land\" }"))
      await write(root, "lib/query.sql", "select 2;\n")
      await write(root, "lib/migrations/001.sql", "drop table t;\n")

      const diff = await owners(root, ["--diff", "HEAD"])
      expect(diff.touched_paths.map((entry) => entry.path)).toEqual([
        "lib/PACKAGE.ts",
        "lib/migrations/001.sql",
        "lib/query.sql"
      ])
      expect(diff.required_approvers).toEqual(["libby", "rooty", "team:platform"])
      expect(policies(diff)).toEqual({
        "lib/PACKAGE.ts": "human-approve",
        "lib/migrations/001.sql": "deny",
        "lib/query.sql": "human-approve"
      })

      // A lookup with no diff reads the checkout, where the change's own declaration stands.
      const lookup = await owners(root, ["lib/migrations/001.sql"])
      expect(lookup.required_approvers).toEqual(["mallory", "rooty"])
      expect(policies(lookup)).toEqual({ "lib/migrations/001.sql": "auto-land" })
    }
  )
})

/** `data` denies agents at the base, under an owner who answers alone. */
const guarded = async (): Promise<string> => {
  const root = await fixture()
  await write(root, "data/PACKAGE.ts", packageOwnedBy("dan", ", noparent: true, agents: { default: \"deny\" }"))
  return root
}

describe.each(["git", "jj"] as const)("owners --diff finds a %s base's packages in the base", (vcs) => {
  // R3-Neon-D3-002: discovery skips a directory tagged as a cache, so the tag took //data out of the base index.
  it.skipIf(vcs === "jj" && !hasJj)("keeps a package the change tags as a cache directory", async () => {
    const root = await guarded()
    commit[vcs](root)
    await write(root, "data/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55\n")
    await write(root, "data/load.ts", "export const changed = true\n")

    const diff = await owners(root, ["--diff", "HEAD"])
    expect(diff.touched_paths).toMatchObject([
      { path: "data/CACHEDIR.TAG", package: "//data", agent_policy: "deny" },
      { path: "data/load.ts", package: "//data", agent_policy: "deny" }
    ])
    expect(diff.required_approvers).toEqual(["dan"])
    // The checkout no longer finds //data, which is what a lookup with no diff reads.
    expect((await owners(root, ["data/load.ts"])).required_approvers).toEqual(["rooty"])
  })

  // R3-Neon-D3-002: the checkout's `discovery.prune` decided which base packages were loaded.
  it.skipIf(vcs === "jj" && !hasJj)("keeps a package the change adds to discovery.prune", async () => {
    const root = await guarded()
    commit[vcs](root)
    await write(root, "WORKSPACE.ts", workspaceModule.replace("[\"vendor\"]", "[\"vendor\", \"data\"]"))
    await write(root, "data/load.ts", "export const changed = true\n")

    const diff = await owners(root, ["--diff", "HEAD"])
    expect(diff.touched_paths).toMatchObject([
      { path: "WORKSPACE.ts", package: "//", agent_policy: "human-approve" },
      { path: "data/load.ts", package: "//data", agent_policy: "deny" }
    ])
    expect(diff.required_approvers).toEqual(["dan", "rooty"])
    expect((await owners(root, ["data/load.ts"])).required_approvers).toEqual(["rooty"])
  })
})

describe("owners --diff base discovery", () => {
  it("keeps a package the change turns into a nested checkout, and its changed helper as the base held it", async () => {
    const root = await guarded()
    await write(root, "data/PACKAGE.ts", libPackage.replace("{ deny: policy.deny }", "{ default: \"deny\" }"))
    await write(root, "data/team.ts", "export const team: ReadonlyArray<string> = [\"dan\"]\n")
    await write(root, "data/policy.mjs", "export const policy = { deny: [] }\n")
    await write(root, "data/extra.json", "{ \"owners\": [] }\n")
    commit.git(root)
    // A `.jj` entry marks another checkout; the helper is no module the checkout's index knows.
    await write(root, "data/.jj", "")
    await write(root, "data/team.ts", "export const team: ReadonlyArray<string> = [\"mallory\"]\n")

    const diff = await owners(root, ["--diff", "HEAD"])
    expect(policies(diff)).toEqual({ "data/.jj": "deny", "data/team.ts": "deny" })
    expect(diff.required_approvers).toEqual(["dan", "rooty"])
  })

  it("answers from the checkout when no declaration changed and the base holds the same packages", async () => {
    const root = await guarded()
    commit.git(root)
    await write(root, "data/load.ts", "export const changed = true\n")
    await write(root, "lib/query.sql", "select 2;\n")

    const diff = await owners(root, ["--diff", "HEAD"])
    expect(policies(diff)).toEqual({ "data/load.ts": "deny", "lib/query.sql": "human-approve" })
    expect(diff.required_approvers).toEqual(["dan", "libby", "rooty", "team:platform"])
  })

  it("leaves out what the base itself never entered", async () => {
    const root = await fixture()
    await write(root, "tagged/CACHEDIR.TAG", "")
    await write(root, "tagged/PACKAGE.ts", packageOwnedBy("tagger", ", noparent: true"))
    await write(root, "tagged/a.ts", "export {}\n")
    commit.git(root)
    await Fs.rm(NodePath.join(root, "tagged/CACHEDIR.TAG"))
    await write(root, "tagged/a.ts", "export const changed = true\n")

    const diff = await owners(root, ["--diff", "HEAD"])
    expect(diff.touched_paths.map((entry) => [entry.path, entry.package])).toEqual([
      ["tagged/CACHEDIR.TAG", "//"],
      ["tagged/a.ts", "//"]
    ])
    expect(diff.required_approvers).toEqual(["rooty"])
    // The checkout lost the tag, so its own discovery finds the package.
    expect((await owners(root, ["tagged/a.ts"])).required_approvers).toEqual(["tagger"])
  })
})

describe("the declaration inventory a base revision held", () => {
  const checkout: PackageDiscovery.Discovery = {
    root: "/workspace",
    workspaceFile: ".smithers/WORKSPACE.ts",
    packageFiles: [],
    cacheDirectory: ".flows",
    repositories: [],
    pruned: [],
    directories: 0
  }
  const files = [
    ".smithers/FACTORY.ts",
    ".smithers/WORKSPACE.ts",
    "PACKAGE.ts",
    "a/PACKAGE.vibe",
    "a/dist/PACKAGE.ts",
    "a/node_modules/x/PACKAGE.ts",
    "cache/PACKAGE.ts",
    ".flows/store/PACKAGE.ts",
    "child/PACKAGE.ts",
    "clone/.git",
    "clone/deep/PACKAGE.ts",
    "skip/me/PACKAGE.ts",
    "skip/meet/PACKAGE.ts",
    "target/CACHEDIR.TAG",
    "target/PACKAGE.ts",
    "work/.jj/repo/store",
    "work/PACKAGE.ts",
    "z/package.ts"
  ]

  it("applies the base's boundaries and markers to the base's files", () => {
    const base = PackageDiscovery.discoverAt(checkout, files, {
      cacheDirectory: "cache",
      repositories: { zed: { path: "child" }, alpha: { path: "absent" } },
      prune: ["skip/me", "nowhere"]
    })
    expect(base).toEqual({
      root: "/workspace",
      workspaceFile: ".smithers/WORKSPACE.ts",
      factoryFile: ".smithers/FACTORY.ts",
      packageFiles: ["PACKAGE.ts", "a/PACKAGE.vibe", "skip/meet/PACKAGE.ts"],
      cacheDirectory: "cache",
      repositories: [{ name: "alpha", path: "absent" }, { name: "zed", path: "child" }],
      pruned: ["clone", "skip/me", "target", "work"],
      directories: 0
    })
  })

  it("defaults the cache directory, and declares no factory the base lacks", () => {
    const base = PackageDiscovery.discoverAt(checkout, [".smithers/WORKSPACE.ts", ".flows/PACKAGE.ts", "b/PACKAGE.ts"])
    expect(base.cacheDirectory).toBe(".flows")
    expect(base.factoryFile).toBeUndefined()
    expect(base.packageFiles).toEqual(["b/PACKAGE.ts"])
  })

  it("keeps the file --workspace-file names, which no revision holds", () => {
    const given = { ...checkout, workspaceFile: "/elsewhere/WORKSPACE.ts" }
    const base = PackageDiscovery.discoverAt(given, ["WORKSPACE.ts", "FACTORY.ts", "PACKAGE.ts"])
    expect(base).toMatchObject({ workspaceFile: "/elsewhere/WORKSPACE.ts", packageFiles: ["PACKAGE.ts"] })
    expect(base.factoryFile).toBeUndefined()
  })

  it("refuses a base whose workspace declaration is another file", () => {
    // Both exist at the base, where `.smithers/` wins; the checkout reads the root fallback.
    expect(() =>
      PackageDiscovery.discoverAt({ ...checkout, workspaceFile: "WORKSPACE.ts" }, [
        ".smithers/WORKSPACE.ts",
        "WORKSPACE.ts"
      ])
    ).toThrow("the base revision holds no workspace declaration at WORKSPACE.ts")
  })

  it("refuses a directory the base declared twice", () => {
    expect(() => PackageDiscovery.discoverAt(checkout, [".smithers/WORKSPACE.ts", "a/PACKAGE.ts", "a/PACKAGE.vibe"]))
      .toThrow("a/PACKAGE.ts and a/PACKAGE.vibe both declare //a; keep one of them")
    expect(() => PackageDiscovery.discoverAt(checkout, [".smithers/WORKSPACE.ts", "PACKAGE.ts", "PACKAGE.vibe"]))
      .toThrow("PACKAGE.ts and PACKAGE.vibe both declare //; keep one of them")
  })
})

describe("the files a base revision held", () => {
  it("lists a Git base's files, and no file added since", async () => {
    const root = await fixture()
    commit.git(root)
    await write(root, "data/CACHEDIR.TAG", "")
    await Fs.rm(NodePath.join(root, "lib/query.sql"))
    const files = await Affected.baseFiles(root, { base: "HEAD" })
    expect(files).toContain("lib/query.sql")
    expect(files).toContain("data/PACKAGE.ts")
    expect(files).not.toContain("data/CACHEDIR.TAG")
  })

  it("leaves out a submodule, which is another checkout", async () => {
    const root = await fixture()
    const child = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-owners-child-")))
    temporaryDirectories.push(child)
    await write(child, "a.ts", "export {}\n")
    commit.git(child)
    git(root, "init", "-q")
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    const files = await Affected.baseFiles(root, { base: "HEAD" })
    expect(files).toContain(".gitmodules")
    expect(files.filter((file) => file === "sub" || file.startsWith("sub/"))).toEqual([])
  })

  it.skipIf(!hasJj)("lists a Jujutsu base's files, whatever the name holds", async () => {
    const root = await fixture()
    const odd = process.platform === "win32" ? "lib/odd name.ts" : "lib/odd \"*\" name.ts"
    await write(root, odd, "export const odd = 1\n")
    commit.jj(root)
    await write(root, "data/CACHEDIR.TAG", "")
    const files = await Affected.baseFiles(root, { base: "HEAD" })
    expect(files).toContain(odd)
    expect(files).toContain("data/PACKAGE.ts")
    expect(files).not.toContain("data/CACHEDIR.TAG")
  })
})

describe("owners --diff base declarations", () => {
  it("reads every changed module a declaration imports as the base held it", async () => {
    const root = await fixture()
    commit.git(root)
    await write(root, "lib/team.ts", "export const team: ReadonlyArray<string> = [\"mallory\"]\n")
    await write(root, "lib/policy.mjs", "export const policy = { deny: [] }\n")
    await write(root, "lib/extra.json", "{ \"owners\": [\"eve\"] }\n")

    const diff = await owners(root, ["--diff", "HEAD", "lib/migrations/001.sql"])
    expect(diff.required_approvers).toEqual(["libby", "rooty", "team:platform"])
    expect(policies(diff)["lib/migrations/001.sql"]).toBe("deny")
    const lookup = await owners(root, ["lib/migrations/001.sql"])
    expect(lookup.required_approvers).toEqual(["eve", "mallory", "rooty"])
    expect(policies(lookup)).toEqual({ "lib/migrations/001.sql": "human-approve" })
  })

  it("keeps a package whose declaration the change deletes, with the helper it imported", async () => {
    const root = await fixture()
    commit.git(root)
    await Fs.rm(NodePath.join(root, "data/PACKAGE.ts"))
    await write(root, "data/load.ts", "export const changed = true\n")
    await Fs.rm(NodePath.join(root, "lib/team.ts"))
    await write(root, "lib/PACKAGE.ts", packageOwnedBy("mallory"))

    const diff = await owners(root, ["--diff", "HEAD"])
    const packages = Object.fromEntries(diff.touched_paths.map((entry) => [entry.path, entry.package]))
    expect(packages).toEqual({
      "data/PACKAGE.ts": "//data",
      "data/load.ts": "//data",
      "lib/PACKAGE.ts": "//lib",
      "lib/team.ts": "//lib"
    })
    // //data set `noparent`, so only its own base owner answers for it.
    expect(diff.required_approvers).toEqual(["dan", "libby", "rooty", "team:platform"])
    expect((await owners(root, ["data/load.ts"])).required_approvers).toEqual(["rooty"])
  })

  it("leaves out a package the change adds, and one discovery never entered", async () => {
    const root = await fixture()
    commit.git(root)
    await write(root, "fresh/PACKAGE.ts", packageOwnedBy("newbie", ", noparent: true"))
    await write(root, "fresh/a.ts", "export {}\n")
    await write(root, "vendor/PACKAGE.ts", packageOwnedBy("vendored-again"))

    const diff = await owners(root, ["--diff", "HEAD"])
    expect(diff.touched_paths.map((entry) => [entry.path, entry.package])).toEqual([
      ["fresh/PACKAGE.ts", "//"],
      ["fresh/a.ts", "//"],
      ["vendor/PACKAGE.ts", "//"]
    ])
    expect(diff.required_approvers).toEqual(["rooty"])
    expect((await owners(root, ["fresh/a.ts"])).required_approvers).toEqual(["newbie"])
  })

  it("fails when an import resolves to a module the base did not hold", async () => {
    const root = await fixture()
    await write(root, "lib/team.js", "export const team = [\"libby\"]\n")
    await Fs.rm(NodePath.join(root, "lib/team.ts"))
    commit.git(root)
    // The same specifier now names a TypeScript module the base never held.
    await Fs.rm(NodePath.join(root, "lib/team.js"))
    await write(root, "lib/team.ts", "export const team: ReadonlyArray<string> = [\"mallory\"]\n")

    const result = await serve(root, ["owners", "--diff", "HEAD", "--format", "json"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.output)).toMatchObject({ code: "owners_failed" })
    expect(result.output).toContain("changed since the revision, which holds no module there")
    expect((await owners(root, ["lib/query.sql"])).required_approvers).toEqual(["mallory", "rooty", "team:platform"])
  })

  it("fails when the base holds no workspace declaration where the checkout has one", async () => {
    const root = await fixture()
    commit.git(root)
    await Fs.mkdir(NodePath.join(root, ".smithers"))
    await Fs.rename(NodePath.join(root, "WORKSPACE.ts"), NodePath.join(root, ".smithers/WORKSPACE.ts"))

    const result = await serve(root, ["owners", "--diff", "HEAD", "--format", "json"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.output)).toEqual({
      code: "owners_failed",
      message:
        "module_import_failed: the base revision holds no workspace declaration at .smithers/WORKSPACE.ts [.smithers/WORKSPACE.ts]"
    })
  })
})

describe("the text a base revision held", () => {
  it("asks Git nothing for no paths, and holds only the files the base has", async () => {
    const root = await fixture()
    expect(await Affected.baseTexts(root, { base: "HEAD", paths: [] })).toEqual(new Map())
    commit.git(root)
    await write(root, "lib/query.sql", "select 2;\n")
    const texts = await Affected.baseTexts(root, {
      base: "HEAD",
      // A file, a directory, and a name the base never held.
      paths: ["lib/query.sql", "lib/migrations", "lib/absent.ts"]
    })
    expect([...texts]).toEqual([["lib/query.sql", "select 1;\n"]])
  })

  it.skipIf(!hasJj)("reads a Jujutsu base by exact path, whatever the name holds", async () => {
    const root = await fixture()
    const odd = process.platform === "win32" ? "lib/odd name.ts" : "lib/odd \"*\" name.ts"
    await write(root, odd, "export const odd = 1\n")
    commit.jj(root)
    await write(root, odd, "export const odd = 2\n")
    const texts = await Affected.baseTexts(root, { base: "HEAD", paths: [odd, "lib/absent.ts"] })
    expect([...texts]).toEqual([[odd, "export const odd = 1\n"]])
  })
})
