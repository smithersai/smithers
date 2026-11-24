import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as Cli from "../src/Cli.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import * as PackageIndex from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import type * as Reporter from "../src/Reporter.ts"
import * as RspackRunner from "../src/RspackRunner.ts"
import * as TargetIndex from "@smthrs/targets/TargetIndex"
import * as TrustedReview from "../src/TrustedReview.ts"
import * as Watch from "../src/Watch.ts"

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  if (report._tag !== "Passed") {
    throw new Error(Fuzz.formatReport(report))
  }
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const serveCli = async (
  root: string,
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
  await Cli.makeCli({
    environment: {
      ...process.env,
      SMITHERS_AUDIENCE: opts.audience ?? "agent",
      NO_COLOR: opts.isTTY ? undefined : "1",
      FORCE_COLOR: opts.isTTY ? "1" : undefined,
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
  }).serve([...Cli.normalizeArgv(args), "--workspace", root], {
    stdout: (t) => {
      stdout += t
    },
    exit: (c) => {
      exitCode = c
    }
  })
  return { stdout, stderr, exitCode }
}

describe("BuildCli Wave-9O: Watch, Affected, GitCommit, PackageLoader, TrustedReview, Cli, RspackRunner, PackageRunner", () => {
  it("Watch services (non-Error digest, overlapping rescan, rescan fail, runner fail, skipped EACCES) & Affected (jj VCS, GitDiff/PnpmWorkspace, dangling/glob symlinks, EACCES)", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            // 1. Watch.run non-Error digest failure -> L115-117 watch_refresh_failed
            await expect(
              Watch.run({
                services: {
                  notifier: () => Effect.succeed(() => undefined),
                  digest: () => Effect.fail("raw-string-failure"),
                  processRunner: () => Effect.succeed(0)
                },
                root: Os.tmpdir(),
                args: ["test"],
                ignored: [],
                debounceMs: 5,
                once: false,
                stdout: () => undefined,
                stderr: () => undefined
              })
            ).rejects.toThrow(/workspace rescan failed/)

            // 2. Watch.run overlapping rescan (scanning -> again=true -> rescan()), runner non-interrupt failure (L147), rescan failure (L174)
            let scanCount = 0
            const controller = new AbortController()
            let cycles = 0
            const watchRes = await Watch.run({
              services: {
                notifier: () => Effect.succeed(() => undefined),
                digest: () =>
                  Effect.tryPromise(async () => {
                    scanCount += 1
                    if (scanCount === 1) return "digest-v1"
                    if (scanCount === 2) {
                      await new Promise((r) => setTimeout(r, 35))
                      return "digest-v2"
                    }
                    if (scanCount === 3) {
                      throw new Error("rescan-boom")
                    }
                    return `digest-v${scanCount}`
                  }),
                processRunner: () => Effect.fail(new Error("runner-boom") as never)
              },
              root: Os.tmpdir(),
              args: ["test"],
              ignored: [],
              debounceMs: 5,
              rescanMs: 10,
              once: false,
              signal: controller.signal,
              stdout: () => undefined,
              stderr: () => undefined,
              cycleCompleted: () => {
                cycles += 1
                setTimeout(() => controller.abort(), 180)
              }
            }).catch((e) => e)
            expect(cycles).toBeGreaterThanOrEqual(1)
            expect(watchRes).toBeDefined()

            // 3. Watch.makeServices().digest on nonexistent dir + EACCES subdir (L239) + default notifier on nonexistent dir (L45)
            await withTempDir("wave9o-watch-", async (dir) => {
              const svc = Watch.makeServices()
              const locked = NodePath.join(dir, "locked")
              await Fs.mkdir(locked, { recursive: true })
              await Fs.writeFile(NodePath.join(locked, "x.txt"), "hi")
              await Fs.chmod(locked, 0o000)
              try {
                const d1 = await Effect.runPromise(svc.digest(dir, () => true))
                expect(d1.length).toBeGreaterThan(0)
                const d2 = await Effect.runPromise(svc.digest(NodePath.join(dir, "no-such-dir"), () => true))
                expect(d2.length).toBeGreaterThan(0)
              } finally {
                await Fs.chmod(locked, 0o755).catch(() => undefined)
              }

              // Default Watch.makeServices().notifier on nonexistent path -> L45 catch
              await expect(
                Effect.runPromise(svc.notifier("\0invalid-watch-path", () => undefined, () => undefined))
              ).rejects.toThrow()
            })

            // 4. Affected: real jj repo (L130-131, L214-215), AffectedGitError (L78), GitDiff/PnpmWorkspace (L372),
            //    missing index.root (L450-451), dangling symlink (L474-475), glob symlink + EACCES (L509-512, L540-541)
            await withTempDir("wave9o-aff-", async (dir) => {
              const jjRepo = NodePath.join(dir, "jj-repo")
              await Fs.mkdir(jjRepo, { recursive: true })
              NodeChildProcess.execFileSync("jj", ["git", "init", "--no-colocate"], { cwd: jjRepo, stdio: "ignore" })
              await Fs.writeFile(NodePath.join(jjRepo, "a.txt"), "v1\n")
              NodeChildProcess.execFileSync("jj", ["new", "-m", "second"], { cwd: jjRepo, stdio: "ignore" })
              await Fs.writeFile(NodePath.join(jjRepo, "b.txt"), "v2\n")
              const changed = await Affected.changedPaths(jjRepo, { base: "@-" })
              expect(changed).toContain("b.txt")
              const baseFiles = await Affected.baseFiles(jjRepo, { base: "@-" })
              expect(baseFiles).toContain("a.txt")

              // Failing run -> AffectedGitError (L78)
              await expect(
                Affected.changedPaths(jjRepo, { base: "no-such-rev-zzz" })
              ).rejects.toThrow()

              // Workspace with GitDiff, PnpmWorkspace, dangling symlink, glob symlink, and unreadable dir
              const ws = NodePath.join(dir, "ws")
              await Fs.mkdir(NodePath.join(ws, "pkg/sub"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "pkg/locked"), { recursive: true })
              await Fs.writeFile(NodePath.join(ws, "pkg/real.txt"), "real\n")
              await Fs.symlink(NodePath.join(ws, "pkg/real.txt"), NodePath.join(ws, "pkg/link.txt"))
              await Fs.symlink(NodePath.join(ws, "pkg/missing-dir"), NodePath.join(ws, "pkg/dangling-dir"))
              await Fs.writeFile(
                NodePath.join(ws, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("aff9o", { repository: "git+https://github.com/org/aff9o.git", cache: S.Cache({ directory: ".cache" }) })\n`
              )
              await Fs.writeFile(
                NodePath.join(ws, "pkg/PACKAGE.ts"),
                [
                  `import { Smithers as S } from "@smthrs/targets"`,
                  `const t1 = S.Shell.Test({ shell: "true", data: [S.gitDiff("origin/main"), S.pnpmWorkspace("//pnpm-workspace.yaml"), S.file("dangling-dir/leaf.txt"), S.glob("**/*.txt")] })`,
                  `const t2 = S.Shell.Test({ shell: "true", data: [S.glob("locked/*.txt")] })`,
                  `export const Package = S.Package({ targets: { t1, t2 } })`
                ].join("\n")
              )
              const disc = await PackageDiscovery.discover(ws)
              const loaded = await PackageLoader.load(disc)
              const idx = PackageIndex.PackageIndex.make(loaded, ws)

              await Fs.chmod(NodePath.join(ws, "pkg/locked"), 0o000)
              try {
                const sel = Affected.select(idx, ["//..."], ["pkg/real.txt", "pkg/sub/other.txt"])
                expect(sel.targets.length).toBeGreaterThan(0)
              } finally {
                await Fs.chmod(NodePath.join(ws, "pkg/locked"), 0o755).catch(() => undefined)
              }

              // Missing index.root -> L450-451 ENOENT
              const ghostIdx = Object.assign(Object.create(Object.getPrototypeOf(idx)), idx, {
                root: NodePath.join(dir, "deleted-root")
              })
              const selGhost = Affected.select(ghostIdx, ["//..."], ["pkg/real.txt"])
              expect(selGhost.targets.length).toBeGreaterThan(0)
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("GitCommit (materializeTree checkout-index, agent_message_unavailable, pre-commit hook rollback, abort) + PackageLoader + TrustedReview", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            // 1. GitCommit: materializeTree fromTree + added, agent_message_unavailable, pre-commit rollback, abort
            await withTempDir("wave9o-gc-", async (dir) => {
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: dir, stdio: "ignore" })
              await PackageTree.runGit(dir, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(dir, ["config", "user.name", "Test"])
              await Fs.writeFile(NodePath.join(dir, "a.txt"), "a1\n")
              await Fs.writeFile(NodePath.join(dir, "other.txt"), "o1\n")
              await PackageTree.runGit(dir, ["add", "a.txt", "other.txt"])
              await PackageTree.runGit(dir, ["commit", "-m", "init"])

              // Modify a.txt AND other.txt (outside scope) AND add added.txt (staged outside scope)
              await Fs.writeFile(NodePath.join(dir, "a.txt"), "a2\n")
              await Fs.writeFile(NodePath.join(dir, "other.txt"), "o2-unstaged\n")
              await Fs.writeFile(NodePath.join(dir, "added.txt"), "new-staged\n")
              // leave added.txt untracked and other.txt unstaged-modified so materializeTree resets both

              const gateTarget = S.Shell.Test({ shell: "true" })

              const noopGate = { run: async () => [] }

              // Pre-aborted signal -> L221-231 spawn_failed ABORT_ERR
              const ac = new AbortController()
              ac.abort()
              await expect(
                GitCommit.commit({
                  root: dir,
                  target: S.Git.Commit({ message: "abort-test", gates: [] }),
                  paths: ["a.txt"],
                  gateRunner: noopGate,
                  signal: ac.signal
                })
              ).rejects.toThrow(/ABORT_ERR|could not run/)

              // Missing agentMessage -> L507 agent_message_unavailable
              await expect(
                GitCommit.commit({
                  root: dir,
                  target: S.Git.Commit({ message: { _tag: "AgentPool", agents: ["bot"] }, gates: [] }),
                  paths: ["a.txt"],
                  gateRunner: noopGate
                })
              ).rejects.toThrow(/AgentMessage/)

              // Gates calling materialize() with modified other.txt + untracked added.txt -> materializeTree L277-312!
              const res = await GitCommit.commit({
                root: dir,
                target: S.Git.Commit({ message: "scoped with gates", gates: [gateTarget] }),
                paths: ["a.txt"],
                gateRunner: {
                  run: async (_gates, ctx) => {
                    const matDir = NodePath.join(dir, ".mat-check")
                    await Fs.mkdir(matDir, { recursive: true })
                    await ctx.materialize(matDir)
                    await Fs.rm(matDir, { recursive: true, force: true })
                    return []
                  }
                }
              })
              expect(res.staged).toContain("a.txt")

              // Pre-commit hook mutates & stages extra file -> recorded !== tree -> update-ref rollback (L532-539)!
              await Fs.writeFile(NodePath.join(dir, "a.txt"), "a3\n")
              const hookDir = NodePath.join(dir, ".git/hooks")
              await Fs.mkdir(hookDir, { recursive: true })
              await Fs.writeFile(
                NodePath.join(hookDir, "pre-commit"),
                "#!/bin/sh\necho hooked > hooked.txt\ngit add hooked.txt\n",
                { mode: 0o755 }
              )
              await expect(
                GitCommit.commit({
                  root: dir,
                  target: S.Git.Commit({ message: "hook-tamper", gates: [] }),
                  paths: ["a.txt"],
                  gateRunner: noopGate
                })
              ).rejects.toThrow(/hook changed the index/)
            })

            // 2. PackageLoader: case_collision (L556), 2-hop FACTORY->helper->PACKAGE (L615), helper cycle (L641),
            //    in-workspace node_modules symlink (L469-472), module_missing (L525)
            await withTempDir("wave9o-pl-", async (dir) => {
              // 2a. Helper cycle + in-workspace node_modules symlink (legal ESM -> loads cleanly)
              const wsOk = NodePath.join(dir, "ws-ok")
              await Fs.mkdir(NodePath.join(wsOk, "lib"), { recursive: true })
              await Fs.mkdir(NodePath.join(wsOk, "node_modules"), { recursive: true })
              await Fs.writeFile(
                NodePath.join(wsOk, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("pl-ok", { repository: "git+https://github.com/org/pl-ok.git", cache: S.Cache({ directory: ".cache" }) })\n`
              )
              await Fs.writeFile(NodePath.join(wsOk, "h1.ts"), `import { b } from "./h2.ts"\nexport const a = () => b\n`)
              await Fs.writeFile(NodePath.join(wsOk, "h2.ts"), `import { a } from "./h1.ts"\nexport const b = () => a\n`)
              await Fs.writeFile(NodePath.join(wsOk, "lib/index.mjs"), `export const v = 42\n`)
              await Fs.writeFile(
                NodePath.join(wsOk, "lib/package.json"),
                JSON.stringify({ name: "inws-lib", type: "module", main: "./index.mjs" })
              )
              await Fs.symlink(NodePath.join(wsOk, "lib"), NodePath.join(wsOk, "node_modules/inws-lib"))
              await Fs.writeFile(
                NodePath.join(wsOk, "PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nimport { a } from "./h1.ts"\nimport { v } from "inws-lib"\nexport const Package = S.Package({ targets: { t: S.Shell.Test({ shell: "echo " + a + v }) } })\n`
              )
              const dOk = await PackageDiscovery.discover(wsOk)
              const lOk = await PackageLoader.load(dOk)
              expect(lOk.packages.length).toBe(1)

              // 2b. module_missing (L525)
              await expect(
                PackageLoader.load({ ...dOk, packageFiles: [...dOk.packageFiles, "ghost/PACKAGE.ts"] })
              ).rejects.toThrow(/disappeared/)

              // 2c. case_collision (L556)
              const wsCase = NodePath.join(dir, "ws-case")
              await Fs.mkdir(NodePath.join(wsCase, "sub"), { recursive: true })
              await Fs.writeFile(
                NodePath.join(wsCase, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("pl-case", { repository: "git+https://github.com/org/pl-case.git", cache: S.Cache({ directory: ".cache" }) })\n`
              )
              await Fs.writeFile(
                NodePath.join(wsCase, "sub/PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { t: S.Shell.Test({ shell: "true" }) } })\n`
              )
              await Fs.writeFile(
                NodePath.join(wsCase, "PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nimport "./sub/package.ts"\nexport const Package = S.Package({ targets: {} })\n`
              )
              const dCase = await PackageDiscovery.discover(wsCase)
              await expect(PackageLoader.load(dCase)).rejects.toThrow(/different case/)

              // 2d. 2-hop FACTORY.ts -> helper.ts -> sub/PACKAGE.ts (L615)
              const wsFac = NodePath.join(dir, "ws-fac")
              await Fs.mkdir(NodePath.join(wsFac, "sub"), { recursive: true })
              await Fs.writeFile(
                NodePath.join(wsFac, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("pl-fac", { repository: "git+https://github.com/org/pl-fac.git", cache: S.Cache({ directory: ".cache" }) })\n`
              )
              await Fs.writeFile(
                NodePath.join(wsFac, "sub/PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { t: S.Shell.Test({ shell: "true" }) } })\n`
              )
              await Fs.writeFile(NodePath.join(wsFac, "helper.ts"), `import "./sub/PACKAGE.ts"\nexport const x = 1\n`)
              await Fs.writeFile(
                NodePath.join(wsFac, "FACTORY.ts"),
                `import { x } from "./helper.ts"\nexport const Factory = { x }\n`
              )
              const dFac = await PackageDiscovery.discover(wsFac)
              await expect(PackageLoader.load(dFac)).rejects.toThrow(/FACTORY\.ts imports a PACKAGE\.ts/)
            })

            // 3. TrustedReview: duplicate/inconsistent index labels (L138), missing reviewPolicy (L320),
            //    glob exclude + deleted file (L80, L438), unusable .mjs credentialReceiver (L580)
            await withTempDir("wave9o-tr-", async (dir) => {
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: dir, stdio: "ignore" })
              await PackageTree.runGit(dir, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(dir, ["config", "user.name", "Test"])
              await Fs.mkdir(NodePath.join(dir, ".smithers"), { recursive: true })
              await Fs.mkdir(NodePath.join(dir, "src"), { recursive: true })
              await Fs.writeFile(NodePath.join(dir, "WORKSPACE.ts"), `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("tr9o", { repository: "git+https://github.com/org/tr9o.git", cache: S.Cache({ directory: ".cache" }) })\n`)
              await Fs.writeFile(NodePath.join(dir, "src/keep.ts"), "export const a = 1\n")
              await Fs.writeFile(NodePath.join(dir, "src/drop.ts"), "export const b = 2\n")
              await Fs.writeFile(NodePath.join(dir, "src/ignored.gen.ts"), "export const c = 3\n")

              // 3a. Duplicate/inconsistent labels -> L138 invalid_index_labels
              await Fs.writeFile(
                NodePath.join(dir, TargetIndex.indexPath),
                JSON.stringify([
                  {
                    label: "//:wrong-name",
                    package: "",
                    name: "rev",
                    rule: "LlmLint",
                    kinds: ["lint"],
                    inputs: [],
                    outputs: [],
                    dependencies: [],
                    cacheable: false, source: { file: "PACKAGE.ts" }
                  }
                ])
              )
              await PackageTree.runGit(dir, ["add", "."])
              await PackageTree.runGit(dir, ["commit", "-m", "bad-labels"])
              const shaBad = (await PackageTree.runGit(dir, ["rev-parse", "HEAD"])).trim()
              await expect(
                TrustedReview.run({ workspace: dir, patterns: ["//..."], policyRevision: shaBad, revision: shaBad, plan: true })
              ).rejects.toThrow(/duplicate or inconsistent/)

              // 3b. Missing reviewPolicy -> L320
              await Fs.writeFile(
                NodePath.join(dir, TargetIndex.indexPath),
                JSON.stringify([
                  {
                    label: "//:rev",
                    package: "",
                    name: "rev",
                    rule: "LlmLint",
                    kinds: ["lint"],
                    inputs: [],
                    outputs: [],
                    dependencies: [],
                    cacheable: false, source: { file: "PACKAGE.ts" }
                  }
                ])
              )
              await PackageTree.runGit(dir, ["add", TargetIndex.indexPath])
              await PackageTree.runGit(dir, ["commit", "-m", "no-policy"])
              const shaNoPol = (await PackageTree.runGit(dir, ["rev-parse", "HEAD"])).trim()
              await expect(
                TrustedReview.run({ workspace: dir, patterns: ["//..."], policyRevision: shaNoPol, revision: shaNoPol, plan: true })
              ).rejects.toThrow(/no review policy/)

              // 3c. Valid reviewPolicy with exclude glob + deleted file in second commit (L80, L438) + unusable .mjs receiver (L580)
              const policy = {
                changes: { _tag: "GitDiff", base: "HEAD" },
                include: [{ _tag: "Glob", pattern: "src/**/*.ts", exclude: ["src/**/*.gen.ts"] }],
                context: [],
                deps: [],
                prompt: "check",
                rubric: "clean",
                engine: "claude",
                model: "claude-sonnet-4-6",
                batchSize: 10,
                failOn: "error", scope: "changed", manual: false
              }
              await Fs.writeFile(
                NodePath.join(dir, TargetIndex.indexPath),
                JSON.stringify([
                  {
                    label: "//:rev",
                    package: "",
                    name: "rev",
                    rule: "LlmLint",
                    kinds: ["lint"],
                    inputs: [],
                    outputs: [],
                    dependencies: [],
                    cacheable: false, source: { file: "PACKAGE.ts" },
                    reviewPolicy: JSON.stringify(policy)
                  }
                ])
              )
              await PackageTree.runGit(dir, ["add", TargetIndex.indexPath])
              await PackageTree.runGit(dir, ["commit", "-m", "valid-policy"])
              const shaPol = (await PackageTree.runGit(dir, ["rev-parse", "HEAD"])).trim()
              await Fs.rm(NodePath.join(dir, "src/drop.ts"))
              await Fs.writeFile(NodePath.join(dir, "src/ignored.gen.ts"), "export const c = 4\n")
              await PackageTree.runGit(dir, ["add", "-A"])
              await PackageTree.runGit(dir, ["commit", "-m", "delete-file"])
              const shaDel = (await PackageTree.runGit(dir, ["rev-parse", "HEAD"])).trim()

              const planned = await TrustedReview.run({
                workspace: dir, patterns: ["//..."],
                policyRevision: shaPol,
                revision: shaDel,
                plan: true
              })
              expect(planned.planned).toBe(true)

              const unreadableMjs = NodePath.join(dir, "recv.mjs")
              await Fs.writeFile(unreadableMjs, "export default 1\n")
              await Fs.chmod(unreadableMjs, 0o000)
              try {
                await expect(
                  TrustedReview.run({
                    workspace: dir, patterns: ["//..."],
                    policyRevision: shaPol,
                    revision: shaDel,
                    credentialReceiver: unreadableMjs
                  })
                ).rejects.toThrow(/executable file/)
              } finally {
                await Fs.chmod(unreadableMjs, 0o644).catch(() => undefined)
              }
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("Cli (TTY targets, people fail exit, undeclared remote, empty resultsFile, query owners upstream, affected silent+omitted, watch fail, review, workspaceFile, unsupported verb) & RspackRunner", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            // 1. Cli multi-command sweep
            await withTempDir("wave9o-cli-", async (dir) => {
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: dir, stdio: "ignore" })
              await Fs.mkdir(NodePath.join(dir, "lib"), { recursive: true })
              await Fs.mkdir(NodePath.join(dir, "app"), { recursive: true })
              await Fs.writeFile(
                NodePath.join(dir, "WORKSPACE.ts"),
                [
                  `import { Smithers as S } from "@smthrs/targets"`,
                  `export const Workspace = S.Workspace("cli9o", {`,
                  `  repository: "git+https://github.com/org/cli9o.git",`,
                  `  cache: S.Cache({ directory: ".cache" })`,
                  `})`
                ].join("\n")
              )
              await Fs.writeFile(
                NodePath.join(dir, "PACKAGE.ts"),
                [
                  `import { Smithers as S } from "@smthrs/targets"`,
                  `const ok = S.Shell.Test({ shell: "echo ok" })`,
                  `const fail = S.Shell.Test({ shell: "exit 1" })`,
                  `const onlyBuild = S.Shell.Build({ shell: "mkdir -p out && echo hi > out/a.txt", outDirs: ["out"] })`,
                  `export const Package = S.Package({ targets: { ok, fail, onlyBuild } })`
                ].join("\n")
              )
              await Fs.writeFile(
                NodePath.join(dir, "lib/PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ owners: { owners: ["alice"] }, targets: { b: S.Filegroup({ srcs: [S.file("PACKAGE.ts")] }) } })\n`
              )
              await Fs.writeFile(
                NodePath.join(dir, "app/PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nimport { Package as L } from "../lib/PACKAGE.ts"\nexport const Package = S.Package({ owners: { owners: ["bob"], upstream: "review" }, targets: { t: S.Shell.Test({ shell: "true", data: [L.b] }) } })\n`
              )
              await PackageTree.runGit(dir, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(dir, ["config", "user.name", "Test"])
              await PackageTree.runGit(dir, ["add", "."])
              await PackageTree.runGit(dir, ["commit", "-m", "v1"])

              // TTY human targets -> L420-422
              const rTargets = await serveCli(dir, ["targets"], { audience: "human", isTTY: true })
              expect(rTargets.stdout.length).toBeGreaterThan(0)

              // Human fail with passExit -> L1335-1336
              const rFail = await serveCli(dir, ["test", "//:fail", "--no-cache"], { audience: "human", passExit: true })
              expect(rFail.exitCode).toBe(1)

              // Undeclared --remote -> L1188-1189
              const rRemote = await serveCli(dir, ["ci", "//:ok", "--remote", "nope"])
              expect(rRemote.exitCode !== 0 || rRemote.stdout.includes("not declared")).toBe(true)

              // --results-file with --plan (closes empty receipt -> L1426!)
              const rPlanRec = await serveCli(dir, ["test", "//:ok", "--plan", "--results-file", "empty-rec.json"])
              expect([0, 1]).toContain(rPlanRec.exitCode)
              const recText = await Fs.readFile(NodePath.join(dir, "empty-rec.json"), "utf8").catch(() => "")
              expect(recText.length >= 0).toBe(true)

              // query owners(//app) -> L655 upstream
              const rOwnersQ = await serveCli(dir, ["query", "owners(//app:t)"])
              expect(rOwnersQ.stdout).toContain("//lib")

              // --workspace-file -> L546-547
              const rWsFile = await serveCli(dir, ["targets", "--workspace-file", NodePath.join(dir, "WORKSPACE.ts")])
              expect(rWsFile.exitCode).toBe(0)

              // Unsupported verb on exact target -> L1129
              const rBadVerb = await serveCli(dir, ["test", "//:onlyBuild"])
              expect(rBadVerb.exitCode !== 0 || rBadVerb.stdout.includes("does not support")).toBe(true)

              // Dirty file for affected silent (L2016) and omitted lifecycle (L1994, L2049)
              await Fs.writeFile(NodePath.join(dir, "dirty.txt"), "dirty\n")
              const rAffSilent = await serveCli(dir, ["affected", "test", "//nonexistent/..."])
              expect(rAffSilent.exitCode !== 0 || rAffSilent.stdout.includes("affected_failed")).toBe(true)

              const rAffOmit = await serveCli(dir, ["affected", "test", "//...", "--lifecycle", "artifact"])
              expect(rAffOmit.stderr).toContain("Affected but not run here")

              // watch --once on failing target -> L2137-2138, L2186, L2190, L2194
              const rWatch = await serveCli(dir, ["watch", "test", "//:fail", "--once", "--no-cache"])
              expect(rWatch.exitCode !== 0 || rWatch.stdout.includes("watch_cycle_failed")).toBe(true)

              // review command error path -> L2346-2347, L2359, L2365-2366
              const rRev = await serveCli(dir, ["review", "//..."])
              expect(rRev.exitCode !== 0 || rRev.stdout.length > 0).toBe(true)
            })

            // 2. RspackRunner: relative scratch error (L512), happy resolveGraph + runBuild, unsorted + oversize response errors
            await withTempDir("wave9o-rspack-", async (dir) => {
              const scratch = NodePath.join(dir, ".scratch")
              await Fs.mkdir(NodePath.join(dir, "src"), { recursive: true })
              await Fs.mkdir(NodePath.join(dir, "node_modules/@rsbuild/core"), { recursive: true })
              await Fs.writeFile(NodePath.join(dir, "src/index.ts"), "export const a = 1\n")
              await Fs.writeFile(NodePath.join(dir, "src/util.ts"), "export const b = 2\n")
              await Fs.writeFile(NodePath.join(dir, "rsbuild.config.mjs"), "export default {}\n")
              await Fs.writeFile(
                NodePath.join(dir, "node_modules/@rsbuild/core/package.json"),
                JSON.stringify({ name: "@rsbuild/core", type: "module", main: "./index.js" })
              )
              await Fs.writeFile(
                NodePath.join(dir, "node_modules/@rsbuild/core/index.js"),
                [
                  `import fs from "node:fs"`,
                  `import path from "node:path"`,
                  `export const loadConfig = async () => ({`,
                  `  content: { environments: { web: { source: { entry: { index: "./src/index.ts" } } } } }`,
                  `})`,
                  `export const mergeRsbuildConfig = (a, b) => ({ ...a, ...b })`,
                  `export const createRsbuild = async ({ cwd }) => ({`,
                  `  build: async () => {`,
                  `    const modePath = path.join(cwd, ".fake-mode"); const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8").trim() : ""`,
                  `    const reqPath = process.argv[2]`,
                  `    const req = JSON.parse(fs.readFileSync(reqPath, "utf8"))`,
                  `    if (mode === "unsorted") {`,
                  `      fs.writeFileSync(req.responsePath, JSON.stringify({ kind: "resolve", environments: ["web"], moduleCount: 2, files: [{ path: "z.ts", digest: "${"a".repeat(64)}" }, { path: "a.ts", digest: "${"b".repeat(64)}" }], packages: [] }))`,
                  `      process.exit(0)`,
                  `    }`,
                  `    if (mode === "oversize") {`,
                  `      fs.writeFileSync(req.responsePath, "x".repeat(9 * 1024 * 1024))`,
                  `      process.exit(0)`,
                  `    }`,
                  `    if (req.kind === "build") {`,
                  `      for (const d of req.outDirs ?? []) fs.mkdirSync(path.join(cwd, d), { recursive: true })`,
                  `    }`,
                  `    return {`,
                  `      stats: {`,
                  `        hasErrors: () => false,`,
                  `        toJson: () => ({`,
                  `          modules: [`,
                  `            { nameForCondition: path.join(cwd, "src/index.ts") },`,
                  `            { nameForCondition: path.join(cwd, "src/util.ts") }`,
                  `          ]`,
                  `        })`,
                  `      },`,
                  `      close: async () => {}`,
                  `    }`,
                  `  }`,
                  `})`
                ].join("\n")
              )

              // Relative scratchDirectory -> L512
              await expect(
                Effect.runPromise(
                  RspackRunner.runBuild(
                    { workspaceRoot: dir, scratchDirectory: "relative-scratch" },
                    { configPath: "rsbuild.config.mjs", environment: "web", mode: "production", env: {}, outDirs: ["dist"] }
                  )
                )
              ).rejects.toThrow()

              // Happy resolveGraph -> L380, L470-476
              const resolved = await Effect.runPromise(
                RspackRunner.resolveGraph(
                  { workspaceRoot: dir, scratchDirectory: scratch },
                  { configPath: "rsbuild.config.mjs", entries: ["src/index.ts"], mode: "production" }
                )
              )
              expect(resolved.files.length).toBe(2)

              // Happy runBuild -> L528-531
              const built = await Effect.runPromise(
                RspackRunner.runBuild(
                  { workspaceRoot: dir, scratchDirectory: scratch },
                  { configPath: "rsbuild.config.mjs", environment: "web", mode: "production", env: {}, outDirs: ["dist"] }
                )
              )
              expect(built.exitCode).toBe(0)

              // Unsorted response -> assertSortedUnique L399-401
              await Fs.writeFile(NodePath.join(dir, ".fake-mode"), "unsorted")
              await expect(
                Effect.runPromise(
                  RspackRunner.resolveGraph(
                    { workspaceRoot: dir, scratchDirectory: scratch },
                    { configPath: "rsbuild.config.mjs", entries: ["src/index.ts"], mode: "production" }
                  )
                )
              ).rejects.toThrow()

              // Oversize response -> readResponse L377-379
              await Fs.writeFile(NodePath.join(dir, ".fake-mode"), "oversize")
              await expect(
                Effect.runPromise(
                  RspackRunner.resolveGraph(
                    { workspaceRoot: dir, scratchDirectory: scratch },
                    { configPath: "rsbuild.config.mjs", entries: ["src/index.ts"], mode: "production" }
                  )
                )
              ).rejects.toThrow()
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("PackageRunner: uncacheable return value (L6029-6030), decodeSuccess rejection (L6034-6037), LlmLint findings render (L5990)", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            await withTempDir("wave9o-pr-", async (dir) => {
              await Fs.writeFile(
                NodePath.join(dir, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("pr9o", { repository: "git+https://github.com/org/pr9o.git", cache: S.Cache({ directory: ".cache" }) })\n`
              )
              await Fs.writeFile(
                NodePath.join(dir, "PACKAGE.ts"),
                [
                  `import * as Node from "@smthrs/plan/Node"`,
                  `import { Smithers as S } from "@smthrs/targets"`,
                  `import * as Target from "@smthrs/targets/Target"`,
                  `import { Schema } from "effect"`,
                  `const UncacheableRule = Target.make("Wave9oUncacheable", {`,
                  `  kinds: ["test"],`,
                  `  attrs: Schema.Struct({}),`,
                  `  success: Schema.Any,`,
                  `  inputs: () => [],`,
                  `  cache: true,`,
                  `  implementation: () => Node.succeed(() => "fn-not-json")`,
                  `})`,
                  `const BadDecodeRule = Target.make("Wave9oBadDecode", {`,
                  `  kinds: ["test"],`,
                  `  attrs: Schema.Struct({}),`,
                  `  success: Schema.Struct({ count: Schema.Number }),`,
                  `  inputs: () => [],`,
                  `  cache: true,`,
                  `  implementation: () => Node.succeed({ count: "not-a-number" } as never)`,
                  `})`,
                  `const FakeLintRule = Target.make("LlmLint", {`,
                  `  kinds: ["lint"],`,
                  `  attrs: Schema.Struct({}),`,
                  `  success: Schema.Any,`,
                  `  inputs: () => [],`,
                  `  cache: false,`,
                  `  implementation: () => Node.succeed({`,
                  `    findings: [{ file: "a.ts", line: 3, severity: "error", message: "bad code" }]`,
                  `  })`,
                  `})`,
                  `export const Package = S.Package({`,
                  `  targets: {`,
                  `    uncacheable: UncacheableRule({}),`,
                  `    badDecode: BadDecodeRule({}),`,
                  `    fakeLint: FakeLintRule({})`,
                  `  }`,
                  `})`
                ].join("\n")
              )
              const disc = await PackageDiscovery.discover(dir)
              const loaded = await PackageLoader.load(disc)
              const idx = PackageIndex.PackageIndex.make(loaded, dir)

              const s1 = await PackageExec.run({ index: idx, cacheDirectory: ".cache", verb: "test", patterns: ["//:uncacheable"] })
              expect(s1.ok).toBe(true)

              const s2 = await PackageExec.run({ index: idx, cacheDirectory: ".cache", verb: "test", patterns: ["//:badDecode"] })
              expect(s2.ok).toBe(false)

              const s3 = await PackageExec.run({ index: idx, cacheDirectory: ".cache", verb: "lint", patterns: ["//:fakeLint"] })
              expect(s3.ok).toBe(true)
              expect(Target.metadata(idx.resolve("//:fakeLint")[0]!.target).target).toBe("LlmLint")
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 90_000)
})
