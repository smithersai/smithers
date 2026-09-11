import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { JJ_PROBE_TIMEOUT_MS, createRepoStore, detectSmithers, inspectRepo, ownerNameOf, repoId } from "./Repos"

/*
 * Repository detection (LOCAL-APP.md "Repository detection") against real
 * directories: the positive rule, both negatives, the walk's skip list, and
 * the id/name derivation.
 */

const directories: Array<string> = []

const scratch = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-repos-")))
  directories.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
})

const WORKSPACE = "import { Smithers as S } from \"@smthrs/targets\"\nexport const Workspace = S.Workspace(\"x\", {})\n"

describe("detectSmithers", () => {
  test("a .smithers/WORKSPACE.ts importing @smthrs/targets is a workspace", async () => {
    const root = await scratch()
    await mkdir(join(root, ".smithers"))
    await writeFile(join(root, ".smithers", "WORKSPACE.ts"), WORKSPACE)
    expect(detectSmithers(root)).toEqual({
      detected: true,
      workspaceFile: ".smithers/WORKSPACE.ts",
      declarationFiles: [".smithers/WORKSPACE.ts"],
      reason: "1 workspace detected",
      workspaces: [{ path: ".", title: basename(root) }]
    })
  })

  test("PACKAGE.ts files count as declarations, single quotes count, node_modules and .git are skipped", async () => {
    const root = await scratch()
    await writeFile(join(root, "WORKSPACE.ts"), "export const Workspace = {}\n")
    await mkdir(join(root, "src", "deep"), { recursive: true })
    await writeFile(join(root, "src", "PACKAGE.ts"), "import { Smithers as S } from 'smthrs'\n")
    await writeFile(join(root, "src", "deep", "PACKAGE.ts"), "export const nothing = 1\n")
    await mkdir(join(root, "node_modules", "x"), { recursive: true })
    await writeFile(join(root, "node_modules", "x", "PACKAGE.ts"), WORKSPACE)
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "PACKAGE.ts"), WORKSPACE)
    const verdict = detectSmithers(root)
    expect(verdict.detected).toBe(true)
    expect(verdict.workspaceFile).toBe("WORKSPACE.ts")
    expect(verdict.declarationFiles).toEqual(["src/PACKAGE.ts"])
    expect(verdict.workspaces).toEqual([{ path: ".", title: basename(root) }])
  })

  test("a root legacy declaration importing smthrs is the root workspace: the loader answers `query //...` for it", async () => {
    // The Smithers checkout itself is rooted on legacy declaration; opening it used to
    // say "no WORKSPACE.ts" and load no targets while the CLI listed 100+.
    const root = await scratch()
    await writeFile(join(root, "legacy declaration"), WORKSPACE)
    expect(detectSmithers(root)).toEqual({
      detected: true,
      workspaceFile: null,
      declarationFiles: ["legacy declaration"],
      reason: "1 workspace detected",
      workspaces: [{ path: ".", title: basename(root) }]
    })
  })

  test("a legacy declaration that does not import smthrs is not a workspace, and a package's legacy declaration below the root never is", async () => {
    const root = await scratch()
    await writeFile(join(root, "legacy declaration"), "export const bazel = 1\n")
    await mkdir(join(root, "packages", "a"), { recursive: true })
    await writeFile(join(root, "packages", "a", "legacy declaration"), WORKSPACE)
    expect(detectSmithers(root)).toEqual({
      detected: false,
      workspaceFile: null,
      declarationFiles: [],
      reason: "no WORKSPACE.ts or smthrs legacy declaration",
      workspaces: []
    })
  })

  test("a WORKSPACE.ts that does not import smthrs still detects; declarationFiles is simply empty", async () => {
    // The plugin contract (LOCAL-APP.md "Repository detection"): detection is
    // the presence of WORKSPACE.ts files alone — detected iff workspaces is
    // nonempty. The imports scan stays as the informational declarationFiles.
    const root = await scratch()
    await writeFile(join(root, "WORKSPACE.ts"), "import { x } from \"./x\"\n")
    expect(detectSmithers(root)).toEqual({
      detected: true,
      workspaceFile: "WORKSPACE.ts",
      declarationFiles: [],
      reason: "1 workspace detected",
      workspaces: [{ path: ".", title: basename(root) }]
    })
  })

  test("child workspaces are discovered two levels deep, skipping vendored and generated trees", async () => {
    const root = await scratch()
    await mkdir(join(root, ".smithers"))
    await writeFile(join(root, ".smithers", "WORKSPACE.ts"), WORKSPACE)
    // Depth 1 and depth 2 count.
    await mkdir(join(root, "aomi", ".smithers"), { recursive: true })
    await writeFile(join(root, "aomi", ".smithers", "WORKSPACE.ts"), WORKSPACE)
    await mkdir(join(root, "packages", "sdk"), { recursive: true })
    await writeFile(join(root, "packages", "sdk", "WORKSPACE.ts"), WORKSPACE)
    // Depth 3 does not.
    await mkdir(join(root, "packages", "deep", "deeper"), { recursive: true })
    await writeFile(join(root, "packages", "deep", "deeper", "WORKSPACE.ts"), WORKSPACE)
    // The skip list does not.
    for (const skipped of ["node_modules", ".git", ".flows", "dist", "build", "target"]) {
      await mkdir(join(root, skipped), { recursive: true })
      await writeFile(join(root, skipped, "WORKSPACE.ts"), WORKSPACE)
    }
    const verdict = detectSmithers(root)
    expect(verdict.detected).toBe(true)
    expect(verdict.workspaces).toEqual([
      { path: ".", title: basename(root) },
      { path: "aomi", title: "aomi" },
      { path: "packages/sdk", title: "sdk" }
    ])
    expect(verdict.reason).toBe("3 workspaces detected")
  })

  test("a root without its own WORKSPACE.ts still detects through its children", async () => {
    const root = await scratch()
    await mkdir(join(root, "aomi", ".smithers"), { recursive: true })
    await writeFile(join(root, "aomi", ".smithers", "WORKSPACE.ts"), WORKSPACE)
    const verdict = detectSmithers(root)
    expect(verdict).toMatchObject({
      detected: true,
      workspaceFile: null,
      workspaces: [{ path: "aomi", title: "aomi" }]
    })
  })
})

describe("repository records", () => {
  test("the id is a stable short hash of the absolute path", () => {
    expect(repoId("/Users/u/force")).toBe(repoId("/Users/u/force"))
    expect(repoId("/Users/u/force")).toMatch(/^[0-9a-f]{12}$/)
    expect(repoId("/Users/u/force")).not.toBe(repoId("/Users/u/force2"))
  })

  test("owner/name comes from https and scp remotes", () => {
    expect(ownerNameOf("https://github.com/artsy/force.git")).toBe("artsy/force")
    expect(ownerNameOf("https://github.com/artsy/force")).toBe("artsy/force")
    expect(ownerNameOf("git@github.com:artsy/force.git")).toBe("artsy/force")
    expect(ownerNameOf(null)).toBeNull()
    expect(ownerNameOf("nonsense")).toBeNull()
  })

  test("inspectRepo names a plain directory by its basename with no git facts", async () => {
    const root = await scratch()
    const result = await inspectRepo(root)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.repo).toEqual({
      id: repoId(root),
      path: root,
      name: basename(root),
      git: null,
      warnings: [],
      smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts or smthrs legacy declaration", workspaces: [] }
    })
  })

  test("inspectRepo refuses a missing path and a file", async () => {
    const root = await scratch()
    await writeFile(join(root, "file.txt"), "x")
    expect((await inspectRepo(join(root, "missing"))).status).toBe("error")
    const file = await inspectRepo(join(root, "file.txt"))
    expect(file.status === "error" && file.code).toBe("not_a_directory")
  })

  test("the store opens, lists in open order, refreshes in place, and closes", async () => {
    const store = createRepoStore()
    const first = await scratch()
    const second = await scratch()
    const opened = await store.open(first)
    expect(opened.status).toBe("ok")
    await store.open(second)
    await store.open(first)
    expect(store.list().map((repo) => repo.path)).toEqual([first, second])
    expect(store.close(repoId(first))).toBe(true)
    expect(store.close(repoId(first))).toBe(false)
    expect(store.list().map((repo) => repo.path)).toEqual([second])
    expect(store.get(repoId(second))?.path).toBe(second)
  })
})

/*
 * POST /api/repo/open answers `store.open` and GET /api/repos answers
 * `store.list`, so both hand the renderer this record. A token embedded in the
 * origin must never survive into it. The developer's own git config is
 * neutralised so url.<base>.insteadOf cannot rewrite the remote under test.
 */
describe("the repository record never carries remote credentials", () => {
  const withRemote = async (remote: string): Promise<string> => {
    const root = await scratch()
    const env = { ...(Bun.env as Record<string, string | undefined>), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
    expect(await Bun.spawn(["git", "init", "-q", root], { env }).exited).toBe(0)
    expect(await Bun.spawn(["git", "-C", root, "remote", "add", "origin", remote], { env }).exited).toBe(0)
    return root
  }

  const isolated = async <A>(body: () => Promise<A>): Promise<A> => {
    const previous = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM] as const
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    try {
      return await body()
    } finally {
      if (previous[0] === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous[0]
      if (previous[1] === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = previous[1]
    }
  }

  test("an https origin loses its userinfo, query and fragment on open and on list", async () => {
    const root = await withRemote("https://user:ghp_secrettoken@github.com/o/r.git?x=1#y")
    const store = createRepoStore()
    const opened = await isolated(() => store.open(root))
    expect(opened.status).toBe("ok")
    if (opened.status !== "ok") return
    expect(opened.repo.git?.remote).toBe("https://github.com/o/r.git")
    expect(opened.repo.name).toBe("o/r")
    expect(store.list().map((repo) => repo.git?.remote)).toEqual(["https://github.com/o/r.git"])
    expect(JSON.stringify(store.list())).not.toContain("ghp_secrettoken")
  })

  test("an scp-style origin keeps its host and path but loses the user, as the picker reports it", async () => {
    const root = await withRemote("git@github.com:o/r.git")
    const opened = await isolated(() => inspectRepo(root))
    expect(opened.status === "ok" && opened.repo.git?.remote).toBe("github.com:o/r.git")
    expect(opened.status === "ok" && opened.repo.name).toBe("o/r")
  })
})

describe("declaration files on a legacy declaration-rooted checkout", () => {
  test("package legacy declaration files that import smthrs are declarations, so target.source.open can reach them", async () => {
    const root = await scratch()
    await writeFile(join(root, "legacy declaration"), WORKSPACE)
    await mkdir(join(root, "packages", "a"), { recursive: true })
    await writeFile(join(root, "packages", "a", "legacy declaration"), WORKSPACE)
    await mkdir(join(root, "packages", "b"), { recursive: true })
    await writeFile(join(root, "packages", "b", "legacy declaration"), "export const plain = 1\n")
    await mkdir(join(root, "node_modules", "x"), { recursive: true })
    await writeFile(join(root, "node_modules", "x", "legacy declaration"), WORKSPACE)
    expect(detectSmithers(root).declarationFiles).toEqual(["legacy declaration", "packages/a/legacy declaration"])
  })
})


describe("the jj probe never holds a repository open hostage", () => {
  test("a jj that hangs is killed at the probe timeout and the repo opens without jj facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-jj-hang-"))
    const shims = join(dir, "bin")
    await mkdir(shims)
    await mkdir(join(dir, ".jj"))
    // The shim ignores every argument and sleeps well past the timeout.
    await writeFile(join(shims, "jj"), "#!/bin/sh\nsleep 30\n")
    await chmod(join(shims, "jj"), 0o755)
    const realPath = process.env.PATH
    process.env.PATH = `${shims}:${realPath ?? ""}`
    const started = Date.now()
    try {
      const result = await inspectRepo(dir)
      expect(result.status).toBe("ok")
      if (result.status === "ok") expect(result.repo.jj).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(JJ_PROBE_TIMEOUT_MS * 3)
    } finally {
      process.env.PATH = realPath
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
