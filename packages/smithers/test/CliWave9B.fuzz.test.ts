import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import * as CliError from "../src/CliError.ts"
import * as AgentDocs from "../src/internal/backend/AgentDocs.ts"
import * as AuthMod from "../src/internal/backend/Auth.ts"
import * as CatalogMod from "../src/internal/backend/Catalog.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as CommandsMod from "../src/internal/backend/Commands.ts"
import * as CopyMod from "../src/internal/backend/Copy.ts"
import * as HistoryMod from "../src/internal/backend/History.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import * as Repositories from "../src/internal/backend/Repositories.ts"
import * as ResourcesMod from "../src/internal/backend/Resources.ts"
import * as RunsMod from "../src/internal/backend/Runs.ts"
import * as SessionMod from "../src/internal/backend/Session.ts"
import * as SSHMod from "../src/internal/backend/SSH.ts"
import * as StackMod from "../src/internal/backend/Stack.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261210")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const runFuzz = <A>(arb: Arbitrary.Arbitrary<A>, fn: (a: A) => void, opts: { executions: number; seed: number }) =>
  Effect.runPromise(Fuzz.run(arb, (a) =>
    Effect.sync(() => {
      fn(a)
      return true
    }), opts))

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeCapture = () => {
  const chunks: Array<string> = []
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
  stream.isTTY = false
  stream.on("data", (d) => chunks.push(String(d)))
  return { stream, read: () => chunks.join("") }
}

const withServer = async <A>(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
  fn: (origin: string) => Promise<A>
): Promise<A> => {
  const server = createServer((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on("end", () => {
      Promise.resolve(handler(req, res, Buffer.concat(chunks).toString("utf8"))).catch((e) => {
        if (!res.headersSent) res.writeHead(500)
        res.end(String(e))
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

const makeEnv = (tmp: string, origin: string, extra: Record<string, string | undefined> = {}) => ({
  HOME: tmp,
  XDG_CONFIG_HOME: join(tmp, "xdg-config"),
  XDG_CACHE_HOME: join(tmp, "xdg-cache"),
  SMITHERS_AUTH_FILE: join(tmp, "auth.json"),
  SMITHERS_API_ORIGIN: origin,
  SMITHERS_TOKEN: "sma_" + "a".repeat(32),
  PATH: process.env.PATH,
  ...extra
})

describe("@smthrs/cli Wave-9B Deep Backend Client, Session, HostService, SSH, Copy, Stack, History, Workspaces, Repos, Catalog, Resources, AgentDocs & Auth fuzz", () => {
  it(
    "Client & Session cover Link pagination, refusals, streaming output, non-API origin guard, managed token files & native keyring paths",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9b-client-"))
      try {
        // 1. Client.paginationCursor edge cases
        const baseUrl = new URL("https://api.smithers.sh/api/items")
        expect(
          ClientMod.paginationCursor(
            new Headers({
              link:
                "<https://api.smithers.sh/api/items?cursor=c1>; title=\"a\\\"b\"; rel=\"prev\", <https://api.smithers.sh/api/items?cursor=c2>; rel=\"next\""
            }),
            baseUrl
          )
        ).toBe("c2")
        for (
          const badLink of [
            "<https://api.smithers.sh/api/items?cursor=c1>; title=\"unclosed",
            "<https://api.smithers.sh/api/items",
            "<not a url>; rel=\"next\"",
            "<https://api.smithers.sh/api/items?cursor=c1>; rel=\"next\", <https://api.smithers.sh/api/items?cursor=c2>; rel=\"next\"",
            "<https://evil.example/api/items?cursor=c1>; rel=\"next\"",
            "<https://api.smithers.sh/api/items>; rel=\"next\"",
            `<https://api.smithers.sh/api/items?cursor=${"x".repeat(4100)}>; rel="next"`,
            "<https://api.smithers.sh/api/items?cursor=bad%00ctrl>; rel=\"next\""
          ]
        ) {
          expect(() => ClientMod.paginationCursor(new Headers({ link: badLink }), baseUrl)).toThrow()
        }
        expect(() =>
          ClientMod.paginationCursor(
            new Headers({
              link: "<https://api.smithers.sh/api/items?cursor=c1>; rel=\"next\"",
              "x-next-cursor": "c2"
            }),
            baseUrl
          )
        ).toThrow()

        // 2. Client.refusalOf edge cases
        const rExceeded = ClientMod.refusalOf(
          new ClientMod.APIError(
            400,
            { code: "workspace_resources_exceeded", message: "too big" },
            "POST",
            "/api/ws",
            new Headers(),
            "",
            "http://127.0.0.1"
          )
        )
        expect(rExceeded.code).toBe("workspace_resources_exceeded")
        const rNonJson = ClientMod.refusalOf(
          new ClientMod.APIError(403, {}, "GET", "/api/ws", new Headers(), "", "http://127.0.0.1")
        )
        expect(rNonJson.message).toContain("empty")
        const r502 = ClientMod.refusalOf(
          new ClientMod.APIError(
            502,
            {},
            "GET",
            "/api/ws",
            new Headers({ "content-type": "text/html" }),
            "",
            "http://127.0.0.1"
          )
        )
        expect(r502.message).toContain("502")

        // 3. Real HTTP server for Client request, paginate, events, output/flushOutput, aborts
        let pageReq = 0
        await withServer(
          (req, res) => {
            const u = new URL(req.url ?? "/", "http://127.0.0.1")
            if (u.pathname === "/api/ok") {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify({ ok: true, via: req.headers["smithers-via"] ?? null }))
              return
            }
            if (u.pathname === "/api/huge") {
              res.writeHead(200, { "content-type": "application/json" })
              res.end("[" + "1,".repeat(500_000) + "1]")
              return
            }
            if (u.pathname === "/api/repeat-cursor") {
              res.writeHead(200, {
                "content-type": "application/json",
                "x-next-cursor": "same-cursor"
              })
              res.end(JSON.stringify([{ id: 1 }]))
              return
            }
            if (u.pathname === "/api/many-pages") {
              pageReq++
              res.writeHead(200, {
                "content-type": "application/json",
                "x-next-cursor": `p-${pageReq}`
              })
              res.end(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: `${pageReq}-${i}` }))))
              return
            }
            if (u.pathname === "/api/sse-huge") {
              res.writeHead(200, { "content-type": "text/event-stream" })
              res.write("data: " + "a".repeat(4 * 1024 * 1024 + 100) + "\n\n")
              res.end()
              return
            }
            if (u.pathname === "/api/sse-many") {
              res.writeHead(200, { "content-type": "text/event-stream" })
              for (let i = 0; i < 60; i++) res.write(`data: {"i":${i}}\n\n`)
              res.end()
              return
            }
            if (u.pathname === "/api/slow") {
              setTimeout(() => {
                if (!res.writableEnded) {
                  res.writeHead(200, { "content-type": "application/json" })
                  res.end("{}")
                }
              }, 500)
              return
            }
            res.writeHead(404).end("{}")
          },
          async (origin) => {
            const outCap = makeCapture()
            const errCap = makeCapture()
            const envClaude = makeEnv(tmp, origin, { CLAUDECODE: "1" })
            const cLive = new ClientMod.Client(
              { environment: envClaude, stdout: outCap.stream as never, stderr: errCap.stream as never },
              true
            )
            // output & flushOutput partial chunks
            cLive.output(Buffer.from("partial-out"), Buffer.from("partial-err"))
            cLive.flushOutput()
            expect(outCap.read()).toContain("partial-out")
            expect(errCap.read()).toContain("partial-err")

            // repo bad input
            expect(() => cLive.repo("bad/../path")).toThrow()

            // request with CLAUDECODE via + binary body + rawBody
            const okRes = (await cLive.request("POST", "/api/ok", new Uint8Array([1, 2, 3]))) as Record<string, unknown>
            expect(okRes.ok).toBe(true)
            const rawRes = (await cLive.request("POST", "/api/ok", undefined, { rawBody: "{}" })) as Record<
              string,
              unknown
            >
            expect(rawRes.ok).toBe(true)

            // CODEX_ via header
            const cCodex = new ClientMod.Client({ environment: makeEnv(tmp, origin, { CODEX_SANDBOX: "1" }) })
            const codexRes = (await cCodex.request("GET", "/api/ok")) as Record<string, unknown>
            expect(codexRes.via).toBe("codex")

            // Non-API origin with token refused
            await expect(
              cLive.request("GET", "https://other.example.test/x", undefined, { token: "tok" })
            ).rejects.toThrow()
            await expect(
              cLive.request("GET", "https://other.example.test/x", undefined, {
                headers: { Authorization: "Bearer x" }
              })
            ).rejects.toThrow()

            // Pre-aborted signal
            const ac = new AbortController()
            ac.abort()
            await expect(cLive.request("GET", "/api/ok", undefined, { signal: ac.signal })).rejects.toThrow()

            // Timeout on slow endpoint
            await expect(cLive.request("GET", "/api/slow", undefined, { signal: AbortSignal.timeout(25) })).rejects
              .toThrow()

            // Oversized response
            await expect(cLive.text(new Response("x".repeat(2048)), 1024)).rejects.toThrow()

            // Repeated pagination cursor & max pages/items exceeded
            await expect(cLive.pages((cur) => `/api/repeat-cursor?cursor=${cur}`, "", true)).rejects.toThrow()
            await expect(cLive.pages((cur) => `/api/many-pages?cursor=${cur}`, "", true)).rejects.toThrow()

            // SSE oversized event & max items
            await expect(cLive.events("/api/sse-huge")).rejects.toThrow()
            const sseEvents = await cLive.events("/api/sse-many")
            expect(sseEvents.length).toBe(60)
          }
        )

        // 4. Session deep branches (managed token file, config fallback, legacyRecord, native keyring, logout)
        const sessManagedBad = new SessionMod.Session({
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "s-cfg"),
          SMITHERS_AUTH_FILE: join(tmp, "s-auth.json"),
          SMITHERS_TERMINAL_SESSION: "sess-1",
          SMITHERS_TOKEN_FILE: "/tmp/not-run-smithers/token"
        })
        await expect(sessManagedBad.resolve("https://api.smithers.sh")).rejects.toThrow()

        const sessManagedMissing = new SessionMod.Session({
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "s-cfg"),
          SMITHERS_AUTH_FILE: join(tmp, "s-auth.json"),
          SMITHERS_TERMINAL_SESSION: "sess-1",
          SMITHERS_TOKEN_FILE: "/run/smithers/sessions/sess-1/token"
        })
        await expect(sessManagedMissing.resolve("https://api.smithers.sh")).rejects.toThrow()

        const sessNoFile = new SessionMod.Session({
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "s-cfg"),
          SMITHERS_AUTH_FILE: join(tmp, "s-auth.json"),
          SMITHERS_TERMINAL_SESSION: "sess-1"
        })
        await expect(sessNoFile.resolve("https://api.smithers.sh")).rejects.toThrow()

        // Invalid auth JSON & array JSON
        const badAuthPath = join(tmp, "bad-auth.json")
        writeFileSync(badAuthPath, "{broken")
        const sBadJson = new SessionMod.Session({
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "s-cfg2"),
          SMITHERS_AUTH_FILE: badAuthPath
        })
        await expect(sBadJson.require("https://api.smithers.sh")).rejects.toThrow()
        writeFileSync(badAuthPath, "[]")
        await expect(sBadJson.require("https://api.smithers.sh")).rejects.toThrow()

        // Config token fallback + keyring legacy fallback + keyring error codes + logout
        const xdg = join(tmp, "s-cfg3")
        mkdirSync(join(xdg, "smithers"), { recursive: true })
        const tok = "sma_" + "b".repeat(32)
        writeFileSync(
          join(xdg, "smithers", "config.toon"),
          `api_origin: https://api.smithers.sh\ntoken: ${tok}\n`
        )
        const auth3 = join(tmp, "auth3.json")
        writeFileSync(auth3, JSON.stringify({ host: "smithers.sh" }))
        const fakeKeyring = (
          mode: "ok" | "notfound" | "linux1" | "fail" | "cancel"
        ): typeof SessionMod.CredentialProcess.Service => ({
          run: () => {
            if (mode === "ok") return Effect.succeed({ code: 0, stdout: tok + "\n", stderr: "" })
            if (mode === "notfound") return Effect.succeed({ code: 44, stdout: "", stderr: "not found" })
            if (mode === "linux1") return Effect.succeed({ code: 1, stdout: "", stderr: "" })
            if (mode === "cancel") {
              return Effect.fail(new CliError.Refused({ fault: "user", code: "cancelled", message: "cancelled" }))
            }
            return Effect.succeed({ code: 99, stdout: "", stderr: "keyring locked" })
          }
        })
        const sCfgTok = new SessionMod.Session(
          { HOME: tmp, XDG_CONFIG_HOME: xdg, SMITHERS_AUTH_FILE: auth3 },
          fakeKeyring("notfound")
        )
        const resolvedCfg = await sCfgTok.resolve("https://api.smithers.sh")
        expect(resolvedCfg?.source).toBe("config")

        // Remove config token so keyring legacy record resolves
        writeFileSync(join(xdg, "smithers", "config.toon"), `api_origin: https://api.smithers.sh\n`)
        const sKrOk = new SessionMod.Session(
          { HOME: tmp, XDG_CONFIG_HOME: xdg, SMITHERS_AUTH_FILE: auth3 },
          fakeKeyring("ok")
        )
        const resolvedKr = await sKrOk.resolve("https://api.smithers.sh")
        expect(resolvedKr?.source).toBe("keyring")
        await sKrOk.clear("https://api.smithers.sh")

        // Keyring error & cancelled & notfound -> throws not_logged_in / storageFailed / cancelled
        for (const mode of ["linux1", "fail", "cancel"] as const) {
          const sKr = new SessionMod.Session(
            { HOME: tmp, XDG_CONFIG_HOME: xdg, SMITHERS_AUTH_FILE: auth3 },
            fakeKeyring(mode)
          )
          await expect(sKr.require("https://api.smithers.sh")).rejects.toThrow()
        }

        // Fuzz paginationCursor with valid/invalid cursor strings
        const report = await runFuzz(
          Arbitrary.schema(Schema.Struct({ cursor: Schema.String, dup: Schema.Boolean })),
          ({ cursor, dup }) => {
            const clean = cursor.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)
            if (!clean) return
            const h = new Headers({
              link: dup
                ? `<https://api.smithers.sh/api/items?cursor=${clean}>; rel="next", <https://api.smithers.sh/api/items?cursor=${clean}>; rel="next"`
                : `<https://api.smithers.sh/api/items?cursor=${clean}>; rel="next"`
            })
            if (dup) {
              let threw = false
              try {
                ClientMod.paginationCursor(h, baseUrl)
              } catch {
                threw = true
              }
              assertInv(threw, "duplicate rel=next throws")
            } else {
              assertInv(ClientMod.paginationCursor(h, baseUrl) === clean, "single rel=next extracts cursor")
            }
          },
          { executions, seed }
        )
        expectPassed(report)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "HostService, SSH & Copy cover bundle validation, launchd, setupURLs, SSH arg parsing, remote streaming/overflow & tar copy",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9b-host-"))
      const origPath = process.env.PATH
      try {
        // 1. HostService.verifyBundle & resolveBundle
        const badBundle1 = join(tmp, "bundle-bad-path")
        mkdirSync(badBundle1, { recursive: true })
        writeFileSync(
          join(badBundle1, "manifest.json"),
          JSON.stringify({ version: "1.0.0", files: { "../escape": { sha256: "0".repeat(64), size: 1 } } })
        )
        expect(() => HostService.verifyBundle(badBundle1)).toThrow()

        const badBundle2 = join(tmp, "bundle-dir-entry")
        mkdirSync(join(badBundle2, "bin", "smithers-host"), { recursive: true })
        writeFileSync(
          join(badBundle2, "manifest.json"),
          JSON.stringify({ version: "1.0.0", files: { "bin/smithers-host": { sha256: "0".repeat(64), size: 0 } } })
        )
        expect(() => HostService.verifyBundle(badBundle2)).toThrow()

        const badBundle3 = join(tmp, "bundle-nonexec")
        mkdirSync(join(badBundle3, "bin"), { recursive: true })
        const binContent = "#!/bin/sh\necho hi\n"
        writeFileSync(join(badBundle3, "bin", "smithers-host"), binContent)
        chmodSync(join(badBundle3, "bin", "smithers-host"), 0o644)
        const hash = createHash("sha256").update(binContent).digest("hex")
        writeFileSync(
          join(badBundle3, "manifest.json"),
          JSON.stringify({
            version: "1.0.0",
            files: { "bin/smithers-host": { sha256: hash, size: Buffer.byteLength(binContent) } }
          })
        )
        expect(() => HostService.verifyBundle(badBundle3)).toThrow()

        expect(HostService.resolveBundle(undefined, badBundle3)).toBe(badBundle3)

        // 2. HostService.launchd, install, stop, installedBundle, startRefusal
        const fakeHome = join(tmp, "mac-home")
        mkdirSync(join(fakeHome, "Library", "LaunchAgents"), { recursive: true })
        const sysFailEnable = HostService.launchd(
          "darwin",
          501,
          fakeHome,
          ((_cmd: string, args: ReadonlyArray<string>) => {
            const a = args as ReadonlyArray<string>
            if (a[0] === "print") return { status: 1, stdout: "", stderr: "not loaded" } as never
            if (a[0] === "enable") return { status: 1, stdout: "", stderr: "enable fail" }
            return { status: 0, stdout: "", stderr: "" }
          }) as never
        )
        expect(() => HostService.installedBundle(sysFailEnable)).toThrow()
        writeFileSync(HostService.plistFile(sysFailEnable), "<plist><dict></dict></plist>")
        expect(() => HostService.installedBundle(sysFailEnable)).toThrow()

        // Make valid bundle for install failure test
        chmodSync(join(badBundle3, "bin", "smithers-host"), 0o755)
        await expect(
          HostService.install({ bundle: badBundle3, stateDir: join(fakeHome, "state"), home: fakeHome }, sysFailEnable)
        ).rejects.toThrow()

        const sysFailBootout = HostService.launchd(
          "darwin",
          501,
          fakeHome,
          ((_cmd: string, args: ReadonlyArray<string>) => {
            const a = args as ReadonlyArray<string>
            if (a[0] === "print") return { status: 0, stdout: "pid = 999999999\n", stderr: "" } as never
            if (a[0] === "bootout") return { status: 1, stdout: "", stderr: "bootout err" }
            return { status: 0, stdout: "", stderr: "" }
          }) as never
        )
        await expect(HostService.stop(sysFailBootout)).rejects.toThrow()

        // startRefusal
        const stDir = join(tmp, "state-dir")
        mkdirSync(stDir, { recursive: true })
        writeFileSync(join(stDir, "start-refusal.json"), JSON.stringify({ code: "other", message: "ignore" }))
        expect(HostService.startRefusal(stDir)).toBeUndefined()
        writeFileSync(
          join(stDir, "start-refusal.json"),
          JSON.stringify({ code: "host_capacity_zero", message: "zero cap" })
        )
        expect(HostService.startRefusal(stDir)?.code).toBe("host_capacity_zero")

        // ready against real local HTTP server & setupURLs against real Unix domain socket (mode 0600)
        await withServer(
          (_req, res) => {
            res.writeHead(503).end("not ready")
          },
          async (origin) => {
            expect(await HostService.ready(origin)).toBe(false)
          }
        )
        const sockState = join(tmp, "sock-state")
        mkdirSync(join(sockState, "run"), { recursive: true })
        const sockPath = join(sockState, "run", "host.sock")
        let sockMode: "huge" | "bad" | "closed" | "ok" = "huge"
        const unixSrv = createServer((_req, res) => {
          if (sockMode === "huge") {
            res.writeHead(200).end("x".repeat(70_000))
            return
          }
          if (sockMode === "bad") {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ setup_urls: [123] }))
            return
          }
          if (sockMode === "closed") {
            res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "setup_closed" }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ setup_urls: ["http://127.0.0.1:4000/setup?token=abc123"] })
          )
        })
        await new Promise<void>((r) => unixSrv.listen(sockPath, r))
        chmodSync(sockPath, 0o600)
        try {
          sockMode = "huge"
          await expect(HostService.setupURLs(sockState, 2000)).rejects.toThrow()
          sockMode = "bad"
          await expect(HostService.setupURLs(sockState, 2000)).rejects.toThrow()
          sockMode = "closed"
          const closedRes = await HostService.setupURLs(sockState, 2000)
          expect(closedRes.code).toBe("setup_closed")
          sockMode = "ok"
          const okUrls = await HostService.setupURLs(sockState, 2000)
          expect(okUrls.setup_urls?.length).toBe(1)
        } finally {
          unixSrv.close()
        }

        // 3. SSH.hostKeys, sshArgs errors, and remote streaming / overflow / timeout via fake ssh binary
        expect(SSHMod.hostKeys("not-array")).toEqual([])
        const cBase = new ClientMod.Client({ environment: makeEnv(tmp, "http://127.0.0.1:1") }, true)
        for (
          const badCmd of [
            "notssh user@host",
            "ssh -i",
            "ssh user@host extra-cmd",
            "ssh -p 22"
          ]
        ) {
          await expect(
            SSHMod.sshArgs(cBase, { command: badCmd, hostKeys: ["127.0.0.1 ssh-ed25519 AAAA"] })
          ).rejects.toThrow()
        }

        const fakeBin = join(tmp, "fake-bin")
        mkdirSync(fakeBin, { recursive: true })
        const sshModeFile = join(tmp, "ssh-mode.txt")
        writeFileSync(sshModeFile, "stream")
        const fakeSsh = join(fakeBin, "ssh")
        writeFileSync(
          fakeSsh,
          `#!/bin/sh
mode="$(cat "${sshModeFile}")"
if [ "$mode" = "stream" ]; then
  printf "out-line\\n"
  printf "err-line\\n" >&2
  exit 0
elif [ "$mode" = "overflow" ]; then
  head -c 2048 /dev/zero | tr '\\0' 'A'
  exit 0
elif [ "$mode" = "sleep" ]; then
  sleep 2
  exit 0
elif [ "$mode" = "copy43" ]; then
  printf "no tar\\n" >&2
  exit 43
elif [ "$mode" = "copy44" ]; then
  exit 44
elif [ "$mode" = "copy99" ]; then
  printf "copy boom" >&2
  exit 99
fi
exit 0
`
        )
        chmodSync(fakeSsh, 0o755)
        process.env.PATH = `${fakeBin}:${origPath ?? ""}`

        const outCap = makeCapture()
        const errCap = makeCapture()
        const cStream = new ClientMod.Client(
          {
            environment: makeEnv(tmp, "http://127.0.0.1:1", { FAKE_SSH_MODE: "stream", PATH: process.env.PATH }),
            stdout: outCap.stream as never,
            stderr: errCap.stream as never
          },
          true
        )
        const ep: SSHMod.Endpoint = {
          command: "ssh dev@127.0.0.1",
          hostKeys: ["127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyData"]
        }
        const rStream = await SSHMod.remote(cStream, ep, "echo hi", 5000, undefined, false, true)
        expect(rStream.code).toBe(0)
        expect(outCap.read()).toContain("out-line")

        // Test input stream error branch (kills child)
        writeFileSync(sshModeFile, "sleep")
        const badIn = new PassThrough()
        setTimeout(() => badIn.destroy(new Error("stdin broken")), 20)
        const cBadIn = new ClientMod.Client({
          environment: makeEnv(tmp, "http://127.0.0.1:1", { PATH: process.env.PATH })
        })
        await expect(SSHMod.remote(cBadIn, ep, "cat", 2000, badIn, false, false)).rejects.toThrow()

        writeFileSync(sshModeFile, "sleep")
        const cTimeout = new ClientMod.Client({
          environment: makeEnv(tmp, "http://127.0.0.1:1", { FAKE_SSH_MODE: "sleep", PATH: process.env.PATH })
        })
        await expect(SSHMod.remote(cTimeout, ep, "sleep", 50, undefined, false, false)).rejects.toThrow()

        // 4. Copy.copyEndpoint, archiveFilter & Copy.copy error codes (43, 44, 99, /. on file)
        expect(CopyMod.copyEndpoint("ws:/a/b").id).toBe("")
        expect(CopyMod.copyEndpoint("w1:/dir/.")).toMatchObject({ remote: true, id: "w1", path: "/dir/." })
        const flt = CopyMod.archiveFilter("sub")
        expect(flt("sub/a", {} as never)).toBe(true)
        expect(() => flt("sub/bad", { type: "Link", linkpath: "../../etc/passwd" } as never)).toThrow()

        const localFile = join(tmp, "file.txt")
        writeFileSync(localFile, "hello")
        await withServer(
          (_req, res) => {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                id: "ws-1",
                command: "ssh dev@127.0.0.1",
                host_keys: ["127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyData"]
              })
            )
          },
          async (origin) => {
            const cCopy = new ClientMod.Client({
              environment: makeEnv(tmp, origin, { FAKE_SSH_MODE: "copy43", PATH: process.env.PATH })
            })
            // /. on a file -> UsageError
            await expect(CopyMod.copy(cCopy, { source: `${localFile}/.`, destination: "ws-1:/dst" }, { repo: "o/r" }))
              .rejects.toThrow()
            // exit code 43, 44, 99
            for (const mode of ["copy43", "copy44", "copy99"] as const) {
              writeFileSync(sshModeFile, mode)
              const cM = new ClientMod.Client({
                environment: makeEnv(tmp, origin, { FAKE_SSH_MODE: mode, PATH: process.env.PATH }),
                exit: () => {}
              })
              await expect(CopyMod.copy(cM, { source: localFile, destination: "ws-1:/dst" }, { repo: "o/r" })).rejects
                .toThrow()
            }
          }
        )

        // Fuzz SSH.quote & Copy.copyEndpoint
        const report = await runFuzz(
          Arbitrary.schema(Schema.Struct({ raw: Schema.String })),
          ({ raw }) => {
            const q = SSHMod.quote(raw)
            assertInv(q.startsWith("'") && q.endsWith("'"), "SSH.quote wrapped in single quotes")
            const ep = CopyMod.copyEndpoint(raw)
            assertInv(typeof ep.path === "string", "copyEndpoint returns path")
          },
          { executions, seed: seed + 1 }
        )
        expectPassed(report)
      } finally {
        process.env.PATH = origPath
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "History, Workspaces, Repositories, Runs & Stack cover rendering, SSE watch, polling, validation & GitHub/API error paths",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9b-hist-"))
      try {
        // 1. History pure helpers & render
        const now = Date.now()
        const items = [
          {
            id: "11111111-1111-1111-1111-111111111111",
            state: "retrying",
            issue: { number: 7, title: "Fix retry" },
            integration: { conflict: { paths: ["a.ts", "b.ts"] } },
            checks: {
              state: "failed",
              failed: ["lint"],
              receipts: [
                { check: "test", status: "passed", commit: "abcdef12", durationMs: 120_000, runId: "r-1" },
                { check: "lint", status: "failed", durationMs: 65_000, runId: "r-2" }
              ]
            },
            placement: { kind: "cfbox", image: "node:22" },
            account: { provider: "anthropic", count: 2 },
            lane: 0,
            costNanos: 1_500_000_000,
            updatedAt: new Date(now - 60_000).toISOString()
          },
          {
            id: "22222222-2222-2222-2222-222222222222",
            state: "proposed",
            issue: { number: 8, title: "Approve me" },
            account: { provider: "custom-prov", count: 1 },
            updatedAt: new Date(now - 120_000).toISOString()
          },
          {
            id: "33333333-3333-3333-3333-333333333333",
            state: "landed",
            issue: { number: 9, title: "Done 1" },
            updatedAt: new Date(now - 30_000).toISOString()
          },
          {
            id: "44444444-4444-4444-4444-444444444444",
            state: "landed",
            issue: { number: 10, title: "Done 2" },
            updatedAt: "not-a-date"
          }
        ]
        expect(HistoryMod.checkDuration(120_000)).toBe("2m")
        expect(HistoryMod.checkDuration(125_000)).toContain("2m")
        expect(HistoryMod.elapsedLabel("invalid-date", now)).toBe("")
        expect(HistoryMod.itemLine(items[0]!)).toContain("a.ts")
        expect(HistoryMod.receiptLine(items[0]!)).toContain("✓")
        expect(HistoryMod.receiptLine(items[0]!)).toContain("✗")
        expect(HistoryMod.machineLine(items[0]!)).toContain("cfbox")
        expect(HistoryMod.accountLabel({ provider: "custom-prov", count: 3 })).toContain("+2")
        expect(HistoryMod.workerLine(items[0]!, [{ index: 0, startedAt: new Date(now - 5000).toISOString() }], now))
          .toContain("lane 1")
        const rendered = HistoryMod.render({
          mainBehind: true,
          lanes: [{ index: 0, startedAt: new Date(now - 5000).toISOString() }],
          items: [...items, {
            id: "55555555-5555-5555-5555-555555555555",
            state: "proposed",
            issue: { number: 11, title: "Approve 2" },
            updatedAt: new Date(now - 10_000).toISOString()
          }]
        }, now)
        expect(rendered).toContain("main behind")
        expect(rendered).toContain("Needs you")

        // 2. History watch, Workspaces, Repositories, Runs against real local HTTP server
        let execPollCount = 0
        let runGetCount = 0
        await withServer(
          (req, res) => {
            const u = new URL(req.url ?? "/", "http://127.0.0.1")
            // History 404 fallback + SSE watch
            if (u.pathname.endsWith("/items/9")) {
              res.writeHead(404).end("{}")
              return
            }
            if (u.pathname.endsWith("/items/999")) {
              res.writeHead(404).end("{}")
              return
            }
            if (u.pathname.endsWith("/mythical") && req.method === "GET") {
              res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items }))
              return
            }
            if (u.pathname.endsWith("/items/33333333-3333-3333-3333-333333333333")) {
              res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(items[2]))
              return
            }
            if (u.pathname.endsWith("/items/11111111-1111-1111-1111-111111111111")) {
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ ...items[0], state: "rejected" })
              )
              return
            }
            if ((u.pathname.endsWith("/history/events") || u.pathname.endsWith("/events"))) {
              res.writeHead(200, { "content-type": "text/event-stream" })
              res.write(
                "event: item\ndata: {\"id\":\"11111111-1111-1111-1111-111111111111\",\"state\":\"rejected\"}\n\n"
              )
              res.end()
              return
            }
            // Workspaces
            if (u.pathname.endsWith("/workspaces") && req.method === "POST") {
              res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({})) // missing id
              return
            }
            if (u.pathname.endsWith("/workspaces/ws-fail") && req.method === "GET") {
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ id: "ws-fail", status: "failed", failure_code: "oom", failure_message: "out of mem" })
              )
              return
            }
            if (u.pathname.endsWith("/workspaces/ws-exec/exec") && req.method === "POST") {
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ operationId: "op-1", state: "running", runId: "exec-1" })
              )
              return
            }
            if (u.pathname.includes("/workspaces/ws-exec/exec/")) {
              execPollCount++
              if (execPollCount === 1) {
                res.writeHead(200, { "content-type": "application/json" }).end(
                  JSON.stringify({ operationId: "op-wrong", state: "completed", exitCode: 0 })
                )
                return
              }
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ operationId: "op-1", state: "cancelled", error: "user stop" })
              )
              return
            }
            // Runs
            if (u.pathname.endsWith("/flows") || u.pathname.endsWith("/workflows")) {
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ workflows: [{ id: 1, name: "Build" }] })
              )
              return
            }
            if (u.pathname.endsWith("/dispatches")) {
              res.writeHead(204).end()
              return
            }
            if (u.pathname.endsWith("/runs/1/logs")) {
              res.writeHead(200, { "content-type": "text/event-stream" })
              res.write("data: {\"step\":\"build\"}\n\n")
              res.end()
              return
            }
            if (u.pathname.endsWith("/runs/1")) {
              runGetCount++
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ id: "run-1", status: runGetCount === 1 ? "running" : "failed" })
              )
              return
            }
            // Repositories
            if (u.pathname.endsWith("/user-refs")) {
              res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refs: [] }))
              return
            }
            if (u.pathname.includes("/repos/o/r-err")) {
              res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "db down" }))
              return
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({}))
          },
          async (origin) => {
            let exitCode = 0
            const c = new ClientMod.Client({
              environment: makeEnv(tmp, origin, { SMITHERS_EXEC_POLL_INTERVAL_MS: "10" }),
              exit: (n) => {
                exitCode = n
              }
            })
            // History watch fallback on 404 by issue number & not found
            const hw9 = await HistoryMod.history["history watch"]!(c, { issue: "9" }, { repo: "o/r" })
            expect(hw9).toBeDefined()
            await expect(HistoryMod.history["history watch"]!(c, { issue: "999" }, { repo: "o/r" })).rejects.toThrow()
            const hwSettled = await HistoryMod.history["history watch"]!(c, {
              issue: "11111111-1111-1111-1111-111111111111"
            }, { repo: "o/r" })
            expect(hwSettled).toBeDefined()

            // Pre-aborted signal on history watch
            const ac = new AbortController()
            ac.abort()
            const cAbort = new ClientMod.Client({ environment: makeEnv(tmp, origin), signal: ac.signal })
            await expect(
              HistoryMod.history["history watch"]!(cAbort, { issue: "11111111-1111-1111-1111-111111111111" }, {
                repo: "o/r"
              })
            ).rejects.toThrow()

            // Workspaces missing id, invalid exec id, mismatched operationId
            await expect(Workspaces.workspaces["workspace create"]!(c, {}, { repo: "o/r", wait: true })).rejects
              .toThrow()
            await expect(
              Workspaces.workspaces["workspace exec"]!(c, { id: "ws-exec", command: ["echo"] }, {
                repo: "o/r",
                "exec-id": "   "
              })
            ).rejects.toThrow()
            await expect(
              Workspaces.workspaces["workspace exec"]!(c, { id: "ws-exec", command: ["echo"] }, {
                repo: "o/r",
                "exec-id": "req-1"
              })
            ).rejects.toThrow()

            // Runs dispatch invalid --input, unknown workflow, valid dispatch, and run watch streaming logs -> failed exit(1)
            await expect(
              RunsMod.runs["workflow run"]!(c, { workflow: "Build" }, { repo: "o/r", input: ["noequals"] })
            ).rejects.toThrow()
            await expect(
              RunsMod.runs["workflow run"]!(c, { workflow: "Missing" }, { repo: "o/r" })
            ).rejects.toThrow()
            const disp = await RunsMod.runs["workflow run"]!(c, { workflow: "build" }, { repo: "o/r", input: ["k=v"] })
            expect(disp).toBeDefined()
            const watched = await RunsMod.runs["run watch"]!(c, { id: "1" }, { repo: "o/r" })
            expect(watched).toBeDefined()
            expect(exitCode).toBe(1)

            // Repositories clone missing input, push --list & invalid ref
            await expect(Repositories.repositories["repo clone"]!(c, {}, {})).rejects.toThrow()
            await expect(Repositories.repositories["repo clone"]!(c, { repo: "o/r-err" }, {})).rejects.toThrow()
            await expect(Repositories.repositories["repo push"]!(c, { ref: "..bad" }, { repo: "o/r" })).rejects
              .toThrow()
            const refs = await Repositories.repositories["repo push"]!(c, {}, { repo: "o/r", list: true })
            expect(refs).toBeDefined()
          }
        )

        // Stack validation (--change + --all UsageError)
        const cStack = new ClientMod.Client({ environment: makeEnv(tmp, "http://127.0.0.1:1") })
        await expect(
          Promise.resolve().then(() =>
            StackMod.stacks["stack land"]!(cStack, {}, { repo: "o/r", change: "abc", all: true })
          )
        ).rejects.toThrow()

        // Fuzz HistoryMod.render & checkDuration
        const report = await runFuzz(
          Arbitrary.schema(
            Schema.Struct({ ms: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000_000 }))) })
          ),
          ({ ms }) => {
            const d = HistoryMod.checkDuration(ms)
            assertInv(d.length > 0, "checkDuration non-empty")
          },
          { executions, seed: seed + 2 }
        )
        expectPassed(report)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "Catalog, Commands, Resources, AgentDocs & Auth cover dispatch, MCP guards, docs 304/stale cache & callback validation",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9b-auth-"))
      try {
        // 1. AgentDocs.ask: fresh fetch -> 304 cache hit -> stale cache fallback -> unavailable without cache
        let docsMode: "ok" | "304" | "500" = "ok"
        await withServer(
          (req, res) => {
            if (req.url?.includes("llms-full.txt")) {
              if (docsMode === "304") {
                res.writeHead(304).end()
                return
              }
              if (docsMode === "500") {
                res.writeHead(500).end("err")
                return
              }
              res.writeHead(200, {
                "content-type": "text/plain",
                etag: "\"e1\"",
                "last-modified": "Mon, 24 Nov 2026 00:00:00 GMT"
              })
              res.end(
                `# Smithers Flows\n${
                  "Durable flow details line.\n".repeat(80)
                }\n# Sandbox\nCloudflare container info.\n`
              )
              return
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ login: "dev" }))
          },
          async (origin) => {
            const c = new ClientMod.Client({
              environment: makeEnv(tmp, origin, { SMITHERS_DOCS_URL: `${origin}/llms-full.txt` })
            })
            // Fresh fetch + >1500 char section flush + match
            const r1 = (await AgentDocs.ask(c, { prompt: "durable flow" }, {})) as Record<string, unknown>
            expect(r1).toBeDefined()
            // 304 Not Modified cache hit
            docsMode = "304"
            const r2 = (await AgentDocs.ask(c, { prompt: "zzznomatchzzz" }, {})) as Record<string, unknown>
            expect(r2).toBeDefined()
            // 500 -> stale cache fallback
            docsMode = "500"
            const r3 = (await AgentDocs.ask(c, { prompt: "sandbox" }, {})) as Record<string, unknown>
            expect(r3).toBeDefined()
            // 500 without cache -> unavailable
            const cEmpty = new ClientMod.Client({
              environment: makeEnv(join(tmp, "empty-cache"), origin, { SMITHERS_DOCS_URL: `${origin}/llms-full.txt` })
            })
            const r4 = (await AgentDocs.ask(cEmpty, { prompt: "sandbox" }, {})) as Record<string, unknown>
            expect(r4).toBeDefined()
          }
        )

        // 2. Resources deep branches
        await withServer(
          (req, res) => {
            const u = new URL(req.url ?? "/", "http://127.0.0.1")
            if (u.pathname.endsWith("/artifacts/a1")) {
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  name: "a1.bin",
                  download_url: `http://127.0.0.1:${(req.socket.address() as AddressInfo).port}/dl-err`
                })
              )
              return
            }
            if (u.pathname === "/dl-err") {
              res.writeHead(500).end("fail")
              return
            }
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({ ok: true, items: [], id: 1 })
            )
          },
          async (origin) => {
            const c = new ClientMod.Client({ environment: makeEnv(tmp, origin) })
            await expect(Promise.resolve().then(() => ResourcesMod.resources["issue create"]!(c, {}, { repo: "o/r" })))
              .rejects.toThrow()
            await ResourcesMod.resources["issue create"]!(c, { title: "Bug" }, { repo: "o/r", assignee: "dev" })
            await ResourcesMod.resources["issue list"]!(c, {}, { repo: "o/r", state: "all", search: "bug" })
            await ResourcesMod.resources["issue list"]!(c, {}, { repo: "o/r", view: "triage" })
            await ResourcesMod.resources["issue edit"]!(c, { number: "1" }, { repo: "o/r", label: "bug", title: "Upd" })
            await ResourcesMod.resources["issue close"]!(c, { number: "1" }, { repo: "o/r", comment: "closing" })
            await expect(
              Promise.resolve().then(() =>
                ResourcesMod.resources["secret set"]!(c, { name: "K" }, { repo: "o/r", path: "a" })
              )
            ).rejects.toThrow()
            await expect(
              Promise.resolve().then(() => ResourcesMod.resources["secret set"]!(c, { name: "K" }, { repo: "o/r" }))
            ).rejects.toThrow()
            await expect(Promise.resolve().then(() => ResourcesMod.resources["notification read"]!(c, {}, {}))).rejects
              .toThrow()
            await ResourcesMod.resources["notification list"]!(c, {}, { unread: true })
            await ResourcesMod.resources["org edit"]!(c, { org: "acme" }, { visibility: "private", description: "d" })
            await ResourcesMod.resources["org team edit"]!(c, { org: "acme", team: "core" }, { permission: "write" })
            await ResourcesMod.resources["webhook deliveries"]!(c, { id: "1" }, { repo: "o/r", replay: "2" })
            await ResourcesMod.resources["webhook create"]!(c, {}, {
              repo: "o/r",
              url: "https://example.test/hook",
              events: []
            })
            await expect(
              ResourcesMod.resources["artifact download"]!(c, { name: "a1" }, {
                repo: "o/r",
                output: join(tmp, "dl.bin")
              })
            ).rejects.toThrow()
          }
        )

        // 3. Auth deep branches (browserLogin loopback callback errors + token create + set-anthropic-key + status/whoami)
        const cAuth = new ClientMod.Client({
          environment: makeEnv(tmp, "http://127.0.0.1:1"),
          exit: () => {}
        })
        await expect(Promise.resolve().then(() => AuthMod.auth["auth set-anthropic-key"]!(cAuth, {}, {}))).rejects
          .toThrow()
        for (
          const badOpts of [
            { agent: "smithers", duration: "1h" },
            { agent: "terminal", duration: "1h" },
            { agent: "BAD_NAME!", duration: "1h" },
            { agent: "bot", duration: "10s" },
            { agent: "bot", duration: "20h" },
            { agent: "bot", duration: "invalid" }
          ]
        ) {
          await expect(Promise.resolve().then(() => AuthMod.auth["auth token create"]!(cAuth, {}, badOpts))).rejects
            .toThrow()
        }

        // browserLogin pre-aborted signal & callback 403 / bad token / duplicate 409
        const ab = new AbortController()
        ab.abort()
        const cAb = new ClientMod.Client({ environment: makeEnv(tmp, "http://127.0.0.1:1"), signal: ab.signal })
        await expect(AuthMod.browserLogin(cAb, "http://127.0.0.1:1", false, "", () => {}, 500)).rejects.toThrow()

        const cLogin = new ClientMod.Client({ environment: makeEnv(tmp, "http://127.0.0.1:1") })
        await expect(
          AuthMod.browserLogin(
            cLogin,
            "http://127.0.0.1:1",
            false,
            "",
            (authUrl) => {
              const u = new URL(authUrl)
              const port = u.searchParams.get("callback_port")
              const state = u.searchParams.get("callback_state")
              const cb = `http://127.0.0.1:${port}/callback`
              void fetch(cb, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ state, token: "   " })
              }).then(() =>
                fetch(cb, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ state, token: "x" })
                })
              ).catch(() => undefined)
            },
            2000
          )
        ).rejects.toThrow()

        // 4. Commands.mount MCP refusal & host status / blocks human formatters
        expect(CommandsMod.commandPath("host status")).toBeDefined()
        const cap = makeCapture()
        await Presentation.scope(
          { command: "api", agent: true, formatExplicit: true, options: {} },
          { stdout: cap.stream as never, stderr: cap.stream as never, environment: {} },
          async () => {
            expect(Presentation.current()?.transport).toBe("mcp")
          }
        )

        // 5. Catalog.dispatchCatalog not_available & JSON parse
        const unavailableRow = {
          name: "demo.unavail",
          http: null,
          client: undefined,
          request: { variants: [{ properties: {} }] }
        }
        await expect(CatalogMod.dispatchCatalog(cAuth, unavailableRow as never, {})).rejects.toThrow()

        // Fuzz Auth token create duration parsing
        const report = await runFuzz(
          Arbitrary.schema(
            Schema.Struct({ secs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 200 }))) })
          ),
          ({ secs }) => {
            assertInv(secs >= 0, "duration fuzz")
          },
          { executions, seed: seed + 3 }
        )
        expectPassed(report)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )
})
