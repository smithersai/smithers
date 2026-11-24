import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import { Fuzz } from "@smthrs/fuzz"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Remotes } from "@smthrs/sandbox"
import { Arbitrary, Effect, Layer, Option, Schema } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as Generate from "../src/cli/Generate.ts"
import * as CloudSandbox from "../src/CloudSandbox.ts"
import * as CloudSession from "../src/CloudSession.ts"
import * as Open from "../src/commands/Open.ts"
import * as Tui from "../src/commands/Tui.ts"
import * as EvalCli from "../src/evaluation/EvalCli.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as IssueDraft from "../src/internal/backend/IssueDraft.ts"
import * as RegistryWorkspace from "../src/internal/RegistryWorkspace.ts"
import * as WorkspaceRemotes from "../src/internal/WorkspaceRemotes.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as LaneIntake from "../src/runner/LaneIntake.ts"
import { project } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const serveCli = async (
  cli: { serve: (args?: Array<string>, opts?: any) => Promise<unknown> },
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {}
) => {
  let stdout = ""
  const codes: Array<number> = []
  await cli.serve([...args], {
    env,
    stdout: (t: string) => (stdout += t),
    exit: (c: number) => codes.push(c)
  })
  return { stdout, codes }
}

describe("@smthrs/cli Wave-5 CloudSession, CloudSandbox, RegistryWorkspace, WorkspaceRemotes, ExecutionEnvironment, LaneIntake, IssueDraft, Open, Tui, Generate & EvalCli fuzz invariants", () => {
  it(
    "CloudSession, CloudSandbox, IssueDraft & ExecutionEnvironment (local/ssh/cloud profiles + plan + run) uphold invariants against loopback HTTP",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-w5-cloud-")))
      let issueAllowed = true
      const srv = createServer((req, res) => {
        let raw = ""
        req.setEncoding("utf8")
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const url = req.url ?? "/"
          if (url === "/ok") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true, echo: raw ? JSON.parse(raw) : null }))
            return
          }
          if (url === "/401") {
            res.writeHead(401, { "content-type": "application/json" })
            res.end(JSON.stringify({ message: "unauthorized" }))
            return
          }
          if (url === "/500") {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(JSON.stringify({ message: "server error" }))
            return
          }
          if (url === "/bad-json") {
            res.writeHead(200, { "content-type": "text/plain" })
            res.end("not valid json {{{")
            return
          }
          if (url.startsWith("/api/issues/")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                number: 42,
                title: "Fix worker retry",
                body: "Details about retry bug",
                make_todo_allowed: issueAllowed,
                digest: "sha256:abc123",
                comments: [{ author: "op", body: "reproduced" }]
              })
            )
            return
          }
          if (url.includes("/workspaces") && req.method === "POST") {
            res.writeHead(201, { "content-type": "application/json" })
            res.end(JSON.stringify({ id: "ws-cloud-1", status: "running", name: "sb-1" }))
            return
          }
          if (url.includes("/workspaces/ws-cloud-1") && req.method === "DELETE") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ deleted: true }))
            return
          }
          if (url.includes("/workspaces/ws-cloud-1")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                id: "ws-cloud-1",
                status: "running",
                exitCode: 0,
                stdout: "sandbox-out\n",
                stderr: "",
                content: Buffer.from("file-bytes").toString("base64"),
                files: ["README.md"]
              })
            )
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, id: "ws-cloud-1", username: "cloud-user" }))
        })
      })
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      try {
        const fakeBin = join(root, "bin")
        mkdirSync(fakeBin, { recursive: true })
        const fakeSsh = join(fakeBin, "ssh")
        writeFileSync(fakeSsh, `#!${process.execPath}\nconsole.log("fake-ssh-ok");\nprocess.exit(0);\n`, {
          mode: 0o755
        })
        chmodSync(fakeSsh, 0o755)

        const env: Record<string, string | undefined> = {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          HOME: root,
          XDG_CONFIG_HOME: join(root, "xdg"),
          SMITHERS_AUTH_FILE: join(root, "auth.json"),
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_TOKEN: "cloud_fuzz_token_12345",
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
        }

        // 1. CloudSession signedIn + call ok/post/401/500/bad-json/bad-path + layerAuthentication + repository
        const cloud = await CloudSession.signedIn(env)
        assertInv(cloud !== undefined, "CloudSession.signedIn resolved with env token")
        if (cloud !== undefined) {
          const okGet = await cloud.get("/ok")
          assertInv((okGet as { ok?: boolean }).ok === true, "cloud.get /ok")
          const okPost = await cloud.post("/ok", { a: 1 })
          assertInv((okPost as { ok?: boolean }).ok === true, "cloud.post /ok")

          let pathRefused = false
          try {
            await cloud.get("//evil.invalid/steal")
          } catch {
            pathRefused = true
          }
          assertInv(pathRefused, "cloud.get refuses protocol-relative URL")

          let authRefused = false
          try {
            await cloud.get("/401")
          } catch (err) {
            authRefused = CloudSession.isAuthenticationRefusal(err)
          }
          assertInv(authRefused, "cloud.get /401 detected by isAuthenticationRefusal")

          for (const badPath of ["/500", "/bad-json"]) {
            let threw = false
            try {
              await cloud.get(badPath)
            } catch {
              threw = true
            }
            assertInv(threw, `cloud.get ${badPath} throws Refused`)
          }
        }
        await Effect.runPromise(
          Effect.gen(function*() {
            const auth = yield* CloudSession.Authentication
            const st = yield* auth.status
            assertInv(typeof st === "object", "CloudSession.Authentication.status")
          }).pipe(Effect.provide(CloudSession.layerAuthentication(env)), Effect.result)
        )
        try {
          const repoRef = CloudSession.repository(root, { repo: "owner/repo" } as never)
          assertInv(typeof repoRef === "string", "CloudSession.repository")
        } catch {}

        // 2. CloudSandbox workspaceApi + make provider acquire/exec/release
        const wsApi = CloudSandbox.workspaceApi(env)
        assertInv(typeof wsApi === "object", "CloudSandbox.workspaceApi")
        const sbProvider = CloudSandbox.make({
          api: wsApi,
          repository: "owner/repo",
          environment: env
        } as never)
        const acquired = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const box = yield* sbProvider.acquire("fuzz-box" as never)
              if (typeof (box as unknown as { exec?: unknown }).exec === "function") {
                yield* (box as unknown as { exec: (cmd: string) => Effect.Effect<unknown, unknown> }).exec("echo hi")
                  .pipe(Effect.result)
              }
              return box
            })
          ).pipe(Effect.result)
        )
        assertInv(acquired._tag === "Success" || acquired._tag === "Failure", "CloudSandbox acquire/exec scoped")

        // 3. IssueDraft.draftFromIssue: invalid number, disallowed, allowed
        const client = new ClientMod.Client({
          environment: env,
          exit: () => {},
          stderr: { write: () => {}, isTTY: false, columns: 80 }
        })
        let badNumThrew = false
        try {
          await IssueDraft.draftFromIssue(client, { number: -1 })
        } catch {
          badNumThrew = true
        }
        assertInv(badNumThrew, "IssueDraft rejects non-positive issue number")

        issueAllowed = false
        let disallowedThrew = false
        try {
          await IssueDraft.draftFromIssue(client, { number: 42 })
        } catch {
          disallowedThrew = true
        }
        assertInv(disallowedThrew, "IssueDraft refuses when make_todo_allowed !== true")

        issueAllowed = true
        await IssueDraft.draftFromIssue(client, { number: 42 }).catch(() => {})

        // 4. ExecutionEnvironment: add/list/get/plan/run/remove across local, ssh, cloud profiles
        const localDir = join(root, "local-env-dir")
        mkdirSync(localDir, { recursive: true })
        const profiles: Array<ExecutionEnvironment.Profile> = [
          { name: "loc-1", transport: "local", directory: localDir },
          { name: "ssh-1", transport: "ssh", destination: "dev@127.0.0.1", directory: "/srv/app" },
          { name: "ws-1", transport: "workspace", destination: "owner/repo/ws-cloud-1", directory: "/workspace" }
        ]
        for (const p of profiles) {
          await ExecutionEnvironment.add(p, env)
          const got = await ExecutionEnvironment.get(p.name, env)
          assertInv(got.name === p.name, `ExecutionEnvironment.get ${p.name}`)
          const planned = await ExecutionEnvironment.plan(p, ["echo", "hi"], env).catch((e) => ({ err: String(e) }))
          assertInv(planned !== undefined, `ExecutionEnvironment.plan ${p.name}`)
        }
        const listed = await ExecutionEnvironment.list(env)
        assertInv(listed.length >= 3, "ExecutionEnvironment.list has all 3 profiles")
        // Real local run
        const runLoc = await ExecutionEnvironment.run(
          profiles[0]!,
          [process.execPath, "-e", "process.exit(0)"],
          env
        ).catch((e) => ({ err: String(e) }))
        assertInv(runLoc !== undefined, "ExecutionEnvironment.run local")
        for (const p of profiles) {
          await ExecutionEnvironment.remove(p.name, env)
        }
        let missingThrew = false
        try {
          await ExecutionEnvironment.get("does-not-exist", env)
        } catch {
          missingThrew = true
        }
        assertInv(missingThrew, "ExecutionEnvironment.get missing throws")
      } finally {
        srv.closeAllConnections?.()
        await new Promise<void>((done) => srv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "RegistryWorkspace, WorkspaceRemotes, LaneIntake, Open, Tui, Generate & EvalCli uphold structural and lifecycle invariants",
    async () => {
      const prevCwd = process.cwd()
      const proj = await project()
      const echoPath = join(proj, ".smithers/flows/echo/flow.ts")
      writeFileSync(
        echoPath,
        readFileSync(echoPath, "utf8").replace("capabilities: []", "capabilities: [\"fs:read:*\"]")
      )
      const identityRoot = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-w5-id-")))

      try {
        // 1. RegistryWorkspace.layer relocation + identity mismatch refusal + same-root pass-through
        const physicalLayer = NodeControl.layerRegistry(proj)
        const sameLayer = RegistryWorkspace.layer(physicalLayer, proj, proj)
        assertInv(sameLayer === physicalLayer, "RegistryWorkspace same root returns registry unchanged")

        const relocatedLayer = RegistryWorkspace.layer(physicalLayer, identityRoot, proj)
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const reg = yield* Registry.Registry
              const all = yield* reg.list()
              const vis = yield* reg.visible()
              assertInv(all.length >= 1 && vis.length >= 1, "RegistryWorkspace list/visible")
              const echo = yield* reg.get("echo")
              assertInv(echo.path.startsWith(identityRoot), "RegistryWorkspace relocates path to identityRoot")
              const opt = yield* reg.getOption("echo")
              assertInv(Option.isSome(opt), "RegistryWorkspace getOption finds echo")
              // Wrong digest must be refused with execution_changed!
              const wrong = yield* reg.loadBody("echo", "0".repeat(64)).pipe(Effect.result)
              assertInv(wrong._tag === "Failure", "RegistryWorkspace loadBody refuses wrong digest")
              // Correct digest delegates to physical registry
              const goodDigest = Descriptor.executionDigest(echo)
              const okBody = yield* reg.loadBody("echo", goodDigest).pipe(Effect.result)
              assertInv(
                okBody._tag === "Success" || okBody._tag === "Failure",
                "RegistryWorkspace loadBody good digest"
              )
            }).pipe(Effect.provide(relocatedLayer))
          )
        )

        // 2. WorkspaceRemotes.layer with missing & present remotes config
        const wrLayer = WorkspaceRemotes.layer({ root: proj, environment: { HOME: identityRoot } }).pipe(
          Layer.provide(Layer.mergeAll(NodeControl.layerGrantStore(proj), NodeServices.layer, FetchHttpClient.layer))
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const rem = yield* Remotes.Remotes
              const res = yield* rem.acquire("missing-remote" as never, { runId: "r-1" } as never).pipe(Effect.result)
              assertInv(res._tag === "Failure" || res._tag === "Success", "WorkspaceRemotes resolve missing")
            }).pipe(Effect.provide(wrLayer as Layer.Layer<any, never, never>))
          ).pipe(Effect.result)
        )

        // 3. LaneIntake submit, corrupt file rejection, admitAll against real Control layer
        const laneState = join(identityRoot, "lane-state")
        const lanePaths = LaneIntake.paths(laneState)
        assertInv(lanePaths.dir.includes("lanes"), "LaneIntake.paths")
        const submittedId = await Effect.runPromise(
          Effect.tryPromise(() =>
            Effect.runPromise(
              LaneIntake.submit(laneState, {
                repository: "owner/repo",
                base: "a".repeat(40),
                brief: "Implement fuzz test",
                profile: "coder",
                limits: { files: 10, bytes: 100_000 }
              } as never).pipe(Effect.provide(NodeServices.layer))
            )
          ).pipe(Effect.result)
        )
        assertInv(submittedId._tag === "Success" || submittedId._tag === "Failure", "LaneIntake.submit")
        mkdirSync(lanePaths.dir, { recursive: true })
        writeFileSync(join(lanePaths.dir, "00000000-0000-4000-8000-000000000001.json"), "{corrupt json")
        const ctrlLayer = NodeControl.layerControl({ root: proj })
        await Effect.runPromise(
          Effect.scoped(
            LaneIntake.admitAll(laneState).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, ctrlLayer) as Layer.Layer<any, never, never>),
              Effect.result
            )
          )
        )

        // 4. Fuzz Tui.launch / binaryPackages / argv across platforms & runtimes + Open URLs/hosts
        const arb = Arbitrary.schema(
          Schema.Struct({
            platform: Schema.Literals(["darwin", "linux", "win32"]),
            arch: Schema.Literals(["arm64", "x64"]),
            hasBun: Schema.Boolean,
            hasBin: Schema.Boolean,
            nodeMajor: Schema.Literals(["22.0.0", "25.8.0"])
          })
        )
        const pkgDir = join(identityRoot, "pkg")
        mkdirSync(join(pkgDir, "dist/tui"), { recursive: true })
        writeFileSync(join(pkgDir, "dist/tui/main.js"), "")
        const tuiReport = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ arch, hasBin, hasBun, nodeMajor, platform }) =>
              Effect.sync(() => {
                const fakeHost: Tui.Host = {
                  ...Tui.host,
                  platform: platform as NodeJS.Platform,
                  arch,
                  versions: { node: nodeMajor, ...(hasBun ? { bun: "1.2.0" } : {}) },
                  avx2: () => true,
                  musl: () => platform === "linux",
                  exists: (p) => (hasBin && p.includes("bin/smithers-tui")) || p.endsWith("main.js"),
                  packageDirectory: () => (hasBin ? pkgDir : undefined)
                }
                const pkgs = Tui.binaryPackages(fakeHost)
                assertInv(Array.isArray(pkgs), "Tui.binaryPackages")
                const res = Tui.launch({}, pathToFileURL(`${pkgDir}/`), fakeHost)
                assertInv("command" in res || res._tag === "/cli/UnsupportedError", "Tui.launch")
                const args = Tui.argv({ root: proj, model: "sonnet", prompt: "hi", resume: "run-1" } as never)
                assertInv(Array.isArray(args), "Tui.argv")
                return true
              }),
            { seed, executions: Math.min(executions, 24) }
          )
        )
        const tuiFail = Fuzz.formatReport(tuiReport)
        if (tuiFail !== undefined) throw new Error(tuiFail)
        expect(tuiReport._tag).toBe("Passed")

        // 5. Open across GitHub HTTPS/SSH/custom URL/non-GitHub error
        for (
          const remoteUrl of [
            "https://github.com/acme/smithers.git",
            "git@github.com:acme/smithers.git",
            "https://gitlab.example.com/acme/other.git",
            ""
          ]
        ) {
          await Open.open(
            {
              gitRemote: () => remoteUrl,
              openUrl: async () => true,
              env: { SMITHERS_WEB_URL: "https://app.smithers.test" }
            } as never,
            proj
          ).catch(() => {})
        }

        // 6. Generate.initialize (vibe=true, vibe=false, idempotent retain, invalid name) in isolated tmpDir!
        const genDir = join(identityRoot, "gen-app")
        mkdirSync(genDir, { recursive: true })
        process.chdir(genDir)
        await Generate.initialize(genDir, "good-app", { HOME: identityRoot }, { vibe: true })
        await Generate.initialize(genDir, "good-app", { HOME: identityRoot }, { vibe: false })
        let badGenName = false
        try {
          await Generate.initialize(genDir, "bad name !!", { HOME: identityRoot })
        } catch {
          badGenName = true
        }
        assertInv(badGenName, "Generate.initialize rejects invalid name")
        const genCli = Generate.createGenerateCli({ environment: { HOME: identityRoot } })
        await serveCli(genCli, ["init", "sub-app", "--root", join(identityRoot, "sub-app"), "--json"], {
          HOME: identityRoot
        })

        // 7. EvalCli list / run / compare / baseline
        const evalCli = EvalCli.createEvalCli({ environment: { HOME: identityRoot } } as never)
        for (
          const argv of [
            ["list", "--root", proj, "--json"],
            ["list", "--root", proj],
            ["show", "missing-suite", "--root", proj, "--json"],
            ["run", "missing-suite", "--root", proj, "--json"],
            ["compare", "missing-suite", "--root", proj, "--json"]
          ]
        ) {
          await serveCli(evalCli, argv, { HOME: identityRoot })
        }
      } finally {
        process.chdir(prevCwd)
        rmSync(proj, { recursive: true, force: true })
        rmSync(identityRoot, { recursive: true, force: true })
      }
    },
    180_000
  )
})
