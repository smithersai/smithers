/**
 * Adversarial properties of the sandbox package's secret and confinement
 * boundaries (#5057's rule, applied to what this package owns):
 *
 * - `HttpSandbox`'s bearer token travels in the `Authorization` header of the
 *   configured origin only: never a URL, a body, another header, another
 *   origin, or a failure's diagnostics, whatever the network or the service
 *   does. `HttpSandbox.serve` fails closed on every forged credential.
 * - `CommandSandbox` carries shell programs and environment secrets on stdin,
 *   so the transport argv the kernel authorizes is constant and bounded, and
 *   a transport failure never names the prefix argv.
 * - Workdir confinement (`SandboxTools.resolve`, `rootedAt`, `parentOf`,
 *   `processDirectory`) and the network allowlist grammar refuse traversal.
 */
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Fuzz } from "@smthrs/fuzz"
import * as GuardedSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Arbitrary, Effect, Exit, FileSystem, Layer, PlatformError, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, posix } from "node:path"
import { inspect } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as HttpSandbox from "../src/HttpSandbox/index.ts"
import { parentOf } from "../src/internal/guestPath.ts"
import { rootedAt } from "../src/internal/rootedPath.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import { refuseNetworkPolicy, validateNetworkPolicy } from "../src/Sandbox/NetworkPolicy.ts"
import type { Provider } from "../src/Sandbox/Provider.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxTools from "../src/SandboxTools/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Fails the property with a message naming the broken invariant. */
const check = (holds: boolean, invariant: string): void => {
  if (!holds) throw new Error(invariant)
}

const base64 = (text: string) => Buffer.from(text).toString("base64")

/** A string built from adversarial fragments. */
const pieces = <const L extends ReadonlyArray<string>>(literals: L, max: number) =>
  Schema.Array(Schema.Literals(literals)).pipe(Schema.check(Schema.isMaxLength(max)))

const byte = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))

/** Header-safe token characters: a real bearer credential, quotes and separators included. */
const tokenPieces = pieces(["a", "Z", "9", "-", "_", ".", "~", "+", "/", "=", ":", "'", "\"", "%2F", "&", "?", "#"], 24)
const tokenOf = (parts: ReadonlyArray<string>) => `tok5057${parts.join("")}`

/** Every way a diagnostic could carry `token`. */
const formsOf = (token: string) => [token, encodeURIComponent(token), base64(token), base64(`Bearer ${token}`)]
const leaks = (text: string, token: string) => formsOf(token).some((form) => text.includes(form))

const services = Effect.runSync(
  Effect.gen(function*() {
    return { fs: yield* FileSystem.FileSystem, spawner: yield* ChildProcessSpawner }
  }).pipe(Effect.provide(platform))
)

/** Real files and processes, retaining logical machine IDs to check every request's identity. */
const machines = (root: string) => {
  const directory = DirectorySandbox.make({
    ...services,
    root: mkdtempSync(join(root, "machines-")),
    persistence: "sticky"
  })
  const held = new Map<string, Pick<Session, "id" | "remoteId">>()
  const asked: Array<Pick<Session, "id" | "remoteId">> = []
  const missing = () => new ProviderError({ code: "not_found", message: "the machine is gone" })
  const provider: Provider = {
    retained: true,
    acquire: (key) =>
      Effect.gen(function*() {
        const remoteId = `machine/${key}`
        asked.push({ id: key, remoteId })
        const session = yield* directory.acquire(key)
        held.set(remoteId, session)
        return { ...session, remoteId }
      }),
    attach: (handle) =>
      Effect.gen(function*() {
        asked.push(handle)
        const actual = held.get(handle.remoteId)
        if (actual === undefined || actual.id !== handle.id) return yield* Effect.fail(missing())
        const session = yield* directory.attach!(actual)
        return { ...session, remoteId: handle.remoteId }
      }),
    destroy: (handle) =>
      Effect.gen(function*() {
        asked.push(handle)
        const actual = held.get(handle.remoteId)
        if (actual === undefined || actual.id !== handle.id) return
        yield* directory.destroy!(actual)
        held.delete(handle.remoteId)
      })
  }
  return { provider, asked }
}

/** One request as it left the client. */
interface Sent {
  readonly url: URL
  readonly method: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

const faults = ["pass", "pass", "pass", "lose", "503", "401", "teapot", "refuse", "garble"] as const
type Fault = typeof faults[number]

/**
 * An `HttpClient` that records each request as it leaves, then lets the
 * network do `plan`'s next fault to it: pass it to `handler`, lose it, or
 * answer in the service's place.
 */
const network = (
  handler: (request: Request) => Effect.Effect<Response>,
  plan: ReadonlyArray<Fault>,
  sent: Array<Sent>
) =>
  HttpClient.make((request) =>
    Effect.gen(function*() {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const body = yield* Effect.promise(() => web.clone().arrayBuffer())
      const fault = plan.length === 0 ? "pass" : plan[sent.length % plan.length]!
      sent.push({
        url: new URL(web.url),
        method: web.method,
        headers: [...web.headers],
        body: Buffer.from(body).toString("latin1")
      })
      if (fault === "lose") {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("connection reset") })
          })
        )
      }
      const response = fault === "pass"
        ? yield* handler(web)
        : fault === "503"
        ? new Response("upstream unavailable", { status: 503 })
        : fault === "401"
        ? new Response(null, { status: 401 })
        : fault === "teapot"
        ? new Response("<html>not json</html>", { status: 418 })
        : fault === "refuse"
        ? new Response(JSON.stringify({ code: "not_found", message: "the machine is gone" }), { status: 404 })
        : new Response("not json", { status: 200 })
      return HttpClientResponse.fromWeb(request, response)
    })
  )

/** `handler` as a server mounts it under `base`'s path: the prefix is the mount's, the rest the handler's. */
const mounted = (base: URL, handler: (request: Request) => Effect.Effect<Response>) => (request: Request) => {
  const url = new URL(request.url)
  url.pathname = url.pathname.slice(base.pathname.replace(/\/+$/, "").length)
  return handler(new Request(url, request))
}

/** Every request carried the token in `Authorization` alone, to the configured origin alone. */
const headersOnly = (sent: ReadonlyArray<Sent>, base: URL, token: string) => {
  for (const request of sent) {
    check(request.url.origin === base.origin, `the token left for another origin: ${request.url.origin}`)
    check(
      request.url.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/v1/`),
      `the request left the service's routes: ${request.url.pathname}`
    )
    check(!leaks(request.url.href, token), "the token is in a URL")
    check(!leaks(decodeURIComponent(request.url.search), token), "the token is in a query")
    check(!leaks(request.body, token), "the token is in a body")
    for (const [name, value] of request.headers) {
      if (name === "authorization") check(value === `Bearer ${token}`, "the Authorization header is not the token")
      else check(!leaks(`${name}: ${value}`, token), `the token is in the ${name} header`)
    }
    check(request.headers.some(([name]) => name === "authorization"), "a request left without its credential")
  }
}

/** A failure says nothing of the token, however deep it is rendered. */
const silent = (exit: Exit.Exit<unknown, unknown>, token: string) => {
  if (Exit.isSuccess(exit)) return
  const rendered = `${inspect(exit, { depth: 12 })}\n${JSON.stringify(exit)}`
  check(!leaks(rendered, token), "a failure's diagnostics carry the token")
}

describe("@smthrs/sandbox secret, transport and confinement fuzz invariants", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-policy-fuzz-")))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  // This executable models SSH's remote shell reparse, using real local processes.
  const ssh = join(root, "ssh")
  writeFileSync(ssh, "#!/bin/sh\nexec /bin/sh -c \"$*\"\n", { mode: 0o755 })

  const guarded = (rules: ReadonlyArray<Rule>) =>
    GuardedSpawner.layer.pipe(
      Layer.provide(ProcessConfinement.layerNoop),
      Layer.provide(GrantStore.layer({ attended: false, rules: [...rules] })),
      Layer.provide(Workspace.layer(root)),
      Layer.provide(platform)
    )
  const spawnAnything = [
    new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" }) })
  ]

  it(
    "HttpSandbox sends its bearer token in the Authorization header of its own origin only, through every network fault",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          token: tokenPieces,
          base: Schema.Literals([
            "http://sandbox.test",
            "http://sandbox.test/tenant/a/",
            "https://sandbox.test:8443/x"
          ]),
          key: pieces(["k", "9", "λ", "/", "..", "%", " ", "'", "😀", "?", "#", "&id=other", "\ud800", "\udc00"], 6),
          path: pieces(["f", "dir/", "..", "λ", " ", "'", "%2e", "?", "#", "&", "="], 6),
          content: Schema.Array(byte).pipe(Schema.check(Schema.isMaxLength(48))),
          command: pieces(["true", ";", " ", "'", "\"", "$HOME", "\n", "λ", "`id`"], 6),
          plan: Schema.Array(Schema.Literals(faults)).pipe(Schema.check(Schema.isMaxLength(7)))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const token = tokenOf(input.token)
              const base = new URL(input.base)
              const key = input.key.join("")
              const content = Uint8Array.from(input.content)
              const { asked, provider: held } = machines(root)
              const sent: Array<Sent> = []
              const provider = HttpSandbox.make({
                url: input.base,
                token,
                client: network(
                  mounted(
                    base,
                    HttpSandbox.serve({ provider: held, token, processDirectory: join(root, "http-records") })
                  ),
                  input.plan,
                  sent
                ),
                processDirectory: join(root, "http-processes"),
                retries: 2,
                retryDelay: "1 millis",
                pollInterval: "1 millis"
              })
              const clean = input.plan.every((fault) => fault === "pass")
              const exits: Array<Exit.Exit<unknown, ProviderError>> = []
              const observed = <A>(effect: Effect.Effect<A, ProviderError>) =>
                Effect.tap(Effect.exit(effect), (exit) => Effect.sync(() => exits.push(exit)))
              const whole = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
                const session = yield* provider.acquire(key)
                // A real guest needs a valid file name. Keep every adversarial fragment in the URL
                // while encoding separators so generated paths cannot escape the fixture's root.
                const path = `${session.workdir}/file-${encodeURIComponent(input.path.join(""))}`
                yield* observed(session.writeFile(path, content))
                const read = yield* observed(session.readFile(path))
                yield* observed(session.ping!)
                const ran = yield* observed(Effect.scoped(Effect.gen(function*() {
                  const child = yield* session.spawn(`printf '%s' ${CommandLine.quote(input.command.join(""))}`, {
                    env: { ORDINARY: "value" }
                  })
                  yield* Stream.runDrain(child.stdout)
                  return yield* child.exitCode
                })))
                if (clean) {
                  check(Exit.isSuccess(read) && Buffer.from(read.value).equals(Buffer.from(content)), "a file changed")
                  check(Exit.isSuccess(ran) && ran.value === 0, "a command's exit was lost")
                }
              })))
              exits.push(whole)
              if (/\p{Surrogate}/u.test(key)) {
                // No URL can name this key's session: refused, typed, before anything is sent.
                check(
                  Exit.isFailure(whole) && Exit.hasFails(whole),
                  `an ill-formed key was not refused: ${inspect(whole)}`
                )
                check(sent.length === 0 && asked.length === 0, "an ill-formed key reached the service")
                return true
              }
              check(sent.length > 0, "nothing was sent")
              headersOnly(sent, base, token)
              for (const exit of exits) {
                silent(exit, token)
                // Every failure is the provider's typed one: no fault is a defect.
                if (Exit.isFailure(exit)) check(Exit.hasFails(exit), `a fault became a defect: ${inspect(exit)}`)
              }
              if (clean) {
                check(exits.every(Exit.isSuccess), `a clean network failed: ${inspect(exits.find(Exit.isFailure))}`)
                // The machine asked for on every route is the one the session key acquired.
                check(
                  asked.every((session) => session.id === key && session.remoteId === `machine/${key}`),
                  `a request named another session: ${JSON.stringify(asked)}`
                )
                check(asked.length >= 6, "a route never reached the provider")
              }
              return true
            }),
          { seed, executions: ioExecutions }
        )
      )
      assertPassed(report)
    },
    180_000
  )

  it("HttpSandbox never follows a hostile service's session answer off its origin or into a defect", async () => {
    const hostile = pieces(
      [
        "m",
        "\udc00",
        "..",
        ".",
        "/",
        "//evil.test/",
        "@evil.test",
        "\\",
        "?x=",
        "#",
        "%2f",
        "%",
        ":",
        " ",
        "λ",
        "😀",
        "\n",
        "\ud800"
      ],
      5
    )
    const arb = Arbitrary.schema(
      Schema.Struct({
        token: tokenPieces,
        base: Schema.Literals(["http://sandbox.test", "http://sandbox.test/tenant/a/", "https://sandbox.test:8443/x"]),
        id: hostile,
        remoteId: hostile,
        workdir: hostile
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const token = tokenOf(input.token)
            const base = new URL(input.base)
            const remoteId = input.remoteId.join("")
            const sent: Array<Sent> = []
            // A service that answers whatever session it likes, then accepts every request.
            const service = (request: Request) =>
              Effect.sync(() => {
                const pathname = new URL(request.url).pathname
                return request.method === "POST" && pathname.endsWith("/v1/sessions")
                  ? new Response(JSON.stringify({ id: input.id.join(""), remoteId, workdir: input.workdir.join("") }))
                  : request.method === "POST"
                  ? new Response(JSON.stringify({ exitCode: 0, stdout: base64("x 0\n"), stderr: "" }))
                  : request.method === "GET"
                  ? new Response(new Uint8Array([1, 2, 3]))
                  : new Response(null, { status: 204 })
              })
            const provider = HttpSandbox.make({
              url: input.base,
              token,
              client: network(service, [], sent),
              retries: 0
            })
            const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
              const session = yield* provider.acquire("key")
              yield* session.writeFile("/f", new Uint8Array([1]))
              yield* session.readFile("/f")
              yield* session.ping!
            })))
            headersOnly(sent, base, token)
            silent(exit, token)
            if (Exit.isFailure(exit)) check(Exit.hasFails(exit), `a hostile answer became a defect: ${inspect(exit)}`)
            if (/\p{Surrogate}/u.test(`${input.id.join("")}${remoteId}`)) {
              // A session a URL cannot name is refused as it is answered: nothing is sent after the acquire.
              check(Exit.isFailure(exit) && sent.length === 1, "an unnameable session was used")
              return true
            }
            // A session segment that is not a dot segment reaches the service as the id it answered.
            if (remoteId !== "" && remoteId !== "." && remoteId !== "..") {
              const prefix = `${base.pathname.replace(/\/+$/, "")}/v1/sessions/`
              for (const request of sent.slice(1)) {
                const segment = request.url.pathname.slice(prefix.length).split("/")[0]!
                check(decodeURIComponent(segment) === remoteId, `the session segment changed: ${segment}`)
              }
            }
            return true
          }),
        { seed: seed + 1, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })

  // Shrunk counterexamples this suite found: `{ key: ["\ud800"] }` and
  // `{ base: "https://sandbox.test:8443/x", remoteId: ["\ud800"] }`. Each died with a `URIError`
  // thrown by `encodeURIComponent` while the session's URL was built, instead of failing typed.
  for (const found of ["key", "remoteId", "id"] as const) {
    it(`HttpSandbox refuses an unpaired surrogate in a session's ${found} with a ProviderError, not a URIError defect`, async () => {
      const sent: Array<Sent> = []
      const answer = {
        id: "key",
        remoteId: "machine",
        workdir: "/work",
        ...found === "key" ? {} : { [found]: "\ud800" }
      }
      const provider = HttpSandbox.make({
        url: "https://sandbox.test:8443/x",
        token: "tok5057",
        client: network(() => Effect.succeed(new Response(JSON.stringify(answer))), [], sent),
        retries: 0
      })
      const exit = await Effect.runPromiseExit(Effect.scoped(provider.acquire(found === "key" ? "\ud800" : "key")))
      expect(Exit.isFailure(exit) && Exit.hasFails(exit)).toBe(true)
      const error = await Effect.runPromise(Effect.flip(exit))
      expect(error).toMatchObject({ code: "unknown", message: expect.stringContaining("unpaired surrogate") })
      // The key is refused before anything is sent; the answer after the acquire alone, with no destroy to build.
      expect(sent.map((request) => request.method)).toEqual(found === "key" ? [] : ["POST"])
    })
  }

  it("HttpSandbox.serve answers every forged credential 401 with nothing, and never a defect for an authorized one", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        token: tokenPieces,
        forgery: Schema.Literals(
          [
            "exact",
            "missing",
            "empty",
            "token-only",
            "dropped-last",
            "extra-last",
            "lowercase-scheme",
            "basic",
            "double-space",
            "padded",
            "case-flipped",
            "other-token",
            "twice",
            "prefix-of-longer"
          ]
        ),
        method: Schema.Literals(["GET", "POST", "PUT", "DELETE", "PATCH"]),
        path: pieces(
          ["/v1/sessions", "/v1", "/", "m-1", "..", "%2e%2e", "%E0%A4%A", "/commands", "/files", "%00", "λ"],
          4
        ),
        query: pieces(
          [
            "id=a",
            "path=/x",
            "path=rel",
            "path=/../etc/passwd",
            "offset=3",
            "offset=-1",
            "offset=1e3",
            "cpus=2",
            "cpus=NaN",
            "memoryMib=",
            "timeoutSecs=1e999"
          ],
          4
        ),
        body: Schema.Literals(
          [
            "",
            "{}",
            "{\"key\":\"k\"}",
            "{\"key\":1}",
            "{\"key\":\"k\",\"limits\":{\"cpus\":1e999}}",
            "{\"id\":\"a\",\"command\":\"true\"}",
            "{\"id\":\"a\",\"command\":\"true\",\"stdin\":\"!!!\"}",
            "{\"id\":\"a\",\"command\":\"true\",\"env\":{\"A\":null}}",
            "not json",
            "[]",
            "null"
          ]
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const token = tokenOf(input.token)
            const expected = `Bearer ${token}`
            const flipped = token.replace(/[a-z]/i, (letter) =>
              letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase())
            const forged: Record<typeof input.forgery, string | undefined> = {
              exact: expected,
              missing: undefined,
              empty: "",
              "token-only": token,
              "dropped-last": expected.slice(0, -1),
              "extra-last": `${expected}x`,
              "lowercase-scheme": `bearer ${token}`,
              basic: `Basic ${base64(`user:${token}`)}`,
              "double-space": `Bearer  ${token}`,
              // HTTP strips a header's outer whitespace, so this one is the token itself.
              padded: ` ${expected}\t`,
              "case-flipped": `Bearer ${flipped}`,
              "other-token": "Bearer tok5057",
              twice: `${expected}, ${expected}`,
              "prefix-of-longer": `${expected}${token}`
            }
            const value = forged[input.forgery]
            const headers = new Headers(value === undefined ? {} : { authorization: value })
            const authorized = headers.get("authorization") === expected
            const { asked, provider } = machines(root)
            const handler = HttpSandbox.serve({ provider, token, processDirectory: join(root, "http-records") })
            const bodied = input.method !== "GET"
            const response = yield* handler(
              new Request(`http://sandbox.test/${input.path.join("/")}?${input.query.join("&")}`, {
                method: input.method,
                headers,
                ...bodied ? { body: input.body } : {}
              })
            )
            const text = yield* Effect.promise(() =>
              response.text()
            )
            if (!authorized) {
              check(response.status === 401, `a forged credential was answered ${response.status}`)
              check(text === "", "a refusal has a body")
              check(asked.length === 0, "a forged credential reached the provider")
              check(!leaks(inspect([...response.headers]), token), "a refusal's headers carry the token")
              return true
            }
            check(response.status !== 401, "the token was refused")
            check([200, 204, 400, 404, 409, 422].includes(response.status), `an unknown status: ${response.status}`)
            check(!leaks(text, token), "an answer carries the token")
            if (response.status >= 400) {
              const failure = JSON.parse(text) as { readonly code?: unknown; readonly message?: unknown }
              check(typeof failure.code === "string" && typeof failure.message === "string", "a shapeless refusal")
            }
            return true
          }),
        { seed: seed + 2, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })

  it(
    "CommandSandbox keeps programs, environment secrets and stdin out of a constant, bounded transport argv",
    async () => {
      const secretPieces = pieces(
        [
          "a",
          " ",
          "'",
          "\"",
          "\\",
          "$HOME",
          "$(id)",
          "`id`",
          ";",
          "&&",
          "|",
          "\n",
          "\r\n",
          "\t",
          "λ",
          "😀",
          "=",
          "#",
          "*"
        ],
        8
      )
      const arb = Arbitrary.schema(
        Schema.Struct({
          names: Schema.Array(Schema.Literals(["TOKEN", "API_KEY", "_x9", "smthrs_env", "smthrs_script"])).pipe(
            Schema.check(Schema.isMaxLength(3))
          ),
          secrets: Schema.Tuple([secretPieces, secretPieces, secretPieces]),
          stdin: Schema.Array(byte).pipe(Schema.check(Schema.isMaxLength(40))),
          withStdin: Schema.Boolean,
          pad: pieces(["x", "'", "\\", "$HOME", "λ", ";", " ", "\""], 4),
          // The last pads the program past the kernel's 64 KiB metadata bound.
          padBytes: Schema.Literals([0, 0, 64, 5000, GrantStore.maximumMetadataBytes + 4096]),
          badName: Schema.Literals(["BAD-NAME", "9LEAD", "A=B", "", "a b", "λ"])
        })
      )
      const report = await Effect.runPromise(
        Effect.gen(function*() {
          const local = yield* ChildProcessSpawner
          const resources: Array<string> = []
          const spawner = makeSpawner((command) => {
            resources.push(CommandLine.render(command))
            return local.spawn(command)
          })
          const session = yield* CommandSandbox.make({ spawner, prefix: [ssh], workdir: join(root, "transport") })
            .acquire(`${basename(root)}-transport`)
          return yield* Fuzz.run(
            arb,
            (input) =>
              Effect.gen(function*() {
                const names = [...new Set(input.names)]
                const env = Object.fromEntries(
                  names.map((name, index) => [name, `s3cr3t5057-${index}-${input.secrets[index]!.join("")}`])
                )
                const unit = `pad5057${input.pad.join("")}`
                const pad = unit.repeat(Math.ceil(input.padBytes / unit.length))
                const stdin = input.withStdin ? Uint8Array.from(input.stdin) : undefined
                const script = `# ${pad}\n${names.map((name) => `printf '%s\\037' "$${name}"`).join("; ")}\ncat`
                const before = resources.length
                const output = yield* Effect.scoped(Effect.gen(function*() {
                  const child = yield* session.spawn(script, { env, ...stdin === undefined ? {} : { stdin } })
                  const chunks = yield* Stream.runCollect(child.stdout)
                  check((yield* child.exitCode) === 0, "the command failed")
                  return Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk)))
                }))
                const expected = Buffer.concat([
                  ...names.map((name) => Buffer.from(`${env[name]!}\u001f`)),
                  Buffer.from(stdin ?? new Uint8Array())
                ])
                check(output.equals(expected), `the guest saw other bytes: ${inspect(output.toString())}`)
                check(resources.length > before, "no transport ran")
                for (const resource of resources.slice(before)) {
                  check(
                    resource.length <= GrantStore.maximumCapabilityResourceLength,
                    `the transport argv outgrew its bound: ${resource.length}`
                  )
                  check(!resource.includes("5057"), "the transport argv carries a program or a secret")
                  for (const secret of Object.values(env)) {
                    check(!resource.includes(base64(secret)), "the transport argv carries an encoded secret")
                  }
                }
                // A name no shell carries is refused before the transport, naming the name and never the value.
                const refused = yield* Effect.flip(
                  Effect.scoped(session.spawn("true", { env: { [input.badName]: "s3cr3t5057-refused" } }))
                )
                check(refused.code === "spawn_error", `an unusable name was ${refused.code}`)
                check(!inspect(refused, { depth: 12 }).includes("s3cr3t5057"), "a refusal carries the value")
                return true
              }),
            // Every execution is a real process chain, so this property takes the fewest the suite's I/O budget allows.
            { seed: seed + 3, executions: Math.min(ioExecutions, 15) }
          ).pipe(
            // Whatever the program, the environment or the input, the kernel authorized one argv.
            Effect.tap(() => Effect.sync(() => expect(new Set(resources).size).toBe(1)))
          )
        }).pipe(Effect.scoped, Effect.provide(guarded(spawnAnything)))
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "CommandSandbox never names its prefix argv in a transport failure, and the kernel refuses an oversized prefix whole",
    async () => {
      const reasons = ["NotFound", "PermissionDenied", "Unknown", "TimedOut", "BadResource"] as const
      const arb = Arbitrary.schema(
        Schema.Struct({
          credential: tokenPieces,
          reason: Schema.Literals(reasons),
          effectful: Schema.Boolean,
          joins: Schema.Literals(["joined", "apart", "default"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const credential = tokenOf(input.credential)
              const prefix = ["ssh", "-o", `ProxyCommand=gateway --token ${credential}`, "machine"]
              // The transport fails as a platform does: with an error that names the whole argv.
              const spawner = makeSpawner((command) =>
                Effect.fail(PlatformError.systemError({
                  _tag: input.reason,
                  module: "ChildProcess",
                  method: "spawn",
                  description: CommandLine.render(command),
                  pathOrDescriptor: CommandLine.render(command)
                }))
              )
              const exit = yield* Effect.exit(Effect.scoped(
                CommandSandbox.make({
                  spawner,
                  prefix: input.effectful ? Effect.succeed(prefix) : prefix,
                  joinsArguments: input.joins === "default" ? undefined : input.joins === "joined",
                  workdir: "/work"
                }).acquire("session")
              ))
              check(Exit.isFailure(exit) && Exit.hasFails(exit), "an unreachable machine was acquired")
              silent(exit, credential)
              const error = yield* Effect.flip(Effect.scoped(
                CommandSandbox.make({ spawner, prefix, workdir: "/work" }).acquire("session")
              ))
              check(error.code === "unavailable" && error.cause === undefined, "the failure kept its cause")
              check(error.message.includes(input.reason), "the failure lost its kind")
              return true
            }),
          { seed: seed + 4, executions: pureExecutions }
        )
      )
      assertPassed(report)

      const sizes = Arbitrary.schema(
        Schema.Struct({
          bytes: Schema.Literals([
            0,
            GrantStore.maximumCapabilityResourceLength + 1,
            GrantStore.maximumMetadataBytes - 1,
            GrantStore.maximumMetadataBytes,
            GrantStore.maximumMetadataBytes + 1,
            2 * GrantStore.maximumMetadataBytes
          ]),
          joins: Schema.Boolean
        })
      )
      const bounded = await Effect.runPromise(
        Effect.gen(function*() {
          const local = yield* ChildProcessSpawner
          let acquired = 0
          return yield* Fuzz.run(
            sizes,
            (input) =>
              Effect.gen(function*() {
                const resources: Array<string> = []
                const spawner = makeSpawner((command) => {
                  resources.push(CommandLine.render(command))
                  return local.spawn(command)
                })
                const pad = "p".repeat(input.bytes)
                const exit = yield* Effect.exit(Effect.scoped(
                  CommandSandbox.make({
                    spawner,
                    // Joined, the argv crosses the reparsing fixture; apart, `env` carries it as it is.
                    prefix: input.joins ? [ssh, "env", `PAD5057=${pad}`] : ["/usr/bin/env", `PAD5057=${pad}`],
                    joinsArguments: input.joins,
                    workdir: join(root, "bounded")
                  }).acquire(`${basename(root)}-bounded-${acquired++}`)
                ))
                // The kernel authorizes the complete argv or none of it: a small one runs, and one past its
                // metadata bound is refused whole, never truncated or hashed into running.
                if (input.bytes <= GrantStore.maximumCapabilityResourceLength + 1) {
                  check(Exit.isSuccess(exit), `a bounded transport argv was refused: ${inspect(exit)}`)
                }
                if (input.bytes >= GrantStore.maximumMetadataBytes) {
                  check(Exit.isFailure(exit), "an oversized transport argv was authorized")
                }
                if (Exit.isSuccess(exit)) return true
                const error = yield* Effect.flip(exit)
                check(
                  error.code === "unavailable" && error.message.includes("PermissionDenied"),
                  `not a refusal: ${inspect(error)}`
                )
                check(resources.length === 1, "the transport ran again after its refusal")
                check(error.cause === undefined && !inspect(error, { depth: 12 }).includes("PAD5057"), "argv leaked")
                check(error.message.length < 256, "the refusal is unbounded")
                return true
              }),
            { seed: seed + 5, executions: Math.min(ioExecutions, 6) }
          )
        }).pipe(Effect.provide(guarded(spawnAnything)))
      )
      assertPassed(bounded)
    },
    60_000
  )

  it("workdir confinement refuses every traversal, and rooting then confining is confining", async () => {
    const segment = [
      "a",
      "b.txt",
      ".",
      "..",
      "...",
      "",
      " ",
      "λ",
      "😀",
      "\\",
      "..\\..",
      "%2e%2e",
      "~",
      "-rf",
      "*",
      "\n"
    ]
    const arb = Arbitrary.schema(
      Schema.Struct({
        workdir: pieces(["work", "space", "λ", "a b", "deep/er"], 3),
        slashes: Schema.Literals(["", "/", "//"]),
        absolute: Schema.Boolean,
        path: pieces(segment as ReadonlyArray<string>, 7),
        nul: Schema.Boolean,
        drive: Schema.Literals(["C:\\work", "c:/", "D:\\a\\b\\", "\\\\server\\share"]),
        processDirectory: pieces(["/", "tmp", ".smthrs", "..", ".", "a b", "$(id)", "'", ";", "λ", "-", "_"], 6)
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) => {
          const root = `/${input.workdir.join("/")}`.replace(/\/+$/, "") || "/"
          const workdir = `${root}${root === "/" ? "" : input.slashes}`
          const joined = input.path.join("/")
          const path = `${input.absolute ? "/" : ""}${joined}${input.nul ? "\0" : ""}`
          const inside = (candidate: string) =>
            candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`)

          const resolved = SandboxTools.resolve(workdir, path)
          const named = posix.resolve(root, path)
          if (resolved !== undefined) {
            check(inside(resolved), `resolve left the workdir: ${resolved}`)
            check(!resolved.includes("\0"), "resolve kept a NUL")
            check(
              resolved === "/" || resolved.slice(1).split("/").every((part) => !["", ".", ".."].includes(part)),
              `resolve kept a dot segment: ${resolved}`
            )
            check(resolved === named, `resolve named another entry than the guest would: ${resolved} vs ${named}`)
            check(SandboxTools.resolve(workdir, resolved) === resolved, "resolve is not idempotent")
          } else if (!input.nul && inside(named)) {
            // A refusal of a path that stays inside is one that climbed above the filesystem root on the way.
            check(path.split("/").includes(".."), `resolve refused a plain inside path: ${path}`)
          }
          if (input.nul) check(resolved === undefined, "resolve accepted a NUL")
          if (!inside(named)) check(resolved === undefined, `resolve accepted a traversal: ${path}`)

          const rooted = rootedAt(workdir)(path)
          if (path.startsWith("/")) check(rooted === path, "rootedAt changed an absolute path")
          else {
            check(inside(rooted), `rootedAt left its root by prefix: ${rooted}`)
            check(!rooted.slice(root.length).startsWith("//"), `rootedAt doubled a slash: ${rooted}`)
            // Rooting a relative path never changes what confinement decides about it.
            check(SandboxTools.resolve(workdir, rooted) === resolved, "rooting changed confinement")
          }
          check(rootedAt(workdir)(rooted) === rooted, "rootedAt is not idempotent")
          const parent = parentOf(rooted)
          if (parent !== undefined) check(parent !== "" && rooted.startsWith(`${parent}/`), "parentOf is no prefix")

          // A Windows guest: separators are normalized, and a drive-absolute path is its own root.
          const windows = rootedAt(input.drive)(joined.replaceAll("/", "\\"))
          check(!windows.includes("\\"), `a Windows path kept a backslash: ${windows}`)
          check(rootedAt(input.drive)(windows) === windows, "a Windows rooting is not idempotent")

          const directory = input.processDirectory.join("")
          const made = Exit.isSuccess(Effect.runSyncExit(Effect.try(() =>
            HttpSandbox.make({
              url: "http://sandbox.test",
              token: "t",
              client: HttpClient.make(() => Effect.die("unused")),
              processDirectory: directory
            })
          )))
          if (made) {
            check(directory.startsWith("/") && !directory.split("/").includes(".."), "a traversing processDirectory")
            check(/^[A-Za-z0-9._/-]*$/.test(directory), "a processDirectory a shell would reparse")
            check(posix.normalize(directory).startsWith("/"), "a relative processDirectory")
          } else {
            check(
              !directory.startsWith("/") || directory.split("/").includes("..") || /[^A-Za-z0-9._/-]/.test(directory),
              `a plain absolute processDirectory was refused: ${directory}`
            )
          }
          return true
        },
        { seed: seed + 6, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })

  it("the network allowlist accepts exact DNS names and one leading wildcard, and fails closed on everything else", async () => {
    const label = [
      "a",
      "example",
      "com",
      "xn--bcher-kva",
      "A1",
      "-",
      "a-b",
      "-a",
      "a-",
      "_",
      "*",
      "é",
      "ａ",
      "",
      " ",
      "\n",
      "\0",
      ":443",
      "/path",
      "http://",
      "user@",
      "%2e",
      "a".repeat(63),
      "a".repeat(64)
    ]
    const arb = Arbitrary.schema(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            wildcard: Schema.Literals(["", "", "*.", "*", "**.", ".*."]),
            labels: pieces(label as ReadonlyArray<string>, 5),
            tail: Schema.Literals(["", "", "", ".", "\n", " "])
          })
        ).pipe(Schema.check(Schema.isMaxLength(4))),
        kind: Schema.Literals(["allow", "allow", "allow", "none", "open", "malformed"])
      })
    )
    const plain = /^[A-Za-z0-9-]{1,63}$/
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) => {
          const allow = input.entries.map((entry) => `${entry.wildcard}${entry.labels.join(".")}${entry.tail}`)
          const valid = (entry: string) => {
            const names = (entry.startsWith("*.") ? entry.slice(2) : entry).split(".")
            return entry.length <= 253 &&
              names.every((name) => plain.test(name) && !name.startsWith("-") && !name.endsWith("-"))
          }
          if (input.kind === "none" || input.kind === "open") {
            const named = input.kind
            check(validateNetworkPolicy("fuzz", named) === named, "a named policy changed")
            const refused = Exit.isFailure(Effect.runSyncExit(Effect.try(() => refuseNetworkPolicy("fuzz", named))))
            check(refused === (named === "none"), "refuseNetworkPolicy misjudged a named policy")
            return true
          }
          const policy = input.kind === "malformed"
            ? { allow: allow.join(",") } as unknown as { readonly allow: ReadonlyArray<string> }
            : { allow }
          const exit = Effect.runSyncExit(Effect.try(() => validateNetworkPolicy("fuzz", policy)))
          const expected = input.kind === "allow" && allow.every(valid)
          check(Exit.isSuccess(exit) === expected, `the allowlist ${JSON.stringify(allow)} was misjudged`)
          if (Exit.isSuccess(exit)) check(exit.value === policy, "an accepted policy was rewritten")
          // A provider that enforces nothing refuses every restriction, the empty allowlist included.
          check(
            Exit.isFailure(Effect.runSyncExit(Effect.try(() => refuseNetworkPolicy("fuzz", policy)))),
            "an unenforceable restriction was accepted"
          )
          refuseNetworkPolicy("fuzz", undefined)
          return true
        },
        { seed: seed + 7, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })
})
