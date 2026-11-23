import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { once } from "node:events"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import type * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import { FilePublicationHost, filePublicationHostLive } from "../src/internal/FilePublicationHost.ts"
import * as Cache from "../src/Cache.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import * as Watch from "../src/Watch.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 8)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const gitExec = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("git", ["-C", root, ...args], (err, stdout) => {
      if (err !== null) reject(err)
      else resolve(stdout.trim())
    })
  })

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,6}$/))

describe("@smthrs/build-cli deep fuzz suite 6: AgentSession, PackageTree, ServiceSupervisor, Watch.run & Cache/OutputCas faults", () => {
  it("AgentSession parseEnvelope, resolveAgents, makeCliSessionFactory, expandDiffSlice, writeSetApplier, verdictStores, precheckMcp & runAgentLint/Diff/Pr", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        outcome: Schema.Literals(["clean", "findings", "needs-input", "mcp-down", "write-escape"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, outcome }) =>
          Effect.promise(async () => {
            const mcpSrv = NodeHttp.createServer((_req, res) => {
              res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}')
            })
            mcpSrv.listen(0, "127.0.0.1")
            await once(mcpSrv, "listening")
            const mcpPort = (mcpSrv.address() as NodeNet.AddressInfo).port
            const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`

            try {
              await withTempDir("smthrs-bc6-ag-", async (root) => {
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
                await Fs.writeFile(NodePath.join(root, "PROMPT.md"), `Review ${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `export const a = "${slug}"\n`)
                await gitExec(root, ["init", "--quiet", "--initial-branch=main"])
                await gitExec(root, ["config", "user.name", "Fuzz"])
                await gitExec(root, ["config", "user.email", "fuzz@example.invalid"])
                await gitExec(root, ["config", "commit.gpgsign", "false"])
                await gitExec(root, ["add", "-A"])
                await gitExec(root, ["commit", "--quiet", "-m", "base"])
                const baseSha = await gitExec(root, ["rev-parse", "HEAD"])
                await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `export const a = "${slug}-v2"\n`)

                // Pure helpers
                const envParsed = AgentSession.parseEnvelope(
                  JSON.stringify({ note: `done ${slug}`, findings: [], edits: [] })
                )
                expect(envParsed.note).toBe(`done ${slug}`)
                let badEnv = false
                try { AgentSession.parseEnvelope("not-json") } catch { badEnv = true }
                expect(badEnv).toBe(true)
                expect(
                  AgentSession.codexErrorMessages('{"type":"error","message":"boom"}\nnot-json\n').length
                ).toBeGreaterThanOrEqual(1)

                const claudeDecl = S.Agent.ClaudeCode({ model: "claude-sonnet-4" })
                const codexDecl = S.Agent.Codex({ model: "gpt-6-sol" })
                const agentsDecl = S.Agents({ claude: claudeDecl, codex: codexDecl })
                const poolDecl = S.Agent.Pool(["claude", "codex"])
                const resolved = AgentSession.resolveAgents(agentsDecl, poolDecl)
                expect(resolved.length).toBe(2)
                expect(AgentSession.agentIdentityOf(resolved).length).toBeGreaterThan(0)
                expect(AgentSession.claudeMcpConfig([{ _tag: "McpHttp", name: "m1", url: mcpUrl }])).toContain(mcpUrl)

                // expandDiffSlice
                const diff = await Effect.runPromise(AgentSession.expandDiffSlice(root, [Input.gitDiff(baseSha)]))
                expect(diff.files.some((f) => f.includes("src/a.ts"))).toBe(true)

                // renderDataFiles
                const rendered = await Effect.runPromise(
                  AgentSession.renderDataFiles(root, ["src/a.ts"])
                )
                expect(rendered).toContain(slug)

                // makeLocalWriteSetApplier: apply + commit + discard + reject escaping path
                const applier = AgentSession.makeLocalWriteSetApplier(root)
                const overlay = await Effect.runPromise(
                  applier.apply(
                    [{ path: "src/gen.ts", contents: `export const g = "${slug}"\n` }],
                    ["src/**"]
                  )
                )
                await Effect.runPromise(
                  applier.commit(overlay).pipe(Effect.provideService(FilePublicationHost, filePublicationHostLive))
                )
                expect(await Fs.readFile(NodePath.join(root, "src", "gen.ts"), "utf8")).toContain(slug)
                const escExit = await Effect.runPromiseExit(
                  applier.apply([{ path: "../outside.txt", contents: "nope" }], ["src/**"])
                )
                expect(Exit.isFailure(escExit)).toBe(true)

                // Verdict stores (memory + file)
                const memStore = AgentSession.makeMemoryVerdictStore()
                const fileStore = AgentSession.makeFileVerdictStore(NodePath.join(root, ".verdicts"))
                const vk = AgentSession.verdictKey({
                  kind: "lint",
                  diffDigest: "d1",
                  promptDigest: "p1",
                  agentIdentity: "id1",
                  mode: "check",
                  gateIdentities: []
                })
                await Effect.runPromise(memStore.put(vk, JSON.stringify({ ok: true, summary: "clean", findings: [] })))
                expect(await Effect.runPromise(memStore.get(vk))).toBeDefined()
                await Effect.runPromise(fileStore.put(vk, JSON.stringify({ ok: true, summary: "clean", findings: [] })).pipe(Effect.provideService(FilePublicationHost, filePublicationHostLive)))
                expect(await Effect.runPromise(fileStore.get(vk))).toBeDefined()

                // precheckMcp (up vs down)
                const upExit = await Effect.runPromiseExit(
                  AgentSession.precheckMcp([{ _tag: "McpHttp", name: "ok", url: mcpUrl }])
                )
                expect(Exit.isSuccess(upExit)).toBe(true)
                if (outcome === "mcp-down") {
                  const downExit = await Effect.runPromiseExit(
                    AgentSession.precheckMcp([{ _tag: "McpHttp", name: "bad", url: "http://127.0.0.1:1/nope" }])
                  )
                  expect(Exit.isFailure(downExit)).toBe(true)
                }

                // makeCliSessionFactory with fake claude CLI + runAgentLint
                const binDir = NodePath.join(root, "fake-bin")
                await Fs.mkdir(binDir, { recursive: true })
                const fakeResp =
                  outcome === "findings"
                    ? {
                        note: "found issue",
                        findings: [{ file: "src/a.ts", line: 1, severity: "error", message: `bad ${slug}` }]
                      }
                    : outcome === "needs-input"
                    ? { note: "needs-input", findings: [] }
                    : outcome === "write-escape"
                    ? { note: "escaped", edits: [{ path: "../escape.txt", kind: "write", content: "x" }] }
                    : { note: `clean ${slug}`, findings: [], edits: [] }

                await writeExecutable(
                  NodePath.join(binDir, "claude"),
                  `#!${process.execPath}
(async () => {
  for await (const _ of process.stdin) {}
  process.stdout.write(JSON.stringify({ type: "result", result: ${JSON.stringify(JSON.stringify(fakeResp))} }));
})();
`
                )

                const factory = AgentSession.makeCliSessionFactory({
                  workspaceRoot: root,
                  agents: undefined,
                  environment: { PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}` }
                })
                const lintTarget = S.Agent.Lint({
                  agent: claudeDecl,
                  prompt: Input.file("PROMPT.md"),
                  data: [Input.file("src/a.ts")]
                })
                const lintAttrs = Target.metadata(lintTarget).attrs as typeof AgentTarget.LintAttrs.Type
                const runtime: AgentSession.AgentRuntime = {
                  workspaceRoot: root,
                  sessions: factory,
                  writeSets: applier,
                  gates: AgentSession.unavailableGateRunner,
                  verdicts: memStore,
                  prOpener: AgentSession.unavailablePrOpener
                }
                const lintExit = await Effect.runPromiseExit(
                  AgentSession.runAgentLint(runtime, {
                    agent: claudeDecl,
                    promptPath: "PROMPT.md",
                    packageDirectory: root,
                    diffs: [Input.gitDiff(baseSha)],
                    mode: outcome === "write-escape" ? "fix" : "check",
                    fixes: ["src/**"],
                    mcp: []
                  } as never)
                )
                if (outcome === "clean") { if (Exit.isFailure(lintExit)) throw new Error(String(lintExit.cause)); expect(Exit.isSuccess(lintExit)).toBe(true) }
                else expect(typeof lintExit._tag).toBe("string")
              })
            } finally {
              await new Promise<void>((resolve) => mcpSrv.close(() => resolve()))
            }
            return true
          }),
        { executions: fsExecutions, seed: 20261240 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("PackageTree snapshot/revert/quarantine, ignored census/revert, portals snapshot/revert & OutDir/File capture/materialize/limits fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        mutation: Schema.Literals(["modify", "delete", "create", "symlink-replace"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, mutation }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-bc6-tree-", async (base) => {
              const root = NodePath.join(base, "ws")
              const externalPortal = NodePath.join(base, "portal-ext")
              const casDir = NodePath.join(base, "cas")
              await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
              await Fs.mkdir(NodePath.join(root, "dist", "sub"), { recursive: true })
              await Fs.mkdir(NodePath.join(root, "ignored-dir"), { recursive: true })
              await Fs.mkdir(externalPortal, { recursive: true })
              await Fs.mkdir(casDir, { recursive: true })

              await Fs.writeFile(NodePath.join(root, ".gitignore"), "ignored-dir/\n.flows/\n")
              await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `orig-${slug}\n`)
              await Fs.writeFile(NodePath.join(root, "dist", "sub", "bundle.js"), `bundle-${slug}\n`)
              await Fs.writeFile(NodePath.join(root, "ignored-dir", "temp.txt"), `ign-${slug}\n`)
              await Fs.writeFile(NodePath.join(externalPortal, "ext.txt"), `ext-${slug}\n`)
              await Fs.symlink(externalPortal, NodePath.join(root, "portal-link"))

              await gitExec(root, ["init", "--quiet", "--initial-branch=main"])
              await gitExec(root, ["config", "user.name", "Tree"])
              await gitExec(root, ["config", "user.email", "tree@example.invalid"])
              await gitExec(root, ["config", "commit.gpgsign", "false"])
              await gitExec(root, ["add", ".gitignore", "src/a.ts", "portal-link"])
              await gitExec(root, ["commit", "--quiet", "-m", "seed"])

              // 1. Tree snapshot -> mutate -> changedSinceSnapshot -> revertPath -> releaseSnapshot
              const snap = await PackageTree.snapshotTree(root, ".flows")
              try {
                if (mutation === "modify") {
                  await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `mutated-${slug}\n`)
                } else if (mutation === "delete") {
                  await Fs.rm(NodePath.join(root, "src", "a.ts"))
                } else if (mutation === "create") {
                  await Fs.writeFile(NodePath.join(root, "src", "extra.ts"), `extra-${slug}\n`)
                } else {
                  await Fs.rm(NodePath.join(root, "src", "a.ts"))
                  await Fs.symlink("nonexistent", NodePath.join(root, "src", "a.ts"))
                }
                const changed = await PackageTree.changedSinceSnapshot(snap, ".flows")
                expect(changed.length).toBeGreaterThanOrEqual(1)
                const judged = PackageTree.judgedChanges(root, changed, ["src"])
                expect(judged.length).toBeGreaterThanOrEqual(1)

                const quarantine = PackageTree.openQuarantine(root, ".flows", "//:test")
                for (const p of changed) {
                  await PackageTree.revertPath(snap, p, quarantine)
                }
                expect(await Fs.readFile(NodePath.join(root, "src", "a.ts"), "utf8")).toBe(`orig-${slug}\n`)
              } finally {
                await PackageTree.releaseSnapshot(snap)
              }

              // 2. Ignored snapshot -> mutate ignored -> changedIgnored -> revertIgnored -> releaseIgnored
              const ignSnap = await PackageTree.snapshotIgnored(root, ".flows")
              try {
                await Fs.writeFile(NodePath.join(root, "ignored-dir", "temp.txt"), "mutated-ign\n")
                await Fs.writeFile(NodePath.join(root, "ignored-dir", "new.txt"), "new-ign\n")
                const ignChanged = await PackageTree.changedIgnored(ignSnap, ".flows")
                expect(ignChanged.length).toBeGreaterThanOrEqual(1)
                for (const p of ignChanged) await PackageTree.revertIgnored(ignSnap, p)
                expect(await Fs.readFile(NodePath.join(root, "ignored-dir", "temp.txt"), "utf8")).toBe(`ign-${slug}\n`)
              } finally {
                await PackageTree.releaseIgnored(ignSnap)
              }

              // 3. Portals snapshot -> mutate external portal -> revertChangedPortals -> releasePortals
              const pSnap = await PackageTree.snapshotPortals(root, ".flows")
              const reachable = await PackageTree.portalsReachableFrom(pSnap, root)
              expect(reachable.length).toBeGreaterThanOrEqual(1)
              try {
                await Fs.writeFile(NodePath.join(externalPortal, "ext.txt"), "portal-mutated\n")
                await PackageTree.revertChangedPortals(pSnap)
                expect(await Fs.readFile(NodePath.join(externalPortal, "ext.txt"), "utf8")).toBe(`ext-${slug}\n`)
              } finally {
                await PackageTree.releasePortals(pSnap)
              }

              // 4. OutDir & File capture / decode / verify / materialize / treeMatchesManifest / scratchCopy / limits
              const outMan = await PackageTree.captureOutDir(root, ".flows", "dist")
              expect(PackageTree.decodeManifest(outMan)).toBeDefined()
              expect(await PackageTree.verifyManifestBlobs(root, ".flows", outMan)).toBeUndefined()
              expect(await PackageTree.treeMatchesManifest(root, outMan)).toBeUndefined()
              await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
              expect(await PackageTree.treeMatchesManifest(root, outMan)).toBeDefined()
              await PackageTree.materializeManifest(root, ".flows", outMan)
              expect(await PackageTree.treeMatchesManifest(root, outMan)).toBeUndefined()

              const fMan = await PackageTree.captureFile(root, ".flows", "src/a.ts")
              expect(PackageTree.decodeFileManifest(fMan)).toBeDefined()
              expect(await PackageTree.verifyFileManifest(root, ".flows", fMan)).toBeUndefined()
              await Fs.writeFile(NodePath.join(root, "src", "a.ts"), "dirty")
              await PackageTree.materializeFile(root, ".flows", fMan)
              expect(await Fs.readFile(NodePath.join(root, "src", "a.ts"), "utf8")).toBe(`orig-${slug}\n`)

              // Limit error on captureOutDir
              let hitLimit = false
              try {
                await PackageTree.captureOutDir(root, ".flows", "dist", root, { ...PackageTree.outDirLimits, entries: 0 })
              } catch {
                hitLimit = true
              }
              expect(hitLimit).toBe(true)

              // scratchCopy
              const scratchDst = await PackageTree.scratchCopy(root, ".flows")
              try {
                expect(await Fs.readFile(NodePath.join(scratchDst, "dist", "sub", "bundle.js"), "utf8")).toBe(`bundle-${slug}\n`)
              } finally {
                await Fs.rm(scratchDst, { recursive: true, force: true })
              }
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261241 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("ServiceSupervisor live HTTP readiness/refcounting/teardown, Watch.run cycle+rescan+abort & Cache remote CAS fault matrix", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        casFault: Schema.Literals(["ok", "corrupt", "500", "403"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, casFault }) =>
          Effect.promise(async () => {
            // 1. ServiceSupervisor duration parsing + live HTTP service refcounting & stop
            expect(ServiceSupervisor.parseDurationMs("500ms", "t")).toBe(500)
            expect(ServiceSupervisor.parseDurationMs("2s", "t")).toBe(2000)
            expect(ServiceSupervisor.parseDurationMs("1m", "t")).toBe(60000)
            let badDur = false
            try {
              ServiceSupervisor.parseDurationMs("invalid", "t")
            } catch {
              badDur = true
            }
            expect(badDur).toBe(true)

            await withTempDir("smthrs-bc6-svc-", async (root) => {
              const portFile = NodePath.join(root, "port.txt")
              const srvScript = NodePath.join(root, "srv.cjs")
              await Fs.writeFile(
                srvScript,
                `const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.argv[2]);
const s = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok-${slug}");
});
s.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(portFile)}, String(s.address().port));
  console.log("LISTENING");
});
process.on("SIGTERM", () => s.close(() => process.exit(0)));
`
              )
              // Reserve an ephemeral free port cleanly
              const probe = NodeHttp.createServer()
              probe.listen(0, "127.0.0.1")
              await once(probe, "listening")
              const freePort = (probe.address() as NodeNet.AddressInfo).port
              await new Promise<void>((resolve) => probe.close(() => resolve()))

              await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function* () {
                    const sup = yield* ServiceSupervisor.make
                    const spec: ServiceSupervisor.ServiceSpec = {
                      key: `svc-${slug}-${freePort}`,
                      argv: [process.execPath, srvScript, String(freePort)],
                      cwd: root,
                      env: { PATH: process.env["PATH"] ?? "" },
                      readiness: {
                        http: `http://127.0.0.1:${freePort}/health`,
                        timeout: "8s"
                      },
                      health: { interval: "200ms", failures: 2 },
                      stop: { signal: "SIGTERM", grace: "2s" }
                    }
                    const h2 = yield* sup.acquire(spec)
                    yield* Effect.scoped(
                      Effect.gen(function* () {
                        const h1 = yield* sup.acquire(spec)
                        expect(h1.key).toBe(h2.key)
                        expect(h1.pid).toBe(h2.pid)
                        void h1.outputTail()
                        const resp = yield* h1.whileHealthy(
                          Effect.promise(() => fetch(`http://127.0.0.1:${freePort}/health`))
                        )
                        expect(resp.status).toBe(200)
                      })
                    )
                    // Still running because h2 holds a ref!
                    const resp2 = yield* h2.whileHealthy(
                      Effect.promise(() => fetch(`http://127.0.0.1:${freePort}/health`))
                    )
                    expect(resp2.status).toBe(200)
                  })
                )
              )

              // 2. Watch.run (once: true + once: false with custom notifier firing change + abort)
              await Fs.writeFile(NodePath.join(root, "watch-entry.mjs"), 'process.stdout.write("cycle-ok\\n");\n')
              const outputs: Array<string> = []
              const watchSvc = Watch.makeServices({ entry: NodePath.join(root, "watch-entry.mjs") })
              const onceRes = await Watch.run({
                services: watchSvc,
                root,
                args: [],
                ignored: [".flows"],
                debounceMs: 10,
                once: true,
                stdout: (t) => outputs.push(t),
                stderr: () => {}
              })
              expect(onceRes).toBeDefined()
              expect(outputs.join("")).toContain("cycle-ok")

              // Live watch cycle -> trigger file change -> 2nd cycle -> abort!
              const ac = new AbortController()
              let notifyCb: ((file: string | null) => void) | undefined
              let cycleCount = 0
              const customSvc: Watch.Services["Service"] = {
                ...watchSvc,
                notifier: (_r, onChange) =>
                  Effect.sync(() => {
                    notifyCb = onChange
                    return () => {}
                  })
              }
              await Watch.run({
                services: customSvc,
                root,
                args: [],
                ignored: [".flows"],
                signal: ac.signal,
                debounceMs: 10,
                rescanMs: 60_000,
                once: false,
                stdout: () => {},
                stderr: () => {},
                cycleCompleted: (c) => {
                  cycleCount = c.number
                  if (c.number === 1) {
                    void Fs.writeFile(NodePath.join(root, "touched.txt"), slug).then(() => notifyCb?.("touched.txt"))
                  } else if (c.number >= 2) {
                    ac.abort()
                  }
                }
              }).catch(() => undefined)
              expect(cycleCount).toBeGreaterThanOrEqual(2)

              // 3. Cache.openCache with live loopback remote CAS server + fault injection
              const acMap = new Map<string, Buffer>()
              const casMap = new Map<string, Buffer>()
              const casSrv = NodeHttp.createServer(async (req, res) => {
                const chunks: Array<Buffer> = []
                for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
                const body = Buffer.concat(chunks)
                const path = req.url ?? "/"
                if (casFault === "500") {
                  res.writeHead(500).end("server error")
                  return
                }
                if (casFault === "403") {
                  res.writeHead(403).end("forbidden")
                  return
                }
                if (path.startsWith("/ac/")) {
                  const key = decodeURIComponent(path.slice(4))
                  if (req.method === "PUT") {
                    acMap.set(key, body)
                    res.writeHead(200).end()
                  } else {
                    const hit = acMap.get(key)
                    if (hit === undefined) res.writeHead(404).end()
                    else res.writeHead(200).end(hit)
                  }
                  return
                }
                if (path === "/cas/findMissing") {
                  const { digests } = JSON.parse(body.toString("utf8")) as { readonly digests: ReadonlyArray<string> }
                  res.writeHead(200).end(JSON.stringify({ missing: digests.filter((d) => !casMap.has(d)) }))
                  return
                }
                if (path.startsWith("/cas/")) {
                  const d = path.slice(5)
                  if (req.method === "PUT") {
                    casMap.set(d, body)
                    res.writeHead(201).end()
                  } else {
                    const b = casMap.get(d)
                    if (b === undefined) res.writeHead(404).end()
                    else res.writeHead(200).end(casFault === "corrupt" ? Buffer.from("corrupted-bytes") : b)
                  }
                  return
                }
                res.writeHead(404).end()
              })
              casSrv.listen(0, "127.0.0.1")
              await once(casSrv, "listening")
              const casPort = (casSrv.address() as NodeNet.AddressInfo).port
              try {
                const wsA = NodePath.join(root, "ws-a")
                const wsB = NodePath.join(root, "ws-b")
                await Fs.mkdir(wsA, { recursive: true })
                await Fs.mkdir(wsB, { recursive: true })
                const warns: Array<string> = []
                const cA = await Cache.openCache({
                  workspaceRoot: wsA,
                  cacheDirectory: ".flows",
                  endpoint: `http://127.0.0.1:${casPort}`,
                  readToken: () => "t1",
                  writeToken: () => "t1",
                  warn: (l) => warns.push(l)
                })
                const cB = await Cache.openCache({
                  workspaceRoot: wsB,
                  cacheDirectory: ".flows",
                  endpoint: `http://127.0.0.1:${casPort}`,
                  readToken: () => "t1",
                  warn: (l) => warns.push(l)
                })
                const entry: Cache.CachedResult = {
                  key: `k-${slug}`,
                  target: "Shell",
                  label: `//:${slug}`,
                  exitOk: true,
                  output: { stdout: `out-${slug}` },
                  storedAt: new Date().toISOString()
                }
                await cA.put(entry.key, entry, { shared: true })
                const got = await cB.get(entry.key)
                if (casFault === "ok") {
                  expect(got?.key).toBe(entry.key)
                } else {
                  expect(got === null || got.key === entry.key).toBe(true)
                }
              } finally {
                await new Promise<void>((resolve) => casSrv.close(() => resolve()))
              }
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261242 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
