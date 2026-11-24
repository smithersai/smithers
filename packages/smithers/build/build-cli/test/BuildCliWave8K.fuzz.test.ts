/**
 * Wave-8K focused fast fuzz suite for packages/smithers/build/build-cli:
 * 1. Mount.ts full materialize/resolveWorkspace/summary error & lifecycle matrix
 *    (symlinks, missing overlay dir, missing patch, refuseIndirection, tracked collision,
 *    post-lay edit, removed laid file, dirty >10 files, extra local commits, missing commit SHA)
 * 2. GithubRender.ts error codes & check/write lifecycle + PackageTree.ts IgnoredCensusError /
 *    PortalCensusError / snapshotIgnored / snapshotPortals real limit & EACCES enforcement
 * 3. Cache.ts remote CAS download/upload failure matrix (429, 500, truncated body, 413 skipLimit,
 *    findMissing timeout skipSlow, PUT 409/401) + effect-resolution.js
 *    buildModuleUrl / importDeclarationModule / bundledSpecifier & bundledSource.
 */
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as Path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import * as Cache from "../src/Cache.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as EffectResolution from "../src/effect-resolution.js"
import * as GithubRender from "../src/GithubRender.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import * as Mount from "../src/Mount.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const seed = 8811
const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50")
const ioExecutions = Math.min(executions, 3)

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = Path.join(root, ...rel.split("/"))
    await Fs.mkdir(Path.dirname(abs), { recursive: true })
    await Fs.writeFile(abs, content)
  }
}

const commitTree = async (root: string, files: Readonly<Record<string, string>>, msg: string): Promise<string> => {
  await writeTree(root, files)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "--no-verify", "-m", msg)
  return git(root, "rev-parse", "HEAD")
}

const mountOpts = (reports: Array<string> = []): Mount.Options => ({
  environment: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  report: (line) => void reports.push(line)
})

describe("BuildCliWave8K — Mount, GithubRender, PackageTree census, Cache remote CAS & effect-resolution", () => {
  it("Mount materialize/resolveWorkspace/summary lifecycle & error matrix", async () => {
    const modeArb = Arbitrary.schema(Schema.Literals(["overlay-errors", "dirty-and-fetch"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        modeArb,
        (mode) =>
          Effect.promise(async () => {
            const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "w8k-mount-")))
            try {
              const upstream = Path.join(base, "upstream")
              await Fs.mkdir(upstream, { recursive: true })
              git(upstream, "init", "--quiet", "--initial-branch=main")
              git(upstream, "config", "user.name", "Upstream")
              git(upstream, "config", "user.email", "upstream@example.invalid")
              git(upstream, "config", "commit.gpgsign", "false")
              const c1 = await commitTree(
                upstream,
                {
                  "README.md": "hello\n",
                  ".smithers/tracked.txt": "upstream tracked\n",
                  ".smithers/dircoll/keep.txt": "dir\n"
                },
                "first"
              )
              const c2 = await commitTree(upstream, { "README.md": "hello 2\n" }, "second")

              const overlay = Path.join(base, "overlay")
              const writeConfig = async (body: string) => {
                await writeTree(overlay, { ".smithers/config.ts": body })
              }
              const makeConfig = (commit: string, extra = "") =>
                `import { Smithers as S } from "@smthrs/targets"\nexport default S.Mounts({ app: S.Mount({ repository: ${JSON.stringify(upstream)}, ref: ${JSON.stringify(commit)}, track: "main"${extra} }) })\n`
              const reports: Array<string> = []
              const opts = mountOpts(reports)

              if (mode === "overlay-errors") {
                // 1. Happy materialize + summary + resolveWorkspace
                await writeConfig(makeConfig(c1))
                await writeTree(overlay, {
                  ".smithers/laid.txt": "v1\n",
                  ".smithers/removable.txt": "drop-me\n"
                })
                const m1 = await Mount.materialize(overlay, "app", opts)
                expect(Mount.summary(m1)).toContain("app")
                const resolved = await Mount.resolveWorkspace(overlay, opts)
                expect(resolved.workspace).toBe(m1.root)

                // 2. Edit laid file in checkout -> mount_overlay_edited
                await Fs.writeFile(Path.join(m1.root, ".smithers", "laid.txt"), "edited-in-checkout\n")
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("was edited after it was laid")
                // Delete edited file so next materialize succeeds AND drops removable.txt
                await Fs.rm(Path.join(m1.root, ".smithers", "laid.txt"))
                await Fs.rm(Path.join(overlay, ".smithers", "removable.txt"))
                const m2 = await Mount.materialize(overlay, "app", opts)
                expect(await Fs.readFile(Path.join(m2.root, ".smithers", "laid.txt"), "utf8")).toBe("v1\n")

                // 3. Upstream tracked file collision -> mount_overlay_collision
                await writeTree(overlay, { ".smithers/tracked.txt": "collide\n" })
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("would replace a file upstream tracks")
                await Fs.rm(Path.join(overlay, ".smithers", "tracked.txt"))

                // 4. Upstream directory collision -> refuseIndirection (mount_overlay_collision)
                await writeTree(overlay, { ".smithers/dircoll": "file-over-dir\n" })
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("which is a directory")
                await Fs.rm(Path.join(overlay, ".smithers", "dircoll"))

                // 5. Symlink in overlay -> mount_config_invalid
                await Fs.symlink(Path.join(overlay, ".smithers", "laid.txt"), Path.join(overlay, ".smithers", "sym.txt"))
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("is a symbolic link")
                await Fs.rm(Path.join(overlay, ".smithers", "sym.txt"))

                // 6. Missing overlay subdirectory -> mount_config_invalid
                await writeConfig(makeConfig(c1, `, overlay: "missing-dir"`))
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("does not exist")

                // 7. Missing patch file -> mount_config_invalid
                await writeConfig(makeConfig(c1, `, patches: ["patches/nope.patch"]`))
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("is missing")
              } else {
                // 1. Materialize c1
                await writeConfig(makeConfig(c1))
                await writeTree(overlay, { ".smithers/laid.txt": "v1\n" })
                const m1 = await Mount.materialize(overlay, "app", opts)

                // 2. Dirty checkout with >10 untracked files -> mount_dirty + listed() ellipsis
                for (let i = 0; i < 12; i++) {
                  await Fs.writeFile(Path.join(m1.root, `dirty-${i}.txt`), `${i}\n`)
                }
                await writeConfig(makeConfig(c2))
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("re-materializing would discard edits")
                for (let i = 0; i < 12; i++) {
                  await Fs.rm(Path.join(m1.root, `dirty-${i}.txt`))
                }

                // 3. Local extra commit on top of materialized commit -> mount_dirty ("would drop commits")
                git(m1.root, "config", "user.name", "Local")
                git(m1.root, "config", "user.email", "local@example.invalid")
                git(m1.root, "config", "commit.gpgsign", "false")
                await commitTree(m1.root, { "local-only.txt": "unpushed\n" }, "local commit")
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("re-materializing would drop commits")

                // 4. Reset to c1 and test non-existent commit SHA -> mount_fetch_failed
                git(m1.root, "reset", "--hard", c1)
                const bogusSha = "deadbeef".repeat(5)
                await writeConfig(makeConfig(bogusSha))
                await expect(Mount.materialize(overlay, "app", opts)).rejects.toThrow("has no commit")
              }

              return true
            } finally {
              await Fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("GithubRender error codes & check/write + PackageTree IgnoredCensusError/PortalCensusError real limits", async () => {
    const modeArb = Arbitrary.schema(Schema.Literals(["github-render", "package-tree-census"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        modeArb,
        (mode) =>
          Effect.promise(async () => {
            const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "w8k-gh-tree-")))
            try {
              if (mode === "github-render") {
                const ws = S.Workspace("gh-fuzz", {
                  repository: "git+https://example.invalid/gh-fuzz.git",
                  cache: S.Cache({ directory: ".flows" })
                })
                const t1 = S.Shell.Test({ shell: "true", sandbox: "none" })
                const tSharded = S.Shell.Test({ shell: "true", sandbox: "none", shards: 2 } as never)

                const renderWith = (
                  ciGen: ReturnType<typeof S.Github.CiGen>,
                  targets: Record<string, unknown>,
                  customResolve?: GithubRender.LabelResolver
                ) => {
                  const index = PackageIndex.make({
                    root: base,
                    workspace: ws,
                    factory: undefined,
                    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: targets as never }) }]
                  })
                  return GithubRender.render({
                    ciGen,
                    workspace: ws,
                    resolve: customResolve ?? index,
                    packageDir: ""
                  })
                }

                // 1. Happy render with schedule, workflow_dispatch, pull_request, push, shards, concurrency, preserve
                const wfMain = S.Github.Workflow({
                  name: "CI",
                  on: {
                    push: { branches: ["main"] },
                    pullRequest: { branches: ["main"] },
                    schedule: ["0 2 * * *"],
                    workflowDispatch: true
                  } as never,
                  concurrency: { group: "ci-${{ github.ref }}", cancelInProgress: "pull_request" } as never,
                  runsOn: "ubuntu-latest",
                  run: [t1, tSharded]
                })
                const ciGen = S.Github.CiGen({
                  workflows: [wfMain],
                  changes: ["workflows/**"],
                  preserve: ["workflows/manual.yml"]
                } as never)
                const rendered = renderWith(ciGen, { t1, tSharded, wfMain, ciGen })
                expect(rendered.files.length).toBeGreaterThan(0)

                // check missing -> write -> check clean -> mutate -> check stale + unexpected + preserved -> write removes unexpected
                const cMissing = await GithubRender.check(base, rendered)
                expect(cMissing.clean).toBe(false)
                expect(cMissing.entries.some((e) => e.status === "missing")).toBe(true)

                const w1 = await GithubRender.write(base, rendered)
                expect(w1.wrote.length).toBeGreaterThan(0)
                const cClean = await GithubRender.check(base, rendered)
                expect(cClean.clean).toBe(true)

                const firstFile = rendered.files[0]!
                await Fs.writeFile(Path.join(base, ...firstFile.path.split("/")), `${firstFile.content}\n# drifted\n`)
                await Fs.writeFile(Path.join(base, "workflows", "manual.yml"), "name: manual\n")
                await Fs.writeFile(Path.join(base, "workflows", "orphan.yml"), "name: orphan\n")
                const cDrifted = await GithubRender.check(base, rendered)
                expect(cDrifted.clean).toBe(false)
                expect(cDrifted.entries.some((e) => e.status === "stale")).toBe(true)
                expect(cDrifted.entries.some((e) => e.status === "unexpected")).toBe(true)
                expect(cDrifted.entries.some((e) => e.status === "preserved")).toBe(true)

                const w2 = await GithubRender.write(base, rendered)
                expect(w2.removed).toContain("workflows/orphan.yml")
                expect(w2.preserved).toContain("workflows/manual.yml")

                // 2. Error cases via GithubRender.render + isGithubRenderError
                const expectCode = (fn: () => unknown, code: GithubRender.ErrorCode) => {
                  try {
                    fn()
                    throw new Error(`expected GithubRenderError(${code})`)
                  } catch (err) {
                    expect(GithubRender.isGithubRenderError(err)).toBe(true)
                    if (GithubRender.isGithubRenderError(err)) expect(err.code).toBe(code)
                  }
                }
                // unlabeled_cigen
                expectCode(
                  () =>
                    GithubRender.render({
                      ciGen,
                      workspace: ws,
                      resolve: { labelOf: () => undefined },
                      packageDir: ""
                    }),
                  "unlabeled_cigen"
                )
                // invalid_schedule
                const wfBadCron = S.Github.Workflow({
                  name: "BadCron",
                  on: { schedule: ["not a cron"] } as never,
                  runsOn: "ubuntu-latest",
                  run: [t1]
                })
                const ciBadCron = S.Github.CiGen({ workflows: [wfBadCron] })
                expectCode(() => renderWith(ciBadCron, { t1, wfBadCron, ciBadCron }), "invalid_schedule")

                // invalid_event_name
                const wfBadCancel = S.Github.Workflow({
                  name: "BadCancel",
                  on: { push: { branches: ["main"] } } as never,
                  concurrency: { group: "g", cancelInProgress: "not valid event!" } as never,
                  runsOn: "ubuntu-latest",
                  run: [t1]
                })
                const ciBadCancel = S.Github.CiGen({ workflows: [wfBadCancel] })
                expectCode(() => renderWith(ciBadCancel, { t1, wfBadCancel, ciBadCancel }), "invalid_event_name")

                // unsupported_affected
                const wfAff = S.Github.Workflow({
                  name: "Aff",
                  on: { push: { branches: ["main"] } } as never,
                  affected: true as never,
                  runsOn: "ubuntu-latest",
                  run: [t1]
                })
                const ciAff = S.Github.CiGen({ workflows: [wfAff] })
                expectCode(() => renderWith(ciAff, { t1, wfAff, ciAff }), "unsupported_affected")

                // invalid_label
                expectCode(
                  () =>
                    renderWith(ciGen, { t1, tSharded, wfMain, ciGen }, {
                      labelOf: (target) => (target === ciGen ? "//:ciGen" : "not a valid label!!!")
                    }),
                  "invalid_label"
                )

                // duplicate_job_id
                expectCode(
                  () =>
                    renderWith(ciGen, { t1, tSharded, wfMain, ciGen }, {
                      labelOf: (target) => (target === ciGen ? "//:ciGen" : "//:same")
                    }),
                  "duplicate_job_id"
                )

                // invalid_path (control char in workflow name)
                const wfCtrl = S.Github.Workflow({
                  name: "Bad\u0007Name",
                  on: { push: { branches: ["main"] } } as never,
                  runsOn: "ubuntu-latest",
                  run: [t1]
                })
                const ciCtrl = S.Github.CiGen({ workflows: [wfCtrl] })
                expectCode(() => renderWith(ciCtrl, { t1, wfCtrl, ciCtrl }), "invalid_workflow_name")
              } else {
                // PackageTree IgnoredCensusError + PortalCensusError constructors & real limits
                const e1 = new PackageTree.IgnoredCensusError("entries", "ign/a", { entries: 2, totalBytes: 100 })
                const e2 = new PackageTree.IgnoredCensusError("totalBytes", "ign/b", { entries: 2, totalBytes: 10 })
                const e3 = new PackageTree.IgnoredCensusError(
                  "unreadable",
                  "ign/c",
                  { entries: 2, totalBytes: 10 },
                  { cause: new Error("EACCES") }
                )
                expect(e1.message).toContain("more than 2 entries")
                expect(e2.message).toContain("more than 10 bytes")
                expect(e3.message).toContain("could not be read")

                const p1 = new PackageTree.PortalCensusError("too-large", "link/a")
                const p2 = new PackageTree.PortalCensusError("unreadable", "link/b", { cause: new Error("EACCES") })
                expect(p1.message).toContain("more than")
                expect(p2.message).toContain("could not be read")

                // Real git workspace with gitignored files & external symlink portal
                const ws = Path.join(base, "ws")
                const portalTarget = Path.join(base, "portal-target")
                await Fs.mkdir(ws, { recursive: true })
                await Fs.mkdir(portalTarget, { recursive: true })
                git(ws, "init", "--quiet", "--initial-branch=main")
                git(ws, "config", "user.name", "Tree")
                git(ws, "config", "user.email", "tree@example.invalid")
                await commitTree(ws, { ".gitignore": "ign/\n.flows/\n", "tracked.txt": "ok\n" }, "init")

                // Ignored files: entries cap + totalBytes cap + happy snapshot/release
                await writeTree(ws, {
                  "ign/f1.txt": "1234567890",
                  "ign/f2.txt": "1234567890",
                  "ign/f3.txt": "1234567890"
                })
                await expect(
                  PackageTree.snapshotIgnored(ws, ".flows", { entries: 1, totalBytes: 1000 })
                ).rejects.toThrow("more than 1 entries")
                await expect(
                  PackageTree.snapshotIgnored(ws, ".flows", { entries: 100, totalBytes: 5 })
                ).rejects.toThrow("more than 5 bytes")
                const ignSnap = await PackageTree.snapshotIgnored(ws, ".flows", { entries: 100, totalBytes: 10000 })
                await PackageTree.releaseIgnored(ignSnap)

                // Portal snapshot: normal + unreadable target
                await Fs.writeFile(Path.join(portalTarget, "p.txt"), "portal\n")
                await Fs.symlink(portalTarget, Path.join(ws, "ext-link"))
                const portalSnap = await PackageTree.snapshotPortals(ws, ".flows")
                expect(portalSnap.portals.length).toBeGreaterThan(0)
                await PackageTree.releasePortals(portalSnap)

                if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
                  await Fs.chmod(portalTarget, 0o000)
                  try {
                    await expect(PackageTree.snapshotPortals(ws, ".flows")).rejects.toThrow("could not be read")
                  } finally {
                    await Fs.chmod(portalTarget, 0o755)
                  }

                  const lockedIgn = Path.join(ws, "ign", "locked")
                  await Fs.mkdir(lockedIgn, { recursive: true })
                  await Fs.writeFile(Path.join(lockedIgn, "secret.txt"), "x")
                  await Fs.chmod(lockedIgn, 0o000)
                  try {
                    await expect(
                      PackageTree.snapshotIgnored(ws, ".flows", { entries: 100, totalBytes: 10000 })
                    ).rejects.toThrow("could not be read")
                  } finally {
                    await Fs.chmod(lockedIgn, 0o755)
                  }
                }
              }

              return true
            } finally {
              await Fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        { executions: ioExecutions, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("Cache remote CAS download/upload failure matrix & effect-resolution bundled/declaration hooks", async () => {
    const modeArb = Arbitrary.schema(Schema.Literals(["remote-cas-faults", "effect-resolution"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        modeArb,
        (mode) =>
          Effect.promise(async () => {
            const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "w8k-cas-er-")))
            try {
              if (mode === "remote-cas-faults") {
                let casBehavior: "ok" | "429" | "500" | "truncated" | "413-find" | "slow-find" | "401-put" | "409-put" =
                  "ok"
                const metaStore = new Map<string, string>()
                const blobStore = new Map<string, Buffer>()
                const server = Http.createServer((req, res) => {
                  const url = req.url ?? "/"
                  const chunks: Array<Buffer> = []
                  req.on("data", (c) => chunks.push(Buffer.from(c)))
                  req.on("end", () => {
                    const body = Buffer.concat(chunks)
                    if (url.startsWith("/v1/ac/")) {
                      const key = url.slice("/v1/ac/".length)
                      if (req.method === "GET") {
                        const hit = metaStore.get(key)
                        if (hit === undefined) res.writeHead(404).end()
                        else res.writeHead(200, { "content-type": "application/json" }).end(hit)
                      } else if (req.method === "PUT") {
                        metaStore.set(key, body.toString("utf8"))
                        res.writeHead(200).end()
                      } else {
                        res.writeHead(405).end()
                      }
                      return
                    }
                    if (url === "/v1/cas/findMissing") {
                      if (casBehavior === "413-find") {
                        res.writeHead(413).end("too large")
                        return
                      }
                      if (casBehavior === "slow-find") {
                        setTimeout(() => {
                          if (!res.writableEnded) res.writeHead(200).end(JSON.stringify({ missing: [] }))
                        }, 300)
                        return
                      }
                      const parsed = JSON.parse(body.toString("utf8")) as { digests?: Array<string> }
                      const missing = (parsed.digests ?? []).filter((d) => !blobStore.has(d))
                      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ missing }))
                      return
                    }
                    if (url.startsWith("/v1/cas/")) {
                      const digest = url.slice("/v1/cas/".length)
                      if (req.method === "PUT") {
                        if (casBehavior === "401-put") {
                          res.writeHead(401).end()
                          return
                        }
                        if (casBehavior === "409-put") {
                          res.writeHead(409).end()
                          return
                        }
                        blobStore.set(digest, body)
                        res.writeHead(200).end()
                        return
                      }
                      if (req.method === "GET") {
                        if (casBehavior === "429") {
                          res.writeHead(429, { "retry-after": "0" }).end()
                          return
                        }
                        if (casBehavior === "500") {
                          res.writeHead(500).end()
                          return
                        }
                        if (casBehavior === "truncated") {
                          res.writeHead(200, { "content-length": String(OutputCas.chunkBytes + 1024) })
                          res.end("short")
                          return
                        }
                        const blob = blobStore.get(digest)
                        if (!blob) res.writeHead(404).end()
                        else res.writeHead(200).end(blob)
                        return
                      }
                    }
                    res.writeHead(404).end()
                  })
                })
                await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
                const addr = server.address() as { port: number }
                const endpoint = `http://127.0.0.1:${addr.port}/v1`
                try {
                  const warnings: Array<string> = []
                  const openStore = async (dirName: string, timeouts?: { get: number; put: number }) => {
                    const wsDir = Path.join(base, dirName)
                    await Fs.mkdir(wsDir, { recursive: true })
                    return Cache.openCache({
                      workspaceRoot: wsDir,
                      cacheDirectory: ".flows",
                      endpoint,
                      readToken: () => "tok-secret",
                      writeToken: () => "tok-secret",
                      ...(timeouts ? { timeouts } : {}),
                      warn: (m: string) => void warnings.push(m)
                    })
                  }

                  // Write a local CAS blob + entry via happy upload
                  const c1 = await openStore("c1")
                  const casDir1 = Path.join(base, "c1", ".flows", "cas")
                  await Fs.mkdir(casDir1, { recursive: true })
                  const blobBytes = Buffer.from("hello-remote-cas-payload\n")
                  const blobDigest = createHash("sha256").update(blobBytes).digest("hex")
                  await OutputCas.writeBlob(casDir1, blobDigest, blobBytes)
                  const key = "a".repeat(64)
                  const output = {
                    kind: "build",
                    manifests: [],
                    files: [{ path: "out.txt", digest: blobDigest, size: blobBytes.length, mode: 0o644 }]
                  }
                  await c1.put(key, {
                    key,
                    target: "Shell.Build",
                    label: "//:out",
                    exitOk: true,
                    storedAt: new Date().toISOString(),
                    output
                  })
                  expect(blobStore.has(blobDigest)).toBe(true)

                  // Download faults: 429, 500, truncated
                  for (const fault of ["429", "500", "truncated"] as const) {
                    casBehavior = fault
                    const cDown = await openStore(`c-down-${fault}`, { get: 120, put: 120 })
                    const got = await cDown.get(key)
                    expect(got == null || got.key === key).toBe(true)
                  }

                  // Upload faults: 413-find (skipLimit), slow-find (skipSlow), 409-put, 401-put
                  for (const [idx, fault] of (["413-find", "slow-find", "409-put", "401-put"] as const).entries()) {
                    casBehavior = fault
                    const cUp = await openStore(`c-up-${fault}`, { get: 60, put: 60 })
                    const casDirUp = Path.join(base, `c-up-${fault}`, ".flows", "cas")
                    await Fs.mkdir(casDirUp, { recursive: true })
                    const bytes = Buffer.from(`upload-fault-${fault}-${idx}`)
                    const d = createHash("sha256").update(bytes).digest("hex")
                    await OutputCas.writeBlob(casDirUp, d, bytes)
                    const k = `${idx}`.repeat(64)
                    await cUp.put(k, {
                      key: k,
                      target: "Shell.Build",
                      label: "//:up",
                      exitOk: true,
                      storedAt: new Date().toISOString(),
                      output: { kind: "build", manifests: [], files: [{ path: "u.txt", digest: d, size: bytes.length, mode: 0o644 }] }
                    })
                  }
                  expect(warnings.length).toBeGreaterThan(0)
                } finally {
                  await new Promise<void>((resolve) => server.close(() => resolve()))
                }
              } else {
                // effect-resolution.js: buildModuleUrl, importDeclarationModule (WORKSPACE.smithers, bundled)
                const wsFile = Path.join(base, ".smithers", "WORKSPACE.smithers")
                await Fs.mkdir(Path.dirname(wsFile), { recursive: true })
                await Fs.writeFile(wsFile, "export const answer = 42\n")
                const wsUrl = pathToFileURL(wsFile).href
                const tagged = EffectResolution.buildModuleUrl(wsUrl)
                expect(tagged).not.toBe(wsUrl)
                expect(EffectResolution.buildModuleUrl(`${wsUrl}?a=1#frag`)).toContain("a=1")
                expect(EffectResolution.buildModuleUrl(tagged)).toBe(tagged)

                const mod1 = (await EffectResolution.importDeclarationModule(
                  wsUrl,
                  wsUrl,
                  "export const answer = 99\n"
                )) as { answer: number }
                expect(mod1.answer).toBe(99)

                // Exercise bundledSpecifier + bundledSource via temporary bundled-cli registry
                const bundleSym = Symbol.for("smithers-build/bundled-cli")
                const prevBundle = (globalThis as Record<symbol, unknown>)[bundleSym]
                const fakeFile = Path.join(base, "fake-bundled-targets.mjs")
                await Fs.writeFile(fakeFile, "export const stub = 0\n")
                const fakeUrl = pathToFileURL(fakeFile).href
                ;(globalThis as Record<symbol, unknown>)[bundleSym] = {
                  addresses: new Map([["@smthrs/fake-bundled", { url: fakeUrl }]]),
                  modules: new Map([["@smthrs/fake-bundled", () => ({ default: "defVal", namedVal: 7 })]])
                }
                try {
                  EffectResolution.installEffectResolution()
                  const mod2 = (await import(fakeUrl)) as { default?: unknown; namedVal?: unknown; stub?: unknown }
                  expect(mod2.default === "defVal" || mod2.stub === 0).toBe(true)
                } finally {
                  if (prevBundle === undefined) delete (globalThis as Record<symbol, unknown>)[bundleSym]
                  else (globalThis as Record<symbol, unknown>)[bundleSym] = prevBundle
                }
              }

              return true
            } finally {
              await Fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        { executions: ioExecutions, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("AgentSession helpers (makeLocalWriteSetApplier, expandDiffSlice, precheckMcp, renderDataFiles, decodePayloadValues, verdictStores) & PackageLoader.probeCacheDirectory", async () => {
    const modeArb = Arbitrary.schema(Schema.Literals(["writeset-and-diff", "mcp-payload-and-probe"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        modeArb,
        (mode) =>
          Effect.promise(async () => {
            const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "w8k-agent-")))
            try {
              if (mode === "writeset-and-diff") {
                const ws = Path.join(base, "ws")
                await Fs.mkdir(ws, { recursive: true })
                git(ws, "init", "--quiet", "--initial-branch=main")
                git(ws, "config", "user.name", "Agent")
                git(ws, "config", "user.email", "agent@example.invalid")
                git(ws, "config", "commit.gpgsign", "false")
                await commitTree(ws, { "src/a.txt": "line1\n", "keep.txt": "ok\n" }, "c1")
                await commitTree(ws, { "src/a.txt": "line1\nneedle\n", "src/added.txt": "needle here\n" }, "c2")

                // expandDiffSlice: paths + added + addedLines
                const slice1 = await Effect.runPromise(
                  AgentSession.expandDiffSlice(ws, [
                    { _tag: "GitDiff", base: "HEAD~1", paths: ["src/**"] },
                    { _tag: "GitDiff", base: "HEAD~1", added: ["src/**"], addedLines: "needle" }
                  ])
                )
                expect(slice1.files.length).toBeGreaterThan(0)

                // makeLocalWriteSetApplier: valid apply, delete, escape, outside writeSet, symlink escape, commit
                const applier = AgentSession.makeLocalWriteSetApplier(ws)
                const overlay = await Effect.runPromise(
                  applier.apply(
                    [
                      { path: "src/new.txt", contents: "created\n" },
                      { path: "src/added.txt", contents: null }
                    ],
                    ["src/**"]
                  )
                )
                expect(overlay.files.get("src/new.txt")).toBe("created\n")
                await Effect.runPromise(applier.commit(overlay))
                expect(await Fs.readFile(Path.join(ws, "src", "new.txt"), "utf8")).toBe("created\n")

                // Invalid edit paths & outside write-set -> AgentWriteEscape
                for (const badPath of ["../escape.txt", "/abs/path.txt", "keep.txt", "src/bad\0name.txt"]) {
                  const exit = await Effect.runPromiseExit(
                    applier.apply([{ path: badPath, contents: "x" }], ["src/**"])
                  )
                  expect(exit._tag).toBe("Failure")
                }

                // Symlink inside write-set pointing outside workspace -> AgentWriteEscape
                const outside = Path.join(base, "outside.txt")
                await Fs.writeFile(outside, "ext\n")
                await Fs.symlink(outside, Path.join(ws, "src", "sym.txt"))
                const symExit = await Effect.runPromiseExit(
                  applier.apply([{ path: "src/sym.txt", contents: "overwrite" }], ["src/**"])
                )
                expect(symExit._tag).toBe("Failure")

                // renderDataFiles: empty, normal, oversize (>512KB), escape, missing
                expect(await Effect.runPromise(AgentSession.renderDataFiles(ws, []))).toBe("")
                const normalRendered = await Effect.runPromise(AgentSession.renderDataFiles(ws, ["keep.txt"]))
                expect(normalRendered).toContain("keep.txt")
                await Fs.writeFile(Path.join(ws, "big.bin"), Buffer.alloc(AgentSession.maximumSessionFileBytes + 64, 65))
                const bigRendered = await Effect.runPromise(AgentSession.renderDataFiles(ws, ["big.bin"]))
                expect(bigRendered).toContain("omitted:")
                const escExit = await Effect.runPromiseExit(AgentSession.renderDataFiles(ws, ["../outside.txt"]))
                expect(escExit._tag).toBe("Failure")
              } else {
                // precheckMcp: HEAD 200, HEAD destroyed -> GET 200 fallback, unreachable port -> AgentMcpUnreachable
                let headFails = false
                const srv = Http.createServer((req, res) => {
                  if (req.method === "HEAD" && headFails) {
                    req.socket.destroy()
                    return
                  }
                  res.writeHead(200).end("ok")
                })
                await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
                const port = (srv.address() as { port: number }).port
                try {
                  await Effect.runPromise(
                    AgentSession.precheckMcp([{ _tag: "McpHttp", name: "ok-head", url: `http://127.0.0.1:${port}/mcp` }], 1000)
                  )
                  headFails = true
                  await Effect.runPromise(
                    AgentSession.precheckMcp([{ _tag: "McpHttp", name: "fallback-get", url: `http://127.0.0.1:${port}/mcp` }], 1000)
                  )
                } finally {
                  await new Promise<void>((resolve) => srv.close(() => resolve()))
                }
                const unreachExit = await Effect.runPromiseExit(
                  AgentSession.precheckMcp([{ _tag: "McpHttp", name: "dead", url: `http://127.0.0.1:${port}/dead` }], 300)
                )
                expect(unreachExit._tag).toBe("Failure")

                // decodePayloadValues: valid, optional omitted, missing required, empty string, invalid enum
                const spec = {
                  title: S.Input.String("title"),
                  kind: { _tag: "InputChoice", values: ["bug", "feat"] } as never,
                  opt: S.Input.Optional(S.Input.String("opt"))
                }
                const decoded = await Effect.runPromise(
                  AgentSession.decodePayloadValues(spec, { title: "fix", kind: "bug" })
                )
                expect(decoded).toEqual({ title: "fix", kind: "bug" })
                for (const bad of [{ kind: "bug" }, { title: "", kind: "bug" }, { title: "x", kind: "nope" }] as Array<Record<string, string>>) {
                  const ex = await Effect.runPromiseExit(AgentSession.decodePayloadValues(spec, bad))
                  expect(ex._tag).toBe("Failure")
                }

                // Verdict stores (memory + file) + codexErrorMessages + claudeMcpConfig + verdictKey
                const mem = AgentSession.makeMemoryVerdictStore()
                await Effect.runPromise(mem.put("k1", JSON.stringify({ ok: true })))
                expect(await Effect.runPromise(mem.get("k1"))).toContain("true")
                const vDir = Path.join(base, "verdicts")
                const fStore = AgentSession.makeFileVerdictStore(vDir)
                expect(await Effect.runPromise(fStore.get("missing"))).toBeUndefined()
                await Fs.mkdir(vDir, { recursive: true })
                await Fs.writeFile(Path.join(vDir, "corrupt.json"), "{bad")
                expect(await Effect.runPromise(fStore.get("corrupt"))).toBeUndefined()
                expect(
                  AgentSession.codexErrorMessages(
                    [JSON.stringify({ type: "error", message: "boom" }), JSON.stringify({ type: "turn.failed", error: { message: "turn fail" } }), "not-json"].join("\n")
                  )
                ).toEqual(["boom", "turn fail"])
                expect(
                  AgentSession.claudeMcpConfig([{ _tag: "McpHttp", name: "m", url: "http://127.0.0.1:1/m" }])
                ).toContain("mcpServers")

                // PackageLoader.probeCacheDirectory: with cache, without cache, missing file
                const wsDir = Path.join(base, "probe-ws")
                await Fs.mkdir(wsDir, { recursive: true })
                await Fs.writeFile(
                  Path.join(wsDir, "WORKSPACE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("p", { repository: "git+https://example.invalid/p.git", cache: S.Cache({ directory: ".custom-cache" }) })\n`
                )
                expect(await PackageLoader.probeCacheDirectory(wsDir, "WORKSPACE.ts")).toBe(".custom-cache")
                expect(await PackageLoader.probeCacheDirectory(wsDir, "MISSING.ts")).toBeUndefined()
              }

              return true
            } finally {
              await Fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        { executions: ioExecutions, seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
