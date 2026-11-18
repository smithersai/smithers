/**
 * The cache directory outside the workspace: `--cache-dir` naming an absolute
 * or `..` path, and `S.Cache({ outside: true })` placing it under the user
 * cache directory. Real git repositories, real temporary directories, the real
 * CLI.
 */
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv, type RuntimeConfig } from "../src/Cli.ts"
import * as Machine from "../src/internal/Machine.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaries: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaries.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaries.push(directory)
  return directory
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" })

const workspaceText = (cache: string): string =>
  `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("outside-demo", {
  repository: "git+https://example.invalid/outside.git",
  cache: ${cache},
  host: S.Host({ bins: ["sh"] })
})
`

const checkTarget = `S.Shell.Test({ shell: "cat src/a.txt", sandbox: "none", data: [S.file("src/a.txt")] })`

const packageText = (targets: Readonly<Record<string, string>>): string =>
  `import { Smithers as S } from "@smthrs/targets"
${Object.entries(targets).map(([name, text]) => `const ${name} = ${text}`).join("\n")}
export const Package = S.Package({ targets: { ${Object.keys(targets).join(", ")} } })
`

/** A committed workspace under a fresh parent directory: `<parent>/repo`. */
const repository = async (
  cache = `S.Cache({ directory: ".flows" })`,
  targets: Readonly<Record<string, string>> = { check: checkTarget }
): Promise<{ readonly parent: string; readonly root: string }> => {
  const parent = await temporary("smthrs-outside-cache-")
  const root = NodePath.join(parent, "repo")
  await write(root, "WORKSPACE.ts", workspaceText(cache))
  await write(root, "PACKAGE.ts", packageText(targets))
  await write(root, "src/a.txt", "a\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return { parent, root }
}

const terminal = (): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY: false,
    columns: 100,
    text: () => out
  }
}

interface Served {
  readonly exitCode: number
  readonly stderr: string
  readonly envelope: string
}

const serve = async (
  root: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = {}
): Promise<Served> => {
  const stdout = terminal()
  const stderr = terminal()
  let exitCode = 0
  let envelope = ""
  const config: RuntimeConfig = {
    environment: {
      ...process.env,
      SMITHERS_AUDIENCE: "agent",
      NO_COLOR: "1",
      CI: undefined,
      SMTHRS_UI: undefined,
      FORCE_COLOR: undefined,
      ...environment
    },
    stdout,
    stderr
  }
  await makeCli(config).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      envelope += text
    }
  })
  return { exitCode, stderr: stderr.text(), envelope }
}

const json = async (
  root: string,
  args: ReadonlyArray<string>,
  environment?: Readonly<Record<string, string | undefined>>
): Promise<Served & { readonly data: any }> => {
  const served = await serve(root, [...args, "--format", "json"], environment)
  return { ...served, data: JSON.parse(served.envelope) }
}

const statusOf = (served: { readonly data: any }): ReadonlyArray<string> =>
  served.data.results.map((result: { readonly status: string }) => result.status)

const exists = (path: string): boolean => NodeFs.existsSync(path)

/** Every result-cache entry file below a cache directory. */
const entriesBelow = async (directory: string): Promise<ReadonlyArray<string>> => {
  const cache = NodePath.join(directory, "cache")
  if (!exists(cache)) return []
  const found: Array<string> = []
  for (const shard of await Fs.readdir(cache)) {
    for (const entry of await Fs.readdir(NodePath.join(cache, shard))) found.push(`${shard}/${entry}`)
  }
  return found
}

/** Runs `//:check` twice and proves the second run is a hit and the checkout stays clean. */
const runsTwiceOutside = async (
  root: string,
  state: string,
  flags: ReadonlyArray<string>,
  environment?: Readonly<Record<string, string | undefined>>
): Promise<void> => {
  const first = await json(root, ["test", "//:check", ...flags], environment)
  expect(first.exitCode, first.envelope).toBe(0)
  expect(statusOf(first)).toEqual(["ran"])
  const second = await json(root, ["test", "//:check", ...flags], environment)
  expect(second.exitCode, second.envelope).toBe(0)
  expect(statusOf(second)).toEqual(["hit"])
  expect(git(root, "status", "--porcelain", "--ignored")).toBe("")
  expect(exists(NodePath.join(root, ".flows"))).toBe(false)
  expect(await entriesBelow(state)).toHaveLength(1)
}

const hasBwrap = process.platform !== "linux" ||
  NodeChildProcess.spawnSync("sh", ["-c", "command -v bwrap"]).status === 0

describe("--cache-dir outside the workspace", () => {
  it("keeps every byte of state in an absolute directory and the checkout clean", async () => {
    const { parent, root } = await repository()
    const state = NodePath.join(parent, "state")
    await runsTwiceOutside(root, state, ["--cache-dir", state])
    expect((await Fs.readdir(state)).sort()).toEqual(["cache", "plan"])
  })

  it("resolves a path that starts with .. against the workspace root", async () => {
    const { parent, root } = await repository()
    await runsTwiceOutside(root, NodePath.join(parent, "state"), ["--cache-dir", "../state"])
  })

  it("stores and restores build outputs through the outside content store", async () => {
    const { parent, root } = await repository(undefined, {
      build:
        `S.Shell.Build({ shell: "cp src/a.txt out.txt", sandbox: "none", data: [S.file("src/a.txt")], outFiles: ["out.txt"] })`
    })
    const state = NodePath.join(parent, "state")
    const first = await json(root, ["build", "//:build", "--cache-dir", state])
    expect(first.exitCode, first.envelope).toBe(0)
    expect(statusOf(first)).toEqual(["ran"])
    expect(git(root, "status", "--porcelain", "--ignored")).toBe("?? out.txt\n")
    expect(await Fs.readdir(NodePath.join(state, "cas"))).toHaveLength(1)
    await Fs.rm(NodePath.join(root, "out.txt"))
    const second = await json(root, ["build", "//:build", "--cache-dir", state])
    expect(second.exitCode, second.envelope).toBe(0)
    expect(statusOf(second)).toEqual(["hit"])
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a\n")
    expect(exists(NodePath.join(root, ".flows"))).toBe(false)
  })

  it("replaces the cache-directory token in argv and env values with the absolute directory", async () => {
    const { parent } = await repository()
    const state = NodePath.join(parent, "state")
    const expected = `${state}/tools/zig`
    const { root } = await repository(undefined, {
      tokens: `S.Shell.Test({ bin: S.Host.bin("sh"), args: ["-c", 'test "$ZIG_LOCAL_CACHE_DIR" = "$1" && test "$1" = ${
        JSON.stringify(expected)
      }', "sh", "{smthrs:cache-directory}/tools/zig"], sandbox: "none", env: { ZIG_LOCAL_CACHE_DIR: "{smthrs:cache-directory}/tools/zig" } })`
    })
    const ran = await json(root, ["test", "//:tokens", "--cache-dir", state])
    expect(ran.exitCode, `${ran.envelope}${ran.stderr}`).toBe(0)
    expect(statusOf(ran)).toEqual(["ran"])
  })

  it.runIf(process.platform === "linux" && hasBwrap)(
    "runs a confined target whose private tmp and home live in the outside directory",
    async () => {
      const { parent } = await repository()
      const state = NodePath.join(parent, "state")
      const { root } = await repository(undefined, {
        confined:
          `S.Shell.Test({ shell: 'cat src/a.txt && echo t > "$TMPDIR/t" && mkdir -p "$HOME" && echo h > "$HOME/h" && test "$STATE" = ${
            JSON.stringify(`${state}/x`)
          }', sandbox: {}, data: [S.file("src/a.txt")], env: { STATE: "{smthrs:cache-directory}/x" } })`
      })
      const first = await json(root, ["test", "//:confined", "--cache-dir", state])
      expect(first.exitCode, `${first.envelope}${first.stderr}`).toBe(0)
      expect(statusOf(first)).toEqual(["ran"])
      const second = await json(root, ["test", "//:confined", "--cache-dir", state])
      expect(statusOf(second)).toEqual(["hit"])
      expect(git(root, "status", "--porcelain", "--ignored")).toBe("")
      expect(await entriesBelow(state)).toHaveLength(1)
    }
  )

  it("names the real outside directory in the env of a target on a machine", async () => {
    const { parent } = await repository()
    const state = NodePath.join(parent, "state")
    const { root } = await repository(undefined, {
      onMachine: `S.Shell.Test({ shell: 'test "$STATE" = ${
        JSON.stringify(`${state}/tools`)
      }', machine: "m", sandbox: "none", data: [S.file("src/a.txt")], env: { STATE: "{smthrs:cache-directory}/tools" } })`
    })
    const machines = await temporary("smthrs-outside-machines-")
    const ran = await json(root, ["test", "//:onMachine", "--cache-dir", state], {
      [Machine.holdingVariable]: machines
    })
    expect(ran.exitCode, `${ran.envelope}${ran.stderr}`).toBe(0)
    expect(statusOf(ran)).toEqual(["ran"])
    expect(git(root, "status", "--porcelain", "--ignored")).toBe("")
    expect(await entriesBelow(state)).toHaveLength(1)
  })

  it("treats an absolute path inside the workspace as the workspace-relative directory", async () => {
    const { root } = await repository()
    const ran = await json(root, ["test", "//:check", "--cache-dir", NodePath.join(root, ".inside")])
    expect(ran.exitCode, ran.envelope).toBe(0)
    expect(await entriesBelow(NodePath.join(root, ".inside"))).toHaveLength(1)
  })

  it("treats an outside link into the workspace as the directory it reaches", async () => {
    const { parent, root } = await repository()
    await Fs.symlink(root, NodePath.join(parent, "alias"))
    const ran = await json(root, ["test", "//:check", "--cache-dir", "../alias/.linked"])
    expect(ran.exitCode, ran.envelope).toBe(0)
    expect(await entriesBelow(NodePath.join(root, ".linked"))).toHaveLength(1)
  })

  it.each(["..", "../.."])("refuses %s, a directory that holds the workspace", async (flag) => {
    const { root } = await repository()
    const refused = await json(root, ["test", "//:check", "--cache-dir", flag])
    expect(refused.exitCode).toBe(1)
    expect(refused.data.message).toContain("holds the workspace")
  })

  it("refuses an outside link that reaches a directory holding the workspace", async () => {
    const { parent, root } = await repository()
    const elsewhere = await temporary("smthrs-outside-alias-")
    await Fs.symlink(parent, NodePath.join(elsewhere, "alias"))
    const refused = await json(root, ["test", "//:check", "--cache-dir", NodePath.join(elsewhere, "alias")])
    expect(refused.exitCode).toBe(1)
    expect(refused.data.message).toContain("holds the workspace")
  })

  it("keeps the result cache beneath an outside directory", async () => {
    const { parent, root } = await repository()
    const state = NodePath.join(parent, "state")
    const elsewhere = await temporary("smthrs-outside-escape-")
    await Fs.mkdir(state)
    await Fs.symlink(elsewhere, NodePath.join(state, "cache"))
    const refused = await json(root, ["test", "//:check", "--cache-dir", state])
    expect(refused.exitCode).toBe(1)
    expect(`${refused.envelope}${refused.stderr}`).toContain("result cache leaves its allowed root")
    expect(await Fs.readdir(elsewhere)).toEqual([])
  })

  it("reports, prunes, and describes the outside directory", async () => {
    const { parent, root } = await repository()
    const state = NodePath.join(parent, "state")
    await runsTwiceOutside(root, state, ["--cache-dir", state])
    const status = await json(root, ["cache", "status", "--cache-dir", state])
    expect(status.exitCode, status.envelope).toBe(0)
    expect(status.data).toMatchObject({ directory: NodePath.join(state, "cache"), exists: true, entries: 1 })
    const info = await json(root, ["info", "--cache-dir", state])
    expect(info.data.cache.directory).toBe(NodePath.join(state, "cache"))
    const pruned = await json(root, ["cache", "prune", "--older-than-days", "0", "--yes", "--cache-dir", state])
    expect(pruned.exitCode, pruned.envelope).toBe(0)
    expect(await entriesBelow(state)).toEqual([])
    const missing = await json(root, ["cache", "status", "--cache-dir", NodePath.join(parent, "never")])
    expect(missing.data).toMatchObject({
      directory: NodePath.join(parent, "never", "cache"),
      exists: false,
      entries: 0
    })
  })
})

describe("S.Cache({ outside: true })", () => {
  const placed = (base: string, root: string): string =>
    NodePath.join(
      base,
      "smithers",
      `outside-demo-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
      ".flows"
    )

  it("places the state under XDG_CACHE_HOME", async () => {
    const { root } = await repository(`S.Cache({ directory: ".flows", outside: true })`)
    const xdg = await temporary("smthrs-outside-xdg-")
    const environment = { XDG_CACHE_HOME: xdg }
    await runsTwiceOutside(root, placed(xdg, root), [], environment)
    const status = await json(root, ["cache", "status"], environment)
    expect(status.data.directory).toBe(NodePath.join(placed(xdg, root), "cache"))
  })

  it("falls back to the home directory's cache", async () => {
    const { root } = await repository(`S.Cache({ directory: ".flows", outside: true })`)
    const home = await temporary("smthrs-outside-home-")
    const environment = { XDG_CACHE_HOME: undefined, HOME: home }
    const base = process.platform === "darwin"
      ? NodePath.join(home, "Library", "Caches")
      : NodePath.join(home, ".cache")
    await runsTwiceOutside(root, placed(base, root), [], environment)
  })

  it("yields to --cache-dir", async () => {
    const { parent, root } = await repository(`S.Cache({ directory: ".flows", outside: true })`)
    const xdg = await temporary("smthrs-outside-xdg-")
    await runsTwiceOutside(root, NodePath.join(parent, "state"), ["--cache-dir", "../state"], { XDG_CACHE_HOME: xdg })
    expect(await Fs.readdir(xdg)).toEqual([])
  })
})

describe("declarations stay inside the workspace", () => {
  it.each([
    ["/abs/cache", "cacheDirectory must be workspace-relative: /abs/cache"],
    ["../cache", "cacheDirectory must not leave the workspace: ../cache"]
  ])("refuses S.Cache({ directory: %s })", async (directory, message) => {
    const { root } = await repository(`S.Cache({ directory: ${JSON.stringify(directory)} })`)
    const refused = await json(root, ["test", "//:check"])
    expect(refused.exitCode).toBe(1)
    expect(refused.data.message).toContain(message)
  })

  it("refuses an install whose cache directory is outside the workspace", async () => {
    const { parent, root } = await repository()
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
const runtime = S.Runtime.Bun({ version: ">=1.4.0" })
export const Workspace = S.Workspace("outside-demo", {
  repository: "git+https://example.invalid/outside.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.BunPackages({ runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { install: S.Install({ lockfilePath: "bun.lock" }) } })
`
    )
    await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write(root, "bun.lock", "{}\n")
    const refused = await json(root, ["install", "--cache-dir", NodePath.join(parent, "state")])
    expect(refused.exitCode).toBe(1)
    expect(`${refused.envelope}${refused.stderr}`).toContain("install requires cacheDirectory \".flows\"")
  })
})
