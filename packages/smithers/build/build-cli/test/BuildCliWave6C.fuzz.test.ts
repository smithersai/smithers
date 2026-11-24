import * as HttpClient from "effect/http/HttpClient"
import * as Sandbox from "@smthrs/sandbox/Sandbox"
import { Smithers as S } from "@smthrs/targets"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Schema, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as Entry from "../src/Entry.ts"
import * as Engine from "../src/engine.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import * as RemoteCi from "../src/internal/RemoteCi.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as Resolver from "../src/Resolver.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fastExecs = Math.max(10, Math.min(executions, 30))
const ioExecs = Math.max(4, Math.min(executions, 8))

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
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex")

describe("@smthrs/build-cli Wave-6C: Cache, OutputCas, RemoteCi, GithubRender, Entry, Engine, PackageLoader & Resolver deep fuzz", () => {
  it("Cache remote HTTP server (Retry-After 429/503, Content-Length/body bounds, /cas/findMissing, endpoint & record validation) & OutputCas chunked hydrate", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        httpMode: Schema.Literals(["ok_roundtrip", "retry_after_sec", "retry_after_date", "bad_content_length", "oversized_content_length", "corrupt_cas_blob"]),
        badKey: Schema.Literals(["empty", "too_long", "unicode_hash", "clean"]),
        badPut: Schema.Literals(["none", "proxy", "unknown_key", "getter_prop", "surrogate_str"]),
        badEndpoint: Schema.Literals(["http_non_loopback", "with_creds", "with_query", "valid_loopback"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ httpMode, badKey, badPut, badEndpoint }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6c-cache-", async (dir) => {
              // 1. Cache.sanitizeKey invariants
              if (badKey === "empty" || badKey === "too_long") {
                expect(() => Cache.sanitizeKey(badKey === "empty" ? "" : "a".repeat(70_000))).toThrow(TypeError)
              } else if (badKey === "unicode_hash") {
                const k = Cache.sanitizeKey("key with spaces & \uD83D\uDE00")
                expect(k).toMatch(/^[0-9a-f]{64}$/)
              } else {
                expect(Cache.sanitizeKey("clean-key_1.0")).toBe("clean-key_1.0")
              }

              // 2. Endpoint validation
              if (badEndpoint !== "valid_loopback") {
                const url =
                  badEndpoint === "http_non_loopback"
                    ? "http://example.invalid/cache"
                    : badEndpoint === "with_creds"
                      ? "https://user:pass@cache.example.invalid"
                      : "http://127.0.0.1:9999/cache?foo=bar"
                await expect(
                  Cache.openCache({
                    workspaceRoot: dir,
                    cacheDirectory: ".bad-ep",
                    endpoint: url,
                    readToken: () => "tok"
                  })
                ).rejects.toThrow()
              }

              // 3. Real loopback HTTP remote cache + CAS server
              const entries = new Map<string, Buffer>()
              const casBlobs = new Map<string, Buffer>()
              let casRetries = 0
              const server = NodeHttp.createServer(async (req, res) => {
                const chunks: Array<Buffer> = []
                for await (const c of req) chunks.push(Buffer.from(c as Uint8Array))
                const body = Buffer.concat(chunks)
                const url = req.url ?? "/"

                if ((httpMode === "retry_after_sec" || httpMode === "retry_after_date") && /\/cas\/[0-9a-f]{64}$/.test(url) && casRetries === 0) {
                  casRetries += 1
                  res.statusCode = 429
                  res.setHeader(
                    "Retry-After",
                    httpMode === "retry_after_sec" ? "0.01" : "99999"
                  )
                  res.end("retry")
                  return
                }

                if (url.endsWith("/cas/findMissing") && req.method === "POST") {
                  const parsed = JSON.parse(body.toString("utf8")) as { digests: Array<string> }
                  const missing = parsed.digests.filter((d) => !casBlobs.has(d))
                  res.statusCode = 200
                  res.setHeader("content-type", "application/json")
                  res.end(JSON.stringify({ missing }))
                  return
                }

                const casMatch = /\/cas\/([0-9a-f]{64})$/.exec(url)
                if (casMatch !== null) {
                  const digest = casMatch[1]!
                  if (req.method === "PUT") {
                    casBlobs.set(digest, body)
                    res.statusCode = 200
                    res.end("ok")
                    return
                  }
                  if (req.method === "GET") {
                    const blob = casBlobs.get(digest)
                    if (blob === undefined) {
                      res.statusCode = 404
                      res.end()
                      return
                    }
                    res.statusCode = 200
                    res.end(httpMode === "corrupt_cas_blob" ? Buffer.from("corrupted!") : blob)
                    return
                  }
                }

                const entryMatch = /\/ac\/([^/]+)$/.exec(url)
                if (entryMatch !== null) {
                  const key = decodeURIComponent(entryMatch[1]!)
                  if (req.method === "PUT") {
                    entries.set(key, body)
                    res.statusCode = 200
                    res.end("ok")
                    return
                  }
                  if (req.method === "GET") {
                    const data = entries.get(key)
                    if (data === undefined) {
                      res.statusCode = 404
                      res.end()
                      return
                    }
                    if (httpMode === "bad_content_length") {
                      res.writeHead(200, { "content-length": "not-a-number" })
                      res.end(data)
                      return
                    }
                    if (httpMode === "oversized_content_length") {
                      res.writeHead(200, { "content-length": String(Cache.remoteEntryLimit + 100) })
                      res.end()
                      return
                    }
                    res.statusCode = 200
                    res.setHeader("content-length", String(data.length))
                    res.end(data)
                    return
                  }
                }
                res.statusCode = 404
                res.end()
              })

              await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
              const port = (server.address() as { port: number }).port
              const endpoint = `http://127.0.0.1:${port}`
              try {
                const localDir1 = NodePath.join(dir, ".c1")
                const localDir2 = NodePath.join(dir, ".c2")
                const warns: Array<string> = []
                const c1 = await Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: ".c1",
                  endpoint,
                  readToken: () => "test-tok",
                  writeToken: () => "test-tok",
                  warn: (w) => void warns.push("c1:" + w)
                })

                // Exercise bad put record validation
                if (badPut !== "none") {
                  const validKey = sha256("k-" + badPut)
                  if (badPut === "proxy") {
                    await expect(c1.put(validKey, new Proxy({}, {}) as never)).rejects.toThrow(TypeError)
                  } else if (badPut === "unknown_key") {
                    await expect(c1.put(validKey, { key: validKey, target: "Shell.Build", label: "//:a", exitOk: true, storedAt: "2026-01-01T00:00:00.000Z", output: {}, extra: 1 } as never)).rejects.toThrow(TypeError)
                  } else if (badPut === "getter_prop") {
                    const obj: Record<string, unknown> = { key: validKey, target: "Shell.Build", label: "//:a", exitOk: true, storedAt: "2026-01-01T00:00:00.000Z" }
                    Object.defineProperty(obj, "output", { get: () => ({}), enumerable: true })
                    await expect(c1.put(validKey, obj as never)).rejects.toThrow(TypeError)
                  } else if (badPut === "surrogate_str") {
                    await c1.put(validKey, {
                      key: validKey,
                      target: "Shell.Build",
                      label: "//:a",
                      exitOk: true,
                      storedAt: new Date().toISOString(),
                      output: { text: "hi \n\t\r\"\\ \u0001 \uD83D\uDE00 \uD800 \u00e9 \u2603" }
                    })
                    const got = await c1.get(validKey)
                    expect(got?.exitOk).toBe(true)
                  }
                }

                // Put entry with CAS files -> upload to remote -> hydrate into fresh localDir2
                const blobBytes = Buffer.from(`cas-payload-${httpMode}`)
                const blobDigest = sha256(blobBytes)
                await OutputCas.writeBlob(NodePath.join(localDir1, "cas"), blobDigest, blobBytes)
                const entryKey = sha256(`entry-${httpMode}`)
                await c1.put(entryKey, {
                  key: entryKey,
                  target: "Shell.Build",
                  label: "//:build",
                  exitOk: true,
                  storedAt: new Date().toISOString(),
                  output: {
                    kind: "build",
                    manifests: [],
                    files: [{ path: "dist/out.txt", digest: blobDigest, size: blobBytes.length, mode: 0o644 }]
                  }
                })

                const c2 = await Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: ".c2",
                  endpoint,
                  readToken: () => "test-tok",
                  warn: (w) => void warns.push("c2:" + w)
                })
                const fetched = await c2.get(entryKey)
                if (httpMode === "bad_content_length" || httpMode === "oversized_content_length" || httpMode === "corrupt_cas_blob" || httpMode === "retry_after_date") {
                  // Must refuse bad/corrupt remote responses safely
                  expect(fetched).toBeNull()
                } else {
                  expect(fetched?.exitOk, JSON.stringify({ warns, entries: [...entries.keys()], cas: [...casBlobs.keys()] })).toBe(true)
                  expect(await OutputCas.hasFile(NodePath.join(localDir2, "cas"), blobDigest)).toBe(true)
                }

                // OutputCas chunked index round-trip & corruption check
                const casDir = NodePath.join(dir, "cas-chunk")
                const chunkBuf = Buffer.from("chunk-data")
                const chunkDigest = sha256(chunkBuf)
                await OutputCas.writeBlob(casDir, chunkDigest, chunkBuf)
                const idxBuf = Buffer.from(JSON.stringify({ kind: "smithers-build/chunks-v1", size: OutputCas.chunkBytes + 10, chunks: [{ digest: chunkDigest, size: OutputCas.chunkBytes }, { digest: chunkDigest, size: 10 }] }))
                const idxDigest = sha256(idxBuf)
                await OutputCas.writeBlob(casDir, idxDigest, idxBuf)
                const idx = await OutputCas.readIndex(casDir, idxDigest)
                expect(idx.chunks.length).toBe(2)
                const badIdxBuf = Buffer.from("{bad json")
                const badIdxDigest = sha256(badIdxBuf)
                await OutputCas.writeBlob(casDir, badIdxDigest, badIdxBuf)
                await expect(OutputCas.readIndex(casDir, badIdxDigest)).rejects.toThrow()
              } finally {
                await new Promise<void>((r) => server.close(() => r()))
              }
            })
            return true
          }),
        { seed: 20261320, executions: ioExecs }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("RemoteCi.providers, run, MachineLost retry, merge, pack & GithubRender multi-toolchain workflows + check/write", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        toolchainKind: Schema.Literals(["pnpm_node", "bun", "go_rust", "writer_in_setup_err"]),
        remoteKind: Schema.Literals(["command", "http_ok", "http_missing_token"]),
        partFail: Schema.Boolean,
        machineLostOnce: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ toolchainKind, remoteKind, partFail, machineLostOnce }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6c-ci-", async (root) => {
              // 1. RemoteCi.providers + RemoteCi.run over real Effect Sandbox.Provider
              const remoteDecl =
                remoteKind === "command"
                  ? S.Remote.Command({ machines: [["sh", "-c"], ["sh", "-c"]], workdir: "/work" })
                  : S.Remote.Http({
                    url: "http://127.0.0.1:9999",
                    token: S.Secret("REMOTE_TOK"),
                    machines: 2,
                    workdir: "/work",
                    limits: { cpus: 2, memoryMib: 1024, timeoutSecs: 60 }
                  })
              expect(RemoteCi.machineCount(remoteDecl)).toBe(2)

              if (remoteKind === "http_missing_token") {
                expect(() => RemoteCi.providers(remoteDecl, {})).toThrow()
              } else {
                const provFactory = RemoteCi.providers(remoteDecl, { REMOTE_TOK: "sec" })
                const spawnerLayer = Layer.succeed(
                  ChildProcessSpawner.ChildProcessSpawner,
                  ChildProcessSpawner.make(() => Effect.die("unused"))
                )
                const httpLayer = Layer.succeed(HttpClient.HttpClient, {} as never)
                const prov = await Effect.runPromise(
                  provFactory(1, "/work").pipe(Effect.provide(Layer.mergeAll(spawnerLayer, httpLayer)))
                )
                expect(prov).toBeDefined()
              }

              // Execute RemoteCi.run with real Effect Sandbox.Provider
              const lines: Array<string> = []
              let attemptNum = 0
              const memProvider = (): Effect.Effect<Sandbox.Provider> =>
                Effect.succeed({
                  name: "mem-sandbox",
                  acquire: () =>
                    Effect.sync(() => {
                      let resultJson = ""
                      const session: Sandbox.Session = {
                        id: `s-${++attemptNum}`,
                        workdir: "/work",
                        writeFile: (_path: string, _bytes: Uint8Array) => Effect.void,
                        readFile: (_path: string) => Effect.succeed(new TextEncoder().encode(resultJson)),
                        spawn: (script: string, _opts?: unknown) =>
                          Effect.gen(function*() {
                            if (machineLostOnce && attemptNum === 1 && script.includes("ci")) {
                              return yield* Effect.fail(new Error("machine lost") as never)
                            }
                            if (script.includes("ci")) {
                              resultJson = JSON.stringify({ label: "//:t1", status: partFail ? "failed" : "ran", durationMs: 5 }) + "\n"
                            }
                            return {
                              stdout: Stream.make(new TextEncoder().encode("remote-out\n")),
                              stderr: Stream.make(new TextEncoder().encode("remote-err\n")),
                              exitCode: Effect.succeed(partFail ? 1 : 0)
                            } as never
                          })
                      } as unknown as Sandbox.Session
                      return session
                    })
                } as unknown as Sandbox.Provider)

              const treeBytes = RemoteCi.pack([{ path: "a.txt", content: new TextEncoder().encode("hi"), mode: 0o644, mtimeMs: 0 }])
              const rows = await Effect.runPromise(
                RemoteCi.run({
                  remote: S.Remote.Command({ machines: [["sh", "-c"]], workdir: "/work" }),
                  runId: "run-1",
                  tree: treeBytes,
                  parts: [{ machine: 1, roots: ["//:t1"] }],
                  flags: ["--no-cache"],
                  output: (l) => void lines.push(l),
                  provider: () => memProvider()
                })
              )
              const merged = RemoteCi.merge([{ label: "//:t1", target: "Shell.Test" }], rows, { pattern: "//:t1", jobs: 1, durationMs: 10 })
              expect(merged.results.length).toBeGreaterThan(0)
              expect(RemoteCi.quote("a'b c")).toContain("'")

              // 2. GithubRender.render + check + write across workspace toolchains
              const manifest = S.file("//package.json")
              const readTok = S.Secret("CACHE_READ")
              const writeTok = S.Secret("CACHE_WRITE")
              const cacheUrl = S.Secret("CACHE_URL")
              const gate = S.Shell.Test({ shell: "true" })
              const cron = S.Cron({ schedule: "0 6 * * 1", run: [gate] })

              const ws =
                toolchainKind === "bun"
                  ? S.Workspace("gh-bun", {
                    repository: "git+https://example.invalid/gh.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest })
                  })
                  : toolchainKind === "go_rust"
                    ? S.Workspace("gh-gorust", {
                      repository: "git+https://example.invalid/gh.git",
                      cache: S.Cache({ directory: ".flows" }),
                      toolchains: [
                        S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: S.Mise({ config: S.file("//mise.toml") }) }),
                        S.Rust.Toolchain({ toolchain: S.file("//rust-toolchain.toml"), lockfile: S.file("//Cargo.lock") })
                      ]
                    })
                    : S.Workspace("gh-node", {
                      repository: "git+https://example.invalid/gh.git",
                      cache: S.Cache({
                        directory: ".flows",
                        remote: S.RemoteCache.make({ endpoint: "https://cache.example.invalid", read: readTok, write: writeTok })
                      }),
                      runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                      packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
                      nodeModules: S.Npm.NodeModules({ packageJson: manifest })
                    })

              const setup = S.Github.Setup({
                cacheUrl,
                cacheToken: toolchainKind === "writer_in_setup_err" ? writeTok : readTok
              })
              const wf = S.Github.Workflow({
                name: "ci",
                on: { pullRequest: true, push: { branches: ["main"] } },
                setup,
                run: [gate]
              })
              const ciGen = S.Github.CiGen({
                workflows: [wf],
                changes: ["workflows/**", "actions/setup/**"]
              })

              const labels = new Map<unknown, string>([
                [gate, "//:gate"],
                [cron, "//:cron"],
                [setup, "//:setup"],
                [wf, "//:wf"],
                [ciGen, "//:ciGen"]
              ])
              const resolve: GithubRender.LabelResolver = {
                labelOf: (t) => labels.get(t)
              }

              if (toolchainKind === "writer_in_setup_err") {
                expect(() => GithubRender.render({ ciGen, workspace: ws, resolve, packageDir: "" })).toThrow()
              } else {
                const rendered = GithubRender.render({ ciGen, workspace: ws, resolve, packageDir: "" })
                expect(rendered.files.length).toBeGreaterThanOrEqual(2)
                const before = await GithubRender.check(root, rendered)
                expect(before.clean).toBe(false)
                // Add an unexpected file in write-set to test removal & stale detection
                await Fs.mkdir(NodePath.join(root, "workflows"), { recursive: true })
                await Fs.writeFile(NodePath.join(root, "workflows", "stale.yml"), "old: true\n")
                const written = await GithubRender.write(root, rendered)
                expect(written.wrote.length).toBeGreaterThan(0)
                expect(written.removed).toContain("workflows/stale.yml")
                const after = await GithubRender.check(root, rendered)
                expect(after.clean).toBe(true)
              }
            })
            return true
          }),
        { seed: 20261321, executions: ioExecs }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Entry.main host harness & Engine.runInstall validation + PackageLoader & Resolver #imports/escapes/closures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        entryMode: Schema.Literals(["version", "bad_audience", "strip_cache_env", "signal_abort"]),
        installBad: Schema.Literals(["empty_root", "non_plain_opts", "unknown_opt", "getter_opt", "bad_cache_dir", "aborted_signal", "bad_toolchain"]),
        loaderSyntax: Schema.Literals(["escapes_and_comments", "template_and_regex", "case_fold"]),
        resolverMode: Schema.Literals(["hash_imports_wildcard", "exports_conditions", "dir_index_and_ext", "depth_cycle"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ entryMode, installBad, loaderSyntax, resolverMode }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6c-misc-", async (root) => {
              // 1. Entry.main(host)
              const outBuf: Array<string> = []
              const errBuf: Array<string> = []
              let exitCode = 0
              const listeners = new Map<string, Set<() => void>>()
              const env: Record<string, string | undefined> = {
                PATH: process.env["PATH"],
                ...(entryMode === "bad_audience" ? { SMITHERS_AUDIENCE: "not-an-audience" } : {}),
                ...(entryMode === "strip_cache_env" ? { SMITHERS_CACHE_URL: "http://127.0.0.1:9999", SMITHERS_CACHE_TOKEN: "secret-tok" } : {})
              }
              const host: Entry.Host = {
                argv: entryMode === "version" ? ["--version"] : ["--help"],
                env,
                cwd: root,
                stdin: { isTTY: false },
                stdout: { isTTY: false, columns: 80, write: (s) => void outBuf.push(s) },
                stderr: { isTTY: false, columns: 80, write: (s) => void errBuf.push(s) },
                on: (sig, fn) => {
                  let set = listeners.get(sig)
                  if (set === undefined) { set = new Set(); listeners.set(sig, set) }
                  set.add(fn)
                  if (entryMode === "signal_abort" && sig === "SIGINT") fn()
                },
                removeListener: (sig, fn) => void listeners.get(sig)?.delete(fn),
                setExitCode: (code) => { exitCode = code }
              }
              await Entry.main(host)
              if (entryMode === "bad_audience") {
                expect(exitCode).toBe(1)
                expect(errBuf.join("")).toContain("smithers-build:")
              } else if (entryMode === "strip_cache_env") {
                expect(env["SMITHERS_CACHE_TOKEN"]).toBeUndefined()
              } else if (entryMode === "signal_abort") {
                expect(exitCode).toBe(1)
              } else {
                expect(exitCode).toBe(0)
              }

              // 2. Engine.runInstall option & boundary validation
              if (installBad === "empty_root") {
                await expect(Engine.runInstall("")).rejects.toThrow(TypeError)
              } else if (installBad === "non_plain_opts") {
                await expect(Engine.runInstall(root, new Date() as never)).rejects.toThrow(TypeError)
              } else if (installBad === "unknown_opt") {
                await expect(Engine.runInstall(root, { bogus: 1 } as never)).rejects.toThrow(TypeError)
              } else if (installBad === "getter_opt") {
                const o: Record<string, unknown> = {}
                Object.defineProperty(o, "cacheDirectory", { get: () => ".flows", enumerable: true })
                await expect(Engine.runInstall(root, o as never)).rejects.toThrow(TypeError)
              } else if (installBad === "bad_cache_dir") {
                await expect(Engine.runInstall(root, { cacheDirectory: ".other" })).rejects.toThrow()
              } else if (installBad === "aborted_signal") {
                const ac = new AbortController()
                ac.abort(new Error("stop"))
                await expect(Engine.runInstall(root, { signal: ac.signal })).rejects.toThrow()
              } else if (installBad === "bad_toolchain") {
                await expect(Engine.runInstall(root, { toolchain: { manager: "invalid" } as never })).rejects.toThrow()
              }

              // 3. PackageLoader lexical scanner & probeCacheDirectory
              const loaderRoot = NodePath.join(root, "loader-ws")
              await Fs.mkdir(NodePath.join(loaderRoot, "pkg"), { recursive: true })
              const cacheDirLiteral =
                loaderSyntax === "escapes_and_comments"
                  ? `/* block\ncomment */ // line\n".fl\\x6f\\u0077s\\u{2D}1"`
                  : loaderSyntax === "template_and_regex"
                    ? `const re = /foo\\//g; /* c */ const c = ".flows-2"`
                    : `".flows-3"`
              await Fs.writeFile(
                NodePath.join(loaderRoot, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\n${loaderSyntax === "template_and_regex" ? cacheDirLiteral + "\n" : ""}export const Workspace = S.Workspace("ldr", {\n  repository: "git+https://example.invalid/ldr.git",\n  cache: S.Cache({ directory: ${loaderSyntax === "template_and_regex" ? '".flows-2"' : cacheDirLiteral} })\n})\n`
              )
              await Fs.writeFile(
                NodePath.join(loaderRoot, "pkg", "PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nconst s = "a\\nb\\tc\\r\\x41\\u0042\\u{1F600}\\\\end"\nexport const Package = S.Package({ targets: { ok: S.Shell.Test({ shell: "true" }) } })\n`
              )
              const probed = await PackageLoader.probeCacheDirectory(loaderRoot, "WORKSPACE.ts")
              expect(probed).toMatch(/^\.flows/)
              const disc = await PackageDiscovery.discover(loaderRoot)
              const loaded = await PackageLoader.load(disc)
              expect(loaded.packages.length).toBe(1)

              // 4. Resolver #imports, subpath exports, directory index & depth cycle
              const resRoot = NodePath.join(root, "res-ws")
              await Fs.mkdir(NodePath.join(resRoot, "src", "dir"), { recursive: true })
              await Fs.mkdir(NodePath.join(resRoot, "node_modules", "dep-pkg", "dist"), { recursive: true })
              const pkgJson =
                resolverMode === "depth_cycle"
                  ? {
                    name: "res-app",
                    type: "module",
                    imports: {
                      "#self": { import: { default: { import: { default: { import: { default: { import: { default: { import: "./src/a.ts" } } } } } } } } }
                    }
                  }
                  : {
                    name: "res-app",
                    type: "module",
                    imports: {
                      "#internal/*": { import: "./src/*.ts", require: "./src/*.ts", default: "./src/*.ts" },
                      "#direct": "./src/a.ts"
                    }
                  }
              await Fs.writeFile(NodePath.join(resRoot, "package.json"), JSON.stringify(pkgJson))
              await Fs.writeFile(
                NodePath.join(resRoot, "node_modules", "dep-pkg", "package.json"),
                JSON.stringify({
                  name: "dep-pkg",
                  exports: { ".": { import: "./dist/index.mjs" }, "./sub/*": "./dist/*.mjs" }
                })
              )
              await Fs.writeFile(NodePath.join(resRoot, "node_modules", "dep-pkg", "dist", "index.mjs"), "export const d = 1\n")
              await Fs.writeFile(NodePath.join(resRoot, "node_modules", "dep-pkg", "dist", "foo.mjs"), "export const f = 2\n")
              await Fs.writeFile(NodePath.join(resRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "bundler" } }))
              await Fs.writeFile(NodePath.join(resRoot, "src", "a.ts"), "export const a = 1\n")
              await Fs.writeFile(NodePath.join(resRoot, "src", "dir", "index.ts"), "export const idx = 1\n")
              const entryCode =
                resolverMode === "hash_imports_wildcard"
                  ? 'import { a } from "#internal/a"\nimport { a as b } from "#direct"\nimport fs from "node:fs"\nconsole.log(a, b, fs)\n'
                  : resolverMode === "exports_conditions"
                    ? 'import { d } from "dep-pkg"\nimport { f } from "dep-pkg/sub/foo"\nconsole.log(d, f)\n'
                    : resolverMode === "dir_index_and_ext"
                      ? 'import { idx } from "./dir"\nimport { a } from "./a.js"\nconsole.log(idx, a)\n'
                      : 'import "#self"\n'
              await Fs.writeFile(NodePath.join(resRoot, "src", "entry.ts"), entryCode)
              const config = await Resolver.loadResolverConfig({ workspaceRoot: resRoot, tsconfig: "tsconfig.json" })
              const closure = await Resolver.computeClosure({
                entries: ["src/entry.ts"],
                config
              })
              expect(closure.result.files.length).toBeGreaterThanOrEqual(1)
            })
            return true
          }),
        { seed: 20261322, executions: ioExecs }
      )
    )
    assertPassed(report)
  }, 60_000)
})
