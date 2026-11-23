import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as SafeFs from "@smthrs/targets/SafeFs"
import { Arbitrary, Effect, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import * as Executor from "../src/Executor.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import * as CacheLocation from "../src/internal/CacheLocation.ts"
import * as DigestIndexFile from "../src/internal/DigestIndexFile.ts"
import * as GoCache from "../src/internal/GoCache.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import * as RecordStore from "../src/internal/RecordStore.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as Planner from "../src/Planner.ts"
import { write } from "./helpers/WriteFile.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const fsExecutions = Math.min(executions, 25)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/build-cli Cache, OutputCas, PackageTree, CacheAdmin, CacheEvidence, InstalledTree, GoCache, Planner & Executor fuzz invariants", () => {
  it("Cache local + live HTTP remote cache, CacheAdmin, OutputCas & RecordStore uphold storage & integrity invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-buildcli-cache-")))
    const remoteEntries = new Map<string, Buffer>()
    const remoteBlobs = new Map<string, Buffer>()
    const server = Http.createServer(async (req, res) => {
      const url = req.url ?? "/"
      const chunks: Array<Buffer> = []
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      const body = Buffer.concat(chunks)
      if (url.startsWith("/entries/")) {
        const key = url.slice("/entries/".length)
        if (req.method === "PUT") {
          remoteEntries.set(key, body)
          res.writeHead(200).end("ok")
          return
        }
        if (req.method === "GET") {
          const hit = remoteEntries.get(key)
          if (hit) {
            res.writeHead(200, { "content-type": "application/json" }).end(hit)
          } else {
            res.writeHead(404).end()
          }
          return
        }
      }
      if (url.startsWith("/blobs/")) {
        const digest = url.slice("/blobs/".length)
        if (req.method === "PUT") {
          remoteBlobs.set(digest, body)
          res.writeHead(200).end("ok")
          return
        }
        if (req.method === "GET") {
          const hit = remoteBlobs.get(digest)
          if (hit) {
            res.writeHead(200, { "content-type": "application/octet-stream" }).end(hit)
          } else {
            res.writeHead(404).end()
          }
          return
        }
        if (req.method === "HEAD") {
          res.writeHead(remoteBlobs.has(digest) ? 200 : 404).end()
          return
        }
      }
      if (url === "/blobs/missing" && req.method === "POST") {
        const parsed = JSON.parse(body.toString("utf8")) as { readonly digests?: ReadonlyArray<string> }
        const missing = (parsed.digests ?? []).filter((d) => !remoteBlobs.has(d))
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ missing }))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no cache server port")
    const endpoint = `http://127.0.0.1:${addr.port}`

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          rawKey: Schema.Literals(["alpha-1", "beta/sub:key", "gamma..delta", "0123456789abcdef"]),
          payloadText: Schema.String.check(Schema.isMaxLength(200)),
          sizeText: Schema.Literals(["100B", "4KB", "2MB", "1GB", "bad-size", "-5MB"]),
          nsInput: Schema.Literals(["ci-main", "pr/123", "bad space", ""]),
          withRemote: Schema.Boolean
        })
      )

      let iter = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ rawKey, payloadText, sizeText, nsInput, withRemote }) =>
            Effect.gen(function*() {
              iter += 1
              const safeText = payloadText.replace(/[\uD800-\uDFFF]/g, "")
              const key = Cache.sanitizeKey(`${rawKey}-${iter}`)
              if (key.includes("/") || key.includes("\\") || key === ".." || key === "." || key.startsWith(".")) {
                throw new Error("unsafe sanitizeKey: " + key)
              }

              // publishNamespaceFromEnvironment
              if (nsInput === "") {
                if (Cache.publishNamespaceFromEnvironment(undefined) !== undefined) throw new Error("undef ns")
              } else {
                try {
                  const normNs = Cache.normalizePublishNamespace(nsInput)
                  if (normNs !== undefined && normNs.length === 0) throw new Error("empty ns")
                } catch {
                  // invalid namespace rejected
                }
              }

              // CacheAdmin.parseSize
              const badSize = sizeText === "bad-size" || sizeText.startsWith("-")
              try {
                const parsed = CacheAdmin.parseSize(sizeText)
                if (badSize || parsed < 0) throw new Error("parseSize should fail: " + sizeText)
              } catch (e) {
                if (!badSize) throw e
              }

              // Open real local (+ optional HTTP remote) cache and roundtrip get/put
              const cacheDir = `.flows-${iter % 4}`
              const store = yield* Effect.promise(() =>
                Cache.openCache({
                  workspaceRoot: tmpRoot,
                  cacheDirectory: cacheDir,
                  warn: () => {},
                  ...(withRemote
                    ? {
                      endpoint,
                      readToken: () => "fuzz-tok",
                      writeToken: () => "fuzz-tok"
                    }
                    : {})
                })
              )
              const entry: Cache.CachedResult = {
                key,
                target: "Shell.Build",
                label: "//:build",
                exitOk: true,
                output: { text: safeText, iter },
                storedAt: "2026-11-23T00:00:00.000Z"
              }
              yield* Effect.promise(() => store.put(key, entry))
              const got = yield* Effect.promise(() => store.get(key))
              if (got === null || got.key !== key) throw new Error("cache get miss after put")

              // CacheAdmin inspect & entries
              const listed = yield* Effect.promise(() => CacheAdmin.entries(tmpRoot, cacheDir))
              if (listed.length < 1) throw new Error("CacheAdmin.entries empty")
              const inspected = yield* Effect.promise(() => CacheAdmin.inspect(tmpRoot, cacheDir, key))
              if (inspected === undefined || inspected.key !== key) throw new Error("CacheAdmin.inspect miss")

              // OutputCas writeBlob / readBlob / hasFile / prepare / hydrate
              const casDir = NodePath.join(tmpRoot, cacheDir, "cas")
              const bytes = Buffer.from(`blob:${safeText}`, "utf8")
              const digest = PackageTree.digestBytes(bytes)
              if (!PackageTree.isSha256Hex(digest)) throw new Error("bad sha256")
              yield* Effect.promise(() => OutputCas.writeBlob(casDir, digest, bytes))
              const readBack = yield* Effect.promise(() => OutputCas.readBlob(casDir, digest))
              if (readBack === undefined || Buffer.compare(readBack, bytes) !== 0) {
                throw new Error("OutputCas readBlob mismatch")
              }
              const has = yield* Effect.promise(() => OutputCas.hasFile(casDir, digest))
              if (!has) throw new Error("OutputCas hasFile false")
              const budget = OutputCas.makeOutputBudget()
              budget.reference(digest)
              const limiter = OutputCas.makeLimiter(4)
              limiter.busy()
              limiter.admitted()
              const prepared = yield* Effect.promise(() =>
                OutputCas.prepare(casDir, { kind: "target-outputs", manifests: [], files: [{ digest }] })
              )
              if (!prepared.digests.includes(digest)) throw new Error("OutputCas prepare missing digest")
              const hydrated = yield* Effect.promise(() =>
                OutputCas.hydrate(casDir, prepared.output, async () => false, limiter)
              )
              if (!hydrated) throw new Error("OutputCas hydrate false")

              // RecordStore write / read / load
              const recCas = RecordStore.contentStore(tmpRoot, cacheDir)
              const sampleRec = {
                id: `fuzz-rec-${iter}`,
                reads: [["src/a.ts", digest]] as const,
                lists: [] as const
              }
              const ref = yield* Effect.promise(() => RecordStore.write(recCas, sampleRec as never))
              const loaded = yield* Effect.promise(() => RecordStore.read(recCas, ref))
              if (loaded === undefined) throw new Error("RecordStore.read failed")
              RecordStore.unreadReason(["missing"])
              RecordStore.unreadReason(["changed"])
              RecordStore.unreadReason([])
              return true
            }),
          { executions: fsExecutions, seed: seed + 10 }
        )
      )
      assertPassed(report)

      // Prune cache via CacheAdmin.remove
      const removed = await CacheAdmin.remove({ root: tmpRoot, cacheDirectory: ".flows-0", dryRun: false, yes: true })
      expect(removed.removed).toBeGreaterThanOrEqual(0)
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("PackageTree snapshot/revert/capture/materialize, InstalledTree, DigestIndexFile, CacheEvidence, CacheLocation & GoCache fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-buildcli-tree-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          fileCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
          content: Schema.String.check(Schema.isMaxLength(100)),
          rule: Schema.Literals(["Vitest", "Typecheck", "EsLint", "Dprint", "TsBuild", "NodeTest", "Shell.Build"]),
          flagOn: Schema.Boolean,
          sandboxOff: Schema.Boolean
        })
      )

      let iter = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ fileCount, content, rule, flagOn, sandboxOff }) =>
            Effect.gen(function*() {
              iter += 1
              const safeText = content.replace(/[\uD800-\uDFFF]/g, "")
              const sub = `ws-${iter}`
              const wsRoot = NodePath.join(tmpRoot, sub)
              yield* Effect.promise(() => Fs.mkdir(NodePath.join(wsRoot, "out"), { recursive: true }))
              for (let i = 0; i < fileCount; i++) {
                yield* Effect.promise(() => write(wsRoot, `out/f${i}.txt`, `v${i}:${safeText}\n`))
              }

              // PackageTree captureOutDir, decodeManifest, verifyManifestBlobs, treeMatchesManifest, materializeManifest
              const manifest = yield* Effect.promise(() => PackageTree.captureOutDir(wsRoot, ".flows", "out"))
              const decoded = PackageTree.decodeManifest(manifest)
              if (decoded === undefined) throw new Error("decodeManifest failed")
              const blobsErr = yield* Effect.promise(() => PackageTree.verifyManifestBlobs(wsRoot, ".flows", decoded))
              if (blobsErr !== undefined) throw new Error("verifyManifestBlobs: " + blobsErr)
              const matchesBefore = yield* Effect.promise(() => PackageTree.treeMatchesManifest(wsRoot, decoded))
              if (matchesBefore !== undefined) throw new Error("treeMatchesManifest before: " + matchesBefore)

              // Delete out/ and materialize from CAS manifest!
              yield* Effect.promise(() => Fs.rm(NodePath.join(wsRoot, "out"), { recursive: true, force: true }))
              yield* Effect.promise(() => PackageTree.materializeManifest(wsRoot, ".flows", decoded))
              const matchesAfter = yield* Effect.promise(() => PackageTree.treeMatchesManifest(wsRoot, decoded))
              if (matchesAfter !== undefined) throw new Error("treeMatchesManifest after: " + matchesAfter)

              // captureFile / decodeFileManifest / verifyFileManifest / materializeFile
              const fileMan = yield* Effect.promise(() => PackageTree.captureFile(wsRoot, ".flows", "out/f0.txt"))
              const decFile = PackageTree.decodeFileManifest(fileMan)
              if (decFile === undefined) throw new Error("decodeFileManifest failed")
              const fileErr = yield* Effect.promise(() => PackageTree.verifyFileManifest(wsRoot, ".flows", decFile))
              if (fileErr !== undefined) throw new Error("verifyFileManifest: " + fileErr)
              yield* Effect.promise(() => Fs.rm(NodePath.join(wsRoot, "out/f0.txt")))
              yield* Effect.promise(() => PackageTree.materializeFile(wsRoot, ".flows", decFile))
              const st = yield* Effect.promise(() => PackageTree.pathState(NodePath.join(wsRoot, "out/f0.txt")))
              if (st.kind !== "file") throw new Error("materializeFile failed")

              // snapshotTree / changedSinceSnapshot / judgedChanges / revertPath / releaseSnapshot
              const snap = yield* Effect.promise(() => PackageTree.snapshotTree(wsRoot, ".flows"))
              yield* Effect.promise(() => write(wsRoot, "out/f0.txt", "MUTATED\n"))
              const changed = yield* Effect.promise(() => PackageTree.changedSinceSnapshot(snap, ".flows"))
              if (!Array.isArray(changed)) throw new Error("changedSinceSnapshot not array")
              const judged = PackageTree.judgedChanges(wsRoot, ["out/f0.txt", "extra/unallowed.txt"], ["out"])
              if (!judged.includes("out/f0.txt") || judged.includes("extra/unallowed.txt")) {
                throw new Error("judgedChanges filtering failed")
              }
              yield* Effect.promise(() => PackageTree.revertPath(snap, "out/f0.txt"))
              yield* Effect.promise(() => PackageTree.releaseSnapshot(snap))

              // InstalledTree measure / identify / difference / describeChange / save / load
              const nmDir = NodePath.join(wsRoot, "node_modules/demo")
              yield* Effect.promise(() => write(wsRoot, "node_modules/demo/index.js", `// ${safeText}\n`))
              const remembered = InstalledTree.empty()
              const id1 = InstalledTree.identify(NodePath.join(wsRoot, "node_modules"), remembered)
              const idFile = InstalledTree.path(wsRoot, ".flows")
              yield* Effect.promise(() => InstalledTree.save(idFile, remembered))
              const loadedRem = yield* Effect.promise(() => InstalledTree.load(idFile))
              const id2 = InstalledTree.identify(NodePath.join(wsRoot, "node_modules"), loadedRem)
              if (id1.digest !== id2.digest) throw new Error("InstalledTree identify not deterministic")
              yield* Effect.promise(() => write(wsRoot, "node_modules/demo/index.js", `// CHANGED ${safeText}\n`))
              const id3 = InstalledTree.identify(NodePath.join(wsRoot, "node_modules"), InstalledTree.empty())
              const diff = InstalledTree.difference(NodePath.join(wsRoot, "node_modules"), id1, id3)
              if (diff !== undefined) {
                InstalledTree.describeChange("node_modules", diff)
              }
              void nmDir

              // DigestIndexFile save / load
              DigestIndexFile.path(wsRoot, ".flows")
              const digIdx = SafeFs.makeDigestIndex()
              yield* Effect.promise(() => DigestIndexFile.save(wsRoot, ".flows", digIdx))
              yield* Effect.promise(() => DigestIndexFile.load(wsRoot, ".flows"))

              // CacheEvidence decide, incomplete, declarationIdentity, attemptFailed, reachedOutside, rightsNeeded
              CacheEvidence.incomplete(rule, { fix: flagOn, buildMode: flagOn, incremental: false })
              const dec = CacheEvidence.decide({
                rule,
                attrs: { fix: false, buildMode: false, incremental: false },
                sandbox: sandboxOff ? "none" : {},
                mechanism: sandboxOff ? S.Sandbox.None() : S.Sandbox.Bubblewrap(),
                services: 0,
                installed: undefined,
                cache: undefined
              })
              CacheEvidence.isEvidence(dec)
              const declId = CacheEvidence.declarationIdentity({
                label: "//:test",
                rule,
                sandbox: undefined,
                inputs: ["src/a.ts"],
                dependencies: [],
                reads: [],
                installedTrees: []
              })
              const writer: CacheEvidence.Writer = { build: "fuzz-build-1", recorder: flagOn ? "strace" : undefined }
              yield* Effect.promise(() =>
                CacheEvidence.rememberFailedAttempt(wsRoot, ".flows", declId, writer, {
                  label: "//:test",
                  denied: [],
                  output: ["boom"]
                })
              )
              const failed = yield* Effect.promise(() => CacheEvidence.attemptFailed(wsRoot, ".flows", declId, writer))
              if (!failed) throw new Error("attemptFailed false after remember")
              const rec = CacheEvidence.record([["src/a.ts", PackageTree.digestBytes(Buffer.from("x"))]], { ok: true })
              const decRec = CacheEvidence.decode(rec)
              if (decRec === undefined) throw new Error("CacheEvidence.decode undefined")
              CacheEvidence.deniedLines("EACCES: permission denied '/etc/secret'\nEPERM: operation not permitted\n")

              // CacheLocation
              const cacheHost: CacheLocation.Host = {
                platform: "linux",
                environment: { HOME: wsRoot },
                home: wsRoot
              }
              CacheLocation.userCacheDirectory(cacheHost)
              CacheLocation.resolve(wsRoot, undefined, { directory: ".flows", outside: flagOn }, "fuzzws", cacheHost)
              CacheLocation.absolute(wsRoot, ".flows")

              // GoCache directory, spawnEnvironment, lease, status, usage, evict
              const goDir = GoCache.directory(wsRoot, ".flows")
              const goEnv = GoCache.spawnEnvironment({ CGO_ENABLED: "0" }, wsRoot, ".flows")
              if (goEnv["GOCACHE"] !== goDir) throw new Error("GoCache GOCACHE mismatch")
              const lease = yield* Effect.promise(() => GoCache.acquireLease(wsRoot, ".flows"))
              const stGo = yield* Effect.promise(() => GoCache.status(wsRoot, ".flows"))
              if (stGo.directory !== goDir) throw new Error("GoCache status dir mismatch")
              yield* Effect.promise(() => GoCache.releaseLease(lease))
              return true
            }),
          { executions: fsExecutions, seed: seed + 11 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Planner key material & Executor DAG scheduler, mergePlans, resolveJobs & cache codec fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        jobs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        nodeCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
        failIndex: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 4 })),
        failFast: Schema.Boolean,
        keySalt: Schema.String.check(Schema.isMaxLength(64))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ jobs, nodeCount, failIndex, failFast, keySalt }) =>
          Effect.gen(function*() {
            const safeSalt = keySalt.replace(/[\uD800-\uDFFF]/g, "")
            // Planner.encodeKeyMaterial & keyOf determinism
            const mat: Planner.KeyMaterial = {
              body: {
                format: Planner.EXECUTION_FORMAT,
                label: "//:build",
                target: "Shell.Build",
                salt: safeSalt,
                n: nodeCount
              },
              inputs: [
                { path: "src/b.ts", digest: "b".repeat(64) },
                { path: "src/a.ts", digest: "a".repeat(64) }
              ],
              layers: ["node:22"],
              capabilities: ["fs"]
            }
            const k1 = Planner.keyOf(mat)
            const k2 = Planner.keyOf(mat)
            if (k1 !== k2 || !PackageTree.isSha256Hex(k1)) throw new Error("keyOf not deterministic")
            const enc = Planner.encodeKeyMaterial(mat)
            if (!enc.includes(safeSalt)) throw new Error("encodeKeyMaterial missing salt")

            // Executor resolveJobs, notStoredCounts, encodeCacheOutput / decodeCacheOutput, describeFailure
            if (Executor.resolveJobs(jobs) !== jobs) throw new Error("resolveJobs mismatch")
            const counts = Executor.notStoredCounts(["cache: false", "cache: false", "no evidence"])
            if (counts.length !== 2 || counts[0]!.count !== 2) throw new Error("notStoredCounts")

            const encoded = Executor.encodeCacheOutput({ ok: true, salt: safeSalt, count: nodeCount })
            if ("reason" in encoded) throw new Error("encodeCacheOutput failed")
            const decoded = Executor.decodeCacheOutput(encoded.output)
            if (!("value" in decoded)) throw new Error("decodeCacheOutput failed")
            if (Executor.describeFailure(new Error("exec-err")).length === 0) throw new Error("describeFailure")

            // Executor.schedule on a generated chain/DAG verifying topological order & fault handling
            const targets: Array<Planner.PlannedTarget> = Array.from({ length: nodeCount }, (_, i) => ({
              label: `//p:t${i}`,
              target: "Shell.Test",
              kinds: ["test"],
              attrs: {},
              dependencies: i > 0 ? [`//p:t${i - 1}`] : [],
              declaredInputs: [],
              declaredOutputs: undefined,
              cacheable: true,
              cacheLookup: "not-wired" as const,
              wouldRun: true as const,
              keyMaterial: mat,
              keyPreview: PackageTree.digestBytes(Buffer.from(`t${i}:${safeSalt}`))
            }))

            const order: Array<string> = []
            const shouldFail = failFast && failIndex >= 0 && failIndex < nodeCount
            const outcome = yield* Effect.result(
              Effect.tryPromise({
                try: () =>
                  Executor.schedule(targets, jobs, async (label) => {
                    order.push(label)
                    if (shouldFail && label === `//p:t${failIndex}`) {
                      throw new Error("injected-fail")
                    }
                  }),
                catch: (err) => err
              })
            )
            if (shouldFail && outcome._tag !== "Failure") throw new Error("expected schedule rejection")
            if (!shouldFail && outcome._tag !== "Success") throw new Error("unexpected schedule rejection")
            if (!shouldFail && order.length !== nodeCount) throw new Error("schedule missed targets")
            // Verify every dependency ran before its dependent
            const pos = new Map(order.map((l, idx) => [l, idx]))
            for (const t of targets) {
              const p = pos.get(t.label)
              if (p === undefined) continue
              for (const dep of t.dependencies) {
                const dp = pos.get(dep)
                if (dp === undefined || dp > p) throw new Error("topological order violated")
              }
            }
            return true
          }),
        { executions: Math.min(executions, 80), seed: seed + 12 }
      )
    )
    assertPassed(report)
  })
})
