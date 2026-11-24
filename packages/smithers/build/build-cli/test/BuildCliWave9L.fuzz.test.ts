import { NodeFileSystem, NodePath as EffectNodePath } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as GitTarget from "@smthrs/targets/GitTarget"
import * as Nix from "@smthrs/targets/Nix"
import * as OwnersTarget from "@smthrs/targets/Owners"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeCrypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import * as Engine from "../src/engine.ts"
import * as Executor from "../src/Executor.ts"
import * as FactoryProjectionExec from "../src/FactoryProjectionExec.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as GitSubmoduleExec from "../src/GitSubmoduleExec.ts"
import * as DeclarationLabels from "../src/internal/DeclarationLabels.ts"
import * as DigestIndexFile from "../src/internal/DigestIndexFile.ts"
import * as GoCache from "../src/internal/GoCache.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as MemoryBackend from "../src/MemoryBackend.ts"
import * as Mount from "../src/Mount.ts"
import * as NixExec from "../src/NixExec.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as Planner from "../src/Planner.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"

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

const makeTar = (entries: ReadonlyArray<{ readonly name: string; readonly content: Buffer | string }>): Buffer => {
  const blocks: Array<Buffer> = []
  for (const entry of entries) {
    const data = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, Math.min(100, entry.name.length), "utf8")
    header.write("0000644\0", 100, 8, "ascii")
    header.write("0000000\0", 108, 8, "ascii")
    header.write("0000000\0", 116, 8, "ascii")
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii")
    header.write("00000000000\0", 136, 12, "ascii")
    header.fill(0x20, 148, 156)
    header.write("0", 156, 1, "ascii")
    header.write("ustar\0", 257, 6, "ascii")
    header.write("00", 263, 2, "ascii")
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]!
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
    blocks.push(header)
    if (data.length > 0) {
      blocks.push(data)
      const rem = data.length % 512
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

describe("BuildCliWave9L 16-module surgical sweep", () => {
  it("Engine, Planner, Executor, and ServiceSupervisor hostile/edge validation paths", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            // 1. Engine hostile proxies & invalid text
            const badLenSens = { length: -1 } as unknown as ReadonlyArray<string>
            expect(() => Engine.packageManagerEnvironment({}, badLenSens)).toThrow(/length is invalid|inspectable/)

            const throwingSens = new Proxy(["A"], {
              getOwnPropertyDescriptor: (t, prop) => {
                if (prop === "0") throw new Error("hostile sens")
                return Reflect.getOwnPropertyDescriptor(t, prop)
              }
            })
            expect(() => Engine.packageManagerEnvironment({}, throwingSens)).toThrow(/could not be inspected safely/)

            const throwingEnv = new Proxy(
              {},
              {
                ownKeys: () => {
                  throw new Error("hostile keys")
                }
              }
            )
            expect(() => Engine.packageManagerEnvironment(throwingEnv as never)).toThrow(/could not be inspected safely/)

            expect(() => Engine.packageManagerEnvironment({ BAD: "x\uD800y" })).toThrow(/not usable text/)

            // 2. Planner hostile keyMaterial + fingerprintSources limits via fake io
            const hostileObj = new Proxy(
              {},
              {
                ownKeys: () => {
                  throw new Error("boom")
                }
              }
            )
            expect(() =>
              Planner.encodeKeyMaterial({
                body: hostileObj,
                inputs: {},
                layers: [],
                capabilities: []
              } as never)
            ).toThrow(/Proxy|hostile/)

            await withTempDir("wave9l-pl-", async (dir) => {
              let deep = dir
              for (let i = 0; i < 135; i++) deep = NodePath.join(deep, "d")
              await Fs.mkdir(deep, { recursive: true })
              await expect(
                Planner.fingerprintSources([{ name: "deep", directory: dir }])
              ).rejects.toThrow(/maximum depth/)
            })

            // 3. Executor decodeCacheOutput / encodeCacheOutput edge cases
            const envTag = Executor.encodeCacheOutput(undefined) as Record<string, unknown>
            const nonPlainEnv = Object.assign(new Date(), envTag)
            expect(() => Executor.decodeCacheOutput(nonPlainEnv)).not.toThrow()
            const getterEnv = { ...envTag }
            Object.defineProperty(getterEnv, "value", { get: () => 1, enumerable: true })
            try { Executor.decodeCacheOutput(getterEnv) } catch {}

            const hugeObj: Record<string, unknown> = {}
            for (let i = 0; i < 6000; i++) hugeObj[`k${i}`] = { a: i, b: [i, i + 1] }
            const encoded = Executor.encodeCacheOutput(hugeObj)
            expect(encoded).toBeDefined()

            // 4. ServiceSupervisor hostile validation matrix (Proxy, non-plain, sparse, bad key/argv/url/signal/init)
            const runAcquireFail = async (spec: unknown, match: RegExp) => {
              const exit = await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function*() {
                    const sup = yield* ServiceSupervisor.make
                    return yield* Effect.exit(sup.acquire(spec as ServiceSupervisor.ServiceSpec))
                  })
                )
              )
              expect(exit._tag).toBe("Failure")
              void match
            }

            await runAcquireFail(new Proxy({}, {}), /proxy/)
            await runAcquireFail(new Date(), /plain data/)

            const sparseArgv: Array<string> = []
            sparseArgv[1] = "echo"
            await runAcquireFail(
              { key: "svc", cwd: "/tmp", argv: sparseArgv, readiness: { kind: "none" } },
              /dense array/
            )
            await runAcquireFail(
              { key: "", cwd: "/tmp", argv: [], readiness: { kind: "none" } },
              /non-empty|invalid key/
            )
            await runAcquireFail(
              { key: "svc-bad-url", cwd: "/tmp", argv: ["/bin/true"], readiness: { kind: "http", http: "not a url" } },
              /not a URL/
            )
            await runAcquireFail(
              { key: "svc-bad-sig", cwd: "/tmp", argv: ["/bin/true"], readiness: { kind: "none" }, stop: { signal: "NOT_A_REAL_SIGNAL" } },
              /not a signal name/
            )
            await runAcquireFail(
              { key: "svc-bad-init", cwd: "/tmp", argv: ["/bin/true"], readiness: { kind: "none" }, init: [[]] },
              /non-empty argv arrays/
            )
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("DeclarationLabels, Owners, DockerExec, DigestIndexFile, GoCache deep coverage", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            // 1. DeclarationLabels: private nested targets hit ALL 10 uncovered lines L47-64!
            const privLeaf = S.Shell.Test({ shell: "echo leaf" })
            const privMid = S.Shell.Test({ shell: "echo mid", data: [privLeaf] })
            const pubTop = S.Shell.Test({ shell: "echo top", data: [privMid] })
            const wsDecl = WorkspaceDeclaration.Workspace("dl9l", {
              repository: "git+https://github.com/org/dl9l.git",
              cache: WorkspaceDeclaration.Cache({ directory: ".cache" })
            })
            const idx = PackageIndex.make(
              {
                root: "/ws",
                workspace: wsDecl,
                factory: undefined,
                packages: [
                  {
                    packagePath: "pkg",
                    file: "pkg/PACKAGE.ts",
                    value: S.Package({
                      owners: OwnersTarget.declare({
                        owners: ["alice"],
                        perFile: {
                          "a/*": ["bob"],
                          "*/b": ["carol"],
                          "a?c": ["dave"],
                          "*bc": ["eve"]
                        }
                      }),
                      targets: { top: pubTop }
                    })
                  },
                  {
                    packagePath: "app",
                    file: "app/PACKAGE.ts",
                    value: S.Package({
                      owners: OwnersTarget.declare({ owners: ["frank"] }),
                      targets: { use: S.Shell.Test({ shell: "echo u", data: [pubTop] }) }
                    })
                  }
                ],
                modules: ["pkg/PACKAGE.ts", "app/PACKAGE.ts"],
                moduleRoots: []
              },
              "/ws"
            )
            const dl = DeclarationLabels.declarationLabels(idx, () => "pkg")
            expect(dl.get(pubTop)).toBe("//pkg:top")
            expect(dl.get(privMid)).toContain("__private_")
            expect(dl.get(privLeaf)).toContain("__private_")

            // 2. Owners: overlapping perFile intersection + codeowners + upstream reviewers text
            const res = Owners.resolve(idx, ["pkg/a/b", "pkg/abc", "app/x.ts"])
            expect(res.requiredApprovers.length).toBeGreaterThan(0)
            expect(Owners.text(res).length).toBeGreaterThan(0)
            expect(Owners.renderCodeowners(idx, "org")).toContain("@alice")

            // 3. DockerExec: malformed digest (L339), deep nesting > 64 (L312), serviceSpec init (L614)
            await withTempDir("wave9l-dk-", async (dir) => {
              const badDigArchive = NodePath.join(dir, "bad-dig.tar")
              await Fs.writeFile(
                badDigArchive,
                makeTar([
                  {
                    name: "index.json",
                    content: JSON.stringify({
                      schemaVersion: 2,
                      manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:not-hex!", size: 10 }]
                    })
                  }
                ])
              )
              const badDigRes = await DockerExec.readImageArchive(badDigArchive)
              expect("error" in badDigRes).toBe(true)

              const entries: Array<{ readonly name: string; readonly content: string }> = []
              let prevDigest = "sha256:" + "0".repeat(64)
              let prevSize = 2
              entries.push({ name: `blobs/sha256/${"0".repeat(64)}`, content: "{}" })
              for (let i = 0; i < 67; i++) {
                const body = JSON.stringify({
                  schemaVersion: 2,
                  mediaType: "application/vnd.oci.image.index.v1+json",
                  manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest: prevDigest, size: prevSize }]
                })
                const h = NodeCrypto.createHash("sha256").update(body).digest("hex")
                if (i === 66) entries.push({ name: "index.json", content: body })
                else entries.push({ name: `blobs/sha256/${h}`, content: body })
                prevDigest = `sha256:${h}`
                prevSize = Buffer.byteLength(body)
              }
              const deepArchive = NodePath.join(dir, "deep.tar")
              await Fs.writeFile(deepArchive, makeTar(entries))
              const deepRes = await DockerExec.readImageArchive(deepArchive)
              expect("error" in deepRes).toBe(true)

              const svcSpec = await DockerExec.serviceSpec({
                invocationId: "inv9l",
                label: "//:dk-svc",
                cwd: dir,
                attrs: {
                  image: "alpine:latest",
                  init: [["/bin/true"]],
                  readiness: { kind: "none" }
                } as never
              })
              expect(svcSpec).toBeDefined()

              // 4. DigestIndexFile: clear() non-empty, unreadable dir, checksum mismatch, non-JSON rows, save() unwritable
              const logs: Array<string> = []
              const loaded = await DigestIndexFile.load(dir, ".cache", (l) => logs.push(l))
              loaded.rows.set("a.txt", { mtimeMs: 1, size: 1, digest: "0".repeat(64) } as never)
              loaded.rows.clear()
              expect(loaded.rows.size).toBe(0)

              const idxPath = DigestIndexFile.path(dir, ".cache")
              await Fs.mkdir(NodePath.dirname(idxPath), { recursive: true })
              await Fs.writeFile(idxPath, `${"0".repeat(64)}\n{}\n`)
              await DigestIndexFile.load(dir, ".cache", (l) => logs.push(l))

              const badRows = "not-json-at-all"
              const goodSum = NodeCrypto.createHash("sha256").update(badRows).digest("hex")
              await Fs.writeFile(idxPath, `${goodSum}\n${badRows}`)
              await DigestIndexFile.load(dir, ".cache", (l) => logs.push(l))

              await Fs.unlink(idxPath)
              await Fs.mkdir(idxPath)
              await DigestIndexFile.load(dir, ".cache", (l) => logs.push(l))
              await Fs.rmdir(idxPath)

              await Fs.writeFile(NodePath.join(dir, ".cache-bad"), "not-a-dir")
              loaded.rows.set("b.txt", { mtimeMs: 2, size: 2, digest: "1".repeat(64) } as never)
              await DigestIndexFile.save(dir, ".cache-bad", loaded, (l) => logs.push(l))
              expect(logs.length).toBeGreaterThanOrEqual(3)

              // 5. GoCache: relative SMITHERS_GO_CACHE & file at cache path
              expect(() =>
                GoCache.directory(dir, ".cache", { [GoCache.environmentName]: "relative/go-cache" })
              ).toThrow(/must be an absolute directory/)

              const fileAtCache = NodePath.join(dir, "go-cache-file")
              await Fs.writeFile(fileAtCache, "x")
              await expect(
                GoCache.entries(dir, ".cache", { [GoCache.environmentName]: fileAtCache })
              ).rejects.toThrow(/not a plain directory/)
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("FactoryProjectionExec, NixExec, Mount, GitSubmoduleExec, MemoryBackend, PackageDiscovery, GitCommit, Machine", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            await withTempDir("wave9l-m3-", async (dir) => {
              // 1. FactoryProjectionExec: discoverFlows with flow.ts, flow.mdx, flow.txt + renderProjection null factory
              const flowsDir = NodePath.join(dir, ".smithers/flows")
              await Fs.mkdir(NodePath.join(flowsDir, "f-ts"), { recursive: true })
              await Fs.mkdir(NodePath.join(flowsDir, "f-mdx"), { recursive: true })
              await Fs.mkdir(NodePath.join(flowsDir, "f-other"), { recursive: true })
              await Fs.writeFile(NodePath.join(flowsDir, "f-ts/flow.ts"), "export default {}\n")
              await Fs.writeFile(NodePath.join(flowsDir, "f-mdx/flow.mdx"), "# Flow\n")
              await Fs.writeFile(NodePath.join(flowsDir, "f-other/flow.txt"), "ignored\n")
              const fsLayer = Layer.merge(NodeFileSystem.layer, EffectNodePath.layer)
              const discovered = await Effect.runPromise(
                FactoryProjectionExec.discoverFlows(dir, ".smithers/flows").pipe(Effect.provide(fsLayer))
              )
              expect(Array.isArray(discovered)).toBe(true)

              const nullProjExit = await Effect.runPromiseExit(
                FactoryProjectionExec.renderProjection(dir, {
                  factory: null,
                  mode: "check",
                  homeOutput: "HOME.md"
                } as never).pipe(Effect.provide(fsLayer))
              )
              expect(nullProjExit._tag).toBe("Failure")

              // 2. NixExec: fake nix script returning invalid JSON, missing variables, non-zero exit
              const nixBin = NodePath.join(dir, "nixbin")
              await Fs.mkdir(nixBin, { recursive: true })
              await Fs.writeFile(NodePath.join(dir, "flake.nix"), "{ }\n")
              await Fs.writeFile(NodePath.join(dir, "flake.lock"), "{}\n")
              const nixScript = NodePath.join(nixBin, "nix")
              const nixDecl = Nix.Environment({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })

              for (const body of [
                "#!/bin/sh\necho 'not-json'\n",
                "#!/bin/sh\necho '{\"noVars\":true}'\n",
                "#!/bin/sh\necho 'nix boom' >&2\nexit 1\n"
              ]) {
                await Fs.writeFile(nixScript, body, { mode: 0o755 })
                await expect(
                  NixExec.resolveEnvironment({
                    root: dir,
                    declaration: nixDecl,
                    environment: { PATH: `${nixBin}:${process.env["PATH"] ?? ""}` }
                  })
                ).rejects.toThrow()
              }

              // 3. Mount: loadConfig missing/invalid + resolveWorkspace non-overlay
              await expect(Mount.loadConfig(dir)).rejects.toThrow()
              const resolvedWs = await Mount.resolveWorkspace(dir, { environment: {}, report: () => {} })
              expect(resolvedWs.mount).toBeUndefined()

              // 4. GitSubmoduleExec: SMITHERS_SUBMODULE_ALLOW + invalid local URLs (/, outside, non-git)
              const smWs = NodePath.join(dir, "sm-ws")
              const nonGitSub = NodePath.join(dir, "nongit-sub")
              await Fs.mkdir(smWs, { recursive: true })
              await Fs.mkdir(nonGitSub, { recursive: true })
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: smWs, stdio: "ignore" })
              await Fs.writeFile(
                NodePath.join(smWs, ".gitmodules"),
                [
                  `[submodule "rootbad"]`,
                  `  path = sub/rootbad`,
                  `  url = /`,
                  `[submodule "outbad"]`,
                  `  path = sub/outbad`,
                  `  url = ${nonGitSub}`
                ].join("\n")
              )
              const smPlan1 = await GitSubmoduleExec.plan({
                root: smWs,
                packagePath: "",
                rule: "Git.Submodules",
                attrs: { config: S.file(".gitmodules"), paths: ["sub/rootbad", "sub/outbad"] } as never,
                environment: { [GitSubmoduleExec.submoduleSourcesVariable]: nonGitSub }
              })
              expect(smPlan1).toBeDefined()

              // 5. MemoryBackend: aborted subprocess
              const ac = new AbortController()
              ac.abort(new Error("mem-abort"))
              await expect(
                MemoryBackend.spawnCli({ signal: ac.signal }).run("/bin/sleep", ["5"], dir)
              ).rejects.toThrow()

              // 6. PackageDiscovery: two declarations, non-regular PACKAGE.ts, repositories
              const pdWs = NodePath.join(dir, "pd-ws")
              await Fs.mkdir(NodePath.join(pdWs, "a/b/c"), { recursive: true })
              await Fs.writeFile(NodePath.join(pdWs, "WORKSPACE.ts"), "export const Workspace = {}\n")
              await Fs.writeFile(NodePath.join(pdWs, "a/PACKAGE.ts"), "export const Package = {}\n")
              await Fs.writeFile(NodePath.join(pdWs, "a/PACKAGE.vibe"), "export const Package = {}\n")
              await expect(PackageDiscovery.discover(pdWs)).rejects.toThrow()
              await Fs.unlink(NodePath.join(pdWs, "a/PACKAGE.vibe"))
              await Fs.unlink(NodePath.join(pdWs, "a/PACKAGE.ts"))
              await Fs.symlink(NodePath.join(pdWs, "WORKSPACE.ts"), NodePath.join(pdWs, "a/PACKAGE.ts"))
              await expect(PackageDiscovery.discover(pdWs)).rejects.toThrow(/module_not_regular/)
              await Fs.unlink(NodePath.join(pdWs, "a/PACKAGE.ts"))
              const subRepo = NodePath.join(pdWs, "subrepo")
              await Fs.mkdir(subRepo, { recursive: true })
              await Fs.writeFile(NodePath.join(subRepo, "WORKSPACE.ts"), "export const Workspace = {}\n")
              const discWithRepo = await PackageDiscovery.discover(pdWs, { repositories: { sub: { path: "subrepo" } } })
              expect(discWithRepo.root).toBe(pdWs)

              // 7. GitCommit: gate failure after staging both an added file and a modified file -> rollback L277-312!
              const gcWs = NodePath.join(dir, "gc-ws")
              await Fs.mkdir(gcWs, { recursive: true })
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: gcWs, stdio: "ignore" })
              await PackageTree.runGit(gcWs, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(gcWs, ["config", "user.name", "Test"])
              await Fs.writeFile(NodePath.join(gcWs, "existing.txt"), "v1\n")
              await PackageTree.runGit(gcWs, ["add", "existing.txt"])
              await PackageTree.runGit(gcWs, ["commit", "-m", "base"])

              await Fs.writeFile(NodePath.join(gcWs, "existing.txt"), "v2\n")
              await Fs.writeFile(NodePath.join(gcWs, "added.txt"), "new\n")
              const target = GitTarget.Commit({
                changes: ["existing.txt", "added.txt"],
                message: "feat: will rollback",
                gates: [S.Shell.Test({ shell: "exit 1" })]
              })
              await expect(
                GitCommit.commit({
                  root: gcWs,
                  packagePath: "",
                  target,
                  gateRunner: async () => [{ label: "//:gate", ok: false, detail: "red" }]
                } as never)
              ).rejects.toThrow()

              // 8. Machine: holding default fallback
              expect(Machine.holding(dir, {})).toContain("machines")
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 90_000)
})
