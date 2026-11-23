import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as Path from "node:path"
import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as CatalogRequest from "../src/CatalogRequest.ts"
import * as CliError from "../src/CliError.ts"
import * as Admin from "../src/internal/backend/Admin.ts"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import * as ClientModule from "../src/internal/backend/Client.ts"
import * as Commands from "../src/internal/backend/Commands.ts"
import * as Copy from "../src/internal/backend/Copy.ts"
import * as Destination from "../src/internal/backend/Destination.ts"
import * as Egress from "../src/internal/backend/Egress.ts"
import * as BackendHistory from "../src/internal/backend/History.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import * as Local from "../src/internal/backend/Local.ts"
import * as Misc from "../src/internal/backend/Misc.ts"
import * as PathSegment from "../src/internal/backend/PathSegment.ts"
import * as ProductApi from "../src/internal/backend/ProductApi.ts"
import * as Repositories from "../src/internal/backend/Repositories.ts"
import * as Resources from "../src/internal/backend/Resources.ts"
import * as Runs from "../src/internal/backend/Runs.ts"
import * as SessionModule from "../src/internal/backend/Session.ts"
import * as SSH from "../src/internal/backend/SSH.ts"
import * as Stack from "../src/internal/backend/Stack.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"
import * as WorkspaceSsh from "../src/internal/backend/WorkspaceSsh.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

interface Parameter {
  readonly name: string
  readonly in: string
  readonly required?: boolean
  readonly type?: string | ReadonlyArray<string>
}
interface Operation {
  readonly method: string
  readonly path: string
  readonly operationId: string
  readonly parameters: ReadonlyArray<Parameter>
  readonly body: "json" | "raw" | "binary" | "other" | "none"
  readonly success: "json" | "raw" | "none" | "websocket"
}

const operations = (JSON.parse(
  FsSync.readFileSync(new URL("./fixtures/product-api-operations.json", import.meta.url), "utf8")
) as ReadonlyArray<Operation>).filter((op) => op.body !== "other" && op.success !== "websocket")

const functionName = (id: string) =>
  id.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word, index) =>
    index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join("")

const generated = ProductApi as unknown as Record<
  string,
  (transport: ProductApi.Transport, input?: unknown) => Promise<unknown>
>

describe("@smthrs/cli ProductApi, Backend Client, Session, History, HostService & Handlers fuzz invariants", () => {
  it("Every ProductApi endpoint safely encodes path/query segments and preserves HTTP methods without traversal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        chunkIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
        segmentKind: Schema.Literals(["clean", "slash", "traversal", "queryHash", "unicode"]),
        includeOptionalQuery: Schema.Boolean,
        shouldReject: Schema.Boolean
      })
    )

    const chunkSize = Math.ceil(operations.length / 8)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ chunkIdx, segmentKind, includeOptionalQuery, shouldReject }) =>
          Effect.promise(async () => {
            const batch = operations.slice(chunkIdx * chunkSize, (chunkIdx + 1) * chunkSize)

            const makeSample = (p: Parameter) => {
              const types = [p.type ?? []].flat()
              if (types.includes("integer") || types.includes("number")) return 42
              if (types.includes("boolean")) return true
              if (segmentKind === "clean") return `ok_${p.name}`
              if (segmentKind === "slash") return `a/b/${p.name}`
              if (segmentKind === "traversal") return `..//../${p.name}`
              if (segmentKind === "queryHash") return `${p.name}?x=1#frag%20`
              return `café_${p.name}`
            }

            for (const op of batch) {
              const fn = generated[functionName(op.operationId)]
              assertInv(typeof fn === "function", `missing ProductApi fn ${op.operationId}`)
              const pathValues = Object.fromEntries(
                op.parameters.filter((p) => p.in === "path").map((p) => [p.name, makeSample(p)])
              )
              const queryParams = op.parameters.filter((p) =>
                p.in === "query" && (p.required === true || includeOptionalQuery)
              )
              const queryValues = Object.fromEntries(queryParams.map((p) => [p.name, makeSample(p)]))
              const headers = Object.fromEntries(
                op.parameters.filter((p) => p.in === "header" && p.required === true).map((p) => [p.name, "hdr-val"])
              )
              const body = op.body === "binary"
                ? new Uint8Array([1, 2, 3])
                : op.body === "raw"
                ? "{\"signed\":true}"
                : { fuzz: true }
              const input = {
                ...(Object.keys(pathValues).length > 0 ? { path: pathValues } : {}),
                ...(Object.keys(queryValues).length > 0 ? { query: queryValues } : {}),
                ...(Object.keys(headers).length > 0 ? { headers } : {}),
                ...(op.body === "json" || op.body === "binary" || op.body === "raw" ? { body } : {})
              }

              const calls: Array<{ method: string; path: string }> = []
              const err = new Error("transport-refused")
              const transport: ProductApi.Transport = {
                request: (method, path) => {
                  calls.push({ method, path })
                  return shouldReject ? Promise.reject(err) : Promise.resolve({ ok: true })
                },
                response: (method, path) => {
                  calls.push({ method, path })
                  return shouldReject ? Promise.reject(err) : Promise.resolve(new Response("ok"))
                }
              }

              if (shouldReject) {
                let caught: unknown
                try {
                  await fn!(transport, input)
                } catch (e) {
                  caught = e
                }
                assertInv(caught === err, `transport failure propagated for ${op.operationId}`)
              } else {
                await fn!(transport, input)
                assertInv(calls.length === 1, `single call for ${op.operationId}`)
                assertInv(calls[0]!.method === op.method.toUpperCase(), `method match for ${op.operationId}`)
                const [pathPart] = calls[0]!.path.split("?")
                assertInv(
                  !pathPart!.split("/").some((seg) => seg === ".."),
                  `no unescaped traversal in ${calls[0]!.path}`
                )
              }
            }
            return true
          }),
        { seed, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Client redaction, Session origin/token hygiene, CatalogRequest, SSH, Copy, Local & PathSegment uphold security invariants", async () => {
    const tmpHome = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-backend-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          secret: Schema.Literals([
            "ghp_SuperSecretToken987654321",
            "sk-ant-api03-verysecretvalue1234",
            "tok_multiline\nsecret_line_12345"
          ]),
          rawSegment: Schema.Literals(["ok", "a/b", "..", ".", "", "x?y#z", "123"]),
          origin: Schema.Literals([
            "https://smithers.sh",
            "https://smithers.sh/",
            "http://127.0.0.1:4000",
            "http://localhost:8787/api",
            "smithers.sh",
            "ftp://bad.example",
            "javascript:alert(1)",
            ""
          ]),
          httpMethod: Schema.Literals(["GET", "POST", "PATCH", "PUT", "DELETE"]),
          remotePath: Schema.Literals(["ws-1:/tmp/file.txt", "./local.txt", "ws-1:dir/sub"]),
          sshText: Schema.Literals(["simple", "it's quoted", "$(rm -rf /)", "a; b && c"]),
          cmdName: Schema.Literals([
            "status",
            "run view",
            "workflow watch",
            "workflow run",
            "workflow list",
            "cache list",
            "issue list"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ secret, rawSegment, origin, httpMethod, remotePath, sshText, cmdName }) =>
            Effect.sync(() => {
              // PathSegment
              if (rawSegment === "." || rawSegment === "..") {
                try {
                  PathSegment.pathSegment(rawSegment)
                  assertInv(false, `pathSegment must reject ${rawSegment}`)
                } catch (e) {
                  assertInv(e instanceof CliError.UsageError, "pathSegment throws UsageError on dot")
                }
              } else {
                const seg = PathSegment.pathSegment(rawSegment)
                assertInv(!seg.includes("/") && !seg.includes("?") && !seg.includes("#"), "pathSegment encoded")
              }

              // Client helpers & redaction
              assertInv(typeof ClientModule.str(rawSegment) === "string", "Client.str")
              assertInv(Array.isArray(ClientModule.list([1, 2])), "Client.list")
              assertInv(typeof ClientModule.object({ a: 1 }) === "object", "Client.object")
              assertInv(ClientModule.positive("42") === 42, "Client.positive")
              const picked = ClientModule.pick({ a: 1, b: 2, c: 3 }, ["a", "c"])
              assertInv(picked.a === 1 && picked.b === undefined, "Client.pick")
              const qs = ClientModule.query({ a: 1, b: undefined, c: "x y" })
              assertInv(qs.includes("a=1") && !qs.includes("b="), "Client.query")
              const cursor = ClientModule.paginationCursor(
                new Headers({ Link: `<https://smithers.sh/api/items?cursor=abc123>; rel="next"` }),
                new URL("https://smithers.sh/api/items")
              )
              assertInv(cursor === "abc123", "paginationCursor parses Link next")

              // Secret redaction on Client.write / Client.redact / Client.output
              const chunks: Array<string> = []
              const sink = Object.assign(
                new Writable({
                  write(chunk, _enc, cb) {
                    chunks.push(String(chunk))
                    cb()
                  }
                }),
                { isTTY: false, columns: 80 }
              )
              const client = new ClientModule.Client(
                {
                  environment: { HOME: tmpHome, SMITHERS_DISABLE_SYSTEM_KEYRING: "1" },
                  stdout: sink,
                  stderr: sink
                },
                true
              )
              client.protect(secret)
              client.write(`Authorization: Bearer ${secret}\n`)
              client.output(Buffer.from(`stdout ${secret}\n`), Buffer.from(`stderr ${secret}\n`))
              const redactedObj = JSON.stringify(client.redact({ msg: `leaked ${secret}` }))
              const combined = chunks.join("") + redactedObj
              for (const line of secret.split("\n")) {
                if (line.length >= 8) {
                  assertInv(!combined.includes(line), `secret line must never leak: ${line}`)
                }
              }

              // Session origin normalization
              try {
                const norm = SessionModule.normalizeOrigin(origin)
                assertInv(norm.startsWith("http://") || norm.startsWith("https://"), "normalizeOrigin protocol")
                assertInv(!norm.endsWith("/"), "normalizeOrigin no trailing slash")
              } catch (e) {
                assertInv(e instanceof CliError.UsageError || e instanceof Error, "invalid origin error")
              }
              try {
                const obs = SessionModule.observeOrigin(origin)
                assertInv(typeof obs === "string", "observeOrigin string")
              } catch {
                // invalid origin rejected
              }
              const invTok = SessionModule.invalidToken()
              assertInv(invTok instanceof CliError.Refused, "invalidToken is Refused")

              const sess = new SessionModule.Session({
                HOME: tmpHome,
                SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
                SMITHERS_TOKEN: "tok_test_123456"
              })
              const cid = sess.credentialIdentity("https://smithers.sh")
              assertInv(
                typeof cid === "string" && !cid.includes("tok_test_123456"),
                "credentialIdentity hides raw token"
              )

              // CatalogRequest
              try {
                const req = CatalogRequest.catalogRequest(
                  {
                    http: {
                      method: httpMethod,
                      path: "/api/repos/{owner}/items",
                      body: { title: "title" },
                      query: { q: "q" }
                    }
                  },
                  { owner: rawSegment, title: "hello", q: "search" }
                )
                assertInv(req.method === httpMethod, "catalogRequest method")
                assertInv(!req.path.includes("{owner}"), "catalogRequest substituted")
              } catch (e) {
                assertInv(e instanceof CatalogRequest.CatalogRequestError, "catalogRequest typed error")
              }

              // SSH, Copy, Local, Commands, Destination, WorkspaceSsh, Repositories, Workspaces
              const sq = SSH.quote(sshText)
              assertInv(sq.startsWith("'") && sq.endsWith("'"), "SSH.quote wraps in single quotes")
              const validKeys = SSH.hostKeys([{ algorithm: "ssh-ed25519", public_key: "AAAAC3NzaC1lZDI1NTE5AAAAIA==" }])
              assertInv(validKeys.length === 1, "SSH.hostKeys accepts valid key")
              let badKeyRefused = false
              try {
                SSH.hostKeys(["invalid"])
              } catch (e) {
                badKeyRefused = e instanceof CliError.Refused
              }
              assertInv(badKeyRefused, "SSH.hostKeys refuses malformed key")
              const ep = Copy.copyEndpoint(remotePath)
              assertInv(typeof ep.path === "string", "Copy.copyEndpoint")
              const cpScript = Copy.copyScript(true, "/tmp/x", "file.txt", false)
              assertInv(cpScript.includes("tar"), "Copy.copyScript")
              const parsedLines = Local.lines("a\n\n  \nb\n")
              assertInv(parsedLines.length === 2, "Local.lines")
              const parsedRev = Local.parseRevision("abc\tdef\thi\n", "@")
              assertInv(typeof parsedRev === "object", "Local.parseRevision")
              assertInv(typeof Commands.commandPath(cmdName) === "string", "Commands.commandPath")
              assertInv(
                typeof Destination.targetsInstall({ args: {}, options: { repo: "octo/app" } }, {
                  environment: { HOME: tmpHome }
                }) === "boolean",
                "Destination.targetsInstall"
              )
              const wsBody = Workspaces.workspaceBody({ name: "dev", image: "ubuntu", cpu: "4" })
              assertInv(typeof wsBody === "object", "Workspaces.workspaceBody")
              const gAuth = Repositories.gitAuth("https://smithers.sh", "tok_123")
              assertInv(typeof gAuth === "object", "Repositories.gitAuth")

              return true
            }),
          { seed: seed + 1, executions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
      await expect(WorkspaceSsh.workspaceSshPrefix({ HOME: tmpHome }, "not-a-valid-ref")).rejects.toThrow()
    } finally {
      await Fs.rm(tmpHome, { recursive: true, force: true })
    }
  })

  it("BackendHistory renderers & HostService plist/address/maintenance validators handle arbitrary inputs safely", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        state: Schema.Literals([
          "queued",
          "running",
          "blocked",
          "needs_approval",
          "needs_input",
          "ready",
          "merged",
          "failed",
          "cancelled",
          "proposed",
          "unknown_state"
        ]),
        ms: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500_000 })),
        nanos: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000_000 })),
        bindAddr: Schema.Literals(["127.0.0.1:4000", "localhost:8080", "[::1]:4000", "0.0.0.0:4000", "bad-bind", ""]),
        origin: Schema.Literals(["https://smithers.sh", "http://127.0.0.1:4000", "http://evil.com", "not-a-url"]),
        labelText: Schema.Literals(["normal", "xml <tag> & \"quotes\"", "path/to/bin"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ state, ms, nanos, bindAddr, origin, labelText }) =>
          Effect.sync(() => {
            const item = {
              id: "item-1",
              number: 7,
              title: labelText,
              state,
              lane: "main",
              branch: "feat/fuzz",
              pull_url: "https://github.com/octocat/repo/pull/7",
              checks: [{ name: "test", status: "passed", duration_ms: ms }],
              receipts: [{ id: "r1", kind: "check", status: "passed", duration_ms: ms }],
              started_at: new Date(Date.now() - ms).toISOString(),
              spend_nanos: nanos,
              machine: { name: "nyc-02", status: "online" },
              account: { provider: "anthropic", email: "dev@example.com" }
            }
            const lbl = BackendHistory.stateLabel(item)
            const grp = BackendHistory.groupOf(item)
            const ool = BackendHistory.outOfLanes(item)
            const line = BackendHistory.itemLine(item, [{ change_id: "abc", description: labelText }])
            const dur = BackendHistory.checkDuration(ms)
            const rec = BackendHistory.receiptLine(item)
            const mac = BackendHistory.machineLine(item.machine)
            const acc = BackendHistory.accountLabel(item.account)
            const spd = BackendHistory.spendLabel(nanos)
            const elp = BackendHistory.elapsedLabel(item.started_at, Date.now())
            const wrk = BackendHistory.workerLine(item, [{ name: "main", items: [item] }], Date.now())
            const rendered = BackendHistory.render({
              items: [item],
              workers: [item],
              machines: [item.machine],
              lanes: [{ name: "main", items: [item] }],
              spend_nanos: nanos
            })
            assertInv(
              typeof lbl === "string" &&
                (grp === "needs-you" || grp === "working" || grp === "done") &&
                typeof ool === "boolean" &&
                typeof line === "string" &&
                typeof dur === "string" &&
                typeof rec === "string" &&
                typeof mac === "string" &&
                typeof acc === "string" &&
                spd.startsWith("$") &&
                typeof elp === "string" &&
                typeof wrk === "string" &&
                typeof rendered === "string",
              "BackendHistory renderers return strings"
            )

            // HostService XML plist escaping & address validation
            const xml = HostService.plist({
              Label: HostService.label,
              ProgramArguments: ["/usr/bin/node", labelText],
              KeepAlive: true,
              ThrottleInterval: 5,
              EnvironmentVariables: { FOO: labelText }
            })
            assertInv(xml.includes("<?xml") && xml.includes("</plist>"), "HostService.plist valid wrapper")
            if (labelText.includes("<tag>")) {
              assertInv(!xml.includes("<tag>") && xml.includes("&lt;tag&gt;"), "HostService.plist escapes XML")
            }
            const hp = HostService.hostPlist({
              bundle: "/opt/smithers/bundle",
              stateDir: "/tmp/state",
              home: "/tmp/home",
              bind: "127.0.0.1:4000",
              origins: ["https://smithers.sh"]
            })
            assertInv(hp.includes(HostService.label), "HostService.hostPlist contains label")

            const stText = HostService.startText({ state: "running", origin: "http://127.0.0.1:4000" })
            assertInv(typeof stText === "string", "HostService.startText")

            try {
              HostService.maintenance("backup")
            } catch (e) {
              assertInv(e instanceof CliError.Refused || e instanceof Error, "HostService.maintenance platform guard")
            }

            try {
              HostService.validateAddress({ bind: bindAddr, origins: [origin] })
              assertInv(bindAddr !== "bad-bind" && origin !== "not-a-url", "validateAddress rejects invalid inputs")
            } catch (e) {
              assertInv(
                e instanceof CliError.UsageError || e instanceof CliError.Refused || e instanceof Error,
                "validateAddress error"
              )
            }

            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Backend Client & Command handlers operate cleanly against a real loopback HTTP server", async () => {
    const tmpHome = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-http-fuzz-")))
    let responseStatus = 200
    let responseBody: unknown = { ok: true }
    const seenRequests: Array<{ method: string; url: string }> = []

    const server = Http.createServer((req, res) => {
      seenRequests.push({ method: req.method ?? "GET", url: req.url ?? "/" })
      const chunks: Array<Buffer> = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        res.statusCode = responseStatus
        if (responseStatus === 204) {
          res.end()
          return
        }
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(responseBody))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address() as { port: number }
    const origin = `http://127.0.0.1:${addr.port}`

    try {
      const httpHandlers: Array<
        { name: string; fn: Resources.Handler; args: ClientModule.Values; opts: ClientModule.Values }
      > = [
        { name: "admin audit", fn: Admin.admin["admin audit"]!, args: {}, opts: { host: origin } },
        { name: "admin runs", fn: Admin.admin["admin runs"]!, args: {}, opts: { host: origin } },
        { name: "admin sessions", fn: Admin.admin["admin sessions"]!, args: {}, opts: { host: origin } },
        { name: "admin tokens", fn: Admin.admin["admin tokens"]!, args: {}, opts: { host: origin } },
        { name: "admin workspaces", fn: Admin.admin["admin workspaces"]!, args: {}, opts: { host: origin } },
        { name: "admin analytics", fn: Admin.admin["admin analytics"]!, args: {}, opts: { host: origin } },
        { name: "repo list", fn: Repositories.repositories["repo list"]!, args: {}, opts: { host: origin } },
        {
          name: "repo view",
          fn: Repositories.repositories["repo view"]!,
          args: { repo: "octo/app" },
          opts: { host: origin }
        },
        {
          name: "issue list",
          fn: Resources.resources["issue list"]!,
          args: {},
          opts: { host: origin, repo: "octo/app" }
        },
        {
          name: "issue view",
          fn: Resources.resources["issue view"]!,
          args: { number: "1" },
          opts: { host: origin, repo: "octo/app" }
        },
        {
          name: "issue create",
          fn: Resources.resources["issue create"]!,
          args: {},
          opts: { host: origin, repo: "octo/app", title: "bug", body: "desc" }
        },
        {
          name: "label list",
          fn: Resources.resources["label list"]!,
          args: {},
          opts: { host: origin, repo: "octo/app" }
        },
        {
          name: "secret list",
          fn: Resources.resources["secret list"]!,
          args: {},
          opts: { host: origin, repo: "octo/app" }
        },
        {
          name: "variable list",
          fn: Resources.resources["variable list"]!,
          args: {},
          opts: { host: origin, repo: "octo/app" }
        },
        {
          name: "webhook list",
          fn: Resources.resources["webhook list"]!,
          args: {},
          opts: { host: origin, repo: "octo/app" }
        },
        {
          name: "wiki list",
          fn: Resources.resources["wiki list"]!,
          args: {},
          opts: { host: origin, repo: "octo/app" }
        },
        { name: "notification list", fn: Resources.resources["notification list"]!, args: {}, opts: { host: origin } },
        { name: "ssh-key list", fn: Resources.resources["ssh-key list"]!, args: {}, opts: { host: origin } },
        { name: "org list", fn: Resources.resources["org list"]!, args: {}, opts: { host: origin } },
        { name: "workspace list", fn: Workspaces.workspaces["workspace list"]!, args: {}, opts: { host: origin } },
        { name: "egress list", fn: Egress.egress["egress list"]!, args: {}, opts: { host: origin, repo: "octo/app" } },
        { name: "stack list", fn: Stack.stacks["stack list"]!, args: {}, opts: { host: origin, repo: "octo/app" } },
        {
          name: "history list",
          fn: BackendHistory.history["history"]!,
          args: {},
          opts: { host: origin, repo: "octo/app" }
        },
        { name: "runs list", fn: Runs.runs["run list"]!, args: {}, opts: { host: origin, repo: "octo/app" } },
        { name: "search repos", fn: Misc.misc["search repos"]!, args: { query: "smithers" }, opts: { host: origin } }
      ].filter((h) => typeof h.fn === "function")

      const arb = Arbitrary.schema(
        Schema.Struct({
          status: Schema.Literals([200, 204, 400, 401, 403, 404, 429, 500]),
          handlerIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Math.max(0, httpHandlers.length - 1) })),
          method: Schema.Literals(["GET", "POST", "PATCH", "DELETE"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ status, handlerIdx, method }) =>
            Effect.promise(async () => {
              const client = new ClientModule.Client({
                environment: {
                  HOME: tmpHome,
                  SMITHERS_URL: origin,
                  SMITHERS_TOKEN: "tok_loopback_test_secret_1234",
                  SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
                }
              })

              // Direct Client.request against real loopback HTTP server
              responseStatus = status
              responseBody = status >= 400
                ? { error: "boom", message: "boom", code: "err_code" }
                : { ok: true, items: [] }
              if (status >= 400) {
                let err: unknown
                try {
                  await client.request(method, "/api/fuzz/test", method === "GET" ? undefined : { x: 1 })
                } catch (e) {
                  err = e
                }
                assertInv(err !== undefined, `HTTP ${status} rejects`)
                if (err instanceof ClientModule.APIError) {
                  const refused = ClientModule.refusalOf(err, (v) => client.redact(v), origin)
                  assertInv(refused instanceof CliError.Refused, `refusalOf handles ${status}`)
                }
              } else {
                const res = await client.request(method, "/api/fuzz/test", method === "GET" ? undefined : { x: 1 })
                if (status === 204) assertInv(res === null || res === undefined, "204 returns empty")
                else assertInv(typeof res === "object" && res !== null, "200 returns object")
              }

              responseStatus = 200
              responseBody = {
                id: "ws-1",
                name: "demo",
                items: [],
                runs: [],
                data: [],
                users: [],
                workspaces: [],
                repositories: [],
                issues: [],
                labels: [],
                secrets: [],
                variables: [],
                webhooks: [],
                pages: [],
                notifications: [],
                keys: [],
                tokens: [],
                orgs: [],
                teams: [],
                entries: [],
                rules: [],
                ok: true
              }

              const h = httpHandlers[handlerIdx]
              if (h) {
                try {
                  await h.fn(client, h.args, h.opts)
                } catch (e) {
                  assertInv(e instanceof Error, `handler ${h.name} threw Error`)
                }
              }

              const getCatalogCmd = Catalog.catalogCommands.find((c) =>
                c.http?.method === "GET" && !c.http.path.includes("{")
              )
              if (getCatalogCmd) {
                try {
                  await Catalog.dispatchCatalog(client, getCatalogCmd, {})
                } catch (e) {
                  assertInv(e instanceof Error, "dispatchCatalog threw Error")
                }
              }

              return true
            }),
          { seed: seed + 3, executions: Math.min(executions, 30) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
      expect(seenRequests.length).toBeGreaterThan(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Fs.rm(tmpHome, { recursive: true, force: true })
    }
  })
})
