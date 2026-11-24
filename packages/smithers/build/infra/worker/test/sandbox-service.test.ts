import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import type * as CloudflareSandbox from "@smthrs/sandbox/CloudflareSandbox"
import * as HttpSandbox from "@smthrs/sandbox/HttpSandbox"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Stream from "effect/Stream"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { sandboxInstanceTypes } from "../sandbox-instances.ts"
import { makeSandboxService, type SandboxWorkerEnv } from "../SandboxService.ts"

// -----------------------------------------------------------------------------
// The Cloudflare Sandbox SDK slice `CloudflareSandbox` takes, as a fake: the
// binding resolution, the base64 file framing and the FILE_NOT_FOUND error
// shape are the vendor's; every command underneath is a real `sh -c` and every
// file a real file. Paths are real: the service's workdir and the client's
// process directory both live under this suite's root.
// -----------------------------------------------------------------------------

const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-sandbox-service-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const spawner = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(
    Effect.provide(Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, Path.layer)))
  )
)

const runSh = (command: string, cwd: string | undefined, env: Record<string, string | undefined> | undefined) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", ["-c", command], { cwd, env: env ?? {}, extendEnv: true })
        )
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode
        ], { concurrency: "unbounded" })
        return { exitCode: Number(exitCode), stdout, stderr }
      })
    )
  )

class FileNotFound extends Error {
  readonly code = "FILE_NOT_FOUND"
}

/** One Durable Object binding: every sandbox it resolved, by id, and how. */
class FakeBinding {
  readonly resolutions: Array<{ readonly id: string; readonly options: unknown }> = []
  readonly destroyed: Array<string> = []
  readonly name: string
  constructor(name: string) {
    this.name = name
  }
}

const sdk: CloudflareSandbox.Sdk<FakeBinding> = {
  getSandbox: (binding, id, options) => {
    binding.resolutions.push({ id, options })
    return {
      mkdir: async (path, mkdirOptions) => mkdirSync(path, { recursive: mkdirOptions?.recursive === true }),
      writeFile: async (path, content) => writeFileSync(path, Buffer.from(content, "base64")),
      readFile: async (path) => {
        try {
          return { content: readFileSync(path).toString("base64") }
        } catch {
          throw new FileNotFound(`missing ${path}`)
        }
      },
      exec: (command, commandOptions) => runSh(command, commandOptions?.cwd, commandOptions?.env),
      startProcess: () => Promise.reject(new Error("the service runs commands in exec mode")),
      destroy: async () => {
        binding.destroyed.push(id)
      }
    }
  }
}

const token = "a-sandbox-service-bearer-token-0123456789"

const bindings = () => {
  const [large, small] = sandboxInstanceTypes.map((instance) => new FakeBinding(instance.name))
  const env: SandboxWorkerEnv<FakeBinding> = {
    SANDBOX_TOKEN: token,
    SANDBOX_STANDARD_4: large!,
    SANDBOX_STANDARD_3: small!
  }
  return { env, large: large!, small: small! }
}

const workdir = join(root, "workspace")
const worker = makeSandboxService({ sdk, workdir })

/** An `HttpClient` whose network is the Worker's `fetch` in this process. */
const clientOf = (env: SandboxWorkerEnv<FakeBinding>) =>
  HttpClient.make((request) =>
    Effect.gen(function*() {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const response = yield* Effect.promise(() => worker.fetch(web, env))
      return HttpClientResponse.fromWeb(request, response)
    })
  )

const providerOf = (env: SandboxWorkerEnv<FakeBinding>, options: Partial<HttpSandbox.HttpSandboxOptions> = {}) =>
  HttpSandbox.make({
    url: "https://sandbox.test",
    token,
    client: clientOf(env),
    processDirectory: join(root, "processes"),
    pollInterval: "5 millis",
    ...options
  })

const decoder = new TextDecoder()
const encoder = new TextEncoder()

describe("sandbox service", () => {
  it("acquires, runs, polls, moves files and destroys a machine through HttpSandbox.make", async () => {
    const { env, large, small } = bindings()
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const session = yield* providerOf(env, { pollBytes: 4 }).acquire("ci:build-1")
          yield* session.writeFile(`${session.workdir}/input.txt`, encoder.encode("hello from the host\n"))
          const child = yield* session.spawn("cat input.txt; echo warning >&2; exit 3", {
            cwd: session.workdir,
            env: { SANDBOX_PROOF: "set" }
          })
          const [stdout, stderr, exitCode] = yield* Effect.all([
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
            child.exitCode
          ], { concurrency: "unbounded" })
          const environment = yield* session.spawn("printf %s \"$SANDBOX_PROOF\" > env.txt", {
            cwd: session.workdir,
            env: { SANDBOX_PROOF: "set" }
          })
          yield* environment.exitCode
          const written = yield* session.readFile(`${session.workdir}/env.txt`)
          const missing = yield* Effect.flip(session.readFile(`${session.workdir}/absent.txt`))
          return { session, stdout, stderr, exitCode, written: decoder.decode(written), missing }
        })
      )
    )

    expect(outcome.session.remoteId).toMatch(/^standard-4-/)
    expect(outcome.session.workdir).toBe(workdir)
    expect(outcome.stdout).toBe("hello from the host\n")
    expect(outcome.stderr).toBe("warning\n")
    expect(outcome.exitCode).toBe(3)
    expect(outcome.written).toBe("set")
    expect(outcome.missing.code).toBe("not_found")
    // Every request resolved the one machine of the session's key, with the
    // SDK's implicit shell session off, and closing the scope destroyed it.
    expect(new Set(large.resolutions.map((resolution) => resolution.id))).toEqual(new Set([outcome.session.remoteId]))
    expect(large.resolutions.map((resolution) => resolution.options)).toEqual(
      large.resolutions.map(() => ({ enableDefaultSession: false }))
    )
    expect(large.destroyed).toEqual([outcome.session.remoteId])
    expect(small.resolutions).toEqual([])
  })

  it("serves the smallest declared instance type that holds the session's limits", async () => {
    const { env, large, small } = bindings()
    const remoteId = await Effect.runPromise(
      Effect.scoped(
        Effect.map(providerOf(env, { limits: { cpus: 2, memoryMib: 4096 } }).acquire("small"), (s) => s.remoteId)
      )
    )
    const refused = await Effect.runPromise(
      Effect.flip(Effect.scoped(providerOf(env, { limits: { cpus: 8 } }).acquire("too-large")))
    )

    expect(remoteId).toMatch(/^standard-3-/)
    expect(small.destroyed).toEqual([remoteId])
    expect(large.resolutions).toEqual([])
    expect(refused.message).toContain("no declared instance has at least 8 cpus")
  })

  it("refuses a request without the service's token before it reaches a machine", async () => {
    const { env, large, small } = bindings()
    const refused = await Effect.runPromise(
      Effect.flip(Effect.scoped(providerOf(env, { token: "not-the-service-token-0123456789" }).acquire("intruder")))
    )
    const bare = await worker.fetch(new Request("https://sandbox.test/v1/sessions", { method: "POST" }), env)

    expect(refused.code).toBe("unknown")
    expect(refused.message).toContain("refused the token")
    expect(bare.status).toBe(401)
    expect(large.resolutions).toEqual([])
    expect(small.resolutions).toEqual([])
  })

  it("counts each request including authentication failures and binding defects", async () => {
    const rows: Array<AnalyticsEngineDataPoint> = []
    const env = {
      ...bindings().env,
      SANDBOX_REQUEST_METRICS: {
        writeDataPoint(point?: AnalyticsEngineDataPoint) {
          if (point) rows.push(point)
        }
      }
    }
    const request = (authorized: boolean) =>
      new Request("https://sandbox.test/v1/sessions", {
        method: "POST",
        headers: authorized ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify({ key: "metrics-session" })
      })
    expect((await worker.fetch(request(false), env)).status).toBe(401)
    expect((await worker.fetch(request(true), env)).status).toBe(200)
    expect(
      (await worker.fetch(request(true), {
        ...env,
        get SANDBOX_STANDARD_4(): FakeBinding {
          throw new Error("binding unavailable")
        }
      })).status
    ).toBe(503)
    expect(rows.map((row) => row.blobs)).toEqual(["401", "200", "503"].map((status) => ["sessions", "POST", status]))
    expect(rows.every((row) => Number(row.doubles?.[0]) >= 0)).toBe(true)
  })

  it("logs a handler failure by name and code only, and still counts it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const rows: Array<AnalyticsEngineDataPoint> = []
      const response = await worker.fetch(
        new Request("https://sandbox.test/v1/sessions?key=query-secret", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-private": "header-secret" },
          body: JSON.stringify({ key: "payload-secret" })
        }),
        {
          ...bindings().env,
          SANDBOX_REQUEST_METRICS: {
            writeDataPoint(point?: AnalyticsEngineDataPoint) {
              if (point) rows.push(point)
            }
          },
          get SANDBOX_STANDARD_4(): FakeBinding {
            throw Object.assign(new Error(`binding refused Bearer ${token}`), { code: "BINDING_DOWN" })
          }
        }
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        code: "unavailable",
        message: "the sandbox service could not handle the request"
      })
      expect(rows.map((row) => row.blobs)).toEqual([["sessions", "POST", "503"]])
      expect(errors.mock.calls).toEqual([["smithers sandbox service: request failed (name=Error code=BINDING_DOWN)"]])
    } finally {
      errors.mockRestore()
    }
  })

  it("counts a request whose URL does not parse as other and answers it without throwing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const rows: Array<AnalyticsEngineDataPoint> = []
      const parsed = new Request("https://sandbox.test/v1/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: "payload-secret" })
      })
      // A runtime can hand a Worker a request line no URL parser accepts; `Request` itself refuses to build one.
      const unparseable = new Proxy(parsed, {
        get: (target, property) => {
          if (property === "url") return "//[v1/sessions?key=query-secret"
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
      const response = await worker.fetch(unparseable, {
        ...bindings().env,
        SANDBOX_REQUEST_METRICS: {
          writeDataPoint(point?: AnalyticsEngineDataPoint) {
            if (point) rows.push(point)
          }
        }
      })
      expect(response.status).toBe(503)
      expect(rows.map((row) => row.blobs)).toEqual([["other", "POST", "503"]])
      expect(errors.mock.calls).toHaveLength(1)
      const line = String(errors.mock.calls[0]?.[0])
      expect(line).toMatch(/^smithers sandbox service: request failed \([A-Za-z0-9_.=$ -]+\)$/)
      for (const secret of [token, "query-secret", "payload-secret", "v1/sessions"]) expect(line).not.toContain(secret)
    } finally {
      errors.mockRestore()
    }
  })

  it("keeps unrecognized input out of metrics and tolerates a lost datapoint", async () => {
    const request = new Request("https://sandbox.test/private-session?key=hidden", { method: "PATCH" })
    const rows: Array<AnalyticsEngineDataPoint | undefined> = []
    const response = await worker.fetch(request, {
      ...bindings().env,
      SANDBOX_REQUEST_METRICS: {
        writeDataPoint(point) {
          rows.push(point)
          throw new Error("metrics unavailable")
        }
      }
    })
    expect(response.status).toBe(401)
    expect(rows).toEqual([{ indexes: ["other"], blobs: ["other", "other", "401"], doubles: [expect.any(Number)] }])
  })

  it("answers 503 to every request when the Worker was deployed without its token", async () => {
    const { env, large } = bindings()
    const response = await worker.fetch(
      new Request("https://sandbox.test/v1/sessions", { method: "POST", body: JSON.stringify({ key: "anyone" }) }),
      { ...env, SANDBOX_TOKEN: undefined }
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "unavailable", message: "the sandbox service has no SANDBOX_TOKEN" })
    expect(large.resolutions).toEqual([])
  })
})
