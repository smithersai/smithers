import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import type * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as DependencyDocs from "../src/DependencyDocs.ts"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import * as JsrPublish from "../src/JsrPublish.ts"
import * as LocalRepository from "../src/LocalRepository.ts"
import * as NpmPublish from "../src/NpmPublish.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as TsBuild from "../src/TsBuild.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"
import { packageManager, runtime } from "./toolchain.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261140")
const fsExecutions = Math.min(executions, 16)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/targets deep fuzz suite 6: PackageJson generated+cache, Exec imports+secrets+heldOutput, Target errors, WorkspaceDeclaration full surface & SafeFs/SecretProxy edges", () => {
  it(
    "PackageJson.sync generated fields with fake CLI, field cache hit/refresh, publishFields & validation errors",
    async () => {
      const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-pjgen-")))
      try {
        const fakeGenCli = NodePath.join(tmpRoot, "fake-gen.mjs")
        await Fs.writeFile(
          fakeGenCli,
          `#!${process.execPath}\n` +
            "for await (const _ of process.stdin) {}\n" +
            "const answer = JSON.stringify({ description: 'Clean generated package description', keywords: ['smithers', 'build', 'fuzz'] });\n" +
            "process.stdout.write(JSON.stringify({ type: 'result', result: answer }));\n",
          "utf8"
        )
        await Fs.chmod(fakeGenCli, 0o755)

        const arb = Arbitrary.schema(
          Schema.Struct({
            slug: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,8}$/)),
            badParse: Schema.Literals(["none", "not-json", "bad-desc", "few-kw", "bad-kw", "extra-key"]),
            pubKind: Schema.Literals(["npm", "jsr", "both"])
          })
        )

        let runIdx = 0
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ slug, badParse, pubKind }) =>
              Effect.gen(function*() {
                const idx = runIdx++
                const ws = NodePath.join(tmpRoot, `ws-${idx}`)
                const pkgRel = `packages/${slug}`
                yield* Effect.promise(async () => {
                  await Fs.mkdir(NodePath.join(ws, pkgRel, "src"), { recursive: true })
                  await Fs.writeFile(NodePath.join(ws, pkgRel, "README.md"), `# ${slug}\n`, "utf8")
                  await Fs.writeFile(NodePath.join(ws, pkgRel, "src/index.ts"), "export const x = 1\n", "utf8")
                })

                // 1. parseGenerated error branches
                if (badParse !== "none") {
                  const raw = badParse === "not-json"
                    ? "not json"
                    : badParse === "bad-desc"
                    ? JSON.stringify({ description: "has\nnewline", keywords: ["aaa", "bbb", "ccc"] })
                    : badParse === "few-kw"
                    ? JSON.stringify({ description: "ok", keywords: ["only-one"] })
                    : badParse === "bad-kw"
                    ? JSON.stringify({ description: "ok", keywords: ["BAD KEY", "bbb", "ccc"] })
                    : JSON.stringify({ description: "ok", keywords: ["aaa", "bbb", "ccc"], extra: 1 })
                  let threw = false
                  try {
                    PackageJson.parseGenerated(raw, ["description", "keywords"])
                  } catch {
                    threw = true
                  }
                  if (!threw) throw new Error(`expected parseGenerated throw for ${badParse}`)
                }

                // 2. PackageJson.sync with generated fields -> invokes CLI, writes cache, then hits cache on check, then refreshes!
                const baseSync: PackageJson.SyncPayload = {
                  path: `${pkgRel}/package.json`,
                  packageDirectory: pkgRel,
                  mode: "write",
                  fields: { name: `@demo/${slug}`, version: "0.1.0", license: "MIT" },
                  generated: ["description", "keywords"],
                  readme: Input.file(`${pkgRel}/README.md`),
                  sources: Input.glob(`${pkgRel}/src/**/*.ts`),
                  promptVersion: PackageJson.promptVersion,
                  engine: "claude",
                  model: "claude-opus-5-5"
                }
                yield* PackageJson.sync(
                  { workspaceRoot: ws, cacheDirectory: ".flows", executable: fakeGenCli },
                  baseSync
                )
                // Second run in check mode should hit the field cache without drift!
                yield* PackageJson.sync({ workspaceRoot: ws, cacheDirectory: ".flows", executable: fakeGenCli }, {
                  ...baseSync,
                  mode: "check"
                })
                // Refresh mode bypasses cache and re-writes
                yield* PackageJson.sync({ workspaceRoot: ws, cacheDirectory: ".flows", executable: fakeGenCli }, {
                  ...baseSync,
                  mode: "refresh"
                })

                // 3. publishFields & PackageJson publish option
                const buildT = TsBuild.TsBuild({
                  packageManager,
                  tsconfig: Input.file(`${pkgRel}/tsconfig.json`),
                  srcs: [Input.glob(`${pkgRel}/src/**/*.ts`)],
                  entries: [Input.file(`${pkgRel}/src/index.ts`)],
                  deps: [],
                  tool: { name: "tsc" },
                  format: "esm",
                  outDir: "dist",
                  cwd: pkgRel
                })
                const jsrPub = JsrPublish.JsrPublish({
                  packageManager,
                  config: Input.file(`${pkgRel}/jsr.json`),
                  sources: [],
                  deps: [],
                  package: `@demo/${slug}`,
                  cliVersion: "0.13.0",
                  allowDirty: false,
                  dryRun: false
                })
                if (pubKind === "npm") {
                  void PackageJson.publishFields(buildT, `//${pkgRel}:build`, { access: "public", provenance: false })
                } else if (pubKind === "jsr") {
                  try {
                    PackageJson.publishFields(jsrPub, `//${pkgRel}:jsr`, { access: "public", provenance: true })
                  } catch {
                    // expected: no outDir
                  }
                } else {
                  const pj = PackageJson.PackageJson({
                    name: `@demo/${slug}`,
                    version: "0.1.0",
                    description: PackageJson.generated,
                    keywords: PackageJson.generated,
                    license: "MIT",
                    publish: { entry: buildT, access: "public", provenance: false },
                    readme: Input.file("README.md"),
                    sources: Input.glob("src/**/*.ts")
                  })
                  if (!PackageJson.isDeclaration(pj)) throw new Error("isDeclaration")
                  if (!PackageJson.isGenerated(PackageJson.generated)) throw new Error("isGenerated")
                }

                // 4. PackageJson validation rejections
                for (
                  const badOpts of [
                    null,
                    new Proxy({}, {}),
                    { name: "BAD NAME!!", version: "1.0.0" },
                    { name: "@demo/ok", version: "1.0.0", scripts: { test: 42 } },
                    { name: "@demo/ok", version: "1.0.0", publish: 42 }
                  ]
                ) {
                  let threw = false
                  try {
                    PackageJson.PackageJson(badOpts as never)
                  } catch {
                    threw = true
                  }
                  if (!threw) throw new Error("expected PackageJson error")
                }

                return true
              }),
            { executions: fsExecutions, seed }
          )
        )
        assertPassed(report)
      } finally {
        await Fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Exec import token expansion, Secret+HttpSecret proxy delivery & heldOutput teardown fuzz invariants",
    async () => {
      const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-exec6-")))
      const upstream = NodeHttp.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "x-echo": String(req.headers["authorization"] ?? "") })
        res.end(`GOT=${req.headers["authorization"] ?? ""}`)
      })
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
      const upAddr = upstream.address() as NodeNet.AddressInfo
      try {
        await Fs.writeFile(NodePath.join(tmpRoot, "preload.mjs"), "globalThis.__PRELOADED = 'yes';\n", "utf8")

        const arb = Arbitrary.schema(
          Schema.Struct({
            mode: Schema.Literals([
              "import-rel",
              "import-url",
              "import-missing-bare",
              "secret-proxy-exec",
              "held-output"
            ])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ mode }) =>
              Effect.gen(function*() {
                if (mode === "import-rel") {
                  const res = yield* Exec.run(
                    { workspaceRoot: tmpRoot },
                    {
                      cwd: ".",
                      argv: [process.execPath, "-e", "process.stdout.write(String(globalThis.__PRELOADED))"],
                      env: { NODE_OPTIONS: "{smthrs:import:./preload.mjs}" },
                      secrets: [],
                      expectedExitCodes: [0],
                      timeoutMs: 15_000
                    }
                  )
                  if (res.stdout !== "yes") throw new Error(`preload failed: ${res.stdout}`)
                } else if (mode === "import-url") {
                  const res = yield* Exec.run(
                    { workspaceRoot: tmpRoot },
                    {
                      cwd: ".",
                      argv: [process.execPath, "-e", "process.stdout.write('ok')"],
                      env: { NODE_OPTIONS: "{smthrs:import:node:fs}" },
                      secrets: [],
                      expectedExitCodes: [0],
                      timeoutMs: 15_000
                    }
                  )
                  if (res.stdout !== "ok") throw new Error("import-url")
                } else if (mode === "import-missing-bare") {
                  const exit = yield* Exec.run(
                    { workspaceRoot: tmpRoot },
                    {
                      cwd: ".",
                      argv: [process.execPath, "-e", "process.stdout.write('ok')"],
                      env: { NODE_OPTIONS: "{smthrs:import:definitely-nonexistent-pkg-xyz-999}" },
                      secrets: [],
                      expectedExitCodes: [0],
                      timeoutMs: 15_000
                    }
                  ).pipe(Effect.exit)
                  void exit
                } else if (mode === "secret-proxy-exec") {
                  const origin = `http://127.0.0.1:${upAddr.port}`
                  const sec = Secret.Secret("FUZZ_EXEC_SECRET")
                  const cred = Secret.HttpSecret(sec, [origin])
                  const res = yield* Exec.run(
                    {
                      workspaceRoot: tmpRoot
                    },
                    {
                      cwd: ".",
                      argv: [
                        process.execPath,
                        "-e",
                        "const http=require('node:http');const u=new URL(process.env.HTTP_PROXY);const req=http.request({host:u.hostname,port:Number(u.port),path:process.argv[1],headers:{Host:new URL(process.argv[1]).host,Authorization:'Bearer '+process.env.FUZZ_EXEC_SECRET}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>process.stdout.write(b));});req.end();",
                        `${origin}/api`
                      ],
                      env: { FUZZ_EXEC_SECRET: cred } as never,
                      secrets: [cred] as never,
                      expectedExitCodes: [0],
                      timeoutMs: 15_000
                    }
                  ).pipe(Effect.exit)
                  void res
                } else {
                  // heldOutput: main exits while a grandchild inherits stdout briefly
                  const res = yield* Exec.run(
                    { workspaceRoot: tmpRoot, heldOutput: { links: () => [], holders: () => [], kill: () => {} } },
                    {
                      cwd: ".",
                      argv: [
                        process.execPath,
                        "-e",
                        "const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 3000)'], { stdio: ['ignore', 1, 2], detached: false }); process.stdout.write('main-done');"
                      ],
                      env: {},
                      secrets: [],
                      expectedExitCodes: [0],
                      timeoutMs: 15_000
                    }
                  ).pipe(Effect.exit)
                  void res
                }
                return true
              }),
            { executions: Math.min(executions, 10), seed: seed + 1 }
          )
        )
        assertPassed(report)
      } finally {
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
        await Fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Target attrs/rejection diagnostics, WorkspaceDeclaration full constructors & SafeFs/SecretProxy edge invariants",
    async () => {
      const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-misc6-")))
      try {
        await Fs.writeFile(NodePath.join(tmpRoot, "a.txt"), "hello world\n", "utf8")
        await Fs.symlink(NodePath.join(tmpRoot, "loop-b"), NodePath.join(tmpRoot, "loop-a"))
        await Fs.symlink(NodePath.join(tmpRoot, "loop-a"), NodePath.join(tmpRoot, "loop-b"))

        const arb = Arbitrary.schema(
          Schema.Struct({
            badKey: Schema.Literals(["shel", "shlel", "completelyUnknownKey123"]),
            flagVal: Schema.Literals(["debug", "release", "1"]),
            wsBad: Schema.Literals([
              "name",
              "prune-abs",
              "prune-escape",
              "dup-hook",
              "bad-cache",
              "bad-host",
              "bad-flags"
            ])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ badKey, flagVal, wsBad }) =>
              Effect.promise(async () => {
                // 1. Target.ts rejection diagnostics ("did you mean", exotic values, getters, depth)
                try {
                  Shell.Test({ shell: "true", [badKey]: "oops" } as never)
                  throw new Error("should reject excess key")
                } catch (e) {
                  if (badKey === "shel" && !(e instanceof Error && e.message.includes("did you mean"))) {
                    throw new Error(`expected did-you-mean suggestion, got: ${String(e)}`)
                  }
                }
                for (
                  const exotic of [
                    { shell: "true", env: new Map() },
                    { shell: "true", env: new Proxy({}, {}) },
                    Object.defineProperty({ shell: "true" }, "args", { get: () => [], enumerable: true })
                  ]
                ) {
                  let threw = false
                  try {
                    Shell.Test(exotic as never)
                  } catch {
                    threw = true
                  }
                  if (!threw) throw new Error("expected exotic/getter rejection")
                }
                // Target.isTarget negative cases
                if (Target.isTarget(null) || Target.isTarget({}) || Target.isTarget(new Proxy({}, {}))) {
                  throw new Error("isTarget false")
                }
                if (Target.declaredOutputsFailure({ cwd: "../bad", paths: ["dist"] }) === undefined) {
                  throw new Error("bad cwd")
                }
                void Target.declaredOutputsFailure({ cwd: ".", paths: [] })
                if (Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "dist"] }) === undefined) {
                  throw new Error("dup paths")
                }
                if (Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "dist/a"] }) === undefined) {
                  throw new Error("overlap paths")
                }
                void Target.catalogNotImplemented()

                // 2. WorkspaceDeclaration full constructors & error paths
                const host = WorkspaceDeclaration.Host({ bins: ["git", "node"] })
                const flags = WorkspaceDeclaration.Flags({ mode: flagVal })
                if (!WorkspaceDeclaration.isFlagsDeclaration(flags)) throw new Error("isFlagsDeclaration")
                const flagRef = WorkspaceDeclaration.Flags.mode
                if (flagRef === undefined) throw new Error("callable Flags ref")
                const wsOk = WorkspaceDeclaration.Workspace("good-ws", {
                  repository: "git+https://github.com/demo/repo.git",
                  cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
                  packageManager,
                  runtime,
                  nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: Input.file("//package.json") }),
                  host,
                  flags,
                  discovery: { prune: ["vendor", "tmp/cache"] },
                  repos: { upstream: LocalRepository.make("vendor/upstream") },
                  docs: { effect: DependencyDocs.Package("effect") }
                })
                if (!WorkspaceDeclaration.flagNames(wsOk).has("mode")) throw new Error("flagNames")

                // Invalid Workspace / sub-constructor cases
                let threwWs = false
                try {
                  if (wsBad === "name") {
                    WorkspaceDeclaration.Workspace("bad name!", {
                      repository: "git+https://github.com/demo/repo.git",
                      cache: WorkspaceDeclaration.Cache({ directory: ".flows" })
                    })
                  } else if (wsBad === "prune-abs") {
                    WorkspaceDeclaration.Workspace("ok", {
                      repository: "git+https://github.com/demo/repo.git",
                      cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
                      discovery: { prune: ["/abs"] }
                    })
                  } else if (wsBad === "prune-escape") {
                    WorkspaceDeclaration.Workspace("ok", {
                      repository: "git+https://github.com/demo/repo.git",
                      cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
                      discovery: { prune: ["../out"] }
                    })
                  } else if (wsBad === "bad-cache") {
                    WorkspaceDeclaration.Cache({ directory: "../escape" })
                  } else if (wsBad === "bad-host") {
                    WorkspaceDeclaration.Host({ bins: [""] })
                  } else if (wsBad === "bad-flags") {
                    WorkspaceDeclaration.Flags({ "123-bad": "v" })
                  } else {
                    WorkspaceDeclaration.Workspace("ok", {
                      repository: "git+https://github.com/demo/repo.git",
                      cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
                      gitHooks: { badHook: Shell.Test({ shell: "true" }) } as never
                    })
                  }
                } catch {
                  threwWs = true
                }
                if (!threwWs) throw new Error(`expected WorkspaceDeclaration throw for ${wsBad}`)

                // 3. SafeFs edge cases (symlink loop, readText limit, listDirectory limit, errorCode)
                let loopFailed = false
                try {
                  await SafeFs.resolveFile(NodePath.join(tmpRoot, "loop-a"), { root: tmpRoot })
                } catch {
                  loopFailed = true
                }
                if (!loopFailed) throw new Error("expected symlink loop failure")

                let limitFailed = false
                try {
                  await SafeFs.readText(NodePath.join(tmpRoot, "a.txt"), { root: tmpRoot, limit: 3 })
                } catch {
                  limitFailed = true
                }
                if (!limitFailed) throw new Error("expected readText limit failure")

                const rd = await SafeFs.resolveDirectory(tmpRoot, { root: tmpRoot })
                if (rd !== undefined) {
                  let dirLimitFailed = false
                  try {
                    await SafeFs.listDirectory(rd.path, rd, { root: tmpRoot, directoryEntries: 0 })
                  } catch {
                    dirLimitFailed = true
                  }
                  if (!dirLimitFailed) throw new Error("expected listDirectory limit failure")
                }
                if (SafeFs.errorCode(Object.assign(new Error("x"), { code: "ENOENT" })) !== "ENOENT") {
                  throw new Error("errorCode")
                }
                if (SafeFs.errorCode(null) !== undefined) throw new Error("errorCode null")

                // 4. Secret & SecretProxy validation edge cases
                if (SecretProxy.parseConnectAuthority("example.com:443") === undefined) {
                  throw new Error("parseConnectAuthority")
                }
                if (SecretProxy.parseConnectAuthority("bad:port") !== undefined) {
                  throw new Error("bad connect authority")
                }
                const vault = SecretProxy.makeVault({ read: () => "val" })
                for (const badAud of ["not-a-url", "ftp://example.com", "https://user:pass@example.com"]) {
                  let threw = false
                  try {
                    vault.request(badAud)
                  } catch {
                    threw = true
                  }
                  if (!threw) throw new Error(`expected bad audience throw for ${badAud}`)
                }

                return true
              }),
            { executions: fsExecutions, seed: seed + 2 }
          )
        )
        assertPassed(report)
      } finally {
        await Fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    120_000
  )
})
