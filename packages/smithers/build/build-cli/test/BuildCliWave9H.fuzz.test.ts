import * as NodeServices from "@effect/platform-node/NodeServices"
import * as GitTarget from "@smthrs/targets/GitTarget"
import * as MemoryTarget from "@smthrs/targets/MemoryTarget"
import * as Reference from "@smthrs/targets/Reference"
import { Effect } from "effect"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import * as DockerExec from "../src/DockerExec.ts"
import * as FactoryProjectionExec from "../src/FactoryProjectionExec.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as CacheLocation from "../src/internal/CacheLocation.ts"
import * as DigestIndexFile from "../src/internal/DigestIndexFile.ts"
import * as DprintPlugins from "../src/internal/DprintPlugins.ts"
import * as GoCache from "../src/internal/GoCache.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import * as FetchExecutor from "../src/internal/rules/FetchExecutor.ts"
import * as SkillsInstallRule from "../src/internal/rules/SkillsInstallRule.ts"
import * as MemoryBackend from "../src/MemoryBackend.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const makeTar = (files: ReadonlyArray<{ readonly name: string; readonly content: Buffer | string }>): Buffer => {
  const chunks: Array<Buffer> = []
  for (const f of files) {
    const data = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content
    const header = Buffer.alloc(512, 0)
    header.write(f.name, 0, "utf8")
    header.write("0000644\0", 100, "ascii")
    header.write("0000000\0", 108, "ascii")
    header.write("0000000\0", 116, "ascii")
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii")
    header.write("00000000000\0", 136, "ascii")
    header.fill(0x20, 148, 156)
    header.write("0", 156, "ascii")
    header.write("ustar\0", 257, "ascii")
    header.write("00", 263, "ascii")
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]!
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii")
    chunks.push(header)
    chunks.push(data)
    const rem = data.length % 512
    if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

describe("BuildCliWave9H medium module sweep", () => {
  it("PackageDiscovery conflicts & missing, OutputCas validation, DockerExec OCI archive errors", async () => {
    await withTempDir("wave9h-part1-", async (dir) => {
      const ws = NodePath.join(dir, "ws")
      await Fs.mkdir(NodePath.join(ws, ".smithers"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "a", "b"), { recursive: true })
      await Fs.writeFile(NodePath.join(ws, ".smithers", "WORKSPACE.ts"), "export const Workspace = {}\n")
      await Fs.writeFile(NodePath.join(ws, "a", "PACKAGE.ts"), "export const Package = {}\n")

      // Two declarations in same dir: PACKAGE.ts + PACKAGE.vibe
      await Fs.writeFile(NodePath.join(ws, "a", "PACKAGE.vibe"), "export const Package = {}\n")
      await expect(PackageDiscovery.discover(ws)).rejects.toThrow()
      await Fs.rm(NodePath.join(ws, "a", "PACKAGE.vibe"))

      // Non-regular PACKAGE.ts (symlink)
      await Fs.symlink("PACKAGE.ts", NodePath.join(ws, "a", "b", "PACKAGE.ts"))
      await expect(PackageDiscovery.discover(ws)).rejects.toThrow(/module_not_regular/)
      await Fs.rm(NodePath.join(ws, "a", "b", "PACKAGE.ts"))

      // Repositories option pruning
      await Fs.mkdir(NodePath.join(ws, "subrepo"), { recursive: true })
      await Fs.writeFile(NodePath.join(ws, "subrepo", "WORKSPACE.ts"), "export const Workspace = {}\n")
      await Fs.writeFile(NodePath.join(ws, "subrepo", "PACKAGE.ts"), "export const Package = {}\n")
      const discRepo = await PackageDiscovery.discover(ws, {
        repositories: { child: { path: "subrepo" } }
      })
      expect(discRepo.repositories.length).toBe(1)

      // OutputCas invalid chunk index, prepare invalid shapes, hydrate chunk size mismatch
      const cas = NodePath.join(dir, "cas")
      await Fs.mkdir(cas, { recursive: true })
      const badIdxText = JSON.stringify({ version: 999 })
      const badIdxDigest = createHash("sha256").update(badIdxText).digest("hex")
      await Fs.writeFile(NodePath.join(cas, badIdxDigest), badIdxText)
      await expect(OutputCas.readIndex(cas, badIdxDigest)).rejects.toThrow(/invalid CAS chunk index/)

      await expect(OutputCas.prepare(cas, { kind: "target-outputs", manifests: [], files: [null] })).rejects.toThrow(/invalid output file/)
      await expect(
        OutputCas.prepare(cas, { kind: "target-outputs", manifests: [], files: [{ path: "a", digest: "not-hex" }] })
      ).rejects.toThrow(/invalid output content identity/)
      await expect(OutputCas.prepare(cas, { kind: "target-outputs", manifests: "not-array" })).rejects.toThrow(/invalid output manifests/)
      await expect(OutputCas.prepare(cas, { kind: "target-outputs", manifests: [{ outDir: 123 }] })).rejects.toThrow(/invalid output manifest/)

      const chunkBytesData = Buffer.from("hello")
      const chunkHash = createHash("sha256").update(chunkBytesData).digest("hex")
      const idxJson = JSON.stringify({
        kind: "smithers-build/chunks-v1",
        size: OutputCas.chunkBytes + 5,
        chunks: [
          { digest: chunkHash, size: OutputCas.chunkBytes },
          { digest: chunkHash, size: 5 }
        ]
      })
      const idxHash = createHash("sha256").update(idxJson).digest("hex")
      const hydrateCas = NodePath.join(dir, "hcas")
      await Fs.mkdir(hydrateCas, { recursive: true })
      await expect(
        OutputCas.hydrate(
          hydrateCas,
          { kind: "target-outputs", manifests: [], files: [{ path: "x", digest: "b".repeat(64), index: idxHash }] },
          async (d) => {
            await OutputCas.writeBlob(hydrateCas, d, d === idxHash ? Buffer.from(idxJson) : chunkBytesData)
            return true
          }
        )
      ).rejects.toThrow(/chunk size differs/)

      // DockerExec.readImageArchive error paths
      const badBlobTar = NodePath.join(dir, "bad-blob.tar")
      const idx1 = JSON.stringify({
        manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"a".repeat(64)}` }]
      })
      await Fs.writeFile(
        badBlobTar,
        makeTar([
          { name: "index.json", content: idx1 },
          { name: `blobs/sha256/${"a".repeat(64)}`, content: "wrong-bytes" }
        ])
      )
      const r1 = await DockerExec.readImageArchive(badBlobTar)
      expect("error" in r1).toBe(true)

      const malDigestTar = NodePath.join(dir, "mal-digest.tar")
      await Fs.writeFile(
        malDigestTar,
        makeTar([
          {
            name: "index.json",
            content: JSON.stringify({
              manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "md5:bad" }]
            })
          }
        ])
      )
      const r2 = await DockerExec.readImageArchive(malDigestTar)
      expect("error" in r2).toBe(true)

      expect(DockerExec.pushTagRefusal("bad tag!")).toBeDefined()
      expect(DockerExec.loadedImageIds("Loaded image ID: sha256:abc\nLoaded image: img:1\n").length).toBeGreaterThan(0)
      expect(DockerExec.pushedDigest(`latest: digest: sha256:${"b".repeat(64)} size: 123`)).toBe(`sha256:${"b".repeat(64)}`)
      expect(DockerExec.manifestConfig("not-json")).toBeUndefined()
    })
  }, 60_000)

  it("SkillsInstallRule, FetchExecutor, FactoryProjectionExec, MemoryBackend, GitCommit", async () => {
    await withTempDir("wave9h-part2-", async (dir) => {
      const homeDir = NodePath.join(dir, "home")
      const libDir = NodePath.join(dir, "skills")
      await Fs.mkdir(homeDir, { recursive: true })
      const runSkills = (req: SkillsInstallRule.Request) =>
        Effect.runPromiseExit(
          SkillsInstallRule.install(req, { root: dir, home: homeDir }).pipe(Effect.provide(NodeServices.layer))
        )

      expect((await runSkills({ library: { root: "missing-lib" }, select: ["a"], agents: ["claude"] }))._tag).toBe("Failure")

      await Fs.mkdir(NodePath.join(libDir, "good-skill"), { recursive: true })
      await Fs.writeFile(NodePath.join(libDir, "good-skill", "SKILL.md"), "---\nname: good-skill\ndescription: test\n---\n# Good\n")
      expect((await runSkills({ library: { root: "skills" }, select: ["nope"], agents: ["claude"] }))._tag).toBe("Failure")

      const realTarget = NodePath.join(dir, "real-agent-skills")
      await Fs.mkdir(realTarget, { recursive: true })
      await Fs.mkdir(NodePath.join(homeDir, ".claude"), { recursive: true })
      await Fs.symlink(realTarget, NodePath.join(homeDir, ".claude", "skills"))
      expect((await runSkills({ library: { root: "skills" }, select: ["good-skill"], agents: ["claude"] }))._tag).toBe("Failure")
      await Fs.rm(NodePath.join(homeDir, ".claude", "skills"))

      await Fs.mkdir(NodePath.join(homeDir, ".claude", "skills", "good-skill"), { recursive: true })
      expect((await runSkills({ library: { root: "skills" }, select: ["good-skill"], agents: ["claude"] }))._tag).toBe("Failure")
      await Fs.rm(NodePath.join(homeDir, ".claude", "skills", "good-skill"), { recursive: true, force: true })

      const okSk = await runSkills({ library: { root: "skills" }, select: ["good-skill"], agents: ["claude"] })
      if (okSk._tag !== "Success") throw new Error(String(okSk.cause))

      // FetchExecutor
      expect(FetchExecutor.redactUrl("not a url")).toBe("<unparsable url>")
      expect(() => FetchExecutor.redirectTarget("https://example.com/a", "http://[bad")).toThrow(FetchExecutor.FetchError)
      expect(() => FetchExecutor.redirectTarget("https://example.com/a", "ftp://example.com/b")).toThrow(FetchExecutor.FetchError)

      const srv = Http.createServer((req, res) => {
        if (req.url === "/404") {
          res.writeHead(404)
          res.end("nope")
        } else if (req.url === "/big") {
          res.writeHead(200)
          res.end("x".repeat(500))
        } else if (req.url === "/slow") {
          // leave open for timeout
        } else {
          res.writeHead(200)
          res.end("ok-body")
        }
      })
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
      const port = (srv.address() as { port: number }).port
      const baseUrl = `http://127.0.0.1:${port}`
      try {
        await expect(
          FetchExecutor.download({
            root: dir,
            url: `${baseUrl}/404`,
            outFile: "f1",
            sha256: "a".repeat(64)
          })
        ).rejects.toThrow()
        await expect(
          FetchExecutor.download({
            root: dir,
            url: `${baseUrl}/big`,
            outFile: "f2",
            sha256: "a".repeat(64),
            limitBytes: 10
          })
        ).rejects.toThrow()
        await expect(
          FetchExecutor.download({
            root: dir,
            url: `${baseUrl}/slow`,
            outFile: "f3",
            sha256: "a".repeat(64),
            deadlineMs: 60
          })
        ).rejects.toThrow()
        await Fs.writeFile(NodePath.join(dir, "blocker"), "x")
        await expect(
          FetchExecutor.download({
            root: dir,
            url: `${baseUrl}/ok`,
            outFile: "blocker/out",
            sha256: createHash("sha256").update("ok-body").digest("hex")
          })
        ).rejects.toThrow()
      } finally {
        srv.closeAllConnections()
        await new Promise<void>((resolve) => srv.close(() => resolve()))
      }

      // FactoryProjectionExec
      const flowDir = NodePath.join(dir, ".smithers", "flows")
      await Fs.mkdir(NodePath.join(flowDir, "alpha"), { recursive: true })
      await Fs.mkdir(NodePath.join(flowDir, "beta"), { recursive: true })
      await Fs.mkdir(NodePath.join(flowDir, "gamma"), { recursive: true })
      await Fs.writeFile(NodePath.join(flowDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n")
      await Fs.writeFile(NodePath.join(flowDir, "alpha", "flow.ts"), "export default {}\n")
      await Fs.writeFile(NodePath.join(flowDir, "beta", "SKILL.md"), "---\nname: beta\ndescription: b\n---\n")
      await Fs.writeFile(NodePath.join(flowDir, "beta", "flow.mdx"), "# Beta\n")
      await Fs.writeFile(NodePath.join(flowDir, "gamma", "README.md"), "not a flow\n")
      const discovered = await Effect.runPromise(
        FactoryProjectionExec.discoverFlows(dir, ".smithers/flows").pipe(Effect.provide(NodeServices.layer))
      )
      expect(Array.isArray(discovered)).toBe(true)

      // MemoryBackend
      const noBin = await MemoryBackend.pathLocator({ PATH: "/nonexistent" }).find()
      expect(noBin).toBeUndefined()
      const errBin = NodePath.join(dir, "mem-err")
      await writeExecutable(errBin, "#!/bin/sh\necho err-line >&2\nexit 2\n")
      const cli = MemoryBackend.spawnCli({ environment: { PATH: `${dir}:${process.env["PATH"] ?? ""}` } })
      const memOut = await cli.run(errBin, ["get"], dir)
      expect(memOut.stderr).toContain("err-line")
      await expect(
        MemoryBackend.retain({
          root: dir,
          target: MemoryTarget.Retain({ source: Reference.gitCommit("HEAD"), tags: ["t"] }),
          memory: MemoryTarget.SmithersCloud({ bank: ["core"] }),
          locator: MemoryBackend.pathLocator({ PATH: "/nonexistent" })
        })
      ).rejects.toThrow(MemoryBackend.MemoryBackendUnavailable)

      // GitCommit
      const gitWs = NodePath.join(dir, "gitws")
      await Fs.mkdir(gitWs, { recursive: true })
      NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: gitWs, stdio: "ignore" })
      await PackageTree.runGit(gitWs, ["config", "user.email", "test@example.com"])
      await PackageTree.runGit(gitWs, ["config", "user.name", "Test"])
      await Fs.writeFile(NodePath.join(gitWs, "a.txt"), "v1\n")
      await PackageTree.runGit(gitWs, ["add", "a.txt"])
      await PackageTree.runGit(gitWs, ["commit", "-q", "-m", "init"])

      await Fs.writeFile(NodePath.join(gitWs, "a.txt"), "v2\n")
      await Fs.writeFile(NodePath.join(gitWs, "b.txt"), "new\n")
      const commitTarget = GitTarget.Commit({ message: "feat: default", gates: [] })
      await expect(
        GitCommit.commit({
          root: gitWs,
          target: commitTarget,
          paths: ["a.txt", "b.txt"],
          messageOverride: "   ",
          gateRunner: { run: async () => [] }
        })
      ).rejects.toThrow(GitCommit.GitCommitError)

      await expect(
        GitCommit.commit({
          root: gitWs,
          target: commitTarget,
          paths: ["a.txt", "b.txt"],
          messageOverride: "feat: test",
          gateRunner: {
            run: async () => {
              await Fs.writeFile(NodePath.join(gitWs, "a.txt"), "v3-mutated\n")
              await PackageTree.runGit(gitWs, ["add", "a.txt"])
              return []
            }
          }
        })
      ).rejects.toThrow(GitCommit.GitCommitError)

      const committed = await GitCommit.commit({
        root: gitWs,
        target: commitTarget,
        paths: ["a.txt", "b.txt"],
        messageOverride: "feat: clean commit",
        gateRunner: { run: async () => [] }
      })
      expect(committed.sha).toMatch(/^[a-f0-9]{40}$/)
    })
  }, 90_000)

  it("CacheLocation, DprintPlugins, DigestIndexFile, GoCache, and AgentFake edge paths", async () => {
    await withTempDir("wave9h-part3-", async (dir) => {
      expect(CacheLocation.userCacheDirectory({ platform: "darwin", home: "/Users/x", environment: {} })).toContain("Caches")
      expect(
        CacheLocation.userCacheDirectory({ platform: "win32", home: "/Users/x", environment: { LOCALAPPDATA: "/App" } })
      ).toContain("App")
      expect(
        CacheLocation.userCacheDirectory({ platform: "linux", home: "/home/x", environment: { XDG_CACHE_HOME: "/xdg" } })
      ).toContain("/xdg")
      expect(
        CacheLocation.resolve(dir, undefined, { directory: ".cache", outside: true }, "w", CacheLocation.ambientHost({}))
      ).toBeTruthy()
      expect(CacheLocation.absolute(dir, ".cache")).toBe(NodePath.join(dir, ".cache"))

      expect(DprintPlugins.cacheDirectory({ DPRINT_CACHE_DIR: "/tmp/dp" }, "linux", "/home/u")).toBe("/tmp/dp")
      expect(DprintPlugins.cacheDirectory({ XDG_CACHE_HOME: "/tmp/xdg" }, "linux", "/home/u")).toContain("dprint")
      expect(DprintPlugins.cacheDirectory({}, "darwin", "/home/u")).toContain("Caches")
      expect(DprintPlugins.cacheDirectory({}, "win32", "C:\\u")).toBeUndefined()
      const dpCfg = NodePath.join(dir, "dprint.json")
      await Fs.writeFile(dpCfg, "{bad-json")
      expect(typeof DprintPlugins.measure(dpCfg, undefined)).toBe("string")
      await Fs.writeFile(dpCfg, JSON.stringify({ plugins: ["https://plugins.dprint.dev/ts-0.1.wasm"] }))
      expect(typeof DprintPlugins.measure(dpCfg, NodePath.join(dir, "dp-cache"))).toBe("string")

      expect((await DigestIndexFile.load(dir, ".cache")).rows.size).toBe(0)
      const idxPath = DigestIndexFile.path(dir, ".cache")
      await Fs.mkdir(NodePath.dirname(idxPath), { recursive: true })
      await Fs.writeFile(idxPath, "{corrupt")
      expect((await DigestIndexFile.load(dir, ".cache")).rows.size).toBe(0)

      const goDir = GoCache.directory(dir, ".cache")
      await Fs.mkdir(NodePath.join(goDir, "00"), { recursive: true })
      await Fs.writeFile(NodePath.join(goDir, "00", `${"0".repeat(64)}-a`), "cached-obj")
      const goEntries = await GoCache.entries(dir, ".cache")
      expect(goEntries.length).toBeGreaterThanOrEqual(1)
      const goStatus = await GoCache.status(dir, ".cache")
      expect(goStatus.entries).toBeGreaterThanOrEqual(1)
      const lease = await GoCache.acquireLease(dir, ".cache")
      expect(await GoCache.leased("Go.Test", dir, ".cache")).toBe(true)
      await GoCache.releaseLease(lease)
      const goUsage = await GoCache.usage(dir, ".cache")
      expect(goUsage).toBeDefined()
      const evicted = await GoCache.evict(dir, ".cache", goEntries)
      expect(evicted.removed).toBeGreaterThanOrEqual(0)

      expect(AgentFake.sessionTimeoutFromEnvironment({ [AgentFake.timeoutEnvironmentVariable]: "5000" })).toBe(5000)
      expect(() => AgentFake.sessionTimeoutFromEnvironment({ [AgentFake.timeoutEnvironmentVariable]: "not-num" })).toThrow()
      const scriptPath = NodePath.join(dir, "fake-agent.json")
      await Fs.writeFile(
        scriptPath,
        JSON.stringify({
          responses: [{ envelope: { ok: true, summary: "done", findings: [] } }]
        })
      )
      const loadedScript = AgentFake.loadFakeScript(scriptPath)
      const factory = AgentFake.makeScriptedSessionFactory(loadedScript)
      expect(factory).toBeDefined()
      const gateRunner = AgentFake.makeScriptedGateRunner([{ ok: true, results: [] } as never])
      expect(gateRunner).toBeDefined()
    })
  }, 60_000)
})
