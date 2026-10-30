import { Smithers as S } from "@smthrs/targets"
import ignore from "ignore"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import * as Owners from "../src/Owners.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

it("maps an absolute workspace path to its owners and rejects absolute paths outside the workspace", async () => {
  const root = await fixture()
  expect(await ownersJson(root, [NodePath.join(root, "lib/query.sql")])).toEqual(
    await ownersJson(root, ["lib/query.sql"])
  )
  for (
    const path of [NodePath.join(root, "..", "outside.sql"), `${root}-sibling/lib/query.sql`, "C:\\outside\\file.sql"]
  ) {
    const result = await serve(root, ["owners", path, "--format", "json"])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("outside the workspace")
  }
})

it("refuses empty and parent-relative owners paths through the command", async () => {
  const root = await fixture()
  for (const path of [".", "./", "lib/../query.sql", "../query.sql", root]) {
    const result = await serve(root, ["owners", path, "--format", "json"])
    expect(result.exitCode, path).toBe(1)
    expect(JSON.parse(result.output)).toEqual({
      code: "owners_failed",
      message: `owners paths must be workspace-relative: ${JSON.stringify(path)}`
    })
  }
})

const workspaceModule = (teams: string) =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  owners: { owners: ["team:platform"], agents: { default: "human-approve", "auto-land": ["*.md"] } },
  teams: S.Teams(${teams}),
})
`

const rootPackage = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({
  owners: { owners: ["team:platform"] },
  targets: {
    codeowners: S.Owners.Codeowners({ org: "acme" }),
    ownersTree: S.Owners.Tree({}),
    run: S.Shell.Run({ shell: "echo hi" }),
  },
})
`

const libPackage = `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["**"]) })
export const Package = S.Package({
  owners: {
    owners: ["libby"],
    perFile: { "*.sql": ["team:data"] },
    agents: { deny: ["migrations/**"] },
  },
  targets: { srcs },
})
`

const innerPackage = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { srcs: S.Filegroup({ srcs: S.glob(["**"]) }) } })
`

const appPackage = `import { Smithers as S } from "@smthrs/targets"
import { Package as lib } from "../lib/PACKAGE.ts"
const build = S.Shell.Test({ shell: "echo build", data: [lib.srcs] })
export const Package = S.Package({
  owners: { owners: ["appy"], upstream: "review" },
  targets: { build },
})
`

const dataPackage = `import { Smithers as S } from "@smthrs/targets"
import { Package as lib } from "../lib/PACKAGE.ts"
const build = S.Shell.Test({ shell: "echo build", data: [lib.srcs] })
export const Package = S.Package({
  owners: { owners: ["dan"], noparent: true, upstream: { mode: "approve", packages: ["//lib"] } },
  targets: { build },
})
`

const fixture = async (teams = `{ platform: ["will"], data: ["chungyi"] }`): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-owners-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "fixture", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, "WORKSPACE.ts", workspaceModule(teams))
  await write(root, "PACKAGE.ts", rootPackage)
  await write(root, "README.md", "# fixture\n")
  await write(root, "lib/PACKAGE.ts", libPackage)
  await write(root, "lib/index.ts", "export const one = 1\n")
  await write(root, "lib/query.sql", "select 1;\n")
  await write(root, "lib/migrations/001.sql", "create table t (id int);\n")
  await write(root, "lib/inner/PACKAGE.ts", innerPackage)
  await write(root, "lib/inner/deep.ts", "export const deep = true\n")
  await write(root, "app/PACKAGE.ts", appPackage)
  await write(root, "app/main.ts", "export {}\n")
  await write(root, "data/PACKAGE.ts", dataPackage)
  await write(root, "data/load.ts", "export {}\n")
  return root
}

const ownersJson = async (root: string, args: ReadonlyArray<string>) => {
  const result = await serve(root, ["owners", ...args, "--format", "json"])
  expect(result.exitCode, result.output).toBe(0)
  return JSON.parse(result.output) as {
    readonly touched_paths: ReadonlyArray<{
      readonly path: string
      readonly package: string
      readonly owners: ReadonlyArray<{
        readonly login?: string
        readonly team?: string
        readonly role: string
        readonly reasons: ReadonlyArray<string>
      }>
      readonly agent_policy: string
      readonly packages: ReadonlyArray<string>
    }>
    readonly required_approvers: ReadonlyArray<string>
    readonly suggested_reviewers: ReadonlyArray<string>
  }
}

describe("owners resolution", () => {
  it("resolves direct, per-file, inherited, and upstream owners with reasons", async () => {
    const root = await fixture()
    const result = await ownersJson(root, ["lib/query.sql"])
    expect(result.touched_paths).toHaveLength(1)
    const entry = result.touched_paths[0]!
    expect(entry.package).toBe("//lib")
    expect(entry.agent_policy).toBe("human-approve")
    expect(entry.packages).toEqual(["//app", "//data", "//lib"])
    expect(entry.owners).toEqual([
      { login: "appy", role: "review", reasons: ["upstream-of //app"] },
      { login: "dan", role: "approve", reasons: ["upstream-of //data"] },
      { login: "libby", role: "approve", reasons: ["direct"] },
      { team: "data", role: "approve", reasons: ["per-file *.sql"] },
      { team: "platform", role: "approve", reasons: ["inherited from //", "upstream-of //app"] }
    ])
    expect(result.required_approvers).toEqual(["dan", "libby", "team:data", "team:platform"])
    expect(result.suggested_reviewers).toEqual(["appy"])
  })

  it("applies the nearest agent policy override and inherits through undeclared packages", async () => {
    const root = await fixture()
    const denied = await ownersJson(root, ["lib/migrations/001.sql"])
    expect(denied.touched_paths[0]!.agent_policy).toBe("deny")
    // //lib/inner lists its own srcs, which nothing depends on, so neither
    // upstream claim reaches it; inheritance still does.
    const inner = await ownersJson(root, ["lib/inner/deep.ts"])
    expect(inner.touched_paths[0]!.package).toBe("//lib/inner")
    expect(inner.touched_paths[0]!.owners.map((owner) => owner.login ?? `team:${owner.team}`)).toEqual([
      "libby",
      "team:platform"
    ])
    expect(inner.touched_paths[0]!.owners.find((owner) => owner.login === "libby")?.reasons).toEqual([
      "inherited from //lib"
    ])
    const readme = await ownersJson(root, ["README.md"])
    expect(readme.touched_paths[0]!.package).toBe("//")
    expect(readme.touched_paths[0]!.agent_policy).toBe("auto-land")
    expect(readme.touched_paths[0]!.owners).toEqual([{ team: "platform", role: "approve", reasons: ["direct"] }])
  })

  it("stops inheritance at noparent and bounds an upstream claim to the named packages", async () => {
    const root = await fixture()
    const data = await ownersJson(root, ["data/load.ts"])
    expect(data.touched_paths[0]!.owners).toEqual([{ login: "dan", role: "approve", reasons: ["direct"] }])
    // Both claimants depend on //lib:srcs; //data's claim is bounded to //lib
    // and //app's is not, and both reach a file of //lib.
    const lib = await ownersJson(root, ["lib/index.ts"])
    expect(lib.touched_paths[0]!.owners.find((owner) => owner.login === "dan")?.role).toBe("approve")
    expect(lib.touched_paths[0]!.owners.find((owner) => owner.login === "appy")?.role).toBe("review")
  })

  it("refuses a team the workspace roster does not declare", async () => {
    const root = await fixture(`{ platform: ["will"] }`)
    const result = await serve(root, ["owners", "lib/query.sql"])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("team:data")
    expect(result.output).toContain("roster")
  })

  it("answers rdeps() and owners() queries", async () => {
    const root = await fixture()
    const dependents = await serve(root, ["query", "rdeps(//lib:srcs)", "--format", "json"])
    expect(dependents.exitCode, dependents.output).toBe(0)
    expect(JSON.parse(dependents.output).dependents).toEqual(["//app:build", "//data:build"])
    const owners = await serve(root, ["query", "owners(//lib:srcs)", "--format", "json"])
    expect(owners.exitCode, owners.output).toBe(0)
    const parsed = JSON.parse(owners.output)
    expect(parsed.package).toBe("//lib")
    expect(parsed.owners.map((entry: { owner: string }) => entry.owner)).toEqual(["libby", "team:platform"])
    const upstream = await serve(root, ["query", "owners(//app:build)", "--format", "json"])
    expect(JSON.parse(upstream.output).upstream).toEqual(["//lib"])
    const text = await serve(root, ["query", "owners(//lib:srcs)"])
    expect(text.output).toContain("libby")
    expect(text.output).toContain("inherited from //")
  })

  it("renders CODEOWNERS and the OWNERS tree, checks drift, and writes on --write", async () => {
    const root = await fixture()
    const drift = await serve(root, ["lint", "//:codeowners"])
    expect(drift.exitCode).toBe(1)
    expect(drift.logs).toContain("drift in declared emit outputs")
    const written = await serve(root, ["//:codeowners", "--write"])
    expect(written.exitCode, written.output).toBe(0)
    const codeowners = await Fs.readFile(NodePath.join(root, ".github", "CODEOWNERS"), "utf8")
    expect(codeowners).toContain("* @acme/platform\n")
    expect(codeowners).toContain("/lib/ @dan @libby @acme/platform\n")
    expect(codeowners).toContain("/lib/**/*.sql @dan @libby @acme/data @acme/platform\n")
    expect(codeowners).toContain("/data/ @dan\n")
    // A review claim has no CODEOWNERS form: appy owns /app/ but never joins the /lib/ line.
    expect(codeowners).toContain("/app/ @appy @acme/platform\n")
    const clean = await serve(root, ["lint", "//:codeowners"])
    expect(clean.exitCode, clean.output).toBe(0)

    const treeWritten = await serve(root, ["//:ownersTree", "--write"])
    expect(treeWritten.exitCode, treeWritten.output).toBe(0)
    const rootOwners = await Fs.readFile(NodePath.join(root, "OWNERS"), "utf8")
    expect(rootOwners).toContain("team:platform\n")
    const libOwners = await Fs.readFile(NodePath.join(root, "lib", "OWNERS"), "utf8")
    expect(libOwners).toBe(
      [
        "# Generated by smithers-build from lib/PACKAGE.ts owners. Do not edit.",
        "libby",
        "per-file *.sql = team:data",
        "agents: human-approve",
        "agents: deny migrations/**",
        "reviewers: appy, team:platform  # upstream-of //app",
        "dan  # upstream-of //data",
        ""
      ].join("\n")
    )
    const dataOwners = await Fs.readFile(NodePath.join(root, "data", "OWNERS"), "utf8")
    expect(dataOwners).toContain("set noparent\n")
    await expect(Fs.access(NodePath.join(root, "lib", "inner", "OWNERS"))).rejects.toThrow()
    const treeClean = await serve(root, ["lint", "//:ownersTree"])
    expect(treeClean.exitCode, treeClean.output).toBe(0)
  })

  it("resolves the paths a diff touches", async () => {
    const root = await fixture()
    // runGit refuses a workspace without its own .git, so create the repository directly.
    NodeChildProcess.execFileSync("git", ["init", "-q", root])
    await PackageTree.runGit(root, ["add", "-A"])
    await PackageTree.runGit(root, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-q",
      "-m",
      "base"
    ])
    await write(root, "lib/query.sql", "select 2;\n")
    const result = await ownersJson(root, ["--diff", "HEAD"])
    expect(result.touched_paths.map((entry) => entry.path)).toEqual(["lib/query.sql"])
    expect(result.required_approvers).toContain("libby")
  })
})

const renderingIndex = (
  packages: ReadonlyArray<{ readonly packagePath: string; readonly value: ReturnType<typeof S.Package> }>,
  workspaceOwners: ReadonlyArray<string> = []
): PackageIndex => {
  const packageJson = S.file("//package.json")
  return PackageIndex.make({
    root: process.cwd(),
    factory: undefined,
    workspace: S.Workspace("rendering", {
      owners: { owners: workspaceOwners },
      repository: "git+https://example.invalid/rendering.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: "26" }),
      packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
      nodeModules: S.Npm.NodeModules({ packageJson })
    }),
    packages: packages.map((entry) => ({
      ...entry,
      file: entry.packagePath === "" ? "PACKAGE.ts" : `${entry.packagePath}/PACKAGE.ts`
    }))
  })
}

// Evaluate each positive CODEOWNERS pattern independently using gitignore
// semantics, retaining only the owners on the last matching line.
const generatedOwners = (rendered: string, path: string): ReadonlyArray<string> => {
  let owners: Array<string> = []
  for (const line of rendered.split("\n")) {
    if (line === "" || line.startsWith("#")) continue
    const [pattern, ...handles] = line.trim().split(/\s+/)
    if (ignore().add(pattern!).ignores(path)) owners = handles.map((handle) => handle.slice(1))
  }
  return owners.sort()
}

describe("ownership renderer projections", () => {
  const nestedIndex = () =>
    renderingIndex([
      {
        packagePath: "",
        value: S.Package({
          owners: {
            owners: ["base"],
            perFile: { "*.sql": ["security"], "nested/migrations/**": ["migration-owner"] }
          },
          targets: {}
        })
      },
      {
        packagePath: "nested",
        value: S.Package({
          owners: {
            owners: ["nested-owner"],
            perFile: { "schema.*": ["schema-owner"], "migrations/**": ["child-migrations"] }
          },
          targets: {}
        })
      },
      { packagePath: "nested/inner", value: S.Package({ targets: {} }) },
      {
        packagePath: "nested/isolated",
        value: S.Package({
          owners: {
            owners: ["isolated-owner"],
            noparent: true,
            perFile: { "*.sql": ["isolated-sql"] }
          },
          targets: {}
        })
      },
      {
        packagePath: "nested/unowned",
        value: S.Package({
          owners: {
            owners: [],
            noparent: true,
            perFile: { "*.md": ["unowned-md"] }
          },
          targets: {}
        })
      },
      { packagePath: "sibling", value: S.Package({ owners: { owners: ["sibling-owner"] }, targets: {} }) }
    ])

  it("resolves a path with dot or empty segments to the package it names", () => {
    const index = nestedIndex()
    const spelled = Owners.resolve(index, ["nested/./isolated//schema.sql", "./nested/isolated/schema.sql"])
    expect(spelled.touchedPaths.map((entry) => [entry.path, entry.package])).toEqual([
      ["nested/isolated/schema.sql", "//nested/isolated"]
    ])
    expect(spelled.requiredApprovers).toEqual(Owners.resolve(index, ["nested/isolated/schema.sql"]).requiredApprovers)
  })

  it.each([
    "nested/query.sql",
    "nested/inner/query.sql",
    "nested/schema.sql",
    "nested/schema.ts",
    "nested/migrations/001.sql",
    "nested/migrations/notes.md",
    "nested/isolated/schema.sql",
    "nested/isolated/notes.md",
    "nested/unowned/schema.sql",
    "sibling/query.sql",
    "sibling/notes.md"
  ])("keeps last-match CODEOWNERS equal to resolve for %s", (path) => {
    const index = nestedIndex()
    expect(generatedOwners(Owners.renderCodeowners(index, "acme"), path))
      .toEqual(Owners.resolve(index, [path]).requiredApprovers)
  })

  it.each([
    ["a*.sql", "*b.sql"],
    ["schema.*", "*.sql"],
    ["**/migrations/*.sql", "migrations/**"],
    ["**/a/**", "**/b/**"],
    ["?.sql", "a*.sql"],
    ["a*.sql", "?.sql"],
    ["*/a.sql", "a.sql"],
    ["nested/a/*.sql", "*/a.sql"],
    ["**/**/a.sql", "*.sql"],
    ["*.sql", "*.sql"]
  ])("unions overlapping %s and %s without assigning owners outside their matches", (ancestor, child) => {
    const index = renderingIndex([
      {
        packagePath: "",
        value: S.Package({
          owners: {
            owners: ["base"],
            perFile: { [ancestor]: ["ancestor"] }
          },
          targets: {}
        })
      },
      {
        packagePath: "nested",
        value: S.Package({
          owners: {
            owners: ["nested"],
            perFile: { [child]: ["child"] }
          },
          targets: {}
        })
      }
    ])
    const rendered = Owners.renderCodeowners(index, "acme")
    for (const directory of ["", "migrations/", "deep/migrations/", "a/b/", "b/a/", "a/", "b/"]) {
      for (const file of ["a.sql", "ab.sql", "xb.sql", "schema.sql", "schema.ts", "notes.md"]) {
        const path = `nested/${directory}${file}`
        expect(generatedOwners(rendered, path), path).toEqual(Owners.resolve(index, [path]).requiredApprovers)
      }
    }
  })

  it("uses workspace fallback only when no package or per-file owner is declared", () => {
    const index = renderingIndex([
      {
        packagePath: "",
        value: S.Package({
          owners: {
            perFile: { "*.sql": ["security"] }
          },
          targets: {}
        })
      },
      { packagePath: "nested", value: S.Package({ targets: {} }) }
    ], ["workspace-owner"])
    const rendered = Owners.renderCodeowners(index, "acme")
    for (const path of ["nested/query.sql", "nested/notes.md"]) {
      expect(generatedOwners(rendered, path)).toEqual(Owners.resolve(index, [path]).requiredApprovers)
    }
    expect(Owners.text(Owners.resolve(index, ["nested/notes.md"]))).toContain(
      `  ${"workspace-owner".padEnd(24)}  approve  workspace\n`
    )
  })

  it.each(["renderCodeowners", "renderOwnersTree"] as const)(
    "%s computes each claimant closure once per call",
    (renderer) => {
      const packages: Array<{ packagePath: string; value: ReturnType<typeof S.Package> }> = []
      let previous = S.Filegroup({ srcs: [] })
      for (let i = 0; i < 24; i++) {
        const target = S.Filegroup({ srcs: i === 0 ? [] : [previous] })
        packages.push({
          packagePath: `p${i}`,
          value: S.Package({
            owners: { owners: [`owner${i}`], ...(i % 6 === 0 ? { upstream: "approve" as const } : {}) },
            targets: { files: target }
          })
        })
        previous = target
      }
      const index = renderingIndex(packages)
      const scans = vi.spyOn(index, "targets")
      try {
        const first = Owners[renderer](index, "acme")
        expect(scans).toHaveBeenCalledTimes(4)
        expect(Owners[renderer](index, "acme")).toEqual(first)
        expect(scans).toHaveBeenCalledTimes(8)
        if (typeof first === "string") {
          expect(generatedOwners(first, "p0/file.ts")).toEqual(["owner0", "owner12", "owner18", "owner6"])
        } else {
          const content = first.find((file) => file.path === "p0/acme")!.content
          for (const claimant of [6, 12, 18]) {
            expect(content).toContain(`owner${claimant}  # upstream-of //p${claimant}`)
          }
        }
      } finally {
        scans.mockRestore()
      }
    }
  )
})

describe("bounded upstream claims", () => {
  const claimsIndex = () => {
    const core = S.Filegroup({ srcs: [] })
    const sub = S.Filegroup({ srcs: [core] })
    const other = S.Filegroup({ srcs: [] })
    return renderingIndex([
      { packagePath: "", value: S.Package({ targets: {} }) },
      {
        packagePath: "core",
        value: S.Package({ owners: { owners: ["core-owner"], perFile: { "*.ts": ["core-owner"] } }, targets: { core } })
      },
      { packagePath: "core/sub", value: S.Package({ owners: { owners: ["sub-owner"] }, targets: { sub } }) },
      { packagePath: "other", value: S.Package({ owners: { owners: ["other-owner"] }, targets: { other } }) },
      {
        packagePath: "bounded",
        value: S.Package({
          owners: { owners: ["bound-owner"], upstream: { mode: "approve", packages: ["//core/..."] } },
          // //core is reached twice: directly and through //core/sub.
          targets: { all: S.Filegroup({ srcs: [core, sub, other] }) }
        })
      },
      {
        packagePath: "a-review",
        value: S.Package({
          owners: { owners: ["shared", "watcher"], upstream: { mode: "review", packages: ["//..."] } },
          targets: { uses: S.Filegroup({ srcs: [other] }) }
        })
      },
      {
        packagePath: "b-approve",
        value: S.Package({
          owners: { owners: ["shared"], upstream: "approve" },
          targets: { uses: S.Filegroup({ srcs: [other] }) }
        })
      },
      {
        packagePath: "silent",
        value: S.Package({
          owners: { owners: [], upstream: "review" },
          targets: { uses: S.Filegroup({ srcs: [other] }) }
        })
      }
    ])
  }

  it("applies a subtree-bounded claim to the subtree only and lets approve outrank review", () => {
    const index = claimsIndex()
    const resolution = Owners.resolve(index, ["other/x.ts", "core/sub/x.ts", "core/x.ts", "core"])
    const byPath = new Map(resolution.touchedPaths.map((entry) => [entry.path, entry]))
    expect(byPath.get("other/x.ts")!.owners).toEqual([
      { owner: "other-owner", role: "approve", reasons: [{ kind: "direct" }] },
      {
        owner: "shared",
        role: "approve",
        reasons: [{ kind: "upstream-of", label: "//a-review" }, { kind: "upstream-of", label: "//b-approve" }]
      },
      { owner: "watcher", role: "review", reasons: [{ kind: "upstream-of", label: "//a-review" }] }
    ])
    expect(byPath.get("other/x.ts")!.packages).toEqual(["//a-review", "//b-approve", "//other", "//silent"])
    expect(byPath.get("core/x.ts")!.owners).toEqual([
      { owner: "bound-owner", role: "approve", reasons: [{ kind: "upstream-of", label: "//bounded" }] },
      { owner: "core-owner", role: "approve", reasons: [{ kind: "direct" }, { kind: "per-file", pattern: "*.ts" }] }
    ])
    expect(byPath.get("core/sub/x.ts")!.owners.map((entry) => entry.owner)).toEqual([
      "bound-owner",
      "core-owner",
      "sub-owner"
    ])
    // The package directory itself belongs to the package but matches no per-file rule.
    expect(byPath.get("core")!.package).toBe("//core")
    expect(byPath.get("core")!.owners).toEqual([
      { owner: "bound-owner", role: "approve", reasons: [{ kind: "upstream-of", label: "//bounded" }] },
      { owner: "core-owner", role: "approve", reasons: [{ kind: "direct" }] }
    ])
    expect(resolution.requiredApprovers).toEqual(["bound-owner", "core-owner", "other-owner", "shared", "sub-owner"])
    expect(resolution.suggestedReviewers).toEqual(["watcher"])
  })

  it("keeps a bounded claim out of CODEOWNERS and OWNERS for packages outside its bounds", () => {
    const index = claimsIndex()
    const codeowners = Owners.renderCodeowners(index, "acme")
    expect(codeowners).toContain("/core/ @bound-owner @core-owner\n")
    expect(codeowners).toContain("/other/ @other-owner @shared\n")
    const tree = new Map(Owners.renderOwnersTree(index).map((file) => [file.path, file.content]))
    // An undeclared root takes the workspace declaration, here empty.
    expect(tree.get("OWNERS")).toBe("# Generated by smithers-build from PACKAGE.ts owners. Do not edit.\n")
    expect(tree.get("core/OWNERS")).toContain("bound-owner  # upstream-of //bounded")
    // //silent claims //other but neither it, the root, nor the workspace names an owner.
    expect(tree.get("other/OWNERS")).toBe(
      [
        "# Generated by smithers-build from other/PACKAGE.ts owners. Do not edit.",
        "other-owner",
        "reviewers: shared, watcher  # upstream-of //a-review",
        "shared  # upstream-of //b-approve",
        ""
      ].join("\n")
    )
  })

  it("renders paths without owners and an empty resolution as text", () => {
    const index = claimsIndex()
    expect(Owners.text(Owners.resolve(index, []))).toBe("no paths")
    expect(Owners.text(Owners.resolve(index, ["other/x.ts"]))).toBe(
      [
        "other/x.ts  //other  agents: human-approve",
        `  ${"other-owner".padEnd(24)}  approve  direct`,
        `  ${"shared".padEnd(24)}  approve  upstream-of //a-review, upstream-of //b-approve`,
        `  ${"watcher".padEnd(24)}  review  upstream-of //a-review`,
        "",
        "required approvers  other-owner shared",
        "suggested reviewers watcher"
      ].join("\n")
    )
    expect(Owners.text(Owners.resolve(index, ["silent/x.ts"]))).toBe(
      [
        "silent/x.ts  //silent  agents: human-approve",
        "  no owners",
        "",
        "required approvers  none",
        "suggested reviewers none"
      ].join("\n")
    )
  })
})

describe("rdeps", () => {
  it("finds transitive dependents, walks shared dependencies once, and needs one target", () => {
    const root = S.Filegroup({ srcs: [] })
    const direct = S.Filegroup({ srcs: [root] })
    const shared = S.Filegroup({ srcs: [] })
    const index = renderingIndex([
      { packagePath: "r", value: S.Package({ targets: { files: root } }) },
      { packagePath: "b", value: S.Package({ targets: { files: direct } }) },
      { packagePath: "y", value: S.Package({ targets: { files: S.Filegroup({ srcs: [direct] }) } }) },
      {
        packagePath: "x",
        value: S.Package({
          targets: {
            files: S.Filegroup({ srcs: [S.Filegroup({ srcs: [shared] }), S.Filegroup({ srcs: [shared] })] })
          }
        })
      },
      { packagePath: "d", value: S.Package({ targets: { files: shared } }) }
    ])
    expect(Owners.rdeps(index, "//r:files")).toEqual(["//b:files", "//y:files"])
    expect(Owners.rdeps(index, "//d:files")).toEqual(["//x:files"])
    expect(() => Owners.rdeps(index, "//...")).toThrow("rdeps() requires one exact or default target")
  })
})
