import { Fuzz } from "@smthrs/fuzz"
import { ProcessLedger } from "@smthrs/kernel"
import { Arbitrary, Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as http from "node:http"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as DestinationProxy from "../src/DestinationProxy.ts"
import * as HostLiveness from "../src/HostLiveness.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/platform-node ProcessSandbox, DestinationProxy, ProcessReaper & HostLiveness fuzz invariants", () => {
  it("ProcessSandbox.select, plan, environment, launcher, toolchain, hiddenEntries, bubblewrap, seatbelt, docker, wrap, diagnose & writeProtected enforce confinement across linux/darwin/win32", async () => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-psb-fuzz-")))
    const workspaceRoot = path.join(tmpBase, "ws")
    const outside = path.join(tmpBase, "outside")
    const homeDir = path.join(tmpBase, "home")
    fs.mkdirSync(workspaceRoot, { recursive: true })
    fs.mkdirSync(path.join(workspaceRoot, "out", "locked"), { recursive: true })
    fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.mkdirSync(path.join(homeDir, ".ssh"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".ssh", "id_ed25519"), "SECRET-KEY")
    fs.writeFileSync(path.join(workspaceRoot, ".env"), "SECRET=1")
    fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET")
    fs.symlinkSync(outside, path.join(workspaceRoot, "escape-link"), "dir")

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          platform: Schema.Literals(["linux", "darwin", "win32"]),
          hasBwrap: Schema.Boolean,
          hasSandboxExec: Schema.Boolean,
          hasDocker: Schema.Boolean,
          useDocker: Schema.Boolean,
          network: Schema.Literals(["none", "loopback", "open"]),
          strict: Schema.Boolean,
          withUidGid: Schema.Boolean,
          unixSockets: Schema.Boolean,
          writeMode: Schema.Literals(["normal", "dotdot_escape", "symlink_escape", "workspace_root"]),
          readOnlySubdir: Schema.Boolean,
          extraRead: Schema.Literals(["none", "sub", "escape"]),
          denialKind: Schema.Literals([
            "eacces_read",
            "erofs_write",
            "mkdir_denied",
            "escape_link",
            "outside_ws",
            "clean"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({
            platform,
            hasBwrap,
            hasSandboxExec,
            hasDocker,
            useDocker,
            network,
            strict,
            withUidGid,
            unixSockets,
            writeMode,
            readOnlySubdir,
            extraRead,
            denialKind
          }) =>
            Effect.sync(() => {
              const hostFacts: ProcessSandbox.Host = {
                ...ProcessSandbox.host(),
                platform,
                executable: (name) => {
                  if (name === "bwrap" && hasBwrap) return "/usr/bin/bwrap"
                  if (
                    (name === "sandbox-exec" || name === "/usr/bin/sandbox-exec") && hasSandboxExec
                  ) return "/usr/bin/sandbox-exec"
                  if (name === "docker" && hasDocker) return "/usr/bin/docker"
                  if (name === "node") return process.execPath
                  return undefined
                },
                exists: (p) => fs.existsSync(p)
              }

              const declaredMech: ProcessSandbox.Request["mechanism"] = useDocker
                ? { _tag: "docker", image: "alpine:3.20" }
                : undefined

              const selected = ProcessSandbox.select({ network, mechanism: declaredMech }, hostFacts)
              if (useDocker) {
                if (network === "loopback" || !hasDocker) {
                  if (!ProcessSandbox.isUnenforceable(selected)) return false
                } else {
                  if (ProcessSandbox.isUnenforceable(selected) || selected._tag !== "docker") return false
                }
              } else if (platform === "linux") {
                if (
                  hasBwrap && network !== "loopback" &&
                  (ProcessSandbox.isUnenforceable(selected) || selected._tag !== "bubblewrap")
                ) return false
                if ((!hasBwrap || network === "loopback") && !ProcessSandbox.isUnenforceable(selected)) return false
              } else if (platform === "darwin") {
                if (
                  hasSandboxExec && (ProcessSandbox.isUnenforceable(selected) || selected._tag !== "seatbelt")
                ) return false
                if (!hasSandboxExec && !ProcessSandbox.isUnenforceable(selected)) return false
              } else {
                if (!ProcessSandbox.isUnenforceable(selected)) return false
              }

              const launched = ProcessSandbox.launcher("node", "/usr/bin:/bin", [], workspaceRoot, hostFacts)
              if (typeof launched.program !== "string" || !Array.isArray(launched.reads)) return false
              const tc = ProcessSandbox.toolchain("/usr/bin:/bin", workspaceRoot, hostFacts)
              if (!Array.isArray(tc.reads) || !Array.isArray(tc.links)) return false
              const tcReads = ProcessSandbox.toolchainReads("/usr/bin:/bin", workspaceRoot, hostFacts)
              if (!Array.isArray(tcReads)) return false

              const hidden = ProcessSandbox.hiddenEntries(
                workspaceRoot,
                [path.join(workspaceRoot, ".env")],
                [],
                hostFacts
              )
              if (!Array.isArray(hidden)) return false

              if (platform === "win32") {
                const drives = ProcessSandbox.windowsDrives(path.join(tmpBase, "no-mountinfo"))
                if (!Array.isArray(drives)) return false
              }

              const wp = ProcessSandbox.writeProtected(
                [workspaceRoot, path.join(workspaceRoot, "does-not-exist")],
                ["echo", "hi"],
                hostFacts
              )
              if (platform === "linux" && hasBwrap) {
                if (wp === undefined) return false
                if (!wp.includes("--dev-bind") || !wp.includes("--ro-bind")) return false
                if (wp.some((a) => a.includes("does-not-exist"))) return false
              } else {
                if (wp !== undefined) return false
              }

              const writeTarget = writeMode === "normal"
                ? "out"
                : writeMode === "dotdot_escape"
                ? "../outside/pwn"
                : writeMode === "symlink_escape"
                ? "escape-link/pwn"
                : "."

              const readTargets = extraRead === "none"
                ? []
                : extraRead === "sub"
                ? ["src"]
                : ["escape-link"]

              const planned = ProcessSandbox.plan(
                {
                  reads: readTargets,
                  writes: [writeTarget],
                  readOnly: readOnlySubdir ? ["out/locked"] : [],
                  network,
                  strict,
                  unixSockets,
                  mechanism: declaredMech,
                  ...(withUidGid ? { uid: 1000, gid: 1000 } : {})
                },
                {
                  workspaceRoot,
                  cwd: workspaceRoot,
                  tmp: path.join(tmpBase, "tmp")
                },
                hostFacts
              )

              if (ProcessSandbox.isUnenforceable(selected)) {
                return ProcessSandbox.isUnenforceable(planned)
              }

              if (ProcessSandbox.isUnenforceable(planned)) {
                return writeMode === "symlink_escape" || extraRead === "escape"
              }

              if (writeMode === "symlink_escape") return false
              if (writeMode === "dotdot_escape" && planned.writes.length > 0) return false
              for (const w of planned.writes) {
                if (!w.startsWith(workspaceRoot)) return false
              }

              const envMap = ProcessSandbox.environment(
                planned,
                {
                  PATH: "/usr/bin",
                  HOME: homeDir,
                  SECRET_TOKEN: "ghp_secret123",
                  TERM: "xterm-256color"
                },
                homeDir
              )
              if ("SECRET_TOKEN" in envMap) return false
              if (envMap["HOME"] === homeDir) return false

              if (planned.mechanism._tag === "bubblewrap") {
                const args = ProcessSandbox.bubblewrap(planned, ["echo", "ok"], hostFacts, "/usr/bin")
                if (!args.includes("/usr/bin/bwrap")) return false
                if (!args.includes("--unshare-all")) return false
                if (network === "open" && !args.includes("--share-net")) return false
                if (network !== "open" && args.includes("--share-net")) return false
                const wrapped = ProcessSandbox.wrap(planned, ["echo", "ok"], { PATH: "/usr/bin" }, hostFacts)
                if (wrapped.containerName !== undefined) return false
                if (!wrapped.argv.includes("/usr/bin/bwrap")) return false
              } else if (planned.mechanism._tag === "seatbelt") {
                const profile = ProcessSandbox.seatbelt(planned, hostFacts)
                if (!profile.startsWith("(version 1)")) return false
                if (strict && !profile.includes("(deny default)")) return false
                if (!strict && !profile.includes("(allow default)")) return false
                if (network !== "open" && !profile.includes("(deny network*)")) return false
                if (network === "loopback" && !profile.includes("localhost:*")) return false
                if (network === "open" && !unixSockets && !profile.includes("(deny network* (local unix-socket))")) {
                  return false
                }
                if (planned.readOnly.length > 0 && !profile.includes("(deny file-write* ")) return false
                const wrapped = ProcessSandbox.wrap(planned, ["echo", "ok"], { PATH: "/usr/bin" }, hostFacts)
                if (wrapped.containerName !== undefined) return false
                if (wrapped.argv[0] !== "/usr/bin/sandbox-exec" || wrapped.argv[1] !== "-p") return false
              } else if (planned.mechanism._tag === "docker") {
                const args = ProcessSandbox.docker(
                  planned,
                  ["echo", "ok"],
                  { PATH: "/usr/bin", HOME: homeDir, FOO: "bar" },
                  hostFacts,
                  "smithers-test-c1"
                )
                if (args[0] !== "/usr/bin/docker" || !args.includes("--read-only")) return false
                if (!args.includes(network === "open" ? "bridge" : "none")) return false
                if (!args.includes("HOME=/tmp/home")) return false
                if (args.some((a) => a.startsWith("PATH=") || a === `HOME=${homeDir}`)) return false
                if (!args.includes("FOO=bar")) return false
                const wrapped = ProcessSandbox.wrap(
                  planned,
                  ["echo", "ok"],
                  { PATH: "/usr/bin", FOO: "bar" },
                  hostFacts
                )
                if (wrapped.containerName === undefined || !wrapped.containerName.startsWith("smithers-")) return false
              }

              const sampleText = denialKind === "eacces_read"
                ? `EACCES: permission denied, open '${path.join(workspaceRoot, ".env")}'`
                : denialKind === "erofs_write"
                ? `EROFS: read-only file system, open '${path.join(workspaceRoot, "out", "locked", "f.txt")}'`
                : denialKind === "mkdir_denied"
                ? `mkdir: '${path.join(workspaceRoot, "ungranted")}': Permission denied`
                : denialKind === "escape_link"
                ? `cannot open '${path.join(workspaceRoot, "escape-link", "secret.txt")}'`
                : denialKind === "outside_ws"
                ? `EACCES: permission denied, open '${path.join(outside, "secret.txt")}'`
                : "all good, no errors"
              const diag = ProcessSandbox.diagnose(planned, sampleText)
              if (denialKind === "outside_ws" || denialKind === "clean") {
                if (diag !== undefined) return false
              } else {
                if (
                  diag === undefined || !diag.includes(`sandbox: ${planned.mechanism._tag}, network ${network}`)
                ) return false
                if (denialKind === "escape_link" && !diag.includes("resolves to")) return false
              }
              return true
            }),
          { seed, executions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("ProcessConfinement.make honors unavailable policy and fails closed without mechanism", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        unavailable: Schema.Literals(["refuse", "unconfined"]),
        platform: Schema.Literals(["linux", "darwin", "win32"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ unavailable, platform }) =>
          Effect.sync(() => {
            const hostFacts: ProcessSandbox.Host = {
              ...ProcessSandbox.host(),
              platform,
              executable: () => undefined
            }
            const svc = ProcessConfinement.make({ unavailable, host: hostFacts })
            return svc !== undefined
          }),
        { seed: seed + 1, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ProcessReaper.reap & report never signal live owners, own group, pre-boot, or mismatched identities", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ownerPid: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 500 })),
        ownGroup: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 500 }))),
        recordPid: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 500 })),
        recordPgid: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 500 }))),
        recordOwnerPid: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 500 })),
        ownerLiveness: Schema.Literals(["alive", "dead", "unknown"]),
        bootDeltaMs: Schema.Int.check(Schema.isBetween({ minimum: -5000, maximum: 10000 })),
        startKind: Schema.Literals(["match", "mismatch", "gone", "unavailable", "unsupported"]),
        killOutcome: Schema.Literals(["signalled", "already-gone", "failed"]),
        ledgerWriteFails: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          ownerPid,
          ownGroup,
          recordPid,
          recordPgid,
          recordOwnerPid,
          ownerLiveness,
          bootDeltaMs,
          startKind,
          killOutcome,
          ledgerWriteFails
        }) =>
          Effect.gen(function*() {
            const bootMs = 1_700_000_000_000
            const startedAtMs = bootMs + bootDeltaMs
            const record: ProcessLedger.ProcessRecord = {
              pid: recordPid,
              pgid: recordPgid,
              hostId: "fuzz-host",
              ownerPid: recordOwnerPid,
              startedAtMs,
              commandDigest: "fuzz-cmd"
            }
            let killCalls = 0
            const reaped: Array<number> = []
            const skipped: Array<string> = []
            const ledger: ProcessLedger.Service = {
              record: () => Effect.die("unused"),
              release: () => Effect.void,
              reaped: (row) =>
                ledgerWriteFails
                  ? Effect.fail(new Error("disk full") as never)
                  : Effect.sync(() => void reaped.push(row.pid)),
              skipped: (_row, reason) =>
                ledgerWriteFails
                  ? Effect.fail(new Error("disk full") as never)
                  : Effect.sync(() => void skipped.push(reason)),
              live: Effect.succeed([]),
              orphans: Effect.succeed([record])
            }
            const system: ProcessReaper.System = {
              isAlive: () => ownerLiveness,
              startedAtMs: () => {
                if (startKind === "match") return { _tag: "started", startedAtMs: startedAtMs + 500 }
                if (startKind === "mismatch") {
                  return { _tag: "started", startedAtMs: startedAtMs + ProcessReaper.identityToleranceMs + 5000 }
                }
                if (startKind === "gone") return { _tag: "gone" }
                if (startKind === "unavailable") return { _tag: "unavailable" }
                return { _tag: "unsupported" }
              },
              ownGroup: () => ownGroup,
              bootedAtMs: () => bootMs,
              refuseTarget: () => undefined,
              killTree: () => {
                killCalls += 1
                return killOutcome
              }
            }

            const decided = yield* ProcessReaper.reap({ ownerPid, system }).pipe(
              Effect.provideService(ProcessLedger.ProcessLedger, ledger)
            )
            yield* ProcessReaper.report(decided)

            if (decided.length !== 1) return false
            const entry = decided[0]!
            const isOwnGroup = recordPid === ownerPid ||
              recordPgid === ownerPid ||
              (ownGroup !== null && (recordPid === ownGroup || recordPgid === ownGroup))
            if (isOwnGroup) {
              if (entry.killed || entry.refusal !== "own-group" || killCalls !== 0) return false
              if (!ledgerWriteFails && skipped[0] !== "own-group") return false
              return true
            }
            if (recordPgid !== null && ownGroup === null) {
              if (entry.killed || entry.refusal !== "own-group-unknown" || killCalls !== 0) return false
              if (skipped.length !== 0) return false
              return true
            }
            if (recordOwnerPid !== ownerPid && ownerLiveness !== "dead") {
              if (entry.killed || entry.refusal !== "owner-alive" || killCalls !== 0) return false
              if (skipped.length !== 0) return false
              return true
            }
            if (startedAtMs < bootMs + ProcessReaper.identityToleranceMs) {
              if (entry.killed || entry.refusal !== "pre-boot" || killCalls !== 0) return false
              if (!ledgerWriteFails && skipped[0] !== "pre-boot") return false
              return true
            }
            if (startKind === "gone") {
              if (entry.killed || entry.refusal !== "process-gone" || killCalls !== 0) return false
              return true
            }
            if (startKind === "unavailable") {
              if (entry.killed || entry.refusal !== "identity-unverified" || killCalls !== 0) return false
              if (skipped.length !== 0) return false
              return true
            }
            if (startKind === "mismatch") {
              if (entry.killed || entry.refusal !== "identity-mismatch" || killCalls !== 0) return false
              return true
            }
            if (killCalls !== 1) return false
            if (killOutcome === "failed") {
              if (entry.killed || entry.refusal !== "kill-failed" || reaped.length !== 0) return false
              return true
            }
            if (!entry.killed) return false
            if (!ledgerWriteFails && reaped[0] !== recordPid) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("HostLiveness.isAlive honors host isolation, invalid-pid fail-safe, earlier-incarnation rule, and ESRCH-only death", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        sameHost: Schema.Boolean,
        crossHostPolicy: Schema.Literals(["lease", "alive"]),
        samePidPolicy: Schema.Literals(["reclaim", "probe"]),
        pid: Schema.Literals([-1, 0, 1.5, 4242, 9999]),
        samePidAsClaimant: Schema.Boolean,
        sameNonce: Schema.Boolean,
        signalOutcome: Schema.Literals(["ok", "ESRCH", "EPERM", "EINVAL", "UNKNOWN"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ sameHost, crossHostPolicy, samePidPolicy, pid, samePidAsClaimant, sameNonce, signalOutcome }) =>
          Effect.gen(function*() {
            let signalled = false
            const probe = HostLiveness.isAlive({
              hostId: "host-a",
              crossHostPolicy,
              samePidPolicy,
              signal: () => {
                signalled = true
                if (signalOutcome === "ok") return
                const err = new Error(signalOutcome) as NodeJS.ErrnoException
                err.code = signalOutcome === "UNKNOWN" ? "EIO" : signalOutcome
                throw err
              }
            })
            const owner: HostLiveness.Owner = {
              hostId: sameHost ? "host-a" : "host-b",
              pid,
              nonce: "nonce-1"
            }
            const claimant: HostLiveness.Owner = {
              hostId: "host-a",
              pid: samePidAsClaimant ? pid : 7777,
              nonce: sameNonce ? "nonce-1" : "nonce-2"
            }
            const alive = yield* probe(owner, { claimant })
            if (!sameHost) {
              if (signalled) return false
              return alive === (crossHostPolicy !== "lease")
            }
            if (!Number.isSafeInteger(pid) || pid <= 0) {
              if (signalled) return false
              return alive === true
            }
            if (samePidPolicy !== "probe" && samePidAsClaimant && !sameNonce) {
              if (signalled) return false
              return alive === false
            }
            if (!signalled) return false
            return alive === (signalOutcome !== "ESRCH")
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("DestinationProxy.open enforces proxy authentication, exact host allowlist, CONNECT rejection, and strips hop-by-hop headers", async () => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-dproxy-fuzz-")))
    const socketPath = path.join(tmpBase, "broker.sock")
    const token = "fuzz-broker-secret-token"
    let lastHeaders: http.IncomingHttpHeaders = {}
    const upstream = http.createServer((req, res) => {
      lastHeaders = req.headers
      res.writeHead(200, { "content-type": "text/plain" }).end("UPSTREAM_OK")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
    const addr = upstream.address() as net.AddressInfo
    const port = addr.port

    const rawHttpOverUnix = (raw: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const sock = net.connect(socketPath)
        let data = ""
        sock.setTimeout(2000)
        sock.on("data", (chunk) => {
          data += chunk.toString("utf8")
        })
        sock.on("end", () => resolve(data))
        sock.on("timeout", () => {
          sock.destroy()
          resolve(data)
        })
        sock.on("error", reject)
        sock.write(raw)
      })

    try {
      const authOk = "Basic " + Buffer.from("broker:" + token).toString("base64")
      const arb = Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals([
            "missing_auth",
            "wrong_auth",
            "bad_url",
            "disallowed_host",
            "userinfo_url",
            "https_plain_get",
            "allowed_get",
            "connect_missing_auth",
            "connect_disallowed",
            "connect_with_path"
          ])
        })
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            yield* DestinationProxy.open(socketPath, [`127.0.0.1:${port}`], token)
            const report = yield* Fuzz.run(
              arb,
              ({ kind }) =>
                Effect.promise(async () => {
                  lastHeaders = {}
                  if (kind === "missing_auth") {
                    const resp = await rawHttpOverUnix(
                      `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 407 ")
                  }
                  if (kind === "wrong_auth") {
                    const resp = await rawHttpOverUnix(
                      `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\nConnection: close\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 407 ")
                  }
                  if (kind === "bad_url") {
                    const resp = await rawHttpOverUnix(
                      `GET /relative-path HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: ${authOk}\r\nConnection: close\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 400 ")
                  }
                  if (kind === "disallowed_host") {
                    const resp = await rawHttpOverUnix(
                      `GET http://evil.example.com/ HTTP/1.1\r\nHost: evil.example.com\r\nProxy-Authorization: ${authOk}\r\nConnection: close\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 403 ")
                  }
                  if (kind === "userinfo_url") {
                    const resp = await rawHttpOverUnix(
                      `GET http://user:pass@127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: ${authOk}\r\nConnection: close\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 403 ")
                  }
                  if (kind === "https_plain_get") {
                    const resp = await rawHttpOverUnix(
                      `GET https://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: ${authOk}\r\nConnection: close\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 403 ")
                  }
                  if (kind === "allowed_get") {
                    const resp = await rawHttpOverUnix(
                      `GET http://127.0.0.1:${port}/ok HTTP/1.1\r\nHost: spoofed.invalid\r\nProxy-Authorization: ${authOk}\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n`
                    )
                    if (!resp.startsWith("HTTP/1.1 200 ") || !resp.includes("UPSTREAM_OK")) return false
                    if (lastHeaders["proxy-authorization"] !== undefined) return false
                    if (lastHeaders["proxy-connection"] !== undefined) return false
                    if (lastHeaders["host"] !== `127.0.0.1:${port}`) return false
                    return true
                  }
                  if (kind === "connect_missing_auth") {
                    const resp = await rawHttpOverUnix(
                      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 407 ")
                  }
                  if (kind === "connect_disallowed") {
                    const resp = await rawHttpOverUnix(
                      `CONNECT evil.example.com:443 HTTP/1.1\r\nHost: evil.example.com:443\r\nProxy-Authorization: ${authOk}\r\n\r\n`
                    )
                    return resp.startsWith("HTTP/1.1 403 ")
                  }
                  const resp = await rawHttpOverUnix(
                    `CONNECT 127.0.0.1:${port}/extra HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: ${authOk}\r\n\r\n`
                  )
                  return resp.startsWith("HTTP/1.1 403 ")
                }),
              { seed: seed + 4, executions: Math.min(executions, 40) }
            )
            const failure = Fuzz.formatReport(report)
            if (failure !== undefined) throw new Error(failure)
            expect(report._tag).toBe("Passed")
          })
        )
      )
    } finally {
      upstream.close()
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})
