import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Node from "@smthrs/plan/Node"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as GitHooks from "../src/GitHooks.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect } from "../src/internal/PackageRunner.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as Reporter from "../src/Reporter.ts"
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
    await Machine.remove(dir)
  }
}

const slugArb = Schema.Literals(["aa", "b1", "c2", "d3"])

describe("@smthrs/build-cli Wave-6I: Custom Target CAS restore, machine fresh-putBack/runKept, PackageTree/Loader/Index/Cache, GithubRender, GitHooks, Reporter, InstalledTree, Watch & ObservedReads fuzz", () => {
  it("PackageRunner custom Target.make answerTargetHit/restoreManifests + fresh-machine putBack/runKept", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        slug: slugArb,
        leaveDaemon: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ slug, leaveDaemon }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6i-run-", async (root) => {
              execFileSync("git", ["init", "-q"], { cwd: root })
              execFileSync("git", ["config", "user.email", "w6i@example.invalid"], { cwd: root })
              execFileSync("git", ["config", "user.name", "w6i"], { cwd: root })

              await Fs.writeFile(
                NodePath.join(root, "package.json"),
                JSON.stringify({ name: `w6i-${slug}`, version: "1.0.0", packageManager: "pnpm@11.21.0" })
              )
              await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
              await Fs.writeFile(NodePath.join(root, "in.txt"), `v1-${slug}\n`)
              await Fs.writeFile(NodePath.join(root, "cons-in.txt"), `c1-${slug}\n`)
              await Fs.writeFile(NodePath.join(root, ".gitignore"), ".flows/\nc-dir/\nc-file.txt\n")

              execFileSync("git", ["add", "."], { cwd: root })
              execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root })

              // 1. Custom Target.make with declared outDir + outFile -> Run 1 -> delete outputs -> Run 2 hits answerTargetHit + restoreManifests!
              const CustomOut = Target.make("Custom.Wave6IOut", {
                attrs: Schema.Struct({ tag: Schema.NonEmptyString }),
                kinds: ["build"],
                cache: true,
                outputs: () => ({ cwd: ".", paths: ["c-dir", "c-file.txt"] }),
                success: Schema.Void,
                implementation: (attrs) =>
                  Node.map(Node.succeed(null), () => {
                    NodeFs.mkdirSync(NodePath.join(root, "c-dir"), { recursive: true })
                    NodeFs.writeFileSync(NodePath.join(root, "c-dir/item.txt"), `dir-${attrs.tag}`)
                    NodeFs.writeFileSync(NodePath.join(root, "c-file.txt"), `file-${attrs.tag}`)
                    return undefined
                  })
              })
              const customOut = CustomOut({ tag: slug })

              // 2. Machine-scoped producer -> consumer with FRESH keptDir2 on Build 2 so putBack / runKept runs!
              const prodScript = leaveDaemon
                ? `node -e 'setTimeout(() => {}, 2500)' </dev/null >/dev/null 2>&1 & echo daemon-${slug} > kept-art.txt`
                : `echo file-${slug} > kept-art.txt`
              const keptProd = S.Shell.Test({
                shell: prodScript,
                data: [S.file("//in.txt")],
                machine: "job",
                sandbox: "none"
              })
              const keptCons = S.Shell.Test({
                shell: "cat kept-art.txt cons-in.txt >/dev/null",
                data: [keptProd, S.file("//cons-in.txt")],
                machine: "job",
                sandbox: "none"
              })

              const manifest = S.file("//package.json")
              const index = PackageIndex.make({
                root,
                workspace: S.Workspace("w6i-run", {
                  repository: "git+https://example.invalid/w6i-run.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                  packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
                  nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                  host: S.Host({ bins: ["sh", "cat", "node"] }),
                  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                }),
                factory: undefined,
                packages: [
                  {
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({ targets: { customOut, keptProd, keptCons } })
                  }
                ]
              })

              const keptDir1 = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-w6i-k1-")))
              const keptDir2 = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-w6i-k2-")))
              const runWithKeep = async (patterns: ReadonlyArray<string>, keepDir: string) => {
                const opts: PackageExec.RunOptions = {
                  index,
                  patterns,
                  verb: "auto",
                  cacheDirectory: ".flows",
                  jobs: 2,
                  environment: {
                    ...process.env,
                    [Machine.keepVariable]: JSON.stringify({ [root]: keepDir })
                  },
                  log: () => {}
                }
                const pl = await PackageExec.plan(opts)
                return await Effect.runPromise(executeEffect(pl, opts))
              }

              try {
                // Step A: CustomOut cold -> delete outputs -> warm hit restores from CAS via answerTargetHit!
                const c1 = await runWithKeep(["//:customOut"], keptDir1)
                if (!c1.ok) throw new Error("c1 failed: " + JSON.stringify(c1.results))
                await Fs.rm(NodePath.join(root, "c-dir"), { recursive: true, force: true })
                await Fs.rm(NodePath.join(root, "c-file.txt"), { force: true })
                const c2 = await runWithKeep(["//:customOut"], keptDir1)
                expect(c2.ok).toBe(true)
                expect(c2.results.find((r) => r.label === "//:customOut")?.status).toBe("hit")
                expect(await Fs.readFile(NodePath.join(root, "c-file.txt"), "utf8")).toBe(`file-${slug}`)
                expect(await Fs.readFile(NodePath.join(root, "c-dir/item.txt"), "utf8")).toBe(`dir-${slug}`)

                // Step B: Machine keptProd -> keptCons on keptDir1, then mutate cons-in.txt and run on FRESH keptDir2!
                const k1 = await runWithKeep(["//:keptCons"], keptDir1)
                expect(k1.ok).toBe(true)
                await Fs.writeFile(NodePath.join(root, "cons-in.txt"), `c2-${slug}\n`)
                const k2 = await runWithKeep(["//:keptCons"], keptDir2)
                expect(k2.ok).toBe(true)
              } finally {
                await Machine.remove(keptDir1)
                await Machine.remove(keptDir2)
              }
            })
            return true
          }),
        { seed: 20262101, executions: 2 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("PackageTree revertPath/escaping-parent/rollback, PackageLoader factory/cycle/escapes, PackageIndex resolve errors & Cache outside-dir/io validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        slug: slugArb,
        hasDefault: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ slug, hasDefault }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6i-tree-", async (root) => {
              execFileSync("git", ["init", "-q"], { cwd: root })
              execFileSync("git", ["config", "user.email", "w6i@example.invalid"], { cwd: root })
              execFileSync("git", ["config", "user.name", "w6i"], { cwd: root })

              // 1. PackageTree revertPath (missing, link, file), escaping parent symlink, materializeManifest swap rollback
              await Fs.writeFile(NodePath.join(root, "reg.txt"), `orig-${slug}\n`)
              await Fs.symlink("reg.txt", NodePath.join(root, "sym.txt"))
              execFileSync("git", ["add", "."], { cwd: root })
              execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root })

              const snap = await PackageTree.snapshotTree(root, ".flows")
              try {
                await Fs.writeFile(NodePath.join(root, "added.txt"), "new\n")
                await Fs.writeFile(NodePath.join(root, "reg.txt"), "clobbered\n")
                await Fs.rm(NodePath.join(root, "sym.txt"))
                await Fs.symlink("other.txt", NodePath.join(root, "sym.txt"))
                await PackageTree.revertPath(snap, "added.txt")
                await PackageTree.revertPath(snap, "reg.txt")
                await PackageTree.revertPath(snap, "sym.txt")
                expect(await Fs.readFile(NodePath.join(root, "reg.txt"), "utf8")).toBe(`orig-${slug}\n`)
                expect(await Fs.readlink(NodePath.join(root, "sym.txt"))).toBe("reg.txt")
              } finally {
                await PackageTree.releaseSnapshot(snap)
              }

              // Escaping symlink parent on captureOutDir + materializeManifest rollback on failing rename
              const ext = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-w6i-ext-")))
              try {
                await Fs.mkdir(NodePath.join(ext, "sub"), { recursive: true })
                await Fs.symlink(ext, NodePath.join(root, "esc-parent"))
                await expect(
                  PackageTree.captureOutDir(root, NodePath.join(root, ".flows"), "esc-parent/sub")
                ).rejects.toThrow(/outside the workspace/)

                await Fs.mkdir(NodePath.join(root, "good-out"), { recursive: true })
                await Fs.writeFile(NodePath.join(root, "good-out/a.txt"), `good-${slug}`)
                const manifest = await PackageTree.captureOutDir(root, NodePath.join(root, ".flows"), "good-out")
                let renameCount = 0
                const faultyIo: PackageTree.TreeIo = {
                  ...Fs,
                  rename: async (from, to) => {
                    renameCount++
                    // Fail on the 2nd rename (publishing temp -> destination) so rollback restores old!
                    if (renameCount === 2) throw new Error("injected swap rename failure")
                    return Fs.rename(from, to)
                  }
                }
                await expect(
                  PackageTree.materializeManifest(root, NodePath.join(root, ".flows"), manifest, faultyIo)
                ).rejects.toThrow(/injected swap rename failure/)
                expect(await Fs.readFile(NodePath.join(root, "good-out/a.txt"), "utf8")).toBe(`good-${slug}`)
              } finally {
                await Fs.rm(ext, { recursive: true, force: true })
              }

              // 2. PackageLoader: factory_imports_package, package_import_cycle, and JS string escape decoding
              await withTempDir("smthrs-w6i-ldr-", async (lroot) => {
                await Fs.writeFile(
                  NodePath.join(lroot, "WORKSPACE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("ldr", { repository: "git+https://example.invalid/ldr.git", cache: S.Cache({ directory: ".flows" }) })\n`
                )
                await Fs.writeFile(
                  NodePath.join(lroot, "PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nconst s = "a\\\r\nb\\0\\n\\x41"\nexport const Package = S.Package({ targets: { t: S.Shell.Test({ shell: "true", env: { S: s } }) } })\n`
                )
                await Fs.writeFile(
                  NodePath.join(lroot, "FACTORY.ts"),
                  `import "./PACKAGE.ts"\nexport const Factory = {}\n`
                )
                await expect(PackageLoader.load(await PackageDiscovery.discover(lroot))).rejects.toThrow(/FACTORY\.ts imports a PACKAGE\.ts/)
                await Fs.rm(NodePath.join(lroot, "FACTORY.ts"))

                // Package import cycle a/PACKAGE.ts <-> b/PACKAGE.ts
                await Fs.mkdir(NodePath.join(lroot, "a"), { recursive: true })
                await Fs.mkdir(NodePath.join(lroot, "b"), { recursive: true })
                await Fs.writeFile(NodePath.join(lroot, "a/PACKAGE.ts"), `import "../b/PACKAGE.ts"\nexport const Package = {}\n`)
                await Fs.writeFile(NodePath.join(lroot, "b/PACKAGE.ts"), `import "../a/PACKAGE.ts"\nexport const Package = {}\n`)
                await expect(PackageLoader.load(await PackageDiscovery.discover(lroot))).rejects.toThrow(/cycle/)
              })

              // 3. PackageIndex.resolve error & wildcard/default branches
              const t1 = S.Shell.Test({ shell: "true" })
              const idx = PackageIndex.make({
                root,
                workspace: S.Workspace("w6i-idx", {
                  repository: "git+https://example.invalid/w6i-idx.git",
                  cache: S.Cache({ directory: ".flows" })
                }),
                factory: undefined,
                packages: [
                  {
                    file: "sub/PACKAGE.ts",
                    packagePath: "sub",
                    value: S.Package({ targets: hasDefault ? { default: S.Alias(t1), t1 } : { t1 } })
                  }
                ]
              })
              expect(() => idx.resolve("//...:noSuchName")).toThrow(/no target named/)
              expect(() => idx.resolve("//nope:*")).toThrow(/no package/)
              expect(() => idx.resolve("//nope")).toThrow(/no package/)
              expect(() => idx.resolve("//sub:missing")).toThrow()
              expect(idx.resolve("//sub:*").length).toBeGreaterThanOrEqual(1)
              if (hasDefault) {
                expect(idx.resolve("//sub").length).toBe(1)
              } else {
                expect(() => idx.resolve("//sub")).toThrow(/no default key/)
              }

              // 4. Cache outside-workspace cacheDirectory + io validation
              const outsideCacheDir = NodePath.join(Os.tmpdir(), `smthrs-w6i-outcache-${slug}-${process.pid}`)
              try {
                const relOutside = NodePath.relative(root, outsideCacheDir)
                const c = await Cache.openCache({ workspaceRoot: root, cacheDirectory: relOutside })
                expect(await c.get("absent-key")).toBeNull()
                await expect(
                  Cache.openCache({
                    workspaceRoot: root,
                    cacheDirectory: ".flows",
                    io: { badKey: () => {} } as unknown as Cache.CacheIo
                  })
                ).rejects.toThrow(TypeError)
              } finally {
                await Fs.rm(outsideCacheDir, { recursive: true, force: true })
              }
            })
            return true
          }),
        { seed: 20262102, executions: 6 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("GithubRender release/workflowDispatch/shards/env, GitHooks backup/drift, Reporter live TTY all statuses, InstalledTree worker pool hit/refused, Watch concurrent rescan & ObservedReads nested mounts/.. traversal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        slug: slugArb,
        injectEscapingUnit: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ slug, injectEscapingUnit }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6i-ext2-", async (root) => {
              // 1. GithubRender release + workflowDispatch object inputs + shards + environment
              const t = S.Shell.Test({ shell: "true", shards: 3 })
              const wf = S.Github.Workflow({
                name: `rel-${slug}`,
                on: {
                  release: ["published", "created"],
                  workflowDispatch: {
                    inputs: {
                      env: {
                        type: "choice",
                        options: ["staging", "production"],
                        required: true,
                        default: "staging",
                        description: "Deployment target"
                      },
                      dryRun: { type: "boolean", default: true, description: "Dry run" }
                    }
                  }
                },
                runsOn: "ubuntu-latest",
                environment: "production",
                run: [t]
              })
              const ciGen = S.Github.CiGen({ workflows: [wf], changes: ["workflows/**"] })
              const ghWs = S.Workspace("gh-w6i", {
                repository: "git+https://example.invalid/gh-w6i.git",
                cache: S.Cache({ directory: ".flows" })
              })
              const rendered = GithubRender.render({
                ciGen,
                workspace: ghWs,
                resolve: {
                  labelOf: (x) => (x === ciGen ? "//:ci" : x === wf ? "//:wf" : x === t ? "//:t" : undefined),
                },
                packageDir: ""
              })
              expect(rendered.files[0]!.content).toContain("release:")
              expect(rendered.files[0]!.content).toContain("workflow_dispatch:")
              expect(rendered.files[0]!.content).toContain("SMTHRS_SHARD")
              expect(rendered.files[0]!.content).toContain("production")

              // 2. GitHooks backup of pre-existing custom hook + drift check
              execFileSync("git", ["init", "-q"], { cwd: root })
              const hookPath = NodePath.join(root, ".git/hooks/pre-commit")
              await Fs.mkdir(NodePath.dirname(hookPath), { recursive: true })
              await Fs.writeFile(hookPath, "#!/bin/sh\necho custom-user-hook\n", { mode: 0o755 })
              const hookDefs = GitHooks.render({ preCommit: "//:lint" })
              const beforeCheck = await GitHooks.check(root, hookDefs)
              expect(beforeCheck.clean).toBe(false)
              await GitHooks.install(root, hookDefs)
              expect(await Fs.readFile(`${hookPath}.bak`, "utf8")).toContain("custom-user-hook")
              expect((await GitHooks.check(root, hookDefs)).clean).toBe(true)

              // 3. Reporter live TTY rendering across all 5 statuses + multiline indented errors + full cache + failures
              let ttyBuf = ""
              const fakeTty: Reporter.Terminal = {
                isTTY: true,
                columns: 100,
                write: (chunk: string) => {
                  ttyBuf += chunk
                }
              }
              const rep = Reporter.make({
                renderer: "tty",
                terminal: fakeTty,
                interval: false
              })
              rep.begin({
                verb: "test",
                pattern: "//...",
                jobs: 2,
                targets: [
                  { label: "//:a", target: "Shell.Test" },
                  { label: "//:b", target: "Shell.Test" },
                  { label: "//:c", target: "Shell.Test" },
                  { label: "//:d", target: "Shell.Test" },
                  { label: "//:e", target: "Shell.Test" }
                ]
              })
              rep.targetStarted("//:a")
              rep.toolOutput("//:a", "stdout", `hello-${slug}\n`)
              rep.note("progress note")
              rep.warn("progress warn")
              rep.targetFinished({ label: "//:a", target: "Shell.Test", key: "k1", status: "ran", durationMs: 12 })
              rep.targetFinished({ label: "//:b", target: "Shell.Test", key: "k2", status: "hit", durationMs: 1 })
              rep.targetFinished({
                label: "//:c",
                target: "Shell.Test",
                key: "k3",
                status: "failed",
                durationMs: 25,
                error: "top failure\n  indented finding one\nplain tool line\n\n  indented finding two"
              })
              rep.targetFinished({ label: "//:d", target: "Shell.Test", key: "k4", status: "skipped", durationMs: 0, error: "blocked by //:c" })
              rep.targetFinished({ label: "//:e", target: "Shell.Test", key: "k5", status: "cancelled", durationMs: 3 })
              rep.summary({
                verb: "test",
                pattern: "//...",
                jobs: 2,
                ok: false,
                durationMs: 41,
                counts: { hit: 1, ran: 1, failed: 1, skipped: 1, cancelled: 1 },
                results: [
                  { label: "//:a", target: "Shell.Test", key: "k1", status: "ran", durationMs: 12 },
                  { label: "//:b", target: "Shell.Test", key: "k2", status: "hit", durationMs: 1 },
                  { label: "//:c", target: "Shell.Test", key: "k3", status: "failed", durationMs: 25, error: "top failure\n  indented finding one\nplain tool line\n\n  indented finding two" },
                  { label: "//:d", target: "Shell.Test", key: "k4", status: "skipped", durationMs: 0 },
                  { label: "//:e", target: "Shell.Test", key: "k5", status: "cancelled", durationMs: 3 }
                ],
                notStored: [{ reason: "unconfined", count: 1 }],
                recorder: { name: "strace", why: "fallback" }
              })
              rep.close()
              let silentBuf = ""
              const silentRep = Reporter.silent({ isTTY: false, columns: 80, write: (c) => { silentBuf += c } })
              for (let i = 0; i < 14; i++) silentRep.warn(`warn-${i}-${slug}`)
              silentRep.targetFinished({ label: "//:c", target: "Shell.Test", key: "k3", status: "failed", durationMs: 5, error: "err" })
              silentRep.close()
              expect(silentBuf).toContain("omitted")
              expect(ttyBuf).toContain("indented finding one")
              expect(ttyBuf).toContain("//:c")

              // 4. InstalledTree.identifyAsync worker pool (>8 units): cold -> warm hit -> mutated -> escaping symlink refused!
              const nm = NodePath.join(root, "node_modules")
              for (let i = 0; i < 10; i++) {
                const u = NodePath.join(nm, `pkg-${i}`)
                await Fs.mkdir(u, { recursive: true })
                await Fs.writeFile(NodePath.join(u, "index.js"), `module.exports = "${slug}-${i}"\n`)
              }
              const remembered = InstalledTree.empty()
              const id1 = await InstalledTree.identifyAsync(nm, remembered)
              expect(id1.digest.length).toBeGreaterThan(10)
              const id2 = await InstalledTree.identifyAsync(nm, remembered)
              expect(id2.digest).toBe(id1.digest)
              await Fs.writeFile(NodePath.join(nm, "pkg-0/index.js"), `module.exports = "mut-${slug}"\n`)
              const id3 = await InstalledTree.identifyAsync(nm, remembered)
              expect(id3.digest).not.toBe(id1.digest)
              if (injectEscapingUnit) {
                await Fs.symlink("/etc/hosts", NodePath.join(nm, "pkg-9/escape"))
                const idEsc = await InstalledTree.identifyAsync(nm, remembered)
                expect(idEsc.digest).not.toBe(id3.digest)
              }

              // 5. Watch.run with concurrent rescan + file digest change + abort
              const ac = new AbortController()
              let digestStep = 0
              let cycles = 0
              let outText = ""
              await Watch.run({
                root,
                args: ["test", "//:t"],
                ignored: [".flows"],
                once: false,
                signal: ac.signal,
                debounceMs: 5,
                rescanMs: 12,
                stdout: (t) => { outText += t },
                stderr: () => {},
                cycleCompleted: (c) => {
                  cycles = c.number
                  if (c.number === 1) {
                    digestStep = 1
                  } else if (c.number >= 2) {
                    ac.abort()
                  }
                },
                services: {
                  notifier: (_root, changed) =>
                    Effect.sync(() => {
                      const t1 = setTimeout(() => {
                        digestStep = 1
                        changed("in.txt")
                        changed("in.txt")
                      }, 20)
                      return () => clearTimeout(t1)
                    }),
                  digest: () =>
                    Effect.promise(async () => {
                      await new Promise((r) => setTimeout(r, 10))
                      return `digest-${digestStep}`
                    }),
                  processRunner: () => Effect.succeed(0)
                }
              }).catch(() => undefined)
              expect(cycles).toBeGreaterThanOrEqual(2)
              void outText

              // 6. ObservedReads nested mounts (mountView) + `..` traversal + bytesHoldValue (UTF-8 + 40-hex SHA)
              const mntRoot = NodePath.join(root, "mnt-ws")
              const mntSub = NodePath.join(root, "mnt-backing")
              await Fs.mkdir(NodePath.join(mntRoot, "a/b"), { recursive: true })
              await Fs.mkdir(mntSub, { recursive: true })
              const sha = "abcdef0123456789abcdef0123456789abcdef01"
              await Fs.writeFile(NodePath.join(mntSub, "data.txt"), `café-${slug} ${sha.slice(0, 7)}`)
              await Fs.writeFile(NodePath.join(mntRoot, "a/top.txt"), `top-${slug}`)
              const mntTrace = ObservedReads.read(
                () => [
                  `100 openat(AT_FDCWD, ${JSON.stringify(NodePath.join(mntRoot, "a/b/../top.txt"))}, O_RDONLY) = 4<${NodePath.join(mntRoot, "a/top.txt")}>`,
                  `100 openat(AT_FDCWD, ${JSON.stringify(NodePath.join(mntRoot, "a/b/sub/data.txt"))}, O_RDONLY) = 5<${NodePath.join(mntRoot, "a/b/sub/data.txt")}>`,
                  `100 getdents64(6<${NodePath.join(mntRoot, "a/b")}>, 0x1, 4096) = 24`
                ],
                mntRoot
              )
              const mntObs = ObservedReads.observe(mntTrace, {
                root: mntRoot,
                ignore: [],
                startedMs: Date.now() + 60_000,
                mounts: [[NodePath.join(mntRoot, "a/b/sub"), mntSub]],
                variables: { values: { CAFE: `café-${slug}`, REV: sha }, text: "CAFE REV" }
              })
              expect("refusal" in mntObs ? mntObs.refusal : undefined).toBeUndefined()
            })
            return true
          }),
        { seed: 20262103, executions: 4 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
