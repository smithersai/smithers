import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeFs from "node:fs/promises"
import * as NodeHttp from "node:http"
import type * as NodeNet from "node:net"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Filegroup from "../src/Filegroup.ts"
import * as GeneratedFile from "../src/GeneratedFile.ts"
import * as GithubCiGen from "../src/GithubCiGen.ts"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as Nix from "../src/Nix.ts"
import * as Reference from "../src/Reference.ts"
import * as Runtime from "../src/Runtime.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const fsExecutions = Math.min(executions, 14)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    await NodeFs.rm(dir, { recursive: true, force: true })
  }
}

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,6}$/))
const Body = Schema.String.check(Schema.isPattern(/^[a-z0-9 ]{4,24}$/))
const SecretVal = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10,18}$/))

describe("@smthrs/targets deep fuzz suite 7: SafeFs, Input gitignore/limits, GeneratedFile, ToolBuild, Secret/SecretProxy, LlmLint, Runtime, Nix & GithubCiGen", () => {
  it("SafeFs digestIndex/digestEntry/readText/syncDirectory, Input gitignore+ScanLimits & GeneratedFile write/check/symlink fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        body: Body,
        syncErr: Schema.Literals(["EPERM", "EINVAL", "EACCES", "ENOENT", "EIO"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        (input) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-t7-fs-", async (root) => {
              const canon = await SafeFs.canonicalRoot(root)
              const srcDir = NodePath.join(root, "pkg", "src")
              const ignoredDir = NodePath.join(root, "pkg", "ignored")
              const nestedDir = NodePath.join(root, "pkg", "src", "sub", "deep")
              await NodeFs.mkdir(nestedDir, { recursive: true })
              await NodeFs.mkdir(ignoredDir, { recursive: true })

              const f1 = NodePath.join(srcDir, `${input.slug}.ts`)
              const f2 = NodePath.join(nestedDir, "keep.ts")
              const fIgn = NodePath.join(ignoredDir, "skip.ts")
              const fNeg = NodePath.join(srcDir, "keep.log")
              const fSkipLog = NodePath.join(srcDir, "drop.log")
              await NodeFs.writeFile(f1, `export const v = ${JSON.stringify(input.body)}\n`)
              await NodeFs.writeFile(f2, "export const deep = 1\n")
              await NodeFs.writeFile(fIgn, "export const ignored = 1\n")
              await NodeFs.writeFile(fNeg, "kept log\n")
              await NodeFs.writeFile(fSkipLog, "dropped log\n")
              await NodeFs.writeFile(
                NodePath.join(root, "pkg", ".gitignore"),
                "# comment\nignored/\n*.log\n!src/keep.log\n/root-only.txt\n"
              )
              await NodeFs.writeFile(NodePath.join(root, "pkg", "root-only.txt"), "root only\n")

              const validLink = NodePath.join(srcDir, "alias.ts")
              const danglingLink = NodePath.join(srcDir, "dangling.ts")
              const outsideFile = NodePath.join(NodeOs.tmpdir(), `outside-${input.slug}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
              await NodeFs.writeFile(outsideFile, "secret outside")
              const escapeLink = NodePath.join(srcDir, "escape.ts")
              try {
                await NodeFs.symlink(f1, validLink)
                await NodeFs.symlink(NodePath.join(srcDir, "missing-target.ts"), danglingLink)
                await NodeFs.symlink(outsideFile, escapeLink)

                // SafeFs digestIndex with settled timestamp
                const futureNow = () => BigInt(Date.now() + 60_000) * 1_000_000n
                const idx = SafeFs.makeDigestIndex([], futureNow)
                const resolved = await SafeFs.resolveFile(f1, { root: canon })
                expect(resolved).toBeDefined()
                const d1 = await SafeFs.digestEntry(resolved!, { root: canon, digests: idx })
                const d2 = await SafeFs.digestEntry(resolved!, { root: canon, digests: idx })
                expect(d1).toBe(d2)
                expect(idx.rows.size + idx.confirmed.size).toBeGreaterThanOrEqual(1)

                const df1 = await SafeFs.digestFile(f1, { root: canon, digests: idx })
                expect(df1).toBe(d1)
                await NodeFs.writeFile(f1, `export const v = ${JSON.stringify(input.body + "!")}\n`)
                const idx2 = SafeFs.makeDigestIndex(idx.rows, futureNow)
                const df2 = await SafeFs.digestFile(f1, { root: canon, digests: idx2 })
                expect(df2).not.toBe(df1)

                const st = await NodeFs.stat(f1, { bigint: true })
                expect(SafeFs.digestStatus(st)).toBeTruthy()
                const badStat = { ...st, mtimeNs: undefined, ctimeNs: undefined, mtimeMs: Number.NaN, ctimeMs: Number.NaN } as unknown as SafeFs.Stats
                expect(SafeFs.digestStatus(badStat)).toBeUndefined()

                expect(await SafeFs.resolveFile(danglingLink, { root: canon })).toBeUndefined()
                expect(await SafeFs.resolveFile(validLink, { root: canon })).toBeDefined()
                let escaped = false
                try {
                  await SafeFs.resolveFile(escapeLink, { root: canon })
                } catch {
                  escaped = true
                }
                expect(escaped).toBe(true)

                expect(await SafeFs.resolveDirectory(NodePath.join(root, "does-not-exist"), { root: canon })).toBeUndefined()
                const dirOnFile = await SafeFs.resolveDirectory(f1, { root: canon }).catch(() => undefined)
                expect(dirOnFile).toBeUndefined()

                let tooBig = false
                try {
                  await SafeFs.readText(f1, { root: canon, limit: 2 })
                } catch {
                  tooBig = true
                }
                expect(tooBig).toBe(true)

                const ac = new AbortController()
                ac.abort(new Error("cancelled"))
                let aborted = false
                try {
                  await SafeFs.readText(f1, { root: canon, signal: ac.signal })
                } catch {
                  aborted = true
                }
                expect(aborted).toBe(true)

                // syncDirectory with faulty DirectorySyncIo
                const syncErrObj = Object.assign(new Error("sync fail"), { code: input.syncErr })
                const faultySyncIo: SafeFs.DirectorySyncIo = {
                  open: async () => {
                    throw syncErrObj
                  }
                }
                try {
                  await SafeFs.syncDirectory(srcDir, faultySyncIo)
                } catch {
                  // expected for non-ignored errno
                }

                // Input.expandGlob with gitignore + WalkCache + ScanLimits
                const walkCache = Input.makeWalkCache()
                const matched = await Input.expandGlob(canon, "pkg", Input.glob("**/*"), { walks: walkCache })
                expect(matched.some((p) => p.endsWith("keep.ts"))).toBe(true)
                expect(matched.some((p) => p.includes("ignored/skip.ts"))).toBe(false)
                expect(matched.some((p) => p.endsWith("drop.log"))).toBe(false)
                const matched2 = await Input.expandGlob(canon, "pkg", Input.glob("**/*.ts"), { walks: walkCache })
                expect(matched2.length).toBeGreaterThanOrEqual(2)

                let limitHit = false
                try {
                  await Input.expandGlob(canon, "pkg", Input.glob("**/*"), {
                    limits: { depth: 1, entries: 1, files: 1, directories: 1, ignoreBytes: 4 }
                  })
                } catch {
                  limitHit = true
                }
                expect(limitHit).toBe(true)

                const digests1 = await Input.digestFiles(
                  canon,
                  [NodePath.relative(canon, f1), NodePath.relative(canon, f2)],
                  { digests: idx }
                )
                const digests2 = await Input.digestFiles(
                  canon,
                  [NodePath.relative(canon, f1), NodePath.relative(canon, f2)],
                  { digests: idx }
                )
                expect(digests1).toEqual(digests2)

                for (const badBase of ["", "-flag", "ref\0x", "\uD800"]) {
                  let invalid = false
                  try {
                    Input.validateGitBase(badBase)
                  } catch {
                    invalid = true
                  }
                  expect(invalid).toBe(true)
                }
              } finally {
                await NodeFs.rm(outsideFile, { force: true })
              }

              // GeneratedFile write/check/drift/symlink/failureMessage/resolveOutputPath
              const genRel = `gen/${input.slug}.txt`
              await Effect.runPromise(GeneratedFile.writeGeneratedFile(root, { path: genRel, contents: input.body }))
              await Effect.runPromise(GeneratedFile.checkGeneratedFile(root, { path: genRel, contents: input.body }))
              const driftExit = await Effect.runPromiseExit(
                GeneratedFile.checkGeneratedFile(root, { path: genRel, contents: input.body + "-changed" })
              )
              expect(driftExit._tag).toBe("Failure")
              const missingExit = await Effect.runPromiseExit(
                GeneratedFile.checkGeneratedFile(root, { path: "gen/missing.txt", contents: "hi" })
              )
              expect(missingExit._tag).toBe("Failure")

              const symRel = `gen/${input.slug}-link.txt`
              await Effect.runPromise(GeneratedFile.writeGeneratedSymlink(root, { path: symRel, target: `${input.slug}.txt` }))
              await Effect.runPromise(GeneratedFile.checkGeneratedSymlink(root, { path: symRel, target: `${input.slug}.txt` }))
              const wrongSym = await Effect.runPromiseExit(
                GeneratedFile.checkGeneratedSymlink(root, { path: symRel, target: "other.txt" })
              )
              expect(wrongSym._tag).toBe("Failure")
              const regAsSym = await Effect.runPromiseExit(
                GeneratedFile.checkGeneratedSymlink(root, { path: genRel, target: `${input.slug}.txt` })
              )
              expect(regAsSym._tag).toBe("Failure")
              const missingSym = await Effect.runPromiseExit(
                GeneratedFile.checkGeneratedSymlink(root, { path: "gen/no-sym.txt", target: "x" })
              )
              expect(missingSym._tag).toBe("Failure")

              expect(GeneratedFile.resolveOutputPath("a/b/c.txt")).toBe("a/b/c.txt")
              for (const badPath of ["", "../escape", "/abs/path", "a\0b"]) {
                let bad = false
                try {
                  GeneratedFile.resolveOutputPath(badPath)
                } catch {
                  bad = true
                }
                expect(bad).toBe(true)
              }
              expect(GeneratedFile.failureMessage(new Error("boom"))).toContain("boom")
              expect(GeneratedFile.failureMessage("str-err")).toContain("str-err")
              expect(GeneratedFile.failureMessage({ message: "obj-err" })).toContain("obj-err")
              expect(GeneratedFile.failureMessage(42)).toBeTruthy()
              expect(
                GeneratedFile.failureMessage("x".repeat(GeneratedFile.maximumFailureMessageCodeUnits + 100)).length
              ).toBeLessThanOrEqual(GeneratedFile.maximumFailureMessageCodeUnits + 64)

              const plan = GeneratedFile.generateFile("write", { path: genRel, contents: input.body })
              expect(plan).toBeDefined()
              expect(GeneratedFile.WriteFileLive({ workspaceRoot: root })).toBeDefined()
              expect(GeneratedFile.CheckFileLive({ workspaceRoot: root })).toBeDefined()
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261150 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("ToolBuild captureOutputs/measureOutput edges, Secret normalization & live SecretProxy HTTP+CONNECT+redaction fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        secretVal: SecretVal,
        mode: Schema.Literals(["ok", "chunked", "disallowed", "connect"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        (input) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-t7-tb-", async (root) => {
              const outDir = NodePath.join(root, "pkg", "dist")
              await NodeFs.mkdir(NodePath.join(outDir, "nested"), { recursive: true })
              const fileOut = NodePath.join(outDir, `${input.slug}.js`)
              const nestedOut = NodePath.join(outDir, "nested", "chunk.js")
              await NodeFs.writeFile(fileOut, `export const s = ${JSON.stringify(input.slug)}\n`)
              await NodeFs.writeFile(nestedOut, "export const c = 1\n")

              const single = await ToolBuild.measureOutput(root, "pkg", `dist/${input.slug}.js`)
              expect(single.contentDigest).toBeTruthy()
              const dirOut = await ToolBuild.measureOutput(root, "pkg", "dist")
              expect(dirOut.contentDigest).toBeTruthy()

              let overlapFailed = false
              try { await ToolBuild.measureOutputs(root, "pkg", [`dist/${input.slug}.js`, "dist"]) } catch { overlapFailed = true }
              expect(overlapFailed).toBe(true)
              const allOuts = await ToolBuild.measureOutputs(root, "pkg", ["dist"])
              expect(allOuts.outputs.length).toBe(1)
              const declared = { cwd: "pkg", paths: ["dist"] } as const
              expect(await ToolBuild.verifyOutputs(root, declared, allOuts)).toBeUndefined()

              let limitFailed = false
              try {
                await ToolBuild.measureOutputs(root, "pkg", ["dist"], {
                  limits: { ...ToolBuild.defaultCaptureLimits, files: 1 }
                })
              } catch {
                limitFailed = true
              }
              expect(limitFailed).toBe(true)

              await NodeFs.writeFile(nestedOut, "export const c = 2\n")
              let mutatedFailed = false
              try {
                const declared = { cwd: "pkg", paths: ["dist"] } as const
              expect(await ToolBuild.verifyOutputs(root, declared, allOuts)).toBeUndefined()
              } catch {
                mutatedFailed = true
              }
              expect(mutatedFailed).toBe(true)

              await NodeFs.writeFile(nestedOut, "export const c = 1\n")
              await NodeFs.writeFile(NodePath.join(outDir, "extra.js"), "extra")
              let extraFailed = false
              try {
                const declared = { cwd: "pkg", paths: ["dist"] } as const
              expect(await ToolBuild.verifyOutputs(root, declared, allOuts)).toBeUndefined()
              } catch {
                extraFailed = true
              }
              expect(extraFailed).toBe(true)

              let missingFailed = false
              try {
                await ToolBuild.measureOutput(root, "pkg", "dist/missing.js")
              } catch {
                missingFailed = true
              }
              expect(missingFailed).toBe(true)

              const escapeSym = NodePath.join(outDir, "bad-link.js")
              await NodeFs.symlink("/etc/hosts", escapeSym)
              let symFailed = false
              try {
                await ToolBuild.measureOutput(root, "pkg", "dist/bad-link.js")
              } catch {
                symFailed = true
              }
              expect(symFailed).toBe(true)

              expect(ToolBuild.CaptureOutputsLive({ workspaceRoot: root })).toBeDefined()
            })

            const sec = Secret.Secret("API_TOKEN", { fallback: "dev-fallback" })
            expect(Secret.isSecret(sec)).toBe(true)
            expect(Secret.isSecret({ _tag: "Other" })).toBe(false)
            expect(Secret.normalizeAudience("https://API.Example.COM:443")).toBe("https://api.example.com")
            expect(Secret.normalizeAudience("http://127.0.0.1:80")).toBe("http://127.0.0.1")
            expect(Secret.normalizeAudience("https://[::1]:8443")).toBe("https://[::1]:8443")
            for (const badAud of [
              "",
              "ftp://example.com",
              "https://example.com/path",
              "https://user:pass@example.com",
              "http://example.com", "https://example.com?q=1", "https://example.com#h",
              "not-a-url"
            ]) {
              let rejected = false
              try {
                Secret.normalizeAudience(badAud)
              } catch {
                rejected = true
              }
              expect(rejected).toBe(true)
            }
            const originTok = Secret.SecretOrigin("https://api.example.com")
            expect(Secret.secretOriginsIn(`use ${originTok} and ${originTok}`)).toEqual(["https://api.example.com", "https://api.example.com"])

            const upstream = NodeHttp.createServer((req, res) => {
              const chunks: Array<Buffer> = []
              req.on("data", (c) => chunks.push(c as Buffer))
              req.on("end", () => {
                const reqBody = Buffer.concat(chunks).toString("utf8")
                const auth = req.headers["authorization"] ?? ""
                if (req.url === "/chunked") {
                  res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" })
                  const half = Math.floor(input.secretVal.length / 2)
                  res.write(`echo:${auth}:`)
                  res.write(input.secretVal.slice(0, half))
                  res.end(input.secretVal.slice(half))
                } else {
                  res.writeHead(200, { "content-type": "text/plain", "x-echo-secret": input.secretVal })
                  res.end(`auth=${auth};body=${reqBody};leak=${input.secretVal}`)
                }
              })
            })
            await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
            const addr = upstream.address() as NodeNet.AddressInfo
            const upstreamOrigin = `http://127.0.0.1:${addr.port}`
            const realSec = Secret.Secret("LIVE_TOK")
            const cred = Secret.HttpSecret(realSec, [upstreamOrigin])

            try {
              const vault = SecretProxy.makeVault({
                read: (name) => (name === "LIVE_TOK" ? input.secretVal : undefined)
              })
              const placeholder = vault.mint(cred)
              expect(placeholder).toMatch(Secret.placeholderPattern)
              const proxy = await SecretProxy.startProxy(vault)
              try {
                const proxyOrigin = await proxy.originFor(upstreamOrigin)

                if (input.mode === "ok" || input.mode === "chunked") {
                  const path = input.mode === "chunked" ? "/chunked" : "/echo"
                  const resp = await fetch(`${proxyOrigin}${path}`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${placeholder}`, "x-test": "1" },
                    body: `payload=${placeholder}`
                  })
                  const text = await resp.text()
                  expect(resp.status).toBe(200)
                  expect(text).not.toContain(input.secretVal)
                  expect(resp.headers.get("x-echo-secret") ?? "").not.toContain(input.secretVal)
                } else if (input.mode === "disallowed") {
                  const ep = new URL(proxy.endpoint)
                  const status = await new Promise<number>((resolve, reject) => {
                    const req = NodeHttp.request(
                      {
                        hostname: ep.hostname,
                        port: Number(ep.port),
                        method: "GET",
                        path: "http://example.invalid/secret",
                        headers: { host: "example.invalid", authorization: `Bearer ${placeholder}` }
                      },
                      (res) => {
                        res.resume()
                        res.on("end", () => resolve(res.statusCode ?? 0))
                      }
                    )
                    req.on("error", reject)
                    req.end()
                  })
                  expect(status).toBeGreaterThanOrEqual(400)
                } else {
                  const ep = new URL(proxy.endpoint)
                  const status = await new Promise<number>((resolve, reject) => {
                    const req = NodeHttp.request({
                      hostname: ep.hostname,
                      port: Number(ep.port),
                      method: "CONNECT",
                      path: "example.invalid:443"
                    })
                    req.on("connect", (res, socket) => {
                      socket.destroy()
                      resolve(res.statusCode ?? 0)
                    })
                    req.on("response", (res) => {
                      res.resume()
                      resolve(res.statusCode ?? 0)
                    })
                    req.on("error", reject)
                    req.end()
                  })
                  expect(status).toBeGreaterThanOrEqual(400)
                }
              } finally {
                await proxy.close()
              }
            } finally {
              await new Promise<void>((resolve) => upstream.close(() => resolve()))
            }
            return true
          }),
        { executions: fsExecutions, seed: 20261151 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("LlmLint relatedCandidates/LlmLint target/closeFinding errors, Runtime, Nix, Filegroup, Reference, Shell & GithubCiGen fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        runtimeKind: Schema.Literals(["node", "bun"]),
        osKind: Schema.Literals(["ubuntu-latest", "macos-latest", "windows-latest"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        (input) =>
          Effect.promise(async () => {
            const rt =
              input.runtimeKind === "node"
                ? Runtime.Node({ version: ">=26.4.0", imports: ["ts-hook"] })
                : Runtime.Bun({ version: ">=1.4.0" })
            expect(Runtime.isRuntime(rt)).toBe(true)
            expect(Runtime.required(rt)).toBe(rt)
            expect(Runtime.preloads(rt)).toBeDefined()
            expect(Runtime.environment(rt, {})).toBeDefined()
            expect(Runtime.run(rt, ["script.js"]).length).toBeGreaterThanOrEqual(2)
            expect(Runtime.evaluate(rt, "1+1").length).toBeGreaterThanOrEqual(2)
            expect(Runtime.test(rt, ["a.test.ts"]).length).toBeGreaterThanOrEqual(2)
            let reqMissing = false
            try {
              Runtime.required(undefined)
            } catch {
              reqMissing = true
            }
            expect(reqMissing).toBe(true)

            const nixEnv = Nix.Environment({
              flake: Input.file("flake.nix"),
              lock: Input.file("flake.lock"),
              attr: "devShells.default"
            })
            expect(Nix.isEnvironment(nixEnv)).toBe(true)
            expect(Nix.isEnvironment({})).toBe(false)
            expect(Nix.environmentInputs(nixEnv).length).toBe(2)
            expect(Nix.flakeDirectory(nixEnv)).toBe("")
            expect(Nix.outputAttribute(nixEnv, "x86_64-linux")).toBeTruthy()
            expect(Nix.developArguments(nixEnv).length).toBeGreaterThan(0)
            for (const badAttr of ["", "123bad", "bad attr", "a..b"]) {
              let rejected = false
              try {
                Nix.Environment({
                  flake: Input.file("flake.nix"),
                  lock: Input.file("flake.lock"),
                  attr: badAttr
                })
              } catch {
                rejected = true
              }
              expect(rejected).toBe(true)
            }

            const lbl = Reference.label(`//pkg/${input.slug}:build`)
            expect(lbl.label).toBe(`//pkg/${input.slug}:build`)
            for (const badLbl of ["", "no-slashes", "//a:b:c", `//${"a".repeat(Reference.maximumLabelLength + 5)}`]) {
              let rejected = false
              try {
                Reference.label(badLbl)
              } catch {
                rejected = true
              }
              expect(rejected).toBe(true)
            }
            const sSpec = Reference.inputString("desc")
            const lSpec = Reference.inputLiterals(["a", "b"])
            const oSpec = Reference.inputOptional(sSpec)
            expect(Schema.is(Reference.InputSpec)(oSpec)).toBe(true)
            expect(Schema.is(Reference.InputSpec)(lSpec)).toBe(true)

            expect(Shell.observedEnv({ env: ["FOO", "BAR"] })).toEqual(["FOO", "BAR"])
            expect(Shell.observedEnv(undefined)).toEqual([])
            expect(Shell.givenEnv({ env: ["A"], names: ["B"] })).toBeDefined()
            expect(Shell.flagToken("debug")).toBe("{smthrs:flag:debug}")

            await withTempDir("smthrs-t7-fg-", async (root) => {
              await NodeFs.mkdir(NodePath.join(root, "pkg", "src"), { recursive: true })
              await NodeFs.writeFile(NodePath.join(root, "pkg", "src", "a.ts"), 'import { b } from "./b.js"\nexport const a = b\n')
              await NodeFs.writeFile(NodePath.join(root, "pkg", "src", "b.ts"), "export const b = 42\n")
              await NodeFs.writeFile(NodePath.join(root, "pkg", "src", "c.ts"), 'import { a } from "./a.js"\nexport const c = a\n')
              await NodeFs.writeFile(NodePath.join(root, "pkg", "CONTEXT.md"), "# context\n")

              const fg = Filegroup.Filegroup({
                srcs: [Input.glob("src/**/*.ts")]
              })
              expect(Target.isTarget(fg)).toBe(true)
              const expanded = await Filegroup.expand(root, [Input.glob("pkg/src/**/*.ts")])
              expect(expanded.length).toBe(3)

              const rels = LlmLint.relatedCandidates(
                [{ path: "pkg/src/a.ts", contents: 'import { b } from "./b.js"\nimport { x } from "external-pkg"\nexport * from "./c"\n' }],
                new Set(["pkg/src/a.ts", "pkg/src/b.ts", "pkg/src/c.ts", "pkg/go/x.go", "pkg/go/y.go"])
              )
              expect(rels.paths.some((p) => p.endsWith("b.ts"))).toBe(true)

              const lintT = LlmLint.LlmLint({
                changes: Input.gitDiff("main"),
                include: [Input.glob("src/**/*.ts")],
                deps: [],
                prompt: "Check code",
                rubric: "No bugs",
                engine: "claude",
                model: "claude-sonnet-4",
                batchSize: 2,
                failOn: "error"
              })
              expect(Target.isTarget(lintT)).toBe(true)
              const secT = LlmLint.LlmLint({
                changes: Input.gitDiff("main"),
                include: [Input.glob("src/**/*.ts")],
                deps: [],
                prompt: "Audit security",
                rubric: "Security audit",
                engine: "codex",
                model: "gpt-6-sol",
                alternateModel: "claude-opus-5-5",
                batchSize: 2,
                failOn: "warning",
                securityChecks: ["injection"]
              })
              expect(Target.isTarget(secT)).toBe(true)

              expect(LlmLint.LlmReviewLive({ workspaceRoot: root })).toBeDefined()
              const missingClose = await Effect.runPromiseExit(
                LlmLint.closeFinding(NodePath.join(root, ".store"), "nonexistent-id", { revision: "rev1", command: "test", observedResult: "fixed" })
              )
              expect(missingClose._tag).toBe("Failure")
              const emptyStored = await Effect.runPromise(
                LlmLint.storedFindings(NodePath.join(root, ".nonexistent-store"))
              )
              expect(emptyStored).toEqual([])
            })

            const jobs = GithubCiGen.balanceShards(
              [
                { pattern: `//pkg/${input.slug}:test`, durationMs: 30 },
                { pattern: `//pkg/${input.slug}:lint`, durationMs: 10 },
                { pattern: `//pkg/${input.slug}:build`, durationMs: 20 }
              ],
              2
            )
            expect(jobs.length).toBe(2)
            expect(GithubCiGen.renderStep({ name: "Run", id: "setup", condition: "always()", run: "echo hi\necho bye", shell: "bash" }, "      ").length).toBeGreaterThan(2)
            expect(GithubCiGen.renderStep({ uses: "actions/checkout@v4" }, "      ").length).toBe(1)
            let badStep = false
            try { GithubCiGen.renderStep({ name: "Empty" }, "      ") } catch { badStep = true }
            expect(badStep).toBe(true)
            let badShard = false
            try { GithubCiGen.balanceShards([{ pattern: "bad", durationMs: 10 }], 1) } catch { badShard = true }
            expect(badShard).toBe(true)
            let badDur = false
            try { GithubCiGen.balanceShards([{ pattern: `//pkg/${input.slug}:test`, durationMs: -1 }], 1) } catch { badDur = true }
            expect(badDur).toBe(true)
            let badCnt = false
            try { GithubCiGen.balanceShards([{ pattern: `//pkg/${input.slug}:test`, durationMs: 10 }], 2) } catch { badCnt = true }
            expect(badCnt).toBe(true)
            return true
          }),
        { executions: fsExecutions, seed: 20261152 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
