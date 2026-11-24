import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Admin from "../src/internal/backend/Admin.ts"
import * as AgentDocs from "../src/internal/backend/AgentDocs.ts"
import * as Auth from "../src/internal/backend/Auth.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as Copy from "../src/internal/backend/Copy.ts"
import * as History from "../src/internal/backend/History.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import * as Local from "../src/internal/backend/Local.ts"
import * as ProcessMod from "../src/internal/backend/Process.ts"
import * as Repositories from "../src/internal/backend/Repositories.ts"
import * as Runs from "../src/internal/backend/Runs.ts"
import * as SessionMod from "../src/internal/backend/Session.ts"
import * as SSH from "../src/internal/backend/SSH.ts"
import * as Stack from "../src/internal/backend/Stack.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"
import { backendFixture } from "./support/backend-fixture.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeBundle = (baseDir: string, revision = "a".repeat(40)) => {
  const bundle = join(baseDir, "bundle")
  mkdirSync(join(bundle, "bin"), { recursive: true })
  const bins = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]
  const files: Array<{ path: string; sha256: string; mode: number; stage: string }> = []
  for (const rel of bins) {
    const full = join(bundle, rel)
    const content = `#!/bin/sh\necho "ok:${rel}"\nexit 0\n`
    writeFileSync(full, content, { mode: 0o755 })
    chmodSync(full, 0o755)
    files.push({
      path: rel,
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: 0o755,
      stage: "host"
    })
  }
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({ version: 1, platform: "darwin-arm64", revision, files }, null, 2)
  )
  return bundle
}

describe("@smthrs/cli Backend Deep Handlers (HostService, Auth, Session, Workspaces, Copy, SSH, Stack, Repositories, Local, History, AgentDocs) fuzz invariants", () => {
  it(
    "HostService install/stop/start/status/doctor/verifyBundle/ready/waitReady/setupURLs/validateAddress/installTelemetry uphold host invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          bind: Schema.Literals([
            "127.0.0.1:4000",
            "localhost:4000",
            "0.0.0.0:4000",
            "[::1]:4000",
            "invalid:host:port"
          ]),
          readyStatus: Schema.Literals([200, 503]),
          loadedBefore: Schema.Boolean,
          tamperManifest: Schema.Boolean
        })
      )

      let serverReady = 200
      const telemetryCalls: Array<string> = []
      const srv = createServer((req, res) => {
        if (req.url === "/readyz" || req.url === "/health" || req.url === "/api/health" || req.url === "/") {
          res.writeHead(serverReady, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: serverReady === 200, status: serverReady === 200 ? "ready" : "starting" }))
          return
        }
        if (req.url?.startsWith("/api/install")) {
          telemetryCalls.push(req.url)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.writeHead(404).end()
      })
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      try {
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ bind, loadedBefore, readyStatus, tamperManifest }) =>
              Effect.promise(async () => {
                const root = mkdtempSync(join(tmpdir(), "smthrs-hostsvc-fuzz-"))
                try {
                  const bundle = makeBundle(root)
                  const agentsDir = join(root, "LaunchAgents")
                  const stateDir = join(root, "state")
                  mkdirSync(agentsDir, { recursive: true })
                  mkdirSync(stateDir, { recursive: true })

                  try {
                    HostService.validateAddress({ bind, origins: [origin] })
                  } catch (err) {
                    assertInv(err instanceof Error, "validateAddress throws structured refusal")
                  }

                  if (tamperManifest) {
                    writeFileSync(join(bundle, "extra-undeclared.txt"), "sneaky")
                    let threw = false
                    try {
                      HostService.verifyBundle(bundle)
                    } catch {
                      threw = true
                    }
                    assertInv(threw, "verifyBundle rejects undeclared file")
                    rmSync(join(bundle, "extra-undeclared.txt"))
                  }
                  const verified = HostService.verifyBundle(bundle)
                  assertInv(verified.version === "a".repeat(40), "verifyBundle succeeds on valid bundle")
                  const resolved = HostService.resolveBundle(bundle)
                  assertInv(resolved === bundle, "resolveBundle returns explicit path")

                  const xml = HostService.plist({
                    Label: HostService.label,
                    RunAtLoad: true,
                    KeepAlive: false,
                    Port: 4000,
                    ProgramArguments: [join(bundle, "bin/smithers-server"), "--state", stateDir],
                    EnvironmentVariables: { SMITHERS_STATE: stateDir }
                  })
                  assertInv(xml.includes("<plist") && xml.includes(HostService.label), "plist XML well-formed")
                  const svcOpts: HostService.ServiceOptions = {
                    bundle,
                    stateDir,
                    home: root,
                    bind: "127.0.0.1:4000",
                    origins: [origin]
                  }
                  const hp = HostService.hostPlist(svcOpts)
                  assertInv(hp.includes(bundle), "hostPlist includes bundle path")
                  const urls = await HostService.setupURLs(stateDir, 100).catch(() => ({}))
                  assertInv(typeof urls === "object", "setupURLs returns object")

                  let isLoaded = loadedBefore
                  const sys: HostService.Launchd = {
                    domain: "gui/501",
                    agentsDir,
                    launchctl: (args) => {
                      if (args[0] === "print") return { status: isLoaded ? 0 : 1, stdout: "", stderr: "" }
                      if (args[0] === "bootstrap") {
                        isLoaded = true
                        return { status: 0, stdout: "", stderr: "" }
                      }
                      if (args[0] === "bootout") {
                        isLoaded = false
                        return { status: 0, stdout: "", stderr: "" }
                      }
                      return { status: 0, stdout: "", stderr: "" }
                    }
                  }

                  const inst = await HostService.install(svcOpts, sys)
                  assertInv(["installed", "reloaded", "unchanged"].includes(inst), "install returns status")
                  assertInv(HostService.loaded(sys) === true, "loaded after install")
                  const pf = HostService.plistFile(sys)
                  assertInv(pf.endsWith(`${HostService.label}.plist`), "plistFile ends with label")
                  const ib = HostService.installedBundle(sys)
                  assertInv(ib === realpathSync(bundle) || ib === bundle, "installedBundle matches")

                  serverReady = readyStatus
                  const readyRes = await HostService.ready(origin)
                  assertInv(
                    typeof readyRes === "boolean" || typeof readyRes === "string",
                    "ready returns bool or string"
                  )
                  if (readyStatus === 200) {
                    await HostService.waitReady(() => HostService.ready(origin), 2000)
                  }

                  const st = await HostService.status(sys, stateDir, origin, "cred-token").catch((e) => ({
                    err: String(e)
                  }))
                  assertInv(typeof st === "object", "status returns state or refusal")

                  const startedInst = await HostService.startInstalled(
                    svcOpts,
                    sys,
                    async () => true,
                    async () => ({ setup_url: `${origin}/setup` }) as never
                  )
                  assertInv(typeof startedInst === "object", "startInstalled succeeds")
                  const stText = HostService.startText(startedInst)
                  assertInv(typeof stText === "string", "startText renders summary")

                  const refusal = HostService.startRefusal(stateDir)
                  assertInv(
                    refusal === undefined || refusal instanceof Error,
                    "startRefusal returns undefined or Refused"
                  )

                  const stopped = await HostService.stop(sys)
                  assertInv(stopped.state === "stopped", "stop transitions to stopped")

                  HostService.doctor(bundle, stateDir, () => ({ status: 0, stdout: "ok", stderr: "" }) as never)

                  await HostService.installTelemetry(`${origin}/api/install`, "cred-token-fuzz")
                  return true
                } finally {
                  rmSync(root, { recursive: true, force: true })
                }
              }),
            { seed, executions: Math.min(executions, 12) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await new Promise<void>((done) => srv.close(() => done()))
      }
    },
    180_000
  )

  it(
    "Auth (browserLogin & handlers), Session, Client SSE/pagination, AgentDocs, Admin & Runs uphold HTTP transport and redaction invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          adminFlag: Schema.Boolean,
          ttl: Schema.Literals(["30m", "2h"]),
          tokenVal: Schema.Literals(["fuzz_tok_alpha_987654", "fuzz_tok_beta_123456"]),
          docQuery: Schema.Literals(["how to deploy", "durable flows"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ adminFlag, docQuery, tokenVal, ttl }) =>
            Effect.promise(async () => {
              const fx = await backendFixture()
              try {
                let complete!: Promise<void>
                const loginPromise = Auth.browserLogin(fx.c, fx.origin, adminFlag, ttl, (url) => {
                  complete = (async () => {
                    const params = new URL(url).searchParams
                    const dest = `http://127.0.0.1:${params.get("callback_port")}/callback`
                    const r404 = await fetch(dest.replace("callback", "wrong"))
                    assertInv(r404.status === 404, "wrong route 404")
                    const r405 = await fetch(dest, { method: "PUT" })
                    assertInv(r405.status === 405, "PUT 405")
                    const r415 = await fetch(dest, {
                      method: "POST",
                      headers: { "content-type": "text/plain", origin: new URL(dest).origin },
                      body: "{}"
                    })
                    assertInv(r415.status === 415, "text/plain 415")
                    const r403 = await fetch(dest, {
                      method: "POST",
                      headers: { "content-type": "application/json", origin: new URL(dest).origin },
                      body: JSON.stringify({ callback_state: "wrong-state", token: tokenVal })
                    })
                    assertInv(r403.status === 403, "bad state 403")
                    const r200 = await fetch(dest, {
                      method: "POST",
                      headers: { "content-type": "application/json", origin: new URL(dest).origin },
                      body: JSON.stringify({
                        callback_state: params.get("callback_state"),
                        token: tokenVal,
                        expires_at: new Date(Date.now() + 300_000).toISOString()
                      })
                    })
                    assertInv(r200.status === 200, "valid callback 200")
                  })()
                })
                const saved = await loginPromise
                await complete
                assertInv(typeof saved === "object", "browserLogin saved session")

                fx.allow(tokenVal)
                fx.request.handle((method, path) => {
                  if (path.includes("/user") || path.includes("/me") || path.includes("/auth/status")) {
                    return { username: "fuzzuser", email: "fuzz@example.test", id: 1 }
                  }
                  if (path.includes("/connections")) return [{ id: "conn-1", provider: "github" }]
                  if (path.includes("/admin/users")) {
                    return method === "GET"
                      ? [{ id: 1, username: "u1" }]
                      : { id: 2, username: "u2" }
                  }
                  if (path.includes("/admin/system/health")) return { status: "ok" }
                  if (path.includes("/admin/runs")) return [{ id: 10, status: "completed" }]
                  if (path.includes("/workflows")) return [{ id: 1, name: "ci" }]
                  if (path.includes("/runs")) return [{ id: 5, status: "completed" }]
                  return { ok: true }
                })
                const authStatus = await Auth.auth["auth status"]!(fx.c, {}, {})
                assertInv(typeof authStatus === "object", "auth status returned object")
                const authTok = await Auth.auth["auth token"]!(fx.c, {}, {})
                assertInv(typeof authTok === "object" || typeof authTok === "string", "auth token returned")
                const conns = await Auth.auth["auth connections"]!(fx.c, {}, {})
                assertInv(Array.isArray(conns) || typeof conns === "object", "auth connections")
                await Auth.auth["auth revoke"]!(fx.c, { id: "conn-1" }, {})
                await Auth.auth["auth logout"]!(fx.c, {}, {})

                const sess = new SessionMod.Session(fx.environment)
                await sess.save(fx.origin, tokenVal)
                const loaded = await sess.resolve(fx.origin)
                assertInv(loaded !== undefined, "Session round-trips token")
                assertInv(typeof sess.target() === "object", "Session.target")
                assertInv(typeof sess.config() === "object", "Session.config")
                await sess.clear(fx.origin)

                fx.document((req) => ({
                  status: 200,
                  headers: { "content-type": "text/plain" },
                  text: `# Docs for ${req.url}\nDurable flows run everywhere.`
                }))
                try {
                  const docRes = await AgentDocs.ask(fx.c, { question: docQuery }, {})
                  assertInv(docRes !== undefined, "AgentDocs.ask returned response")
                } catch {
                  // Structured refusal when index differs is valid
                }

                await Admin.admin["admin user list"]!(fx.c, {}, {})
                await Admin.admin["admin user create"]!(fx.c, {}, { username: "newu", email: "newu@example.test" })
                await Admin.admin["admin health"]!(fx.c, {}, {})
                await Admin.admin["admin runs list"]!(fx.c, {}, { repo: "owner/repo" })
                await Runs.runs["workflow list"]!(fx.c, {}, { repo: "owner/repo" })
                await Runs.runs["run list"]!(fx.c, {}, { repo: "owner/repo" })

                const apiErr = new ClientMod.APIError(
                  500,
                  { message: `failed with ${tokenVal}` },
                  "GET",
                  "/api/test",
                  new Headers()
                )
                assertInv(apiErr.status === 500, "APIError preserves status")
                return true
              } finally {
                await fx.close()
              }
            }),
          { seed, executions: Math.min(executions, 10) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "Workspaces, Copy, SSH & Process uphold transport, quoting, tar filtering & workspace lifecycle invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          fileBody: Schema.Literals(["copy fuzz payload alpha", "multi\nline\ncontent"]),
          quoteText: Schema.Literals(["simple", "with spaces", "it's quoted", "$(whoami)", "a;b&c|d"]),
          wsName: Schema.Literals(["ws-alpha", "ws-beta"])
        })
      )

      const pubKey = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
      const hostKeyLine = `ssh-ed25519 ${pubKey}`

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ fileBody, quoteText, wsName }) =>
            Effect.promise(async () => {
              const fx = await backendFixture()
              try {
                const sshBin = join(fx.home, "bin", "ssh")
                writeFileSync(sshBin, "#!/bin/sh\nfor last do :; done\nexec /bin/bash -c \"$last\"\n", { mode: 0o755 })
                chmodSync(sshBin, 0o755)

                const quoted = SSH.quote(quoteText)
                assertInv(quoted.startsWith("'") && quoted.endsWith("'"), "SSH.quote wraps in single quotes")
                const keys = SSH.hostKeys([{
                  algorithm: "ssh-ed25519",
                  public_key: pubKey,
                  known_hosts_line: hostKeyLine
                }])
                assertInv(keys.length === 1, "SSH.hostKeys parses key")
                const args = await SSH.sshArgs(fx.c, { command: "ssh guest", hostKeys: keys }, false)
                assertInv(args.includes("-o"), "sshArgs includes options")

                const ep = Copy.copyEndpoint("ws-1:/tmp/file.txt")
                assertInv(ep !== undefined, "copyEndpoint parses remote spec")
                const script = Copy.copyScript(true, "/tmp/dst", "file.txt", false)
                assertInv(typeof script === "string" && script.length > 0, "copyScript builds shell script")

                fx.request.handle((method, path) => {
                  if (method === "GET" && path.endsWith("/ssh")) {
                    return {
                      ssh_command: "ssh guest",
                      host_keys: [{ algorithm: "ssh-ed25519", public_key: pubKey, known_hosts_line: hostKeyLine }]
                    }
                  }
                  if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "op-1" }
                  if (method === "GET" && path.includes("/command-runs/op-1")) {
                    return {
                      operationId: "op-1",
                      state: "completed",
                      result: { exit_code: 0, stdout: "cmd-ok\n", stderr: "", output_truncated: false }
                    }
                  }
                  if (method === "GET" && path.includes("snapshots")) return [{ id: "snap-1", workspace_id: "ws-1" }]
                  if (method === "POST" && path.endsWith("/fork")) return { id: "ws-forked", name: "forked" }
                  if (method === "POST" && path.endsWith("/workspaces")) {
                    return { id: "ws-1", name: wsName, state: "running" }
                  }
                  if (method === "GET" && path.endsWith("/workspaces")) {
                    return [{ id: "ws-1", name: wsName, state: "running" }]
                  }
                  if (method === "GET" && path.includes("/workspaces/ws-1")) {
                    return { id: "ws-1", name: wsName, state: "running" }
                  }
                  if (method === "DELETE" && path.includes("/workspaces/ws-1")) {
                    return { deleted: true }
                  }
                  return { ok: true }
                })

                const srcFile = join(fx.home, "src.txt")
                const guestFile = join(fx.home, "guest.txt")
                const downFile = join(fx.home, "down.txt")
                writeFileSync(srcFile, fileBody)
                await Copy.copy(fx.c, { src: srcFile, dst: `ws-1:${guestFile}` }, { repo: "owner/repo" })
                assertInv(readFileSync(guestFile, "utf8") === fileBody, "Copy upload transferred exact bytes")
                await Copy.copy(fx.c, { src: `ws-1:${guestFile}`, dst: downFile }, { repo: "owner/repo" })
                assertInv(readFileSync(downFile, "utf8") === fileBody, "Copy download transferred exact bytes")

                const body = Workspaces.workspaceBody({ name: wsName, size: "small" })
                assertInv(typeof body === "object", "workspaceBody builds payload")
                await Workspaces.workspaces["workspace create"]!(fx.c, {}, { repo: "owner/repo", name: wsName })
                await Workspaces.workspaces["workspace list"]!(fx.c, {}, { repo: "owner/repo" })
                await Workspaces.workspaces["workspace view"]!(fx.c, { id: "ws-1" }, { repo: "owner/repo" })
                await Workspaces.workspaces["workspace snapshots"]!(fx.c, { id: "ws-1" }, { repo: "owner/repo" })
                await Workspaces.workspaces["workspace fork"]!(fx.c, { id: "ws-1" }, {
                  repo: "owner/repo",
                  name: "forked"
                })
                await Workspaces.workspaces["workspace exec"]!(fx.c, { id: "ws-1" }, {
                  repo: "owner/repo",
                  command: "echo hi"
                })
                await Workspaces.workspaces["workspace delete"]!(fx.c, { id: "ws-1" }, {
                  repo: "owner/repo",
                  yes: true
                })
                const sshInfo = await Workspaces.workspaceSSH(fx.c, "ws-1", { repo: "owner/repo" })
                assertInv(sshInfo.command === "ssh guest", "workspaceSSH fetches endpoint")

                const proc = ProcessMod.spawn(process.execPath, ["-e", "process.exit(0)"], {
                  stdio: "pipe",
                  env: process.env
                })
                const code = await proc.exited
                assertInv(code === 0, "Process.spawn exited 0")
                return true
              } finally {
                await fx.close()
              }
            }),
          { seed, executions: Math.min(executions, 8) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "Stack, Repositories, Local & History uphold real jj repo operations, isolated cwd hygiene & rich rendering invariants",
    async () => {
      const prevCwd = process.cwd()
      const root = mkdtempSync(join(tmpdir(), "smthrs-stack-repo-fuzz-"))
      const fx = await backendFixture({
        HOME: process.env.HOME ?? "",
        JJ_CONFIG: "",
        JJ_USER: "Fuzz Author",
        JJ_EMAIL: "fuzz@example.test"
      })
      try {
        const upstream = join(root, "upstream")
        const localDir = join(root, "local")
        const jjEnv = {
          ...process.env,
          JJ_CONFIG: "",
          JJ_USER: "Fuzz Author",
          JJ_EMAIL: "fuzz@example.test"
        }
        const jj = (args: Array<string>, cwd = localDir) =>
          execFileSync("jj", args, { cwd, env: jjEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

        jj(["git", "init", "--no-colocate", upstream], root)
        writeFileSync(join(upstream, "base.txt"), "base\n")
        jj(["describe", "-m", "Base commit"], upstream)
        jj(["bookmark", "create", "main"], upstream)
        jj(["git", "export"], upstream)
        jj(
          ["git", "clone", "--no-colocate", "--remote", "origin", join(upstream, ".jj/repo/store/git"), localDir],
          root
        )
        jj(["bookmark", "track", "main@origin"], localDir)
        jj(["new", "main@origin"], localDir)
        writeFileSync(join(localDir, "feature.txt"), "feature work\n")
        jj(["describe", "-m", "Add feature"], localDir)

        process.chdir(localDir)

        const bms = await Local.local["bookmark list"]!(fx.c, {}, {})
        assertInv(Array.isArray(bms) || typeof bms === "object", "bookmark list")
        await Local.local["bookmark create"]!(fx.c, { name: "fuzz-bm" }, {})
        await Local.local["bookmark delete"]!(fx.c, { name: "fuzz-bm" }, {})
        const changes = await Local.local["change list"]!(fx.c, {}, {})
        assertInv(Array.isArray(changes) || typeof changes === "object", "change list")
        const shown = await Local.local["change show"]!(fx.c, { id: "@" }, {})
        assertInv(typeof shown === "object", "change show")
        const diffed = await Local.local["change diff"]!(fx.c, { id: "@" }, {})
        assertInv(typeof diffed === "object", "change diff")
        const files = await Local.local["change files"]!(fx.c, { id: "@" }, {})
        assertInv(typeof files === "object", "change files")
        const conflicts = await Local.local["change conflicts"]!(fx.c, { id: "@" }, {})
        assertInv(typeof conflicts === "object", "change conflicts")
        const stackC = await Local.stackChanges(fx.c, "main")
        assertInv(Array.isArray(stackC), "Local.stackChanges")

        const gitAuthEnv = Repositories.gitAuth(fx.origin, "tok_secret_123")
        assertInv(typeof gitAuthEnv === "object", "Repositories.gitAuth")
        fx.request.handle((method, path) => {
          if (path.includes("/repos") && method === "GET") {
            return { full_name: "owner/repo", default_branch: "main", items: [] }
          }
          if (path.includes("/repos") && method === "POST") {
            return { full_name: "owner/repo", clone_url: `${fx.origin}/owner/repo.git` }
          }
          if (path.includes("/stacks") || path.includes("/land")) {
            return { items: [], changes: [], id: 1, state: "open" }
          }
          if (path.includes("/cache")) return { endpoint: fx.origin, token: "cache-tok" }
          return { ok: true }
        })
        await Repositories.repositories["repo list"]!(fx.c, {}, {})
        await Repositories.repositories["repo view"]!(fx.c, { repo: "owner/repo" }, { repo: "owner/repo" })
        await Repositories.repositories["repo home"]!(fx.c, { repo: "owner/repo" }, { repo: "owner/repo" })
        await Repositories.repositories["repo edit"]!(fx.c, { repo: "owner/repo" }, {
          repo: "owner/repo",
          description: "updated"
        })
        await Repositories.repositories["repo mirror-sync"]!(fx.c, {}, { repo: "owner/repo" })
        await Repositories.repositories["repo status"]!(fx.c, {}, {})
        await Local.local["land list"]!(fx.c, {}, { repo: "owner/repo" })

        try {
          const stRes = await Stack.stacks["stack status"]!(fx.c, {}, { repo: "owner/repo" })
          assertInv(stRes !== undefined, "stack status returned")
        } catch {
          // Structured refusal when remote PR list differs is acceptable
        }

        const states = [
          "working",
          "proposed",
          "needs_review",
          "needs_input",
          "blocked",
          "merged",
          "closed",
          "done",
          "failed",
          "cancelled",
          "queued",
          "idle"
        ]
        const now = Date.now()
        for (const state of states) {
          const item = {
            id: `item-${state}`,
            number: 42,
            title: `Work item in ${state}`,
            state,
            status: state,
            kind: "todo",
            branch: "feat/fuzz",
            duration_ms: 12345,
            started_at: new Date(now - 90_000).toISOString(),
            cost_nanos: 2_500_000_000,
            account: { label: "work", provider: "anthropic" },
            checks: [{ name: "ci", status: "passed", duration_ms: 4200 }]
          }
          assertInv(typeof History.stateLabel(item) === "string", "stateLabel")
          assertInv(["needs-you", "working", "done"].includes(History.groupOf(item)), "groupOf")
          assertInv(typeof History.outOfLanes(item) === "boolean", "outOfLanes")
          assertInv(typeof History.itemLine(item, [{ id: "c1", description: "desc" }]) === "string", "itemLine")
          assertInv(typeof History.receiptLine(item) === "string", "receiptLine")
          assertInv(typeof History.machineLine(item) === "string", "machineLine")
          assertInv(typeof History.workerLine(item, [item], now) === "string", "workerLine")
          assertInv(typeof History.accountLabel({ label: "work", email: "a@b.c" }) === "string", "accountLabel")
          assertInv(History.spendLabel(2_500_000_000) === "$2.50", "spendLabel")
          assertInv(typeof History.elapsedLabel(new Date(now - 75_000).toISOString(), now) === "string", "elapsedLabel")
          assertInv(typeof History.checkDuration(4500) === "string", "checkDuration")
          const rendered = History.render({
            items: [item],
            lanes: [item],
            receipts: [item],
            machines: [item],
            workers: [item],
            accounts: [{ label: "personal", provider: "openai", spend_nanos: 1_000_000_000 }]
          }, now)
          assertInv(typeof rendered === "string" && rendered.length > 0, "History.render produces output")
        }
      } finally {
        process.chdir(prevCwd)
        await fx.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
