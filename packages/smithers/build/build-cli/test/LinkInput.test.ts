/**
 * `S.link`: a tracked symbolic link as a declared input, end to end, on the
 * host's own confinement.
 *
 * A link's identity is its own target string. These cases spawn real tools
 * under the real mechanism (bubblewrap on Linux, seatbelt on macOS) and
 * assert the kernel's answer and the planner's key: the link exists inside
 * the sandbox with the same target, a declared target resolves through it, an
 * undeclared one stays unreadable, a retarget re-keys while content behind the
 * link does not, a target outside the workspace is refused, globs carry links
 * as links, and `smthrs affected` selects the target on a retarget.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { openPackageIndex } from "../src/Cli.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" })
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commitAll = (root: string): void => {
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
}

/** A workspace whose `consumer/alias` links to the sibling directory `agent`. */
const linkWorkspace = async (packageModule: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-link-input-")))
  temporaryDirectories.push(root)
  await write(root, ".gitignore", ".flows/\n")
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "consumer/agent/index.js", "module.exports = 'agent-1'\n")
  await write(root, "consumer/other/index.js", "module.exports = 'other'\n")
  await Fs.symlink("agent", NodePath.join(root, "consumer/alias"), "dir")
  await write(root, "PACKAGE.ts", packageModule)
  commitAll(root)
  return root
}

const retarget = async (root: string, path: string, target: string): Promise<void> => {
  await Fs.rm(NodePath.join(root, path))
  await Fs.symlink(target, NodePath.join(root, path), "dir")
}

const run = async (root: string, label: string, readCache = false) => {
  const index = await openPackageIndex({ workspace: root })
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: [label], readCache }
  const planned = await PackageExec.plan(options)
  const summary = await PackageExec.execute(planned, options)
  return { node: planned.nodes.get(label)!, row: summary.results.find((entry) => entry.label === label)! }
}

const planNode = async (root: string, label: string) => {
  const index = await openPackageIndex({ workspace: root })
  const planned = await PackageExec.plan({ index, cacheDirectory: ".flows", verb: "auto" as const, patterns: [label] })
  return planned.nodes.get(label)!
}

const keyOf = async (root: string, label = "//:declared"): Promise<string> => (await planNode(root, label)).keyPreview

/** The shell a confined target runs: the link is a link with its target, then it reads through it. */
const readsThrough =
  `test -L consumer/alias && test "$(readlink consumer/alias)" = agent && cat consumer/alias/index.js`
const seesLink = `test -L consumer/alias && test "$(readlink consumer/alias)" = agent`

const native = process.platform === "darwin" || process.platform === "linux"

describe.runIf(native)("S.link under confinement", () => {
  it("materializes the link with its target, and a declared target resolves through it", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({
  shell: ${JSON.stringify(readsThrough)},
  data: [S.link("consumer/alias"), S.file("consumer/agent/index.js")]
})
export const Package = S.Package({ targets: { declared } })
`)
    const admitted = await run(root, "//:declared")
    expect(admitted.row.error).toBeUndefined()
    expect(admitted.row.status).toBe("ran")
  })

  it("grants nothing through the link: an undeclared target stays unreadable", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const visible = S.Shell.Run({ shell: ${JSON.stringify(seesLink)}, data: [S.link("consumer/alias")] })
const through = S.Shell.Run({ shell: "cat consumer/alias/index.js", data: [S.link("consumer/alias")] })
const sibling = S.Shell.Run({
  shell: "cat consumer/other/index.js",
  data: [S.link("consumer/alias"), S.file("consumer/agent/index.js")]
})
export const Package = S.Package({ targets: { visible, through, sibling } })
`)
    const visible = await run(root, "//:visible")
    expect(visible.row.error).toBeUndefined()
    expect(visible.row.status).toBe("ran")
    expect((await run(root, "//:through")).row.status).toBe("failed")
    expect((await run(root, "//:sibling")).row.status).toBe("failed")
  })

  it("carries a link a glob matched into the sandbox as a link", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: ${JSON.stringify(readsThrough)}, data: [S.glob("consumer/{alias,agent/**}")] })
export const Package = S.Package({ targets: { declared } })
`)
    const admitted = await run(root, "//:declared")
    expect(admitted.row.error).toBeUndefined()
    expect(admitted.row.status).toBe("ran")
  })
})

describe("S.link key", () => {
  const declaredLink = `import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: "true", sandbox: "none", data: [S.link("consumer/alias")] })
export const Package = S.Package({ targets: { declared } })
`

  it("keys the link's target string, never the content behind it", async () => {
    const root = await linkWorkspace(declaredLink)
    const node = await planNode(root, "//:declared")
    expect(node.declaredInputs.flatMap((input) => input.files)).toEqual([
      expect.objectContaining({ path: "consumer/alias", link: "agent" })
    ])
    const first = node.keyPreview
    await write(root, "consumer/agent/index.js", "module.exports = 'agent-2'\n")
    await write(root, "consumer/agent/added.js", "module.exports = 'added'\n")
    expect(await keyOf(root)).toBe(first)
    await retarget(root, "consumer/alias", "other")
    const retargeted = await keyOf(root)
    expect(retargeted).not.toBe(first)
    await retarget(root, "consumer/alias", "agent")
    expect(await keyOf(root)).toBe(first)
  })

  it("re-keys on content behind the link only when that content is declared", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({
  shell: "true",
  sandbox: "none",
  data: [S.link("consumer/alias"), S.file("consumer/agent/index.js")]
})
export const Package = S.Package({ targets: { declared } })
`)
    const first = await keyOf(root)
    await write(root, "consumer/agent/added.js", "module.exports = 'added'\n")
    expect(await keyOf(root)).toBe(first)
    await write(root, "consumer/agent/index.js", "module.exports = 'agent-2'\n")
    expect(await keyOf(root)).not.toBe(first)
  })

  it("keys a dangling link inside the workspace by its target string", async () => {
    const root = await linkWorkspace(declaredLink)
    await retarget(root, "consumer/alias", "not-yet")
    const node = await planNode(root, "//:declared")
    expect(node.declaredInputs.flatMap((input) => input.files)).toEqual([
      expect.objectContaining({ path: "consumer/alias", link: "not-yet" })
    ])
  })

  it.each([
    ["a target that leaves the workspace", "../../outside", "leaves the workspace"],
    ["an absolute target", "/etc", "is absolute"]
  ])("refuses %s, naming the path", async (_, target, reason) => {
    const root = await linkWorkspace(declaredLink)
    await retarget(root, "consumer/alias", target)
    await expect(keyOf(root)).rejects.toMatchObject({
      _tag: "smithers-build/PackageError",
      code: "link_input_refused",
      path: "consumer/alias",
      message: expect.stringContaining(`consumer/alias -> ${target} ${reason}`)
    })
  })

  it("refuses a path that is not a symbolic link", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: "true", sandbox: "none", data: [S.link("consumer/agent")] })
export const Package = S.Package({ targets: { declared } })
`)
    await expect(keyOf(root)).rejects.toMatchObject({
      code: "link_input_refused",
      path: "consumer/agent",
      message: expect.stringContaining("is not a symbolic link")
    })
  })

  it("points S.file at S.link when the file is a link to a directory", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: "true", sandbox: "none", data: [S.file("consumer/alias")] })
export const Package = S.Package({ targets: { declared } })
`)
    await expect(keyOf(root)).rejects.toThrow(
      /consumer\/alias is a symbolic link to a directory.*S\.link\("consumer\/alias"\)/
    )
  })
})

describe("globs and links", () => {
  const globbed = (pattern: string) =>
    `import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: "true", sandbox: "none", data: [S.glob(${JSON.stringify(pattern)})] })
export const Package = S.Package({ targets: { declared } })
`
  const rows = async (root: string) =>
    (await planNode(root, "//:declared")).declaredInputs.flatMap((input) => input.files)

  it("includes a directory link it matches as a link and never descends it", async () => {
    const root = await linkWorkspace(globbed("consumer/**"))
    const files = await rows(root)
    expect(files.map((file) => file.path)).toEqual([
      "consumer/agent/index.js",
      "consumer/alias",
      "consumer/other/index.js"
    ])
    expect(files.find((file) => file.path === "consumer/alias")).toMatchObject({ link: "agent" })
    const first = await keyOf(root)
    await retarget(root, "consumer/alias", "other")
    expect(await keyOf(root)).not.toBe(first)
  })

  it("refuses a link it matches whose target leaves the workspace, naming it", async () => {
    const root = await linkWorkspace(globbed("consumer/**"))
    await retarget(root, "consumer/alias", "/etc")
    await expect(keyOf(root)).rejects.toThrow(/consumer\/alias -> \/etc is absolute/)
  })

  it("enters a node_modules directory only when a .gitignore negation says the workspace tracks it", async () => {
    const root = await linkWorkspace(globbed("consumer/**"))
    await Fs.mkdir(NodePath.join(root, "consumer/node_modules"))
    await Fs.symlink("../agent", NodePath.join(root, "consumer/node_modules/agent"), "dir")
    await write(root, "consumer/node_modules/installed/index.js", "module.exports = 'installed'\n")
    expect((await rows(root)).map((file) => file.path)).not.toContain("consumer/node_modules/agent")
    await write(
      root,
      "consumer/.gitignore",
      "!node_modules/\nnode_modules/*\n!node_modules/agent\n"
    )
    const files = await rows(root)
    expect(files).toContainEqual(expect.objectContaining({ path: "consumer/node_modules/agent", link: "../agent" }))
    expect(files.map((file) => file.path)).not.toContain("consumer/node_modules/installed/index.js")
    await write(root, "PACKAGE.ts", globbed("consumer/node_modules/*"))
    expect(await rows(root)).toEqual([
      expect.objectContaining({ path: "consumer/node_modules/agent", link: "../agent" })
    ])
  })
})

describe("smthrs affected and links", () => {
  it("selects the target when the link's target string changes", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Test({ shell: "true", data: [S.link("consumer/alias")] })
const unrelated = S.Shell.Test({ shell: "true", data: [S.file("consumer/other/index.js")] })
export const Package = S.Package({ targets: { declared, unrelated } })
`)
    await retarget(root, "consumer/alias", "other")
    const changed = await Affected.changedPaths(root, { base: "HEAD" })
    expect(changed).toEqual(["consumer/alias"])
    const index = await openPackageIndex({ workspace: root })
    expect(Affected.select(index, ["//..."], changed).targets).toEqual([
      { label: "//:declared", reasons: ["consumer/alias"] }
    ])
    // The link now points at other/, yet a change there is the declaring target's alone.
    expect(Affected.select(index, ["//..."], ["consumer/other/index.js"]).targets).toEqual([
      { label: "//:unrelated", reasons: ["consumer/other/index.js"] }
    ])
  })
})

describe("links as outputs", () => {
  it("refuses a declared output file that is a link, and points at outDirs", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Build({ shell: "mkdir -p out && ln -s ../consumer/agent out/alias", sandbox: "none", outFiles: ["out/alias"] })
export const Package = S.Package({ targets: { declared } })
`)
    const built = await run(root, "//:declared")
    expect(built.row.status).toBe("failed")
    expect(built.row.error).toContain("declared output file is a symbolic link: out/alias")
  })

  it("captures a link inside a declared outDir as a link and restores it as one", async () => {
    const root = await linkWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Build({ shell: "mkdir -p out/agent && ln -s agent out/alias", sandbox: "none", outDirs: ["out"] })
export const Package = S.Package({ targets: { declared } })
`)
    const built = await run(root, "//:declared")
    expect(built.row.error).toBeUndefined()
    expect(built.row.status).toBe("ran")
    expect(await Fs.readlink(NodePath.join(root, "out/alias"))).toBe("agent")
    await Fs.rm(NodePath.join(root, "out"), { recursive: true })
    const restored = await run(root, "//:declared", true)
    expect(restored.row.status).toBe("hit")
    expect(await Fs.readlink(NodePath.join(root, "out/alias"))).toBe("agent")
  })
})
