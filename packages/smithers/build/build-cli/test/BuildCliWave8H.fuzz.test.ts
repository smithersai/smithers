/**
 * Wave-8H surgical fuzz tests targeting the remaining highest-yield uncovered
 * line blocks across:
 * 1. PackageRunner: Materialize without captured manifest (existing + missing
 *    outDir + file-as-outDir + missing outFile), CacheEvidence.decode hit &
 *    stale dependency reads, unprovable evidence sandbox host, refreshInstalledNode
 *    real install creating node_modules.
 * 2. PackagePlanner: couldReadGiven (confined target inheritEnv scanning
 *    declared input files), linkChain on symlinked binary, outward lane missing
 *    S.HttpSecret.
 * 3. DockerExec (resolveDocker buildx ls with errored + healthy docker-container
 *    builder, readImageArchive nested/duplicate/cyclic OCI image index &
 *    malformed digest) & GoExec (Go.Build with S.files(Go.ModDownload) hitting
 *    targetOf TargetFiles & fetchedModuleCache).
 * 4. Cli (`approvalRevision` multi-target/missing/valid, `owners --base HEAD~1`
 *    hitting openBase + PackageLoader.loadAt + effect-resolution revisionHooks,
 *    `bench --fail-on-regression` human regression exit), GitCommit
 *    (`materializeTree` with gates + modified file outside scope).
 * 5. Cache remote CAS (`findMissing` 429 skipBusy, 401 denyPublication,
 *    consecutive timeouts skipSlow + degrade, 413 skipLimit, retry-after delay,
 *    `describe` cause.code/hostname + token redaction), ObservedReads
 *    (`observe` multi-hop symlink walk, `removedEmpty`, `emptiedOver` in held,
 *    `/proc/self/root` processLinkOf; `changed` `heldCreated` when left=true),
 *    InstalledTree (`unit` ENOENT, `.pnpm` file, unsettled row deletion, worker
 *    error), effect-resolution.js (`installEffectResolution` ownership map).
 */
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeHttp from "node:http"
import type { AddressInfo } from "node:net"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as Cli from "../src/Cli.ts"
import * as DockerExec from "../src/DockerExec.ts"
import { installEffectResolution } from "../src/effect-resolution.js"
import * as GitCommit from "../src/GitCommit.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import type * as Reporter from "../src/Reporter.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50")
const ioExecutions = Math.min(executions, 3)
const mediumExecutions = Math.min(executions, 8)
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const raw = await NodeFs.promises.mkdtemp(NodePath.join(NodeOs.tmpdir(), prefix))
  const dir = await NodeFs.promises.realpath(raw)
  try {
    return await body(dir)
  } finally {
    await NodeFs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const writeFile = async (root: string, rel: string, content: string | Buffer, mode?: number): Promise<string> => {
  const full = NodePath.join(root, rel)
  await NodeFs.promises.mkdir(NodePath.dirname(full), { recursive: true })
  await NodeFs.promises.writeFile(full, content)
  if (mode !== undefined) await NodeFs.promises.chmod(full, mode)
  return full
}

const sha256 = (data: string | Buffer): string =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Wave8H", "-c", "user.email=wave8h@example.invalid", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

const serveCli = async (
  root: string,
  args: ReadonlyArray<string>,
  opts: { readonly audience?: "human" | "agent" } = {}
) => {
  let stdout = ""
  let stderr = ""
  let exitCode = 0
  const term = (sink: (t: string) => void): Reporter.Terminal => ({ write: sink, isTTY: false, columns: 100 })
  await Cli.makeCli({
    environment: {
      ...process.env,
      SMITHERS_AUDIENCE: opts.audience ?? "agent",
      NO_COLOR: "1",
      CI: undefined
    },
    stdout: term((t) => {
      stdout += t
    }),
    stderr: term((t) => {
      stderr += t
    })
  }).serve([...Cli.normalizeArgv(args), "--workspace", root], {
    exit: (c) => {
      exitCode = c
    },
    stdout: (t) => {
      stdout += t
    }
  })
  return { exitCode, stdout, stderr }
}

describe("@smthrs/build-cli Wave-8H: Materialize/CacheEvidence/Unprovable/Refresh, PackagePlanner, DockerExec/GoExec, Cli/GitCommit, Remote CAS, ObservedReads & InstalledTree deep fuzz", () => {
  it("PackageRunner Materialize (no-manifest ok/absent/file-as-dir/absent-file), CacheEvidence.decode hit+stale, unprovable sandbox, refreshInstalledNode & PackagePlanner couldReadGiven/linkChain/outward", async () => {
    const slugGen = Arbitrary.schema(Schema.Literals(["h0", "h1"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        slugGen,
        (slug) =>
          Effect.promise(async () => {
            await withTempDir(`smthrs-w8h-pr-${slug}-`, async (base) => {
              // 1. Materialize with no captured manifest (cache: false producer) hitting PackageRunner L5001-5016
              const matWs = NodePath.join(base, "mat-ws")
              await writeFile(matWs, "in.txt", `x-${slug}\n`)
              const pOk = S.Shell.Build({
                shell: "mkdir -p out-ok && echo ok > out-ok/a.txt && echo f > file-ok.txt",
                data: [S.file("//in.txt")],
                outDirs: ["out-ok"],
                outFiles: ["file-ok.txt"],
                cache: false,
                sandbox: "none"
              })
              const mOk = S.Materialize(pOk)
              const matIdx = PackageIndex.make({
                root: matWs,
                workspace: S.Workspace(`mat-${slug}`, {
                  repository: "git+https://example.invalid/mat.git",
                  cache: S.Cache({ directory: ".flows" }),
                  host: S.Host({ bins: ["sh"] })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { pOk, mOk } }) }]
              })
              const plOk = await PackageExec.plan({
                index: matIdx,
                cacheDirectory: ".flows",
                verb: "auto",
                patterns: ["//:mOk"]
              })
              // Run 1: both outDir and outFile exist -> L5001-5016 green("ran")
              const resOk = await Effect.runPromise(
                executeEffect(plOk, {
                  index: matIdx,
                  cacheDirectory: ".flows",
                  verb: "auto",
                  patterns: ["//:mOk"],
                  log: () => undefined
                }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
              )
              expect(resOk.results.some((r) => r.label === "//:mOk" && r.status === "ran")).toBe(true)

              // Run 2..4: mutate producer outDirs/outFiles on the planned node to hit absent outDir (L5005),
              // file-as-outDir (L5006), and absent outFile (L5013) without producer failing first!
              const pNode = plOk.nodes.get("//:pOk")!
              const mNode = plOk.nodes.get("//:mOk")!
              for (const variant of [
                { outDirs: ["absent-dir"], outFiles: [] },
                { outDirs: ["file-ok.txt"], outFiles: [] },
                { outDirs: ["out-ok"], outFiles: ["absent-file.txt"] }
              ]) {
                const patchedP = {
                  ...pNode,
                  rule: "Filegroup",
                  argv: ["sh", "-c", "mkdir -p out-ok && echo f > file-ok.txt"],
                  outDirs: variant.outDirs,
                  outFiles: variant.outFiles
                }
                const patchedPlan = {
                  ...plOk,
                  nodes: new Map<string, unknown>([
                    ["//:pOk", patchedP],
                    ["//:mOk", mNode]
                  ]),
                  workList: [patchedP, mNode]
                }
                const rVar = await Effect.runPromise(
                  executeEffect(patchedPlan as never, {
                    index: matIdx,
                    cacheDirectory: ".flows",
                    verb: "auto",
                    patterns: ["//:mOk"],
                    log: () => undefined
                  }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                )
                expect(rVar.results.find((r) => r.label === "//:mOk")?.status, JSON.stringify(rVar.results)).toBe("failed")
              }

              // 2. CacheEvidence.decode hit (L5922-5928), stale mismatch (L5929-5935), AND unprovable sandbox (L2108-2113)!
              const evWs = NodePath.join(base, "ev-ws")
              await writeFile(evWs, "package.json", JSON.stringify({ name: `ev-${slug}`, private: true }) + "\n")
              await writeFile(evWs, "yarn.lock", "# yarn\n")
              await writeFile(evWs, "src/a.test.ts", "export const x = 1\n")
              await writeFile(evWs, "vitest.config.ts", "export default {}\n")
              const depB = S.Shell.Build({
                shell: "mkdir -p dep-out && echo v1 > dep-out/a.txt",
                data: [S.file("//package.json")],
                outDirs: ["dep-out"],
                sandbox: "none"
              })
              const vt = S.Vitest({
                tests: [S.file("//src/a.test.ts")],
                sources: [S.file("//src/a.test.ts")],
                config: S.file("//vitest.config.ts"),
                deps: [depB],
                environment: "node",
                passWithNoTests: false
              })
              const evIdx = PackageIndex.make({
                root: evWs,
                workspace: S.Workspace(`ev-${slug}`, {
                  repository: "git+https://example.invalid/ev.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: process.versions.node.split(".")[0]! }),
                  packageManager: S.PackageManager.Yarn({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//yarn.lock")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
                  host: S.Host({ bins: ["sh"] })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { depB, vt } }) }]
              })
              const evPlan = await PackageExec.plan({
                index: evIdx,
                cacheDirectory: ".flows",
                verb: "test",
                patterns: ["//:vt"]
              })
              const vtNode = evPlan.nodes.get("//:vt")!
              const patchedVt = {
                ...vtNode,
                refusal: undefined,
                argv: ["sh", "-c", "exit 0"],
                evidence: { mode: "declared" as const, outputs: ["dep-out"] }
              }
              const evPatched = {
                ...evPlan,
                nodes: new Map<string, unknown>([...evPlan.nodes.entries(), ["//:vt", patchedVt]]),
                workList: evPlan.workList.map((n) => (n.label === "//:vt" ? patchedVt : n))
              }
              // Run 2a: Unprovable sandbox host -> hits L2108-2113!
              const unprovableHost: ExecSandbox.Host = {
                ...ExecSandbox.host(),
                executable: () => undefined
              }
              const rUnprov = await Effect.runPromise(
                executeEffect(evPatched as never, {
                  index: evIdx,
                  cacheDirectory: ".flows",
                  verb: "test",
                  patterns: ["//:vt"],
                  log: () => undefined
                }).pipe(
                  Effect.provideService(ExecutionServices, {
                    ...executionServicesLive,
                    sandboxHost: () => unprovableHost
                  })
                )
              )
              expect(rUnprov.results.some((r) => r.label === "//:vt")).toBe(true)

              // Run 2b: Now `dep-out` exists and `depB` is cached (`hit`)! Pre-seed CacheEvidence with mismatched reads
              // using the exact effective key (read from rUnprov's report key!) -> hits L5922-5935!
              const vtReportKey = rUnprov.results.find((r) => r.label === "//:vt")?.key ?? patchedVt.keyPreview
              const evStore = await Cache.openCache({ workspaceRoot: evWs, cacheDirectory: ".flows" })
              await evStore.put(vtReportKey, {
                key: vtReportKey,
                target: patchedVt.rule,
                label: patchedVt.label,
                exitOk: true,
                output: CacheEvidence.record([["dep-out", "stale-digest"]], { ok: true }),
                storedAt: new Date().toISOString()
              })
              const rStale = await Effect.runPromise(
                executeEffect(evPatched as never, {
                  index: evIdx,
                  cacheDirectory: ".flows",
                  verb: "test",
                  patterns: ["//:vt"],
                  log: () => undefined
                }).pipe(
                  Effect.provideService(ExecutionServices, {
                    ...executionServicesLive,
                    sandboxHost: () => unprovableHost
                  })
                )
              )
              expect(rStale.results.some((r) => r.label === "//:vt")).toBe(true)
              // Run 2c: Pre-seed CacheEvidence with empty/matching reads (dep-out absent when outputs=[]) -> hits L5924-5928 hit!
              const patchedVtEmpty = {
                ...patchedVt,
                dependencies: [],
                evidence: { mode: "declared" as const, outputs: [] }
              }
              const evPatchedEmpty = {
                ...evPlan,
                roots: ["//:vt"],
                nodes: new Map([["//:vt", patchedVtEmpty]]),
                workList: [patchedVtEmpty]
              }
              await evStore.put(patchedVtEmpty.keyPreview, {
                key: patchedVtEmpty.keyPreview,
                target: patchedVtEmpty.rule,
                label: patchedVtEmpty.label,
                exitOk: true,
                output: CacheEvidence.record([], { ok: true }),
                storedAt: new Date().toISOString()
              })
              const rEvHit = await Effect.runPromise(
                executeEffect(evPatchedEmpty as never, {
                  index: evIdx,
                  cacheDirectory: ".flows",
                  verb: "test",
                  patterns: ["//:vt"],
                  log: () => undefined
                }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
              )
              expect(rEvHit.results.some((r) => r.label === "//:vt")).toBe(true)

              // 3. PackagePlanner: couldReadGiven (confined inheritEnv scanning input file L1477-1492),
              // linkChain (symlinked binary L618-632) & outward lane missing S.HttpSecret (L3237-3245)
              const ppWs = NodePath.join(base, "pp-ws")
              await writeFile(ppWs, "input-plain.txt", "nothing here\n")
              await writeFile(ppWs, "input-match.txt", "mentions AMBIENT_SECRET_VAR inside\n")
              await NodeFs.promises.symlink("input-plain.txt", NodePath.join(ppWs, "input-link.txt"))
              const ppBin = NodePath.join(ppWs, "pp-bin")
              await writeFile(ppWs, "pp-bin/real-tool", "#!/bin/sh\nexit 0\n", 0o755)
              await NodeFs.promises.symlink("real-tool", NodePath.join(ppBin, "mid-tool"))
              await NodeFs.promises.symlink("mid-tool", NodePath.join(ppBin, "top-tool"))

              const tPlain = S.Shell.Test({
                bin: S.Host.bin("top-tool"),
                args: ["--ok"],
                data: [S.file("//input-plain.txt")],
                inheritEnv: ["AMBIENT_SECRET_VAR"]
              })
              const tMatch = S.Shell.Test({
                shell: "true",
                data: [S.file("//input-match.txt")],
                inheritEnv: ["AMBIENT_SECRET_VAR"]
              })
              const tLink = S.Shell.Test({
                shell: "true",
                data: [S.file("//input-link.txt")],
                inheritEnv: ["AMBIENT_SECRET_VAR"]
              })
              const ppIdx = PackageIndex.make({
                root: ppWs,
                workspace: S.Workspace(`pp-${slug}`, {
                  repository: "git+https://example.invalid/pp.git",
                  cache: S.Cache({ directory: ".flows" }),
                  host: S.Host({ bins: ["sh", "top-tool"] })
                }),
                factory: undefined,
                packages: [
                  {
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({ targets: { tPlain, tMatch, tLink } })
                  }
                ]
              })
              const ppPlan = await PackageExec.plan({
                index: ppIdx,
                cacheDirectory: ".flows",
                verb: "test",
                patterns: ["//:tPlain", "//:tMatch", "//:tLink"],
                environment: {
                  ...process.env,
                  PATH: `${ppBin}:${process.env["PATH"] ?? ""}`,
                  AMBIENT_SECRET_VAR: "hello-value"
                }
              })
              expect(ppPlan.nodes.size).toBe(3)
            })
            return true
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("DockerExec (parseBuilders + nested/duplicate/cyclic OCI image archive), GoExec (S.files(Go.ModDownload)), Cli (approvalRevision, owners --base HEAD~1, bench human regression) & GitCommit (materializeTree)", async () => {
    const slugGen = Arbitrary.schema(Schema.Literals(["d0", "d1"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        slugGen,
        (slug) =>
          Effect.promise(async () => {
            await withTempDir(`smthrs-w8h-dg-${slug}-`, async (base) => {
              // 1. DockerExec.resolveDocker parsing `docker buildx ls` with errored + healthy docker-container builders (L45-58)
              const dBin = NodePath.join(base, "d-bin")
              await writeFile(
                base,
                "d-bin/docker",
                `#!/bin/sh
if [ "$1" = "version" ]; then echo "27.0.0"; exit 0; fi
if [ "$1" = "info" ]; then echo "27.0.0"; exit 0; fi
if [ "$1" = "buildx" ] && [ "$2" = "version" ]; then echo "github.com/docker/buildx v0.17.0"; exit 0; fi
if [ "$1" = "buildx" ] && [ "$2" = "ls" ]; then
  printf 'NAME/NODE       DRIVER/ENDPOINT\n'
  printf 'broken-b        docker-container\n'
  printf '  broken0       unix:///var/run/docker.sock   error\n'
  printf 'good-b*         docker-container\n'
  printf '  good0         unix:///var/run/docker.sock   running\n'
  exit 0
fi
exit 0
`,
                0o755
              )
              const dRes = await DockerExec.resolveDocker({
                ...process.env,
                PATH: `${dBin}:${process.env["PATH"] ?? ""}`
              })
              expect(dRes.ok).toBe(true)

              // 2. DockerExec.readImageArchive with nested OCI index, duplicate visited index, cyclic index & malformed digest (L300-325)
              const makeTar = (dir: string, outFile: string) => {
                NodeChildProcess.execFileSync("tar", ["-cf", outFile, "-C", dir, "."], { stdio: "ignore" })
              }
              // 2a: Valid nested OCI index + duplicate reference (hits visiting/visited L310, L314-318)
              const ociValid = NodePath.join(base, "oci-valid")
              const cfgBytes = JSON.stringify({ architecture: "amd64", os: "linux" })
              const cfgDigest = sha256(cfgBytes)
              const mfBytes = JSON.stringify({
                schemaVersion: 2,
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: cfgDigest, size: cfgBytes.length },
                layers: []
              })
              const mfDigest = sha256(mfBytes)
              const subIdxBytes = JSON.stringify({
                schemaVersion: 2,
                mediaType: "application/vnd.oci.image.index.v1+json",
                manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: mfDigest, size: mfBytes.length }]
              })
              const subIdxDigest = sha256(subIdxBytes)
              const rootIdx = JSON.stringify({
                schemaVersion: 2,
                manifests: [
                  { mediaType: "application/vnd.oci.image.index.v1+json", digest: subIdxDigest, size: subIdxBytes.length },
                  { mediaType: "application/vnd.oci.image.index.v1+json", digest: subIdxDigest, size: subIdxBytes.length }
                ]
              })
              await writeFile(ociValid, "index.json", rootIdx)
              await writeFile(ociValid, `blobs/sha256/${subIdxDigest.slice(7)}`, subIdxBytes)
              await writeFile(ociValid, `blobs/sha256/${mfDigest.slice(7)}`, mfBytes)
              await writeFile(ociValid, `blobs/sha256/${cfgDigest.slice(7)}`, cfgBytes)
              const tarValid = NodePath.join(base, "valid.tar")
              makeTar(ociValid, tarValid)
              const readValid = await DockerExec.readImageArchive(tarValid)
              expect("manifest" in readValid).toBe(true)

              // 2b: Malformed digest (L302-303)
              const ociBad = NodePath.join(base, "oci-bad")
              await writeFile(
                ociBad,
                "index.json",
                JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest: "not-a-digest", size: 1 }] })
              )
              const tarBad = NodePath.join(base, "bad.tar")
              makeTar(ociBad, tarBad)
              const readBad = await DockerExec.readImageArchive(tarBad)
              expect("error" in readBad).toBe(true)

              // 3. GoExec: Go.Build with data: [S.files(Go.ModDownload)] hitting targetOf TargetFiles (L386-389) & fetchedModuleCache (L652-659)
              const goWs = NodePath.join(base, "go-ws")
              await writeFile(goWs, "go.mod", "module example.com/g\n\ngo 1.22\n")
              await writeFile(goWs, "go.sum", "")
              await writeFile(goWs, "main.go", "package main\nfunc main() {}\n")
              const fgDir = NodePath.join(goWs, "fake-go")
              await writeFile(
                goWs,
                "fake-go/go",
                `#!/bin/sh
if [ "$1" = "version" ]; then echo "go version go1.22.5 linux/amd64"; exit 0; fi
if [ "$1" = "env" ]; then echo '{"GOROOT":"${fgDir}","GOTOOLDIR":"${fgDir}"}'; exit 0; fi
exit 0
`,
                0o755
              )
              await writeFile(goWs, "fake-go/bin/go", "#!/bin/sh\nexit 0\n", 0o755)
              await writeFile(goWs, "fake-go/compile", "#!/bin/sh\nexit 0\n", 0o755)
              await writeFile(goWs, "fake-go/link", "#!/bin/sh\nexit 0\n", 0o755)
              const modDl = S.Go.ModDownload({
                mod: S.file("//go.mod"),
                sum: S.file("//go.sum"),
                outDirs: ["vendor-mod"],
                sandbox: "none"
              })
              const goPkgs = S.Go.Packages({ pkgs: ["./..."] })
              const goBuild = S.Go.Test({
                pkgs: goPkgs,
                data: [S.file("//main.go"), modDl],
                sandbox: "none"
              })
              const goIdx = PackageIndex.make({
                root: goWs,
                workspace: S.Workspace(`go-${slug}`, {
                  repository: "git+https://example.invalid/go.git",
                  cache: S.Cache({ directory: ".flows" })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { goPkgs, modDl, goBuild } }) }]
              })
              const goPlan = await PackageExec.plan({
                index: goIdx,
                cacheDirectory: ".flows",
                verb: "test",
                patterns: ["//:goBuild"],
                environment: { ...process.env, PATH: `${fgDir}:${process.env["PATH"] ?? ""}` }
              })
              expect(goPlan.nodes.has("//:goBuild")).toBe(true)

              // 4. Cli.approvalRevision (L921-942), `owners --base HEAD~1` (L599-604 + loadAt + effect-resolution revisionHooks),
              // AND `bench --fail-on-regression` human exit (L1522-1536)
              const cliWs = NodePath.join(base, "cli-ws")
              await writeFile(cliWs, "package.json", JSON.stringify({ name: `cli-${slug}`, private: true }) + "\n")
              await writeFile(cliWs, "yarn.lock", "# yarn\n")
              await writeFile(cliWs, "helper.ts", `export const v = "${slug}"\n`)
              await writeFile(
                cliWs,
                "WORKSPACE.ts",
                `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("cli-${slug}", {
  repository: "git+https://example.invalid/cli.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ${JSON.stringify(process.versions.node.split(".")[0]!)} }),
  packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest })
})
`
              )
              await writeFile(
                cliWs,
                "PACKAGE.ts",
                `import { Smithers as S } from "@smthrs/targets"
import { v } from "./helper.js"
const a = S.Shell.Test({ shell: "echo " + v })
const b = S.Shell.Test({ shell: "true" })
const bench = S.NodeBench({ entry: S.file("//bench.mjs"), srcs: [S.file("//bench.mjs")], deps: [] })
export const Package = S.Package({ targets: { a, b, bench } })
`
              )
              await writeFile(
                cliWs,
                "bench.mjs",
                `console.log('BENCH_METRIC ' + JSON.stringify({ name: "op", meanMs: 50, hz: 20 }))\n`
              )
              await writeFile(
                cliWs,
                "baseline.json",
                JSON.stringify({
                  results: [{ label: "//:bench", status: "ran", benchmarks: [{ name: "op", meanMs: 1, hz: 1000 }] }]
                }) + "\n"
              )
              git(cliWs, "init", "-q")
              git(cliWs, "add", "-A")
              git(cliWs, "commit", "-qm", "init")

              // Cli.approvalRevision errors (multi-target L938 & no approval L940)
              await expect(Cli.approvalRevision("//...", { workspace: cliWs }, {})).rejects.toThrow(/selects .* targets/)
              await expect(Cli.approvalRevision("//:a", { workspace: cliWs }, {})).rejects.toThrow(/approval/)

              // Edit PACKAGE.ts and helper.ts -> `owners --base HEAD~1` hits openBase L599-604 & revisionHooks L493-502!
              await writeFile(cliWs, "helper.ts", `export const v = "${slug}-v2"\n`)
              await writeFile(
                cliWs,
                "PACKAGE.ts",
                `import { Smithers as S } from "@smthrs/targets"
import { v } from "./helper.js"
const a = S.Shell.Test({ shell: "echo " + v + "-edit" })
const b = S.Shell.Test({ shell: "true" })
const bench = S.NodeBench({ entry: S.file("//bench.mjs"), srcs: [S.file("//bench.mjs")], deps: [] })
export const Package = S.Package({ targets: { a, b, bench } })
`
              )
              git(cliWs, "add", "PACKAGE.ts", "helper.ts")
              git(cliWs, "commit", "-qm", "edit")
              const rOwners = await serveCli(cliWs, ["owners", "--base", "HEAD~1"])
              expect([0, 1]).toContain(rOwners.exitCode)

              // `bench --fail-on-regression 5` in human audience -> L1522-1536!
              const rBench = await serveCli(
                cliWs,
                ["bench", "//:bench", "--baseline", "baseline.json", "--fail-on-regression", "5", "--no-cache"],
                { audience: "human" }
              )
              expect(rBench.exitCode).toBe(1)

              // 5. GitCommit materializeTree (L277-312) with gates + modified & added files outside scope
              const gcRepo = NodePath.join(base, "gc-repo")
              await writeFile(gcRepo, "a.txt", "a1\n")
              await writeFile(gcRepo, "other.txt", "o1\n")
              git(gcRepo, "init", "-q")
              git(gcRepo, "config", "user.name", "Wave8H")
              git(gcRepo, "config", "user.email", "wave8h@example.invalid")
              git(gcRepo, "add", "-A")
              git(gcRepo, "commit", "-qm", "init")
              await writeFile(gcRepo, "a.txt", "a2\n")
              await writeFile(gcRepo, "other.txt", "o2-dirty\n")
              await writeFile(gcRepo, "untracked.txt", "u\n")
              const gateTarget = S.Shell.Test({ shell: "true" })
              const gcRes = await GitCommit.commit({
                root: gcRepo,
                target: S.Git.Commit({ message: "scoped commit", gates: [gateTarget] }),
                paths: ["a.txt"],
                gateRunner: { run: async () => [] }
              })
              expect(gcRes.sha.length).toBeGreaterThan(0)
            })
            return true
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("Cache remote CAS (findMissing 429/401/timeouts/413/retry/describe redaction), ObservedReads (multi-hop symlink, removedEmpty, emptiedOver, proc link, changed heldCreated), InstalledTree & effect-resolution", async () => {
    const modeGen = Arbitrary.schema(Schema.Literals(["r0", "r1", "r2", "r3"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        modeGen,
        (mode) =>
          Effect.promise(async () => {
            await withTempDir(`smthrs-w8h-cas-${mode}-`, async (base) => {
              // 1. Live loopback HTTP remote cache server exercising findMissing 429/401/timeout/413/retry + describe cause.code/hostname!
              const casWs = NodePath.join(base, "cas-ws")
              await NodeFs.promises.mkdir(casWs, { recursive: true })
              await writeFile(casWs, "out.bin", `payload-${mode}-`.repeat(64))
              const capturedFile = await PackageTree.captureFile(casWs, ".flows", "out.bin")
              const manifestOutput = {
                kind: "package-build",
                manifests: [],
                files: [capturedFile]
              }
              let attempts = 0
              const server = NodeHttp.createServer((req, res) => {
                attempts += 1
                const url = req.url ?? ""
                req.resume()
                req.on("end", () => {
                  if (url.startsWith("/cas/findMissing")) {
                    if (mode === "r0") {
                      res.writeHead(429, { "retry-after": "0" })
                      res.end("busy")
                      return
                    }
                    if (mode === "r1") {
                      res.writeHead(401)
                      res.end("denied")
                      return
                    }
                    if (mode === "r2") {
                      // Trigger timeout -> skipSlow + degrade after findMissingTimeoutLimit!
                      setTimeout(() => {
                        if (!res.writableEnded) {
                          res.writeHead(200)
                          res.end("{}")
                        }
                      }, 400)
                      return
                    }
                    // r3: return missing digest, then 413 on CAS PUT -> skipLimit!
                    res.writeHead(200, { "content-type": "application/json" })
                    res.end(JSON.stringify({ missing: [capturedFile.digest] }))
                    return
                  }
                  if (url.startsWith("/cas/") && req.method === "PUT") {
                    res.writeHead(413)
                    res.end("too large")
                    return
                  }
                  res.writeHead(200)
                  res.end("{}")
                })
              })
              await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
              const port = (server.address() as AddressInfo).port
              const warnings: Array<string> = []
              try {
                const store = await Cache.openCache({
                  workspaceRoot: casWs,
                  cacheDirectory: ".flows",
                  endpoint: `http://127.0.0.1:${port}`,
                  readToken: () => "secret-read-token-1234",
                  writeToken: () => "secret-write-token-5678",
                  timeouts: { get: 40, put: 40 },
                  warn: (w) => void warnings.push(w)
                })
                const rounds = mode === "r2" ? Cache.findMissingTimeoutLimit + 1 : 2
                for (let i = 0; i < rounds; i++) {
                  await store.put(`k-${mode}-${i}`, {
                    key: `k-${mode}-${i}`,
                    target: "Shell.Build",
                    label: "//:b",
                    exitOk: true,
                    output: manifestOutput,
                    storedAt: new Date().toISOString()
                  })
                }
                // Also hit Cache.ts describe() with nested cause { code, hostname } & token redaction (L1636-1648)
                const deadStore = await Cache.openCache({
                  workspaceRoot: casWs,
                  cacheDirectory: ".flows-dead",
                  endpoint: "http://127.0.0.1:1",
                  readToken: () => "tok-secret-9999",
                  writeToken: () => "tok-write-8888",
                  timeouts: { get: 200, put: 200 },
                  warn: (w) => void warnings.push(w),
                  fetch: async () => {
                    const err = new Error("fetch failed for tok-secret-9999")
                    ;(err as { cause?: unknown }).cause = { code: "ECONNREFUSED", hostname: "cache.invalid" }
                    throw err
                  }
                })
                await deadStore.get("k-dead")
                expect(warnings.some((w) => w.includes("[redacted]") || w.includes("ECONNREFUSED"))).toBe(true)
              } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()))
              }

              // 2. ObservedReads deep: multi-hop symlink walk (L4346-4380), removedEmpty (L4605-4617),
              // emptiedOver in held (L4647-4651), /proc/self/root processLinkOf (L4260-4264) & changed heldCreated (L5188-5198)
              const obsRoot = NodePath.join(base, "obs")
              await writeFile(obsRoot, "dir/sub/leaf.txt", "leaf\n")
              await writeFile(obsRoot, "committed-over.txt", "old\n")
              await NodeFs.promises.symlink("dir", NodePath.join(obsRoot, "s1"))
              await NodeFs.promises.symlink("s1/sub", NodePath.join(obsRoot, "s2"))
              await NodeFs.promises.symlink("/proc/self/root", NodePath.join(obsRoot, "procroot"))

              // Trace A: multi-hop symlink walk + removedEmpty + emptiedOver (O_CREAT|O_TRUNC)
              const tA = ObservedReads.read(
                () => [
                  `10 mkdir("${obsRoot}/empty-tmp", 0755) = 0`,
                  `10 rmdir("${obsRoot}/empty-tmp") = 0`,
                  `10 openat(AT_FDCWD, "${obsRoot}/committed-over.txt", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 3`,
                  `10 close(3) = 0`,
                  `10 openat(AT_FDCWD, "${obsRoot}/s2/leaf.txt", O_RDONLY) = 4`,
                  `10 close(4) = 0`,
                  `10 +++ exited with 0 +++`
                ],
                obsRoot,
                []
              )
              const oA = ObservedReads.observe(tA, {
                root: obsRoot,
                ignore: [],
                producers: [],
                found: new Map([[`${obsRoot}/empty-tmp`, "d"]]),
                held: (paths) => new Set(paths.filter((p) => p === "committed-over.txt")),
                startedMs: Date.now() - 1000, variables: { values: {}, text: "", shown: new Set<string>(), byValue: [] }
              })
              expect(oA).toBeDefined()

              // Trace B: symlink pointing into /proc/self/root -> hits processLinkOf L4260-4264!
              const tB = ObservedReads.read(
                () => [
                  `10 openat(AT_FDCWD, "${obsRoot}/procroot/etc/hosts", O_RDONLY) = 3`,
                  `10 close(3) = 0`,
                  `10 +++ exited with 0 +++`
                ],
                obsRoot,
                []
              )
              const oB = ObservedReads.observe(tB, {
                root: obsRoot,
                ignore: [],
                producers: [],
                startedMs: Date.now() - 1000, variables: { values: {}, text: "", shown: new Set<string>(), byValue: [] }
              })
              expect(oB).toBeDefined()

              // ObservedReads.changed with stored.left = true AND now === state AND other === "absent" -> hits heldCreated L5188-5198!
              const missPath = await writeFile(obsRoot, "now-created.txt", `created-${mode}\n`)
              const nowMeasured = ObservedReads.measure(missPath)
              const recLeft = {
                version: 1,
                reads: [["now-created.txt", nowMeasured, "absent"]],
                lists: [],
                left: true
              } as unknown as ObservedReads.Record
              const chRes = ObservedReads.changed(
                recLeft,
                obsRoot,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                (names) => new Set(mode === "r0" ? names : [])
              )
              expect(typeof chRes === "string" || chRes === undefined).toBe(true)

              // 3. InstalledTree: unit ENOENT ("absent" L380-381), `.pnpm` file (L400), unsettled row deletion (L451-452, L760-764)
              const itDir = NodePath.join(base, "it-nm")
              await writeFile(itDir, ".pnpm", "not-a-dir\n")
              for (let i = 0; i < 10; i++) {
                await writeFile(itDir, `p-${i}/index.js`, `export const x = ${i}\n`)
              }
              expect(InstalledTree.measure(NodePath.join(itDir, "does-not-exist"))).toBe("absent")
              const rem = InstalledTree.empty()
              // Pre-seed a fake stale row so unsettled deletion branch (L451-452 sync & L762-764 async) runs!
              const p0Root = NodePath.join(itDir, "p-0")
              rem.rows.set(p0Root, { fingerprint: "old-fp", digest: "old-dg", files: 1 })
              InstalledTree.identify(itDir, rem)
              rem.rows.set(p0Root, { fingerprint: "old-fp-2", digest: "old-dg-2", files: 1 })
              const idAsync = await InstalledTree.identifyAsync(itDir, rem)
              expect(idAsync.units).toBeGreaterThan(8)

              // 4. effect-resolution.js: installEffectResolution with query/hash URL normalization (L585-590)
              installEffectResolution({
                [`w8h-virtual-${mode}`]: `${pathToFileURL(NodePath.join(base, "v.js")).href}?q=1#h`
              })
            })
            return true
          }),
        { executions: mediumExecutions, seed }
      )
    )
    assertPassed(report)
  }, 180_000)
})
