import { Smithers as S } from "@smthrs/targets"
import * as OwnersTarget from "@smthrs/targets/Owners"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/Cli.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as RepoResolution from "../src/RepoResolution.ts"
import type * as Reporter from "../src/Reporter.ts"
import * as TestUnits from "../src/TestUnits.ts"

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const serveCli = async (
  root: string | undefined,
  args: ReadonlyArray<string>,
  opts: {
    readonly audience?: "human" | "agent"
    readonly isTTY?: boolean
    readonly passExit?: boolean
    readonly env?: Readonly<Record<string, string | undefined>>
  } = {}
) => {
  let stdout = ""
  let stderr = ""
  let exitCode = 0
  const term = (sink: (t: string) => void): Reporter.Terminal => ({
    write: sink,
    isTTY: opts.isTTY ?? false,
    columns: 100
  })
  const fullArgs = root === undefined ? [...Cli.normalizeArgv(args)] : [...Cli.normalizeArgv(args), "--workspace", root]
  await Cli.makeCli({
    environment: {
      ...process.env,
      SMITHERS_AUDIENCE: opts.audience ?? "agent",
      NO_COLOR: opts.isTTY ? undefined : "1",
      CI: undefined,
      ...(opts.env ?? {})
    },
    stdout: term((t) => {
      stdout += t
    }),
    stderr: term((t) => {
      stderr += t
    }),
    ...(opts.passExit
      ? {
        exit: (c: number) => {
          exitCode = c
        }
      }
      : {})
  }).serve(fullArgs, {
    exit: (c) => {
      exitCode = c
    },
    stdout: (t) => {
      stdout += t
    }
  })
  return { exitCode, stdout, stderr }
}

describe("BuildCliWave9E Cli, PackageLoader, PackageDiscovery, GitCommit, RepoResolution, TestUnits, InstalledTree", () => {
  it(
    "Cli commands: cache clear/status, show workspace, info, affected, units, bench regression, remote/results errors",
    async () => {
      await withTempDir("wave9e-cli-", async (dir) => {
        const nonWs = NodePath.join(dir, "empty")
        await Fs.mkdir(nonWs, { recursive: true })

        // Commands outside a workspace -> not a workspace error paths
        for (
          const cmd of [
            ["cache", "status"],
            ["cache", "clear", "--yes"],
            ["show", "workspace"],
            ["info"],
            ["affected", "--base", "HEAD", "--plan"]
          ]
        ) {
          const res = await serveCli(nonWs, cmd)
          expect(res.exitCode !== 0 || res.stdout.includes("error") || res.stderr.length > 0).toBe(true)
        }

        // Create a minimal real workspace with a fast passing test, failing test, and bench target
        const ws = NodePath.join(dir, "ws")
        await Fs.mkdir(NodePath.join(ws, ".smithers"), { recursive: true })
        await Fs.mkdir(NodePath.join(ws, "pkg"), { recursive: true })
        NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
        // Point @smthrs/targets & effect via symlinked node_modules so PACKAGE.ts imports resolve instantly
        const repoRoot = NodePath.resolve(import.meta.dirname, "../../../../..")
        await Fs.symlink(NodePath.join(repoRoot, "node_modules"), NodePath.join(ws, "node_modules"))

        await Fs.writeFile(
          NodePath.join(ws, ".smithers", "WORKSPACE.ts"),
          `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("wave9e", {
  repository: "git+https://github.com/org/wave9e.git",
  cache: S.Cache({ directory: ".cache" }),
  owners: { owners: ["root-owner"] }
})
`
        )
        await Fs.writeFile(
          NodePath.join(ws, "pkg", "PACKAGE.ts"),
          `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({
  targets: {
  ok: S.Shell.Test({ shell: "echo ok", sandbox: "none" }),
  fail: S.Shell.Test({ shell: "echo boom >&2; exit 1", sandbox: "none" }),
  bench: S.Shell.Test({
    shell: 'echo "BENCH_METRIC {\\"name\\":\\"op\\",\\"hz\\":100,\\"meanMs\\":10}"',
    sandbox: "none"
  })
},
  owners: {
    owners: ["pkg-owner"],
    upstream: { mode: "approve", packages: ["//pkg/..."] }
  }
})
`
        )
        NodeChildProcess.execFileSync("jj", ["new", "-m", "init"], { cwd: ws, stdio: "ignore" })

        // show workspace & info (human + TTY + agent)
        const showHuman = await serveCli(ws, ["show", "workspace"], { audience: "human", isTTY: true })
        expect(showHuman.stdout.length).toBeGreaterThan(0)
        const showAgent = await serveCli(ws, ["show", "workspace"], { audience: "agent" })
        expect(showAgent.stdout.length).toBeGreaterThan(0)
        const infoRes = await serveCli(ws, ["info"], { audience: "human" })
        expect(infoRes.stdout.length).toBeGreaterThan(0)
        const ownersRes = await serveCli(ws, ["owners", "pkg/PACKAGE.ts"], { audience: "agent" })
        expect(ownersRes.stdout.length).toBeGreaterThan(0)

        // cache clear without --yes (error) & with --dry-run & with --yes
        const clearErr = await serveCli(ws, ["cache", "clear"])
        expect(clearErr.exitCode !== 0 || clearErr.stdout.includes("error")).toBe(true)
        const clearDry = await serveCli(ws, ["cache", "clear", "--dry-run"])
        if (clearDry.exitCode !== 0) throw new Error(`clearDry failed: ${clearDry.stdout} | ${clearDry.stderr}`)
        const clearYes = await serveCli(ws, ["cache", "clear", "--yes"])
        expect(clearYes.exitCode).toBe(0)

        // test --remote unknown -> CommandRefused
        const badRemote = await serveCli(ws, ["test", "//pkg:ok", "--remote", "nope"])
        expect(badRemote.exitCode !== 0 || badRemote.stdout.includes("error")).toBe(true)

        // test --results-file pointing to a directory -> results file error
        const resDir = NodePath.join(dir, "results-is-dir")
        await Fs.mkdir(resDir, { recursive: true })
        const badResultsFile = await serveCli(ws, ["test", "//pkg:ok", "--results-file", resDir])
        expect(badResultsFile.exitCode !== 0 || badResultsFile.stdout.includes("results file")).toBe(true)

        // test --results-file valid file + human failure with config.exit(1)
        const validResults = NodePath.join(dir, "results.json")
        const okRun = await serveCli(ws, ["test", "//pkg:ok", "--results-file", validResults], {
          audience: "human",
          passExit: true
        })
        expect(okRun.exitCode).toBe(0)
        const failHuman = await serveCli(ws, ["test", "//pkg:fail"], { audience: "human", passExit: true })
        expect(failHuman.exitCode).toBe(1)

        // affected --base HEAD --plan --shard 0/2 + --lifecycle experimental
        await Fs.writeFile(NodePath.join(ws, "pkg", "extra.txt"), "touched\n")
        const affPlan = await serveCli(ws, ["affected", "--base", "HEAD", "--plan", "--shard", "0/2"])
        expect(affPlan.stdout.length).toBeGreaterThan(0)
        const affLife = await serveCli(ws, ["affected", "--base", "HEAD", "--plan", "--lifecycle", "experimental"])
        expect(affLife.stdout.length).toBeGreaterThan(0)

        // units failure path
        const unitsFail = await serveCli(ws, ["units", "//pkg:ok"])
        expect(unitsFail.exitCode !== 0 || unitsFail.stdout.includes("units_failed")).toBe(true)

        // bench regression: baseline hz=1000 vs current hz=100 -> -90% regression (human + agent!)
        const baseBench = NodePath.join(dir, "baseline-bench.json")
        await Fs.writeFile(
          baseBench,
          JSON.stringify({
            results: [
              {
                label: "//pkg:bench",
                status: "ran",
                benchmarks: [{ name: "op", hz: 1000, meanMs: 1 }]
              }
            ]
          })
        )
        const benchHuman = await serveCli(
          ws,
          ["test", "//pkg:bench", "--baseline", baseBench, "--fail-on-regression", "5"],
          { audience: "human", passExit: true }
        )
        expect(benchHuman.exitCode).toBe(1)
        const benchAgent = await serveCli(
          ws,
          ["test", "//pkg:bench", "--baseline", baseBench, "--fail-on-regression", "5"],
          { audience: "agent" }
        )
        expect(benchAgent.exitCode !== 0 || benchAgent.stdout.includes("bench_regression")).toBe(true)

        // approvalRevision on target without approval: "required"
        await expect(Cli.approvalRevision("//pkg:ok", { workspace: ws }, {})).rejects.toThrow(/approval/)
      })
    },
    120_000
  )

  it("PackageLoader errors, PackageDiscovery limits, GitCommit, RepoResolution, TestUnits, InstalledTree", async () => {
    await withTempDir("wave9e-mods-", async (dir) => {
      const ws = NodePath.join(dir, "ws")
      const outside = NodePath.join(dir, "outside.ts")
      await Fs.mkdir(NodePath.join(ws, ".smithers"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "pkg"), { recursive: true })
      await Fs.writeFile(outside, `export const o = 1\n`)
      const repoRoot = NodePath.resolve(import.meta.dirname, "../../../../..")
      await Fs.symlink(NodePath.join(repoRoot, "node_modules"), NodePath.join(ws, "node_modules"))

      await Fs.writeFile(
        NodePath.join(ws, ".smithers", "WORKSPACE.ts"),
        `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("w9e2", {
  repository: "git+https://github.com/org/w9e2.git",
  cache: S.Cache({ directory: ".cache" })
})
`
      )

      // 1) PackageLoader: module_outside_workspace
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "PACKAGE.ts"),
        `import { o } from "../../outside.ts"\nexport default { o }\n`
      )
      const disc1 = await PackageDiscovery.discover(ws)
      await expect(PackageLoader.load(disc1)).rejects.toThrow()

      // 2) PackageLoader: unsupported_module_specifier (importing WORKSPACE.ts)
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "PACKAGE.ts"),
        `import { Workspace } from "../.smithers/WORKSPACE.ts"\nexport default Workspace\n`
      )
      await expect(PackageLoader.load(disc1)).rejects.toThrow()

      // 3) PackageLoader: package_export_missing (default export is a number, not S.Package)
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "PACKAGE.ts"),
        `export default 42\n`
      )
      await expect(PackageLoader.load(disc1)).rejects.toThrow()

      // 4) PackageLoader: Target as default export instead of S.Package
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "PACKAGE.ts"),
        `import { Smithers as S } from "@smthrs/targets"\nexport default S.Shell.Test({ shell: "true" })\n`
      )
      await expect(PackageLoader.load(disc1)).rejects.toThrow()

      // 5) PackageLoader: escaped import string decoding + loadAt
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "helper.ts"),
        `export const tag = "ok\\n\\r\\t"\n`
      )
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "PACKAGE.ts"),
        `import { Smithers as S } from "@smthrs/targets"\nimport { tag } from "./helper.ts"\nexport const Package = S.Package({ targets: { t: S.Shell.Test({ shell: "echo " + JSON.stringify(tag), sandbox: "none" }) } })\n`
      )
      const graph = await PackageLoader.load(disc1)
      expect(graph.packages.length).toBeGreaterThanOrEqual(1)
      const revGraph = await PackageLoader.loadAt(disc1, {
        changed: new Set(["pkg/helper.ts"]),
        texts: new Map([["pkg/helper.ts", `export const tag = "rev2"\n`]]),
        files: [".smithers/WORKSPACE.ts", "pkg/PACKAGE.ts", "pkg/helper.ts"]
      }, () => ({}))
      expect(revGraph.packages.length).toBeGreaterThanOrEqual(1)

      // 6) InstalledTree: measure on missing dir, regular file, symlink, nested dirs
      const treeDir = NodePath.join(dir, "tree")
      await Fs.mkdir(NodePath.join(treeDir, "a", "b"), { recursive: true })
      await Fs.writeFile(NodePath.join(treeDir, "a", "f.txt"), "hello")
      await Fs.symlink("f.txt", NodePath.join(treeDir, "a", "lnk.txt"))
      const m1 = await InstalledTree.measure(treeDir)
      expect(m1).toMatch(/^[a-f0-9]{64}$/)
      expect(typeof (await InstalledTree.measure(NodePath.join(dir, "no-such-tree")))).toBe("string")

      // 7) TestUnits: not_one_target & not_units
      const idx = PackageIndex.make(graph, ws)
      await expect(
        TestUnits.command({
          index: idx,
          pattern: "//pkg:t",
          cacheDirectory: ".cache",
          list: true,
          environment: process.env
        } as never)
      ).rejects.toThrow()

      // 8) RepoResolution: gitState on non-git dir & resolver on unknown repo
      const rr = RepoResolution.resolver(idx, process.env)
      expect(rr).toBeDefined()
      const gs = await RepoResolution.gitState(rr, { absolutePath: ws } as never)
      expect(gs.dirty).toBe(true)

      // 9) GitCommit: error paths (not a git repo / invalid branch)
      await expect(
        GitCommit.commit({
          root: ws,
          branch: "bad..branch",
          title: "t",
          body: "b",
          candidate: { root: ws, changed: [] },
          gate: { run: async () => ({ ok: true, failures: [] }) }
        } as never)
      ).rejects.toThrow()
    })
  }, 120_000)
})
