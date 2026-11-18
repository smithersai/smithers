/**
 * `--workspace-file`: the workspace declaration read from a plain workspace
 * file that may lie outside the workspace, so a replayed checkout holds only
 * the repository's own files and the cache directory.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import { findPackageJSON } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { isPackageError } from "../src/PackageError.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

/** The `@smthrs/targets` installation this CLI runs with. */
const targetsPackage = NodePath.dirname(findPackageJSON("@smthrs/targets", import.meta.url)!)

const workspaceText = `import { Smithers as S } from "@smthrs/targets"
import { check } from "./check.mjs"

export const Workspace = S.Workspace("outside", {
  repository: "git+https://example.invalid/outside.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] })
})

const test = S.Shell.Test({ shell: check, data: [S.file("a.txt"), S.file("test.sh")] })

export const Package = S.Package({ targets: { test } })
`

/**
 * A declaration directory outside every workspace: the file, the sibling it
 * imports, and a `node_modules/@smthrs/targets` link to the CLI's own copy,
 * as a replay lays them out.
 */
const declaration = async (name = "ws.smithers", text = workspaceText): Promise<string> => {
  const directory = await temporary("smthrs-workspace-file-")
  await write(directory, name, text)
  await write(directory, "check.mjs", "export const check = \"sh test.sh\"\n")
  await Fs.mkdir(NodePath.join(directory, "node_modules", "@smthrs"), { recursive: true })
  await Fs.symlink(targetsPackage, NodePath.join(directory, "node_modules", "@smthrs", "targets"), "dir")
  return NodePath.join(directory, name)
}

/** A git repository holding only `a.txt` and `test.sh`, committed, plus any extra files. */
const repository = async (extra: Readonly<Record<string, string>> = {}): Promise<string> => {
  const root = await temporary("smthrs-workspace-file-repo-")
  await write(root, "a.txt", "a\n")
  await write(root, "test.sh", "grep -q a a.txt\n")
  for (const [path, text] of Object.entries(extra)) await write(root, path, text)
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

/** The routing code and message a rejected call carries. */
const refusal = async (work: () => Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await work()
  } catch (cause) {
    if (isPackageError(cause)) return { code: cause.code, message: cause.message }
    throw cause
  }
  throw new Error("nothing was refused")
}

const ci = (root: string, file: string, ...flags: ReadonlyArray<string>) =>
  serve(root, ["ci", "//...", "--workspace-file", file, "--cache-dir", ".flows", ...flags])

describe("--workspace-file", () => {
  it("runs a repository from a declaration outside it and writes nothing but the cache", async () => {
    const root = await repository()
    const file = await declaration()
    const first = await ci(root, file)
    expect(first.exitCode, first.logs).toBe(0)
    expect(first.logs).toContain("//:test  ran")
    const second = await ci(root, file)
    expect(second.exitCode, second.logs).toBe(0)
    expect(second.logs).toContain("//:test  hit")
    expect(git(root, "status", "--porcelain")).toBe("?? .flows/\n")
  }, 300_000)

  it("runs a target on a machine whose copy holds nothing of the declaration", async () => {
    const root = await repository()
    const machines = await temporary("smthrs-workspace-file-machines-")
    // The step fails when its checkout holds anything git does not track, or the declaration.
    const clean =
      "git rev-parse --git-dir > /dev/null && test -z \"$(git status --porcelain --ignored)\" && test ! -e .smithers && sh test.sh"
    const file = await declaration(
      "ws.smithers",
      workspaceText.replace(
        "S.Shell.Test({ shell: check, data: [S.file(\"a.txt\"), S.file(\"test.sh\")] })",
        `S.Shell.Test({ shell: ${
          JSON.stringify(clean)
        }, machine: "job", sandbox: "none", data: [S.file("a.txt"), S.file("test.sh")] })`
      )
    )
    expect(await Fs.readFile(file, "utf8")).toContain("machine: \"job\"")
    const served = await serve(root, ["ci", "//...", "--workspace-file", file, "--cache-dir", ".flows"], {
      environment: { ...process.env, SMTHRS_MACHINES: machines }
    })
    expect(served.exitCode, served.logs + served.output).toBe(0)
    expect(served.logs).toContain("//:test  ran")
    expect(served.logs).toContain("smthrs: machine job has a fresh checkout")
    expect(git(root, "status", "--porcelain")).toBe("?? .flows/\n")
  }, 300_000)

  it("plans, queries and watches with the option", async () => {
    const root = await repository()
    const file = await declaration()
    const planned = await ci(root, file, "--plan")
    expect(planned.exitCode, planned.logs).toBe(0)
    expect(planned.output).toContain("- label: \"//:test\"")
    // A relative path resolves from the process working directory.
    const relative = NodePath.relative(process.cwd(), file)
    const queried = await serve(root, ["query", "//...", "--workspace-file", relative])
    expect(queried.exitCode, queried.logs).toBe(0)
    expect(queried.output).toContain("//:test")
    // The watch cycle is a new CLI process, which receives the option too.
    const watched = await serve(root, [
      "watch",
      "ci",
      "//...",
      "--once",
      "--plan",
      "--audience",
      "human",
      "--workspace-file",
      relative
    ])
    expect(watched.exitCode, watched.logs).toBe(0)
    expect(watched.logs).toContain("Watch cycle 1 complete")
    expect(watched.logs).toContain("//:test")
  }, 300_000)

  it("reads none of the workspace's own declarations", async () => {
    const own = `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("own", {
  repository: "git+https://example.invalid/own.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] })
})
const other = S.Shell.Test({ shell: "exit 1" })
export const Package = S.Package({ targets: { other } })
`
    const root = await repository({
      ".smithers/WORKSPACE.smithers": own,
      "WORKSPACE.ts": "throw new Error(\"the repository's own WORKSPACE.ts was evaluated\")\n"
    })
    const file = await declaration()
    const mine = await serve(root, ["query", "//..."])
    expect(mine.exitCode, mine.logs).toBe(0)
    expect(mine.output).toContain("//:other")
    const queried = await serve(root, ["query", "//...", "--workspace-file", file])
    expect(queried.exitCode, queried.logs).toBe(0)
    expect(queried.output).toContain("//:test")
    expect(queried.output).not.toContain("//:other")
    const run = await ci(root, file)
    expect(run.exitCode, run.logs).toBe(0)
    expect(run.logs).toContain("//:test  ran")
    expect(run.logs).not.toContain("//:other")
  }, 300_000)

  it("keys targets by the declaration's content, not its path", async () => {
    const root = await repository()
    const first = await ci(root, await declaration("ws.smithers"))
    expect(first.exitCode, first.logs).toBe(0)
    expect(first.logs).toContain("//:test  ran")
    // A byte-identical copy at another path, under another name.
    const copy = await ci(root, await declaration("WORKSPACE.smithers"))
    expect(copy.exitCode, copy.logs).toBe(0)
    expect(copy.logs).toContain("//:test  hit")
  }, 300_000)

  it("refuses a path that is not a regular file, naming it", async () => {
    const directory = await temporary("smthrs-workspace-file-refused-")
    const missing = NodePath.join(directory, "absent.smithers")
    expect(await refusal(() => PackageDiscovery.workspaceFileAt(missing))).toEqual({
      code: "module_missing",
      message: `module_missing: the workspace file does not exist [${missing}]`
    })
    expect(await refusal(() => PackageDiscovery.workspaceFileAt(directory))).toEqual({
      code: "module_not_regular",
      message: `module_not_regular: the workspace file is not a regular file [${directory}]`
    })
    const fifo = NodePath.join(directory, "fifo.smithers")
    NodeChildProcess.execFileSync("mkfifo", [fifo])
    expect(await refusal(() => PackageDiscovery.workspaceFileAt(fifo))).toEqual({
      code: "module_not_regular",
      message: `module_not_regular: the workspace file is not a regular file [${fifo}]`
    })
    const root = await repository()
    expect((await refusal(() => PackageDiscovery.discover(root, { workspaceFile: missing }))).code).toBe(
      "module_missing"
    )
    const served = await ci(root, missing)
    expect(served.exitCode).toBe(1)
    expect(served.output + served.logs).toContain(`the workspace file does not exist [${missing}]`)
    expect(git(root, "status", "--porcelain")).toBe("")
  }, 300_000)

  it("refuses a file with no Workspace export", async () => {
    const root = await repository()
    const file = await declaration("empty.smithers", "export const nothing = 1\n")
    const refused = await refusal(() => PackageLoader.loadWorkspaceDeclaration(root, file))
    expect(refused).toEqual({
      code: "workspace_export_missing",
      message: `workspace_export_missing: empty.smithers has no Workspace export [${file}]`
    })
    const served = await ci(root, file)
    expect(served.exitCode).toBe(1)
    expect(served.output + served.logs).toContain("empty.smithers has no Workspace export")
  }, 300_000)

  it("declares the root package: a root PACKAGE.ts beside it is a second //", async () => {
    const root = await repository({
      "PACKAGE.ts":
        "import { Smithers as S } from \"@smthrs/targets\"\nexport const Package = S.Package({ targets: {} })\n"
    })
    const file = await PackageDiscovery.workspaceFileAt(await declaration())
    const discovery = await PackageDiscovery.discover(root, { workspaceFile: file })
    expect(discovery.workspaceFile).toBe(file)
    expect(discovery.factoryFile).toBeUndefined()
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    const refused = await refusal(async () => PackageIndex.make(await PackageLoader.load(discovery)))
    expect(refused.code).toBe("duplicate_package_path")
    expect(refused.message).toContain(`${file} and PACKAGE.ts both declare //`)
  }, 300_000)

  it("settles the cache directory from the given file", async () => {
    const root = await repository()
    const file = await declaration()
    await expect(PackageLoader.probeCacheDirectory(root, file)).resolves.toBe(".flows")
  }, 300_000)

  it("is a declaration no Package module may import, when it lies inside the workspace", async () => {
    const root = await repository({
      "tools/ws.smithers": workspaceText.replace(/\nconst test[\s\S]*$/, "\n").replace(
        "import { check } from \"./check.mjs\"\n",
        ""
      ),
      "PACKAGE.ts":
        "import { Smithers as S } from \"@smthrs/targets\"\nimport \"./tools/ws.smithers\"\nexport const Package = S.Package({ targets: {} })\n"
    })
    const discovery = await PackageDiscovery.discover(root, { workspaceFile: NodePath.join(root, "tools/ws.smithers") })
    const refused = await refusal(() => PackageLoader.load(discovery))
    expect(refused.code).toBe("unsupported_module_specifier")
  }, 300_000)

  it("is refused with --remote, which ships only the workspace tree", async () => {
    const root = await repository()
    const served = await ci(root, await declaration(), "--remote", "pair")
    expect(served.exitCode).toBe(1)
    expect(served.output + served.logs).toContain("--remote does not take --workspace-file")
  }, 300_000)
})
