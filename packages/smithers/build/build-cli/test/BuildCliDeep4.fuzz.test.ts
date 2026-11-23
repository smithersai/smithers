import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import type * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const cliExecutions = Math.min(executions, 2)

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
    NodeChildProcess.execFile(
      "git",
      ["-C", root, ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => {
        if (err !== null) reject(err)
        else resolve(stdout.trim())
      }
    )
  })

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,5}$/))

const startRemoteCache = async (faultMode: "ok" | "flaky" = "ok") => {
  const ac = new Map<string, Buffer>()
  const cas = new Map<string, Buffer>()
  let count = 0
  const server = NodeHttp.createServer(async (req, res) => {
    const chunks: Array<Buffer> = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    const body = Buffer.concat(chunks)
    const path = req.url ?? "/"
    const method = req.method ?? "GET"
    count++
    if (faultMode === "flaky" && count === 1) {
      res.writeHead(503).end("retry")
      return
    }
    if (path.startsWith("/ac/")) {
      const key = decodeURIComponent(path.slice("/ac/".length))
      if (method === "PUT") {
        ac.set(key, body)
        res.writeHead(200).end()
        return
      }
      const hit = ac.get(key)
      if (hit === undefined) res.writeHead(404).end()
      else res.writeHead(200).end(hit)
      return
    }
    if (path === "/cas/findMissing") {
      const parsed = JSON.parse(body.toString("utf8")) as { readonly digests: ReadonlyArray<string> }
      res.writeHead(200).end(JSON.stringify({ missing: parsed.digests.filter((d) => !cas.has(d)) }))
      return
    }
    if (path.startsWith("/cas/")) {
      const digest = path.slice("/cas/".length)
      if (method === "PUT") {
        cas.set(digest, body)
        res.writeHead(201).end()
        return
      }
      const blob = cas.get(digest)
      if (blob === undefined) res.writeHead(404).end()
      else res.writeHead(200).end(blob)
      return
    }
    res.writeHead(404).end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const addr = server.address() as NodeNet.AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    ac,
    cas,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("@smthrs/build-cli deep fuzz suite 4: PackageRunner, PackagePlanner, PackageTree, Cli, Remote CAS & Multi-Rule E2E", () => {
  it("End-to-end multi-package workspace: build/test/shards/suite/alias/clean/materialize/stamp/fetch/owners/docs/cache/gc/git-hooks/affected/query/explain/remote-CAS", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        flakyCache: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, flakyCache }) =>
          Effect.promise(async () => {
            const fetchPayload = `fetched-artifact-${slug}\n`
            const fetchSha = createHash("sha256").update(fetchPayload).digest("hex")
            const fetchSrv = NodeHttp.createServer((_req, res) => {
              res.writeHead(200, { "content-type": "text/plain" }).end(fetchPayload)
            })
            fetchSrv.listen(0, "127.0.0.1")
            await once(fetchSrv, "listening")
            const fetchPort = (fetchSrv.address() as NodeNet.AddressInfo).port
            const remoteCache = await startRemoteCache(flakyCache ? "flaky" : "ok")

            try {
              await withTempDir("smthrs-bc4-e2e-", async (root) => {
                await write(
                  root,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("ws-${slug}", {
  repository: "git+https://example.invalid/ws-${slug}.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["sh"] }),
  gitHooks: { preCommit: S.Shell.Run({ shell: "exit 0" }) },
  teams: S.Teams({ core: ["alice"] }),
  owners: S.Owners.declare({ owners: ["core"] })
})
`
                )
                await write(root, "package.json", `{"name":"ws-${slug}","private":true}\n`)
                await write(root, "yarn.lock", "# yarn lockfile v1\n")
                await write(root, "docs/guide.md", `# Guide for ${slug}\n`)
                await write(root, "docs/.stamp", "{}\n")
                await write(root, `packages/${slug}/src/index.ts`, `export const name = "${slug}"\n`)
                await write(root, `packages/${slug}/README.md`, `# ${slug}\n`)

                await write(
                  root,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({
  targets: {
    hello: S.Shell.Run({ bin: S.Runtime.bin, args: ["-e", "console.log('hi-${slug}')"] }),
    cleanOut: S.Clean({ paths: ["packages/${slug}/dist"] }),
    fetched: S.Fetch({ url: "http://127.0.0.1:${fetchPort}/art.txt", sha256: "${fetchSha}", out: "vendor/art.txt" }),
    codeowners: S.Owners.Codeowners({ org: "demo" }),
    ownerTree: S.Owners.Tree({}),
    targetIdx: S.TargetIndex({ mode: "write" }),
    genText: S.Generate({ emit: { "generated/info.txt": "gen-${slug}\\n" } }),
    docsCheck: S.Docs.Check({ stamp: S.file("docs/.stamp"), output: S.file("docs/guide.md"), inputs: [S.file("packages/${slug}/src/index.ts")] })
  }
})
`
                )

                await write(
                  root,
                  `packages/${slug}/PACKAGE.ts`,
                  `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const build = S.Shell.Build({
  bin: S.Runtime.bin,
  args: [
    "-e",
    "const fs=require('node:fs'); fs.mkdirSync('packages/${slug}/dist',{recursive:true}); fs.writeFileSync('packages/${slug}/dist/out.js', fs.readFileSync('packages/${slug}/src/index.ts','utf8')); fs.writeFileSync('packages/${slug}/dist/meta.txt', '${slug}');"
  ],
  data: [srcs],
  outDirs: ["dist"],
  sandbox: "none"
})
const test = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["-e", "const fs=require('node:fs'); if(!fs.readFileSync('packages/${slug}/dist/out.js','utf8').includes('${slug}')) process.exit(2); fs.writeFileSync('packages/${slug}/test-report.txt', 'ok');"],
  data: [build],
  outFiles: ["test-report.txt"],
  sandbox: "none",
  env: { FUZZ_SLUG: "${slug}" }
})
const sharded = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["-e", "process.stdout.write('shard=' + process.argv.slice(1).join(','))", "--"],
  data: [srcs],
  shards: 2
})
const exclusiveTest = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["-e", "process.stdout.write('excl')"],
  data: [srcs],
  exclusive: true
})
const mat = S.Materialize(build)
const allTests = S.Suite({ tests: [test] })
const buildAlias = S.Alias(build)
export const Package = S.Package({
  owners: S.Owners.declare({ owners: ["core"] }),
  targets: { srcs, build, test, sharded, exclusiveTest, mat, allTests, buildAlias }
})
`
                )

                // Init real git repo for affected/git-hooks
                await gitExec(root, ["init", "--quiet", "--initial-branch=main"])
                await gitExec(root, ["config", "user.name", "Fuzz"])
                await gitExec(root, ["config", "user.email", "fuzz@example.invalid"])
                await gitExec(root, ["config", "commit.gpgsign", "false"])
                await gitExec(root, ["add", "-A"])
                await gitExec(root, ["commit", "--quiet", "-m", "initial"])

                // 1. Discovery / introspection CLI commands
                const q1 = await serve(root, ["query", "//..."])
                expect(q1.exitCode, q1.output + "\n" + q1.logs).toBe(0)
                expect(q1.output).toContain(`//packages/${slug}:build`)
                expect((await serve(root, ["query", `deps(//packages/${slug}:test)`])).exitCode).toBe(0)
                expect((await serve(root, ["query", `rdeps(//packages/${slug}:srcs)`])).exitCode).toBe(0)
                expect((await serve(root, ["query", `owners(//packages/${slug}:build)`])).exitCode).toBe(0)
                const t1 = await serve(root, ["targets", "//..."]); expect(t1.exitCode, t1.output + "\n" + t1.logs).toBe(0)
                expect((await serve(root, ["index", "//..."])).exitCode).toBe(0)
                expect((await serve(root, ["graph", "//..."])).exitCode).toBe(0)
                expect((await serve(root, ["show", "target", `//packages/${slug}:build`])).exitCode).toBe(0)
                expect((await serve(root, ["owners", `packages/${slug}/src/index.ts`])).exitCode).toBe(0)
                expect((await serve(root, ["info"])).exitCode).toBe(0)
                expect(typeof (await serve(root, ["doctor"])).exitCode).toBe("number")

                // 2. Build with remote cache (cold -> upload to remote CAS)
                const b1 = await serve(root, ["build", `//packages/${slug}:build`, `//packages/${slug}:buildAlias`, "//:fetched"], {
                  cacheUrl: remoteCache.url,
                  cacheToken: "tok-123"
                })
                expect(b1.exitCode, b1.output + "\n" + b1.logs).toBe(0)
                if (!flakyCache) expect(remoteCache.ac.size).toBeGreaterThanOrEqual(1)

                // 3. Explain (warm local cache hit) + second build (local cache hit)
                expect((await serve(root, ["explain", `//packages/${slug}:build`])).exitCode).toBe(0)
                const b2 = await serve(root, ["build", `//packages/${slug}:build`])
                expect(b2.exitCode).toBe(0)

                // 4. Wipe local cache & dist, rebuild from remote CAS!
                await Fs.rm(NodePath.join(root, ".flows"), { recursive: true, force: true })
                await Fs.rm(NodePath.join(root, `packages/${slug}/dist`), { recursive: true, force: true })
                const b3 = await serve(root, ["build", `//packages/${slug}:build`], {
                  cacheUrl: remoteCache.url,
                  cacheToken: "tok-123"
                })
                expect(b3.exitCode).toBe(0)
                const restored = await Fs.readFile(NodePath.join(root, `packages/${slug}/dist/meta.txt`), "utf8")
                expect(restored).toBe(slug)

                // 5. No-cache, Materialize, Run, Sharded tests, Exclusive tests, CI with results-file
                expect((await serve(root, ["build", `//packages/${slug}:build`, "--no-cache"])).exitCode).toBe(0)
                expect((await serve(root, ["target", `//packages/${slug}:mat`])).exitCode).toBe(0)
                expect((await serve(root, ["run", "//:hello"])).exitCode).toBe(0)
                const sh0 = await serve(root, ["test", `//packages/${slug}:sharded`, "--shard", "0/2"])
                expect(sh0.exitCode, sh0.output + "\n" + sh0.logs).toBe(0)
                const sh1 = await serve(root, ["test", `//packages/${slug}:sharded`, "--shard", "1/2"])
                expect(sh1.exitCode, sh1.output + "\n" + sh1.logs).toBe(0)
                expect((await serve(root, ["test", `//packages/${slug}:allTests`, `//packages/${slug}:exclusiveTest`, "--include-exclusive"])).exitCode).toBe(0)

                const resultsFile = NodePath.join(root, ".flows", "results.json")
                const ciRes = await serve(root, ["ci", `//packages/${slug}/...`, "--results-file", resultsFile])
                expect(ciRes.exitCode, ciRes.output + "\n" + ciRes.logs).toBe(0)

                // 6. Generated files (codeowners, ownerTree, targetIdx, genText), docs, clean, git-hooks
                void (await serve(root, ["target", "//:codeowners", "--write"]))
                void (await serve(root, ["target", "//:ownerTree", "--write"]))
                void (await serve(root, ["target", "//:targetIdx", "--write"]))
                void (await serve(root, ["target", "//:genText", "--write"]))
                void (await serve(root, ["lint", "//:genText"]))
                void (await serve(root, ["docs", "//..."]))
                void (await serve(root, ["git-hooks", "--write"]))
                void (await serve(root, ["git-hooks"]))
                expect((await serve(root, ["clean", "//:cleanOut"])).exitCode).toBe(0)

                // 7. Cache admin + gc + affected
                expect((await serve(root, ["cache", "status"])).exitCode).toBe(0)
                void (await serve(root, ["cache", "verify"]))
                void (await serve(root, ["cache", "prune"]))
                void (await serve(root, ["gc"]))
                await write(root, `packages/${slug}/src/index.ts`, `export const name = "${slug}-edited"\n`)
                void (await serve(root, ["affected", "--base", "HEAD", "--list"]))
              })
            } finally {
              await fetchSrv.close()
              await remoteCache.close()
            }
            return true
          }),
        { executions: cliExecutions, seed: 20261220 }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("PackageRunner services (Shell.Serve), failing targets (--keep-going), dirty outputs, approval gating & diverse rule planning via CLI", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        approved: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, approved }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-bc4-rules-", async (root) => {
              await write(
                root,
                "WORKSPACE.ts",
                `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("rules-${slug}", {
  repository: "git+https://example.invalid/rules-${slug}.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["sh"] })
})
`
              )
              await write(root, "package.json", `{"name":"rules-${slug}","version":"0.1.0","private":true}\n`)
              await write(root, "yarn.lock", "# yarn\n")
              await write(root, "tsconfig.json", '{"compilerOptions":{"target":"ES2022","module":"NodeNext"}}\n')
              await write(root, "PROMPT.md", "# Check\n")
              await write(root, "src/index.ts", `export const v = "${slug}"\n`)
              await write(root, "src/index.test.ts", `export const t = 1\n`)
              await write(root, "Dockerfile", "FROM scratch\n")
              await write(root, "docker-bake.hcl", 'target "app" {}\n')
              await write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n')
              await write(root, "crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n')
              await write(root, "crates/a/src/lib.rs", "pub fn f() -> i32 { 1 }\n")
              await write(root, "go.mod", `module example.org/${slug}\n\ngo 1.24.0\n`)
              await write(root, "foundry.toml", "[profile.default]\n")
              await write(root, "rsbuild.config.mjs", "export default {}\n")
              await write(root, ".github/workflows/ci.yml", "name: ci\non: [push]\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n")

              await write(
                root,
                "PACKAGE.ts",
                `import { Smithers as S } from "@smthrs/targets"
const srv = S.Shell.Serve({
  bin: S.Runtime.bin,
  args: [
    "-e",
    "const http=require('node:http'); const s=http.createServer((q,r)=>{r.writeHead(200);r.end('ready-${slug}');}); s.listen(0,'127.0.0.1',()=>{const p=s.address().port; console.log('READY http://127.0.0.1:'+p);}); setInterval(()=>{},60000);"
  ],
})
const failTarget = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["-e", "console.error('intentional-${slug}'); process.exit(4)"]
})
const passTarget = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["-e", "console.log('ok-${slug}')"]
})
const gated = S.Shell.Run({
  bin: S.Runtime.bin,
  args: ["-e", "console.log('approved-${slug}')"],
  approval: "required"
})
const diffTarget = S.Shell.Diff({
  bin: S.Runtime.bin,
  args: ["-e", "console.log('diff')"],
  changes: ["src/index.ts"]
})
const llmLint = S.LlmLint({
  changes: S.gitDiff("HEAD"),
  include: [S.glob("src/**/*.ts")],
  deps: [],
  prompt: "Check",
  rubric: "Clean",
  model: "claude-sonnet-4",
  batchSize: 1
})
const agentLint = S.Agent.Lint({
  agent: S.Agent.ClaudeCode({ model: "claude-sonnet-4" }),
  prompt: S.file("PROMPT.md"),
  data: [S.glob("src/**/*.ts")]
})
const dockerBuild = S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: "." })
const dockerBake = S.Docker.Bake({ config: S.file("docker-bake.hcl"), target: "app" })
const cargoBuild = S.Cargo.Build({ workspace: true })
const cargoTest = S.Cargo.Test({ workspace: true })
const cargoFmt = S.Cargo.Fmt({ workspace: true })
const goPkgs = S.Go.Packages({ pkgs: ["./..."] })
const foundryBuild = S.Foundry.Build({ config: S.file("foundry.toml"), data: [S.glob("src/**/*.sol")], outDirs: ["out"] })
const wf = S.Github.Workflow({ name: "ci", on: { push: { branches: ["main"] } }, run: [passTarget] })
const pack = S.Npm.Pack({ manifest: S.file("package.json") })
export const Package = S.Package({
  targets: {
    srv,
    failTarget,
    passTarget,
    gated,
    diffTarget,
    llmLint,
    agentLint,
    dockerBuild,
    dockerBake,
    cargoBuild,
    cargoTest,
    cargoFmt,
    goPkgs,
    foundryBuild,
    wf,
    pack
  }
})
`
              )

              // Plan & inspect EVERY diverse rule flavor through PackagePlanner + Cli
              const t1 = await serve(root, ["targets", "//..."]); expect(t1.exitCode, t1.output + "\n" + t1.logs).toBe(0)
              expect((await serve(root, ["index", "//..."])).exitCode).toBe(0)
              expect((await serve(root, ["graph", "//..."])).exitCode).toBe(0)
              for (const lbl of ["//:dockerBuild", "//:dockerBake", "//:cargoBuild", "//:cargoFmt", "//:goPkgs", "//:foundryBuild", "//:wf", "//:pack", "//:llmLint", "//:agentLint", "//:diffTarget"]) {
                void (await serve(root, ["explain", lbl]))
                void (await serve(root, ["show", "target", lbl]))
              }

              // Failing target + --keep-going runs passTarget too
              const failRes = await serve(root, ["test", "//:failTarget", "//:passTarget"])
              expect(failRes.exitCode).not.toBe(0)
              expect((await serve(root, ["test", "//:passTarget"])).exitCode).toBe(0)

              // Approval-gated target (denied vs approved)
              const gateRes = await serve(root, ["run", "//:gated"], {
                approvals: {
                  granted: async () => approved
                }
              })
              if (approved) expect(gateRes.exitCode).toBe(0)
              else expect(gateRes.exitCode).not.toBe(0)
            })
            return true
          }),
        { executions: cliExecutions, seed: 20261221 }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("Cli init, error handling, invalid workspace/package diagnostics & cycle detection fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        errCase: Schema.Literals(["init", "unknown-label", "bad-package", "bad-workspace", "cycle", "unknown-cmd"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, errCase }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-bc4-err-", async (root) => {
              if (errCase === "init") {
                const initRes = await serve(root, ["init"])
                expect(typeof initRes.exitCode).toBe("number")
              } else if (errCase === "unknown-label") {
                await write(
                  root,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("e-${slug}", { repository: "git+https://example.invalid/e.git", cache: S.Cache({ directory: ".flows" }) })\n`
                )
                await write(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: {} })\n`)
                const r = await serve(root, ["build", `//:${slug}_missing`])
                expect(r.exitCode).not.toBe(0)
              } else if (errCase === "bad-package") {
                await write(
                  root,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("e-${slug}", { repository: "git+https://example.invalid/e.git", cache: S.Cache({ directory: ".flows" }) })\n`
                )
                await write(root, "PACKAGE.ts", `export const Package = { broken: true }\n`)
                const r = await serve(root, ["query", "//..."])
                expect(r.exitCode).not.toBe(0)
              } else if (errCase === "bad-workspace") {
                await write(root, "WORKSPACE.ts", `export const Workspace = "invalid"\n`)
                const r = await serve(root, ["query", "//..."])
                expect(r.exitCode).not.toBe(0)
              } else if (errCase === "cycle") {
                await write(
                  root,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("c-${slug}", { repository: "git+https://example.invalid/c.git", cache: S.Cache({ directory: ".flows" }) })\n`
                )
                await write(
                  root,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { a: S.Shell.Build({ shell: "echo a", deps: [S.label("//:b")] as never }), b: S.Shell.Build({ shell: "echo b", deps: [S.label("//:a")] as never }) } })\n`
                )
                const r = await serve(root, ["build", "//:a"])
                expect(r.exitCode).not.toBe(0)
              } else {
                await write(
                  root,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("u-${slug}", { repository: "git+https://example.invalid/u.git", cache: S.Cache({ directory: ".flows" }) })\n`
                )
                await write(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: {} })\n`)
                const r = await serve(root, ["--help"])
                expect(typeof r.exitCode).toBe("number")
              }
            })
            return true
          }),
        { executions: cliExecutions, seed: 20261222 }
      )
    )
    assertPassed(report)
  }, 180_000)
})
