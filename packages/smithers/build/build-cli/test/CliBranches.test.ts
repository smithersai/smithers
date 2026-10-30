/**
 * The command surface's remaining branches, driven through the real CLI:
 * PACKAGE.ts `deps()` and `--input` parsing, `--cache-dir`, `--plan` and
 * `--mermaid` under a human renderer, a red run without an exit hook,
 * `gitHooks`, and the human tree and table.
 */
import { Deferred, Effect, Layer } from "effect"
import { Cli, Mcp, z } from "incur"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import * as Audience from "../src/Audience.ts"
import { openCache } from "../src/Cache.ts"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import { approvalRevision, makeCli, normalizeArgv, openPackageIndex, type RuntimeConfig } from "../src/Cli.ts"
import { CliServices, cliServicesLive } from "../src/index.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const temporary = async (prefix: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(root)
  return root
}

/** A committed PACKAGE.ts workspace: two tests and a suite that reaches one of them twice. */
const packageFixture = async (goodShell = "true"): Promise<string> => {
  const root = await temporary("smthrs-cli-branches-pkg-")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ shell: ${JSON.stringify(goodShell)} })
const bad = S.Shell.Test({ shell: "false" })
const hello = S.Shell.Run({ shell: "true" })
const pair = S.Suite({ tests: [good, bad] })
const all = S.Suite({ tests: [pair, good] })
const docs = S.DocsParity({ readme: S.file("README.md"), deps: [], minimumProseCharacters: 20 })
export const Package = S.Package({ targets: { good, bad, hello, pair, all, docs } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  await write(root, "README.md", "# Fixture\n\nThis fixture has enough explanatory prose for the documentation gate.\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

const terminal = (isTTY: boolean): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY,
    columns: 100,
    text: () => out
  }
}

interface Served {
  readonly exitCode: number
  readonly recorded: number | undefined
  readonly stdout: string
  readonly stderr: string
  readonly envelope: string
}

const serve = async (
  root: string,
  args: ReadonlyArray<string>,
  isTTY: boolean,
  configure: (config: RuntimeConfig) => RuntimeConfig = (config) => config
): Promise<Served> => {
  const stdout = terminal(isTTY)
  const stderr = terminal(isTTY)
  let exitCode = 0
  let recorded: number | undefined
  let envelope = ""
  const environment = {
    ...process.env,
    SMITHERS_AUDIENCE: isTTY ? "human" : "agent",
    NO_COLOR: "1",
    CI: undefined,
    SMTHRS_UI: undefined,
    FORCE_COLOR: undefined
  }
  await makeCli(configure({
    environment,
    stdout,
    stderr,
    exit: (code) => {
      recorded = code
    }
  })).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      envelope += text
    }
  })
  return { exitCode, recorded, stdout: stdout.text(), stderr: stderr.text(), envelope }
}

const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
const pretendTTY = (value: boolean): void => {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true })
}
afterEach(() => {
  if (stdoutTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
  else Object.defineProperty(process.stdout, "isTTY", stdoutTTY)
})

const jsonCommand = async (
  root: string,
  args: ReadonlyArray<string>,
  configure: (config: RuntimeConfig) => RuntimeConfig = (config) => config
) => {
  const result = await serve(root, [...args, "--format", "json"], false, configure)
  return { ...result, data: JSON.parse(result.envelope) }
}

describe("public cache and inspection commands", () => {
  it("keeps the embedder's durable-step commands under cache", async () => {
    const root = await packageFixture()
    const result = await jsonCommand(root, ["cache", "steps", "inspect"], (config) => ({
      ...config,
      cacheSteps: Cli.create("steps").command("inspect", {
        options: z.object({ workspace: z.string() }),
        run: () => ({ scope: "durable-steps" })
      })
    }))
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data).toEqual({ scope: "durable-steps" })
  })

  it.each([0, 2])("refuses %s root Install declarations before starting an install", async (count) => {
    const root = await packageFixture()
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ${
        count === 0
          ? ""
          : "one: S.Install({ lockfilePath: \"yarn.lock\" }), two: S.Install({ lockfilePath: \"yarn.lock\" })"
      } } })
`
    )
    const result = await jsonCommand(root, ["install"])
    expect(result.exitCode).toBe(1)
    expect(result.envelope).toContain(
      count === 0 ? "declares no Install target" : "declares more than one Install target"
    )
    expect(await Fs.readdir(root)).not.toContain(".flows")
  })

  it("forwards an explicit watch policy and cache override into a real plan child", async () => {
    const root = await packageFixture("exit 19")
    const result = await serve(
      root,
      [
        "watch",
        "test",
        ":good",
        "--once",
        "--plan",
        "--silent",
        "--verbose",
        "--jobs",
        "1",
        "--no-cache",
        "--cache-dir",
        ".watch-cache",
        "--include-exclusive",
        "--format",
        "json"
      ],
      false,
      (config) => ({
        ...config,
        cacheUrl: "http://127.0.0.1:1",
        cacheToken: "fixture-watch-token"
      })
    )
    expect(result.exitCode, result.envelope).toBe(0)
    expect(JSON.parse(result.envelope).exitCode).toBe(0)
    expect(`${result.envelope}${result.stdout}${result.stderr}`).not.toContain("fixture-watch-token")
    expect(await Fs.readdir(root)).not.toContain(".watch-cache")
  }, 120_000)

  it("degrades a real refused public-cache connection without exposing its read credential", async () => {
    const root = await packageFixture()
    const workspace = await Fs.readFile(NodePath.join(root, "WORKSPACE.ts"), "utf8")
    await write(
      root,
      "WORKSPACE.ts",
      workspace.replace(
        "directory: \".flows\"",
        "directory: \".flows\", remote: S.RemoteCache.make({ endpoint: \"https://cache.example.invalid\", publicReadToken: \"smithers_cachero_" +
          "a".repeat(40) + "\" })"
      )
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const sources = S.Filegroup({ srcs: [S.file("README.md")] })
export const Package = S.Package({ targets: { sources, check: S.Shell.Test({ shell: "true", data: [sources] }) } })
`
    )
    const result = await jsonCommand(
      root,
      ["target", "//:sources"],
      (config) => ({ ...config, cacheUrl: "http://127.0.0.1:1" })
    )
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.stderr).toContain("remote cache disabled after a failure")
    expect(`${result.envelope}${result.stderr}`).not.toContain("smithers_cachero_")
    const ci = await jsonCommand(root, ["ci", "//...", "--cache-dir", ".ci-cache"], (config) => ({
      ...config,
      cacheUrl: "http://127.0.0.1:1"
    }))
    expect(ci.exitCode, ci.envelope).toBe(0)
    expect(ci.stderr).toContain("remote cache disabled after a failure")
    await write(root, "WORKSPACE.ts", workspace)
    const shared = await jsonCommand(root, ["target", "//:sources", "--cache-dir", ".shared-cache"], (config) => ({
      ...config,
      cacheUrl: "http://127.0.0.1:1",
      environment: { ...config.environment, SMITHERS_CACHE_TOKEN: "fixture-default-read-token" }
    }))
    expect(shared.exitCode, shared.envelope).toBe(0)
    expect(shared.stderr).toContain("remote cache disabled after a failure")
    expect(`${shared.envelope}${shared.stderr}`).not.toContain("fixture-default-read-token")
  })

  it("selects absolute labels when the workspace root has no PACKAGE.ts", async () => {
    const root = await packageFixture()
    await Fs.rename(NodePath.join(root, "PACKAGE.ts"), NodePath.join(root, "root-package.txt"))
    await write(
      root,
      "child/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { good: S.Shell.Test({ shell: "true" }) } })
`
    )
    const result = await jsonCommand(root, ["affected", "test", "//...", "--files", "child/PACKAGE.ts", "--plan"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.roots).toEqual(["//child:good"])
  })

  it("plans absolute affected labels through an external workspace symlink", async () => {
    const root = await packageFixture()
    const aliases = await temporary("smthrs-cli-workspace-alias-")
    const alias = NodePath.join(aliases, "workspace")
    await Fs.symlink(root, alias, "dir")
    const result = await jsonCommand(alias, ["affected", "test", "//...", "--files", "PACKAGE.ts", "--plan"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.roots).toEqual(expect.arrayContaining(["//:good", "//:bad"]))
    expect(result.data.targets.map((target: { label: string }) => target.label)).toContain("//:good")
  })

  it("lists an attended documentation writer as omitted from affected CI", async () => {
    const root = await packageFixture()
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { page: S.Docs.Page({ brief: S.file("README.md"), prompt: S.file("README.md"), references: [], inputs: [], output: "guide.md", gates: [], maxRounds: 1 }) } })
`
    )
    const result = await jsonCommand(root, ["affected", "ci", "//:page", "--files", "PACKAGE.ts", "--list"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.targets).toEqual([])
    expect(result.data.omitted).toEqual(["//:page"])
  })

  it.each(["artifact", "evergreen", "all"])("lists affected gates under the %s lifecycle", async (lifecycle) => {
    const root = await packageFixture()
    const result = await jsonCommand(root, [
      "affected",
      "test",
      "//:good",
      "--files",
      "PACKAGE.ts",
      "--list",
      "--lifecycle",
      lifecycle
    ])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.omitted).toEqual(lifecycle === "artifact" ? ["//:good"] : [])
    expect(result.data.targets.map((target: { label: string }) => target.label)).toEqual(
      lifecycle === "artifact" ? [] : ["//:good"]
    )
  })

  it("deduplicates shared work in an affected CI plan", async () => {
    const root = await packageFixture()
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const sources = S.Filegroup({ srcs: [S.file("README.md")] })
const check = S.Shell.Test({ shell: "true", data: [sources] })
const generated = S.TargetIndex({ summary: "Index fixture targets" })
export const Package = S.Package({ targets: { sources, check, generated } })
`
    )
    const result = await jsonCommand(root, ["affected", "ci", "//...", "--files", "PACKAGE.ts", "--plan"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.roots).toEqual(expect.arrayContaining(["//:generated", "//:check"]))
    expect(result.data.targets.filter((target: { label: string }) => target.label === "//:generated")).toHaveLength(1)
  })

  it("retains the declaration snapshot and receipt when an affected gate skips independently", async () => {
    const root = await packageFixture()
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
const check = Target.make("UnavailableReview", {
  attrs: Schema.Struct({}), kinds: ["test"], success: Schema.Void,
  error: LlmLint.ModelCliMissing,
  implementation: () => Node.fail(new LlmLint.ModelCliMissing({
    engine: "codex", executable: "missing-review-host", message: "review host unavailable"
  }))
})({})
export const Package = S.Package({ targets: { check } })
`
    )
    const result = await jsonCommand(root, [
      "affected",
      "test",
      "//:check",
      "--files",
      "PACKAGE.ts",
      "--verbose",
      "--no-cache",
      "--results-file",
      "receipt.json"
    ])
    expect(result.exitCode, result.envelope + result.stderr).toBe(1)
    expect(result.envelope).toContain("targets_failed")
    expect(result.envelope).toContain("1 of 1 targets failed")
    expect(result.stderr).toContain("missing-review-host CLI is not installed")
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, "receipt.json"), "utf8"))).toMatchObject({
      ok: false,
      version: 1,
      counts: { failed: 1, skipped: 0 },
      results: [{ label: "//:check", status: "failed" }]
    })
  })

  it("keeps a missing host executable refusal in an affected plan", async () => {
    const root = await packageFixture()
    const workspace = await Fs.readFile(NodePath.join(root, "WORKSPACE.ts"), "utf8")
    await write(
      root,
      "WORKSPACE.ts",
      workspace.replace("nodeModules:", "host: S.Host({ bins: [\"smithers-absent-cli-9f8e\"] }), nodeModules:")
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ bin: S.Host.bin("smithers-absent-cli-9f8e"), args: [] }) } })
`
    )
    const result = await jsonCommand(root, ["affected", "test", "//:check", "--files", "PACKAGE.ts", "--plan"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.targets[0].refusal).toContain("smithers-absent-cli-9f8e")
  })

  it("retains child repository refusals through inspection and affected aliases", async () => {
    const root = await packageFixture()
    const workspace = await Fs.readFile(NodePath.join(root, "WORKSPACE.ts"), "utf8")
    await write(
      root,
      "WORKSPACE.ts",
      workspace.replace("nodeModules:", "repos: { child: S.LocalRepository(\"child\") }, nodeModules:")
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import { Schema } from "effect"
const child = S.Repo.Target("child", "//:test")
const emptyAlias = Target.make("Alias", { attrs: Schema.Unknown, kinds: ["test"], implementation: () => Target.notImplemented("Alias") })({})
export const Package = S.Package({ targets: { child, alias: S.Alias(child), emptyAlias } })
`
    )
    await write(root, "child/WORKSPACE.ts", "throw new Error(\"deliberate child workspace refusal\")\n")
    const query = await jsonCommand(root, ["query", "//:child"])
    expect(query.exitCode, query.envelope).toBe(0)
    expect(query.data.targets[0].refusal).toEqual(expect.any(String))
    const graph = await jsonCommand(root, ["graph", "//:child"])
    expect(graph.exitCode, graph.envelope).toBe(0)
    expect(graph.envelope).toContain("refusal")
    for (const label of ["//:child", "//:alias"]) {
      const affected = await jsonCommand(root, ["affected", "test", label, "--files", "PACKAGE.ts", "--list"])
      expect(affected.exitCode, affected.envelope).toBe(1)
      expect(affected.envelope).toContain("child")
    }
    const emptyAlias = await jsonCommand(root, ["affected", "test", "//:emptyAlias", "--files", "PACKAGE.ts", "--list"])
    expect(emptyAlias.exitCode, emptyAlias.envelope).toBe(0)
    expect(emptyAlias.data.targets).toEqual([expect.objectContaining({ label: "//:emptyAlias" })])
  }, 120_000)

  it("preserves install overrides while refusing an unsupported package manager", async () => {
    const root = await packageFixture()
    const workspace = await Fs.readFile(NodePath.join(root, "WORKSPACE.ts"), "utf8")
    await write(
      root,
      "WORKSPACE.ts",
      workspace.replace(
        "runtime: S.Runtime.Node({ version: \"26\" })",
        "runtime: S.Runtime.Bun({ version: \">=1.4.0\" })"
      ).replace(
        "S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file(\"//yarn.lock\") })",
        "S.PackageManager.BunPackages({ runtime: S.Runtime.Bun({ version: \">=1.4.0\" }) })"
      )
    )
    await write(root, "bun.lock", "{}\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { install: S.Install({ lockfilePath: "bun.lock" }) } })
`
    )
    const result = await jsonCommand(root, ["install", "--cache-dir", ".install-cache"], (config) => ({
      ...config,
      cacheUrl: "http://127.0.0.1:1",
      environment: { ...config.environment, SMITHERS_CACHE_TOKEN: "fixture-default-read-token" }
    }))
    expect(result.exitCode).toBe(1)
    expect(`${result.envelope}${result.stderr}`, result.envelope + result.stderr).toContain("unsupported")
    expect(`${result.envelope}${result.stderr}`).not.toContain("fixture-default-read-token")
  })

  it("includes the real evaluated Nix environment in a public plan", async () => {
    const root = await packageFixture()
    const workspace = await Fs.readFile(NodePath.join(root, "WORKSPACE.ts"), "utf8")
    await write(
      root,
      "WORKSPACE.ts",
      workspace.replace(
        "nodeModules:",
        "environment: S.Nix.Environment({ file: S.file(\"//environment.nix\") }), host: S.Host({ bins: [\"sh\"] }), nodeModules:"
      )
    )
    await write(
      root,
      "environment.nix",
      `builtins.derivation {
outputs=["out"];name="cli-environment";system=builtins.currentSystem;builder="/bin/bash";
args=["-c" "eval \\\"$buildCommand\\\""];
buildCommand="/bin/mkdir -p \\\"$out\\\"";
PATH="/usr/bin:/bin";SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt";
}`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { good: S.Shell.Test({ bin: S.Host.bin("sh"), args: ["-c", "true"], sandbox: "none" }) } })
`
    )
    const result = await jsonCommand(root, ["ci", "//...", "--plan"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.targets[0].nixEnvironment.path).toEqual(["/usr/bin", "/bin"])
  }, 120_000)

  it("explains a bundler key whose final identity depends on its resolved graph", async () => {
    const root = await packageFixture()
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bundler = S.Bundler.Rspack({ config: S.file("//bundler.mjs") })
const graph = bundler.resolve({ entries: ["main.ts"], universe: [] })
const build = bundler.build({ environment: "web", mode: "development", graph, outDirs: ["out"] })
export const Package = S.Package({ targets: { graph, build } })
`
    )
    await write(root, "bundler.mjs", "export default {}\n")
    await write(root, "main.ts", "export const value = 1\n")
    const result = await jsonCommand(root, ["show", "target", "//:build"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.cache.executionKey).toBe("depends-on-runtime-graph")
    expect(result.data.dependencies).toContain("//:graph")
  })

  it("refuses an empty CI selector supplied through the public MCP boundary", async () => {
    const root = await packageFixture()
    const cli = makeCli({ environment: { ...process.env, NO_COLOR: "1" } })
    const commands = Cli.toCommands.get(cli as never)
    expect(commands).toBeDefined()
    const tool = Mcp.collectTools(commands!, ["build"]).find((entry) => entry.name === "build_ci")
    expect(tool).toBeDefined()
    const result = await Mcp.callTool(tool!, { patterns: [], workspace: root })
    expect(result.isError).toBe(true)
    expect(result.content.map((entry) => entry.text).join("\n")).toContain("VALIDATION_ERROR")
    expect(result.content.map((entry) => entry.text).join("\n")).toContain("expected array to have >=1 items")
  })
  it("reports and retires real action rows while retaining other durable files", async () => {
    const root = await packageFixture()
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  sources: S.Filegroup({ srcs: [S.file("README.md")] })
} })
`
    )
    const empty = await jsonCommand(root, ["cache", "status"])
    expect(empty.exitCode, empty.envelope).toBe(0)
    expect(empty.data).toMatchObject({
      scope: "local-action-results",
      exists: false,
      entries: 0,
      bytes: 0,
      remote: null
    })
    expect((await jsonCommand(root, ["target", "//:sources"])).exitCode).toBe(0)
    await write(root, ".flows/artifacts/retained.txt", "retained")
    const populated = await jsonCommand(root, ["cache", "status"])
    expect(populated.exitCode, populated.envelope).toBe(0)
    expect(populated.data).toMatchObject({ exists: true, entries: 1 })
    expect(populated.data.bytes).toBeGreaterThan(0)
    for (const entry of await CacheAdmin.entries(root, ".flows")) {
      await Fs.utimes(entry.path, new Date(0), new Date(0))
    }
    const preview = await jsonCommand(root, ["cache", "prune", "--older-than-days", "1", "--dry-run"])
    expect(preview.exitCode, preview.envelope).toBe(0)
    expect(preview.data).toMatchObject({ candidates: 1, removed: 0, dryRun: true })
    const refused = await jsonCommand(root, ["cache", "clear"])
    expect(refused.exitCode).toBe(1)
    expect(refused.data).toMatchObject({ code: "cache_clear_failed" })
    expect(refused.envelope).toContain("requires --yes")
    expect(await CacheAdmin.entries(root, ".flows")).toHaveLength(1)
    const pruned = await jsonCommand(root, ["cache", "prune", "--older-than-days", "1", "--yes"])
    expect(pruned.exitCode, pruned.envelope).toBe(0)
    expect(pruned.data).toMatchObject({ candidates: 1, removed: 1, dryRun: false })
    expect((await jsonCommand(root, ["cache", "status"])).data).toMatchObject({ entries: 0, bytes: 0 })
    expect((await jsonCommand(root, ["target", "//:sources"])).exitCode).toBe(0)
    const clearPreview = await jsonCommand(root, ["cache", "clear", "--dry-run"])
    expect(clearPreview.data).toMatchObject({ candidates: 1, removed: 0 })
    const cleared = await jsonCommand(root, ["cache", "clear", "--yes"])
    expect(cleared.exitCode, cleared.envelope).toBe(0)
    expect(cleared.data).toMatchObject({ candidates: 1, removed: 1 })
    expect(await Fs.readFile(NodePath.join(root, ".flows/artifacts/retained.txt"), "utf8")).toBe("retained")
  }, 120_000)

  it.each(["show", "info"])("%s reports the resolved workspace and supplied CLI identity", async (command) => {
    const root = await packageFixture()
    const result = await jsonCommand(
      root,
      [...(command === "show" ? ["show", "workspace"] : ["info"]), "--cache-dir", ".inspection"],
      (config) => ({ ...config, cliName: "fixture-inspector", cliVersion: "9.8.7" })
    )
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data).toMatchObject({
      name: "fixture",
      root,
      packages: 1,
      targets: 6,
      cli: { name: "fixture-inspector", version: "9.8.7" }
    })
    expect(result.data.cache.directory).toBe(NodePath.join(root, ".inspection/cache"))
  })

  it("reports its default identity and preserves an explicitly featured target", async () => {
    const root = await packageFixture()
    const source = await Fs.readFile(NodePath.join(root, "PACKAGE.ts"), "utf8")
    await write(
      root,
      "PACKAGE.ts",
      source.replace("shell: \"true\"", "shell: \"true\", summary: \"A featured check\", featured: true")
    )
    const info = await jsonCommand(root, ["info"])
    expect(info.exitCode, info.envelope).toBe(0)
    expect(info.data.cli).toEqual({ name: "smithers-build", version: expect.any(String) })
    const query = await jsonCommand(root, ["query", "//:good"])
    expect(query.exitCode, query.envelope).toBe(0)
    expect(query.data.targets).toEqual([expect.objectContaining({ summary: "A featured check", featured: true })])
  })

  it("shows cache candidates without treating inspection as execution", async () => {
    const root = await packageFixture()
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  sources: S.Filegroup({ srcs: [S.file("README.md")] }),
  hello: S.Shell.Run({ shell: "true" })
} })
`
    )
    const declaration = await Fs.readFile(NodePath.join(root, "PACKAGE.ts"), "utf8")
    await write(
      root,
      "PACKAGE.ts",
      declaration.replace("S.Package({ targets:", "S.Package({ owners: { owners: [\"maintainer\"] }, targets:")
    )
    const missing = await jsonCommand(root, ["show", "target", "//:sources"])
    expect(missing.exitCode, missing.envelope).toBe(0)
    expect(missing.data).toMatchObject({
      label: "//:sources",
      rule: "Filegroup",
      cache: { cacheable: true, local: "miss", remote: "not-probed" }
    })
    expect(missing.data.cache.reason).toContain("No successful local result")
    expect(missing.data.owners).toHaveLength(1)
    expect(JSON.stringify(missing.data.owners)).toContain("maintainer")
    expect(await CacheAdmin.entries(root, ".flows")).toEqual([])
    const cache = await openCache({ workspaceRoot: root })
    try {
      for (
        const row of [
          { label: "//:sources", target: "Filegroup", exitOk: false },
          { label: "//:other", target: "Filegroup", exitOk: true },
          { label: "//:sources", target: "Other", exitOk: true }
        ]
      ) {
        await cache.put(missing.data.cache.key, {
          key: missing.data.cache.key,
          ...row,
          storedAt: new Date().toISOString(),
          output: null
        }, { shared: false })
        const refused = await jsonCommand(root, ["show", "target", "//:sources"])
        expect(refused.exitCode, refused.envelope).toBe(0)
        expect(refused.data.cache.local).toBe("miss")
      }
    } finally {
      await cache.close()
    }
    expect((await jsonCommand(root, ["target", "//:sources"])).exitCode).toBe(0)
    const hit = await jsonCommand(root, ["explain", "//:sources"])
    expect(hit.exitCode, hit.envelope).toBe(0)
    expect(hit.data.cache).toMatchObject({ local: "candidate", key: missing.data.cache.key })
    expect(hit.data.cache.storedAt).toEqual(expect.any(String))
    expect(hit.data.cache.reason).toContain("execution still validates")
    const uncached = await jsonCommand(root, ["show", "target", "//:hello", "--verb", "run"])
    expect(uncached.exitCode, uncached.envelope).toBe(0)
    expect(uncached.data.cache).toMatchObject({ cacheable: false, local: "miss", reason: "Target is not cacheable" })
    for (const args of [["show", "target", "//..."], ["explain", "//..."]]) {
      const ambiguous = await jsonCommand(root, args)
      expect(ambiguous.exitCode).toBe(1)
      expect(ambiguous.envelope).toContain("requires one exact or default target")
    }
  }, 120_000)

  it("reports configured remote metadata without probing its endpoint", async () => {
    const root = await packageFixture()
    const result = await jsonCommand(root, ["cache", "status"], (config) => ({
      ...config,
      cacheUrl: "https://cache.example.invalid"
    }))
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.remote.health).toBe("not-probed")
    expect(new URL(result.data.remote.endpoint).origin).toBe("https://cache.example.invalid")
    expect(result.data.entries).toBe(0)
  })

  it.each(["deps", "rdeps", "owners"])("refuses an ambiguous %s query", async (operation) => {
    const root = await packageFixture()
    const result = await jsonCommand(root, ["query", `${operation}(//...)`])
    expect(result.exitCode).toBe(1)
    expect(result.envelope).toContain(`${operation}() requires one exact or default target`)
  })

  it("includes a dependency on the workspace root in an ownership query", async () => {
    const root = await packageFixture()
    await write(
      root,
      "child/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../PACKAGE.ts"
export const Package = S.Package({ owners: { owners: ["child-owner"], upstream: "review" }, targets: { command: S.Shell.Test({ shell: "true", data: [root.good] }) } })
`
    )
    const result = await jsonCommand(root, ["query", "owners(//child:command)"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(result.data.upstream).toEqual(["//"])
    expect(result.data.owners).toEqual(expect.arrayContaining([expect.objectContaining({ owner: "child-owner" })]))
  })

  it("renders root ownership and target tables through the human terminal ports", async () => {
    const root = await packageFixture()
    for (
      const args of [
        ["query", "owners(//:good)"],
        ["targets", "//..."],
        ["owners", "README.md"],
        ["index", "//..."],
        ["graph", "//..."]
      ]
    ) {
      const result = await serve(root, [...args, "--audience", "human", "--ui", "tty"], true, (config) => ({
        ...config,
        environment: { ...config.environment, TERM: "xterm-256color", NO_COLOR: undefined, FORCE_COLOR: "1" }
      }))
      expect(result.exitCode, result.envelope).toBe(0)
      expect(result.stdout.length).toBeGreaterThan(0)
      expect(result.envelope).toBe("")
    }
    const missing = await jsonCommand(root, ["owners"])
    expect(missing.exitCode).toBe(1)
    expect(missing.envelope).toContain("owners needs at least one path")
    const executed = await serve(root, ["test", "//:good", "--audience", "human", "--ui", "tty"], true, (config) => ({
      ...config,
      environment: { ...config.environment, TERM: "xterm-256color", NO_COLOR: undefined, FORCE_COLOR: "1" }
    }))
    expect(executed.exitCode, executed.envelope).toBe(0)
    expect(executed.stderr).toContain("//:good")
    expect(executed.envelope).toBe("")
  }, 120_000)

  it("refuses an approval pattern that selects several targets", async () => {
    const root = await packageFixture()
    await expect(approvalRevision("//...", { workspace: root, cacheDir: ".inspection" }, {
      environment: process.env
    })).rejects.toThrow(/selects \d+ targets; name one/)
  })

  it("refuses inspection and cache commands outside a workspace without creating state", async () => {
    const root = await temporary("smthrs-cli-no-workspace-")
    const before = await Fs.readdir(root)
    for (
      const args of [
        ["cache", "status"],
        ["cache", "prune"],
        ["cache", "clear"],
        ["show", "workspace"],
        ["info"],
        ["targets"],
        ["explain", "//:none"],
        ["graph", "//..."],
        ["index", "//..."],
        ["owners", "none"],
        ["affected", "test", "//...", "--files", "none"],
        ["watch", "test", "//...", "--once"],
        ["git-hooks"],
        ["review", "//...", "--policy-revision", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
      ]
    ) {
      const result = await jsonCommand(root, args)
      expect(result.exitCode, result.envelope).toBe(1)
      expect(result.envelope).toContain(args[0] === "review" ? "No workspace found" : "not a workspace")
    }
    expect(await Fs.readdir(root)).toEqual(before)
  })
})

describe("scoped CLI host faults", () => {
  it("refuses a successful MCP plan when its empty receipt cannot be finalized", async () => {
    const root = await packageFixture("exit 19")
    const handles = new Set<Parameters<typeof cliServicesLive.writeFile>[0]>()
    const cli = makeCli({
      environment: { ...process.env, NO_COLOR: "1" },
      services: Layer.succeed(CliServices, {
        ...cliServicesLive,
        writeFile: (file) => {
          handles.add(file)
          return Effect.fail(new Error("plan receipt storage unavailable"))
        }
      })
    })
    const commands = Cli.toCommands.get(cli as never)!
    const tool = Mcp.collectTools(commands, ["build"]).find((entry) => entry.name === "build_test")!
    expect(tool).toBeDefined()
    const result = await Mcp.callTool(tool, {
      patterns: ["//:good"],
      workspace: root,
      plan: true,
      resultsFile: "plan-receipt.json"
    })
    expect(result.isError).toBe(true)
    expect(result.content.map((entry) => entry.text).join("\n")).toContain("plan receipt storage unavailable")
    expect(handles.size).toBe(1)
    for (const handle of handles) expect(handle.fd).toBe(-1)
  })

  it("refuses a declaration that disappears after root discovery without changing another invocation", async () => {
    const root = await packageFixture()
    const services = Layer.succeed(CliServices, {
      ...cliServicesLive,
      workspaceFileOf: () => Effect.succeed(undefined)
    })
    const [faulted, ordinary] = await Promise.allSettled([
      openPackageIndex({ workspace: root }, { services }),
      openPackageIndex({ workspace: root })
    ])
    expect(faulted).toMatchObject({
      status: "rejected",
      reason: { message: "not a workspace; create .smithers/WORKSPACE.ts" }
    })
    expect(ordinary.status).toBe("fulfilled")
    if (ordinary.status === "fulfilled") expect(ordinary.value.targets()).toHaveLength(6)
    expect(await Fs.readFile(NodePath.join(root, "WORKSPACE.ts"), "utf8")).toContain("S.Workspace")
  })

  it("keeps a host read failure intact when its signal has not been aborted", async () => {
    const root = await packageFixture()
    const reason = new Error("workspace host unavailable")
    await expect(openPackageIndex({ workspace: root }, {
      signal: new AbortController().signal,
      services: Layer.succeed(CliServices, {
        ...cliServicesLive,
        findWorkspaceRoot: () => Effect.fail(reason)
      })
    })).rejects.toBe(reason)
  })

  it("cancels a pending host discovery with its caller's reason", async () => {
    const root = await packageFixture()
    const entered = await Effect.runPromise(Deferred.make<void>())
    const controller = new AbortController()
    const reason = new Error("cancelled workspace discovery")
    const pending = openPackageIndex({ workspace: root }, {
      signal: controller.signal,
      services: Layer.succeed(CliServices, {
        ...cliServicesLive,
        findWorkspaceRoot: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      })
    })
    await Effect.runPromise(Deferred.await(entered))
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it("refuses a pre-aborted discovery before acquiring its host layer", async () => {
    const root = await packageFixture()
    let acquired = 0
    const controller = new AbortController()
    const reason = new Error("already cancelled")
    controller.abort(reason)
    await expect(openPackageIndex({ workspace: root }, {
      signal: controller.signal,
      services: Layer.effect(
        CliServices,
        Effect.sync(() => {
          acquired++
          return cliServicesLive
        })
      )
    })).rejects.toBe(reason)
    expect(acquired).toBe(0)
  })

  it.each(["transient", "permanent", "non-error", "partial"])(
    "reports a %s receipt-write failure and closes its native descriptor",
    async (mode) => {
      const root = await packageFixture()
      const handles = new Set<Parameters<typeof cliServicesLive.writeFile>[0]>()
      const attempted: Array<string> = []
      const message = "receipt storage unavailable"
      const reason = mode === "non-error" ? message : new Error(message)
      const services = Layer.succeed(CliServices, {
        ...cliServicesLive,
        writeFile: (file, source) => {
          handles.add(file)
          attempted.push(source)
          if (mode === "transient" && attempted.length > 1) return cliServicesLive.writeFile(file, source)
          if (mode === "partial") {
            return Effect.promise(() => file.writeFile(source.slice(0, 10))).pipe(Effect.andThen(Effect.fail(reason)))
          }
          return Effect.fail(reason)
        }
      })
      const result = await jsonCommand(root, ["test", "//:good", "--results-file", "receipt.json"], (config) => ({
        ...config,
        services
      }))
      expect(result.exitCode).toBe(1)
      expect(result.envelope).toContain(message)
      expect(JSON.parse(attempted[0]!)).toMatchObject({ ok: true, results: [{ label: "//:good", status: "ran" }] })
      expect(handles.size).toBe(1)
      for (const handle of handles) {
        expect(handle.fd).toBe(-1)
        await expect(handle.stat()).rejects.toThrow()
      }
      const source = await Fs.readFile(NodePath.join(root, "receipt.json"), "utf8")
      if (mode === "transient") {
        expect(attempted).toHaveLength(2)
        expect(JSON.parse(source)).toEqual({ results: [], version: 1 })
      } else if (mode === "partial") {
        expect(attempted).toHaveLength(1)
        expect(() => JSON.parse(source)).toThrow()
      } else {
        expect(attempted).toHaveLength(2)
        expect(source).toBe("")
      }
    },
    60_000
  )

  it("writes an empty receipt for a plan without running its failing body", async () => {
    const root = await packageFixture("exit 19")
    const result = await jsonCommand(root, ["test", "//:good", "--plan", "--results-file", "planned.json"])
    expect(result.exitCode, result.envelope).toBe(0)
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, "planned.json"), "utf8"))).toEqual({
      results: [],
      version: 1
    })
  })
})

describe("PACKAGE.ts branches", () => {
  it("refuses the retired application scaffold without creating files", async () => {
    const root = await packageFixture()
    const before = await Fs.readdir(root)
    const result = await serve(root, ["create-app", "retired-app"], false)
    expect(result.exitCode).not.toBe(0)
    expect(await Fs.readdir(root)).toEqual(before)
    await expect(Fs.stat(NodePath.join(root, "retired-app"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("shows human watch progress without duplicating successful child envelopes", async () => {
    const root = await packageFixture()
    const good = await serve(root, ["watch", "test", "//:good", "--once"], true)
    expect(good.exitCode).toBe(0)
    expect(good.stderr).toContain("//:good")
    expect(good.stderr).toContain("Watch cycle 1 complete")
    expect(good.stderr).not.toContain("durationMs:")
    expect(good.stderr).not.toContain("counts:")
    const bad = await serve(root, ["watch", "test", "//:bad", "--once"], true)
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain("Watch cycle 1 failed")
    expect(bad.stderr).toContain("targets_failed")
  })

  it("keeps agent target execution quiet on a PTY and includes useful follow-up commands", async () => {
    const root = await packageFixture()
    const served = await serve(root, ["//:good", "--audience", "agent", "--ui", "tty"], true)
    expect(served.exitCode).toBe(0)
    expect(served.stderr).toBe("")
    expect(served.envelope).toContain("ok: true")
    expect(served.envelope).toContain("explain")
    expect(served.envelope).toContain("cache status")
    expect(served.envelope).toContain(root)
  })

  it("keeps explicitly encoded human results structured while showing progress", async () => {
    const root = await packageFixture()
    const served = await serve(root, ["//:good", "--json"], true, (config) => ({
      ...config,
      presentation: Audience.resolve({ env: {}, audience: "human", stdout: true, stderr: true })
    }))
    expect(served.exitCode).toBe(0)
    expect(served.stdout).toBe("")
    expect(() => JSON.parse(served.envelope)).not.toThrow()
    expect(served.stderr).toContain("Running //:good")
    expect(served.stderr).not.toContain("\u001b[")
  })

  it("answers deps() with the closure, visiting a shared member once, and refuses a pattern", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const closure = await serve(root, ["query", "deps(//:all)", "--ui", "tty"], true)
    expect(closure.exitCode).toBe(0)
    expect(closure.stdout).toBe("//:all depends on 3 targets\n  //:bad\n  //:good\n  //:pair\n")
    pretendTTY(false)
    const refused = await serve(root, ["query", "deps(//...)"], false)
    expect(refused.exitCode).toBe(1)
    expect(refused.envelope).toContain("deps() requires one exact or default target")
  })

  it("rejects malformed and repeated --input flags before running anything", async () => {
    const root = await packageFixture()
    const malformed = await serve(root, ["//:good", "--input", "novalue"], false)
    expect(malformed.exitCode).toBe(1)
    expect(malformed.envelope).toContain("--input expects name=value")
    const repeated = await serve(root, ["//:good", "--input", "a=1", "--input", "a=2"], false)
    expect(repeated.exitCode).toBe(1)
    expect(repeated.envelope).toMatch(/names .*a.* twice/)
  })

  it("honours --cache-dir over the declared cache directory", async () => {
    const root = await packageFixture()
    const served = await serve(root, ["//:good", "--cache-dir", "alt-cache", "--ui", "plain"], false)
    expect(served.exitCode).toBe(0)
    await expect(Fs.stat(NodePath.join(root, "alt-cache"))).resolves.toBeDefined()
  })

  it("returns the plan envelope under a human renderer and the mermaid envelope for graph", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const plan = await serve(root, ["//:good", "--plan", "--ui", "tty"], true)
    expect(plan.exitCode).toBe(0)
    expect(plan.envelope).toContain("rule: Shell.Test")
    expect(plan.stderr).toBe("")
    const graph = await serve(root, ["graph", "//:all", "--mermaid", "--ui", "tty"], true)
    expect(graph.exitCode).toBe(0)
    expect(graph.stdout).toBe("")
    // PACKAGE.ts execution used to accept --mermaid and render the text tree anyway,
    // labelling the envelope `format: text`. The flag now renders a flowchart
    // in both modes, and the envelope says which one it carries.
    expect(graph.envelope).toContain("format: mermaid")
    expect(graph.envelope).toContain("flowchart LR")
  })

  it("falls back to the structured error on a red human run when no exit hook exists", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const served = await serve(root, ["//:bad", "--ui", "stream"], true, (config) => ({ ...config, exit: undefined }))
    expect(served.exitCode).toBe(1)
    expect(served.recorded).toBeUndefined()
    expect(served.envelope).toContain("Error (targets_failed): 1 of 1 targets failed")
    expect(served.stderr).toContain("//:bad  failed")
    expect(served.stderr).not.toContain("\u001b[")
  })

  it("runs ci and docs through the PACKAGE.ts index", async () => {
    const root = await packageFixture()
    for (const verb of ["ci", "docs"]) {
      const served = await serve(root, [verb, "//:docs"], false)
      expect(served.exitCode).toBe(0)
      expect(served.envelope).toContain("ok: true")
    }
    const planned = await serve(root, ["ci", "//:docs", "--plan"], false)
    expect(planned.exitCode).toBe(0)
    expect(planned.envelope).toContain("verb: ci")
    expect(planned.envelope).toContain("label: \"//:docs\"")
    expect(planned.envelope).not.toContain("rule:")
  })

  it("plans and runs disjoint exact CI targets through their supported verbs", async () => {
    const root = await packageFixture()
    const planned = await serve(root, ["ci", "//:good", "//:docs", "--plan", "--format", "json"], false)
    expect(planned.exitCode, planned.envelope).toBe(0)
    const plan = JSON.parse(planned.envelope) as {
      readonly roots: ReadonlyArray<string>
      readonly targets: ReadonlyArray<{ readonly label: string }>
    }
    expect([...plan.roots].sort()).toEqual(["//:docs", "//:good"])
    expect(plan.targets.map((target) => target.label).sort()).toEqual(["//:docs", "//:good"])

    const executed = await serve(root, ["ci", "//:good", "//:docs", "--format", "json"], false)
    expect(executed.exitCode, executed.envelope).toBe(0)
    const summary = JSON.parse(executed.envelope) as {
      readonly ok: boolean
      readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
    }
    expect(summary.ok).toBe(true)
    expect(summary.results.map((result) => result.label).sort()).toEqual(["//:docs", "//:good"])
    expect(summary.results.every((result) => result.status === "ran")).toBe(true)
  })

  it("refuses a mixed CI command when an exact target supports no CI verb", async () => {
    const root = await packageFixture("mkdir -p .flows/tmp; printf good > .flows/tmp/good-ran.log")
    const marker = NodePath.join(root, ".flows", "tmp", "good-ran.log")
    const patterns = ["ci", "//:good", "//:hello"]

    const planned = await serve(root, [...patterns, "--plan", "--format", "json"], false)
    const executed = await serve(root, [...patterns, "--format", "json"], false)
    expect.soft(planned.exitCode, "plan must refuse").toBe(1)
    expect.soft(planned.envelope.includes("//:hello"), "plan must name hello").toBe(true)
    expect.soft(planned.envelope.includes("does not support"), "plan must explain refusal").toBe(true)
    expect.soft(executed.exitCode, "execution must refuse").toBe(1)
    expect.soft(executed.envelope.includes("//:hello"), "execution must name hello").toBe(true)
    expect.soft(executed.envelope.includes("does not support"), "execution must explain refusal").toBe(true)
    expect.soft(executed.envelope.includes("\"counts\":"), "execution must not report run counts").toBe(false)
    await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })

    const control = await serve(root, ["ci", "//:good", "--format", "json"], false)
    expect(control.exitCode, control.envelope).toBe(0)
    expect(await Fs.readFile(marker, "utf8")).toBe("good")
  })

  it("runs a repeated exact CI selector once", async () => {
    const root = await packageFixture()
    const executed = await serve(root, ["ci", "//:good", "//:good", "--format", "json"], false)
    expect(executed.exitCode, executed.envelope).toBe(0)
    const summary = JSON.parse(executed.envelope) as {
      readonly results: ReadonlyArray<{ readonly label: string }>
    }
    expect(summary.results.map((result) => result.label)).toEqual(["//:good"])
  })

  it("deduplicates a CI target selected by both an exact label and a recursive wildcard", async () => {
    const root = await packageFixture()
    const patterns = ["ci", "//:good", "//...:good", "//:docs"]
    const planned = await serve(root, [...patterns, "--plan", "--format", "json"], false)
    expect(planned.exitCode, planned.envelope).toBe(0)
    const plan = JSON.parse(planned.envelope) as { readonly roots: ReadonlyArray<string> }
    expect([...plan.roots].sort()).toEqual(["//:docs", "//:good"])

    const executed = await serve(root, [...patterns, "--format", "json"], false)
    expect(executed.exitCode, executed.envelope).toBe(0)
    const summary = JSON.parse(executed.envelope) as {
      readonly results: ReadonlyArray<{ readonly label: string }>
    }
    expect(summary.results.map((result) => result.label).sort()).toEqual(["//:docs", "//:good"])
  })

  it("still rejects an unsupported single verb and an unknown CI label", async () => {
    const root = await packageFixture()
    const unsupported = await serve(root, ["docs", "//:good", "--plan"], false)
    expect(unsupported.exitCode).toBe(1)
    expect(unsupported.envelope).toContain("does not support the docs verb")

    const unknown = await serve(root, ["ci", "//:good", "//:missing", "--plan"], false)
    expect(unknown.exitCode).toBe(1)
    expect(unknown.envelope).toContain("//:missing")
  })
})
