import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, FileSystem, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as HttpSandbox from "../src/HttpSandbox/index.ts"
import { uploadScript, uploadStage } from "../src/HttpSandbox/upload.ts"
import type { RemoteOptions } from "../src/RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import type { ResourceLimits } from "../src/Sandbox/ResourceLimits.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { platform } from "./helpers/containedPlatform.ts"
import { makeWorkSeed } from "./helpers/workSeed.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-http-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const services = Effect.runSync(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    return { fs, spawner }
  }).pipe(Effect.provide(platform))
)

let made = 0
const fresh = (name: string) => {
  const directory = join(root, `${name}-${made++}`)
  mkdirSync(directory, { recursive: true })
  return directory
}

/** A retained provider whose machines are real directories and whose commands are real processes. */
const machines = () => DirectorySandbox.make({ ...services, root: fresh("machines"), persistence: "sticky" })

const token = "a-test-token"
const base = "http://sandbox.test"

/**
 * What the network does to one request: pass it to the service, or answer
 * in its place. `forward` runs the service; `lose` is a transport failure.
 */
type Fault = (
  request: Request,
  forward: Effect.Effect<Response, HttpClientError.HttpClientError>,
  lose: Effect.Effect<never, HttpClientError.HttpClientError>
) => Effect.Effect<Response, HttpClientError.HttpClientError>

/** An `HttpClient` that hands every request to `handler` in this process, through `fault`. */
const inProcess = (handler: (request: Request) => Effect.Effect<Response>, fault: Fault) =>
  HttpClient.make((request) =>
    Effect.gen(function*() {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const lose = Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("connection reset") })
        })
      )
      const response = yield* fault(web, Effect.suspend(() => handler(web)), lose)
      return HttpClientResponse.fromWeb(request, response)
    })
  )

const pass: Fault = (_request, forward) => forward

/** The command a `commands` request carries, or `""` for any other request. */
const commandOf = (request: Request) =>
  Effect.promise(async () =>
    request.method === "POST" && new URL(request.url).pathname.endsWith("/commands")
      ? (JSON.parse(await request.clone().text()) as { readonly command: string }).command
      : ""
  )

/** Applies `act` to the first `times` requests `matches` selects, passing every other. */
const counted = (
  matches: (request: Request) => Effect.Effect<boolean>,
  act: Fault,
  times = 1
) => {
  const state = { seen: 0 }
  const fault: Fault = (request, forward, lose) =>
    Effect.flatMap(matches(request), (selected) => {
      if (!selected) return forward
      state.seen += 1
      return state.seen <= times ? act(request, forward, lose) : forward
    })
  return { fault, state }
}

const isCommand = (text: string) => (request: Request) =>
  Effect.map(commandOf(request), (command) => command.includes(text))

const isRoute = (method: string, suffix: string) => (request: Request) =>
  Effect.succeed(request.method === method && new URL(request.url).pathname.endsWith(suffix))

const fabricated = (exitCode: number, stderr: string, stdout = "") =>
  Effect.succeed(
    new Response(
      JSON.stringify({
        exitCode,
        stdout: Buffer.from(stdout).toString("base64"),
        stderr: Buffer.from(stderr).toString("base64")
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  )

const broken = (status: number) =>
  Effect.succeed(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("cut"))
        }
      }),
      { status }
    )
  )

const client = (
  handler: (request: Request) => Effect.Effect<Response>,
  options: Partial<HttpSandbox.HttpSandboxOptions> & { readonly fault?: Fault } = {}
) =>
  HttpSandbox.make({
    url: base,
    token,
    client: inProcess(handler, options.fault ?? pass),
    pollInterval: "10 millis",
    retryDelay: "1 millis",
    ...options
  })

const text = (chunks: Iterable<Uint8Array>) => Buffer.concat(Array.from(chunks)).toString("utf8")

const runIn = (session: Sandbox.Session, command: string, options: RemoteOptions = {}) =>
  Effect.scoped(Effect.gen(function*() {
    const child = yield* session.spawn(command, options)
    const [stdout, stderr, code] = yield* Effect.all([
      Stream.runCollect(child.stdout),
      Stream.runCollect(child.stderr),
      child.exitCode
    ], { concurrency: "unbounded" })
    return { chunks: Array.from(stdout), stdout: text(stdout), stderr: text(stderr), code }
  }))

const failureOf = <A>(effect: Effect.Effect<A, ProviderError>) =>
  Effect.map(Effect.flip(effect), (error) => {
    expect(error).toBeInstanceOf(ProviderError)
    return error
  })

const raw = (
  handler: (request: Request) => Effect.Effect<Response>,
  method: string,
  path: string,
  init: { readonly body?: BodyInit; readonly authorization?: string | null } = {}
) =>
  Effect.flatMap(
    handler(
      new Request(`${base}${path}`, {
        method,
        headers: init.authorization === null ? {} : { authorization: init.authorization ?? `Bearer ${token}` },
        ...init.body === undefined ? {} : { body: init.body, duplex: "half" }
      } as RequestInit)
    ),
    (response) => Effect.promise(async () => ({ status: response.status, body: await response.text() }))
  )

const pgrep = (pattern: string) => spawnSync("pgrep", ["-f", pattern]).status === 0

/** Waits until no process matches `pattern`, at most five seconds. */
const gone = (pattern: string) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 100 && pgrep(pattern); attempt += 1) yield* Effect.sleep("50 millis")
    return !pgrep(pattern)
  })

describe("HttpSandbox", () => {
  it.live("conforms to the session contract over the in-process service", () =>
    Effect.gen(function*() {
      const handler = HttpSandbox.serve({ provider: machines(), token })
      const violations = yield* SandboxConformance.check(client(handler), {
        provides: { kill: true, ping: true, interrupt: true, ephemeral: true },
        checkTimeout: "60 seconds",
        work: makeWorkSeed()
      })
      expect(violations).toEqual([])
    }), 600_000)

  it.live("streams a command's output across polls and reports its exit code", () =>
    Effect.gen(function*() {
      const processes = fresh("processes")
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
        processDirectory: processes
      }).acquire("streams")
      const run = yield* Effect.scoped(Effect.gen(function*() {
        // The command waits for a file only the test writes, after it has
        // read the first output: that output crossed while the command ran.
        const child = yield* session.spawn(
          "printf a; printf b >&2; while [ ! -e go ]; do sleep 0.05; done; printf c; exit 7",
          {}
        )
        const first = text(yield* Stream.runCollect(Stream.take(child.stdout, 1)))
        yield* session.writeFile(`${session.workdir}/go`, new Uint8Array())
        const [rest, stderr, code] = yield* Effect.all([
          Stream.runCollect(child.stdout),
          Stream.runCollect(child.stderr),
          child.exitCode
        ], { concurrency: "unbounded" })
        return { first, rest: text(rest), stderr: text(stderr), code }
      }))
      expect(run).toEqual({ first: "a", rest: "c", stderr: "b", code: 7 })
      // The command's records leave the machine with it.
      expect(readdirSync(processes)).toEqual([])
    }).pipe(Effect.scoped), 120_000)

  it.live("reads output larger than one poll across several polls", () =>
    Effect.gen(function*() {
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), { pollBytes: 4 })
        .acquire("large-output")
      const run = yield* runIn(session, "printf 0123456789; printf abcdefghij >&2")
      expect(run).toMatchObject({ stdout: "0123456789", stderr: "abcdefghij", code: 0 })
      expect(run.chunks.map((chunk) => chunk.length)).toEqual([4, 4, 2])
    }).pipe(Effect.scoped), 120_000)

  it.live("delivers removals and assignments of the environment", () =>
    Effect.gen(function*() {
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token })).acquire("environment")
      const run = yield* runIn(session, "printf '%s%s' \"${HOME-unset}\" \"$SMTHRS_HTTP\"", {
        env: { HOME: undefined, SMTHRS_HTTP: "-set" }
      })
      expect(run.stdout).toBe("unset-set")
    }).pipe(Effect.scoped), 120_000)

  it.live("refuses both incompatible writer generations before changing a file", () =>
    Effect.scoped(Effect.gen(function*() {
      const handler = HttpSandbox.serve({ provider: machines(), token })
      let writes = 0
      const session = yield* client(handler, {
        fault: (request, forward) =>
          Effect.gen(function*() {
            if (request.method === "PUT") writes++
            const response = yield* forward
            if (request.method !== "POST") return response
            const { id, remoteId, workdir } = yield* Effect.promise(() => response.json())
            return Response.json({ id, remoteId, workdir })
          })
      }).acquire("rolling-upgrade")
      const path = join(session.workdir, "file")
      writeFileSync(path, "old")
      expect((yield* failureOf(session.writeFile(path, new TextEncoder().encode("new")))).code).toBe("unavailable")
      expect(writes).toBe(0)
      for (const suffix of ["", "&offset=0&total=3&upload=old"]) {
        const route = "/v1/sessions/" + encodeURIComponent(session.remoteId) + "/files?id=rolling-upgrade&path=" +
          encodeURIComponent(path)
        expect((yield* raw(handler, "PUT", route + suffix, { body: "new" })).status).toBe(426)
      }
      expect(readFileSync(path, "utf8")).toBe("old")
    })))

  it.live("reclaims receipts and rejects a late delivery after acquiring the same key again", () =>
    Effect.gen(function*() {
      const directory = machines()
      const handler = HttpSandbox.serve({ provider: directory, token })
      const acquire = () =>
        raw(handler, "POST", "/v1/sessions", { body: JSON.stringify({ key: "reuse", uploadVersion: 2 }) }).pipe(
          Effect.map((answer) => JSON.parse(answer.body) as { workdir: string; remoteId: string; incarnation: string })
        )
      const old = yield* acquire()
      const held = yield* Effect.scoped(directory.attach!({ id: "reuse", remoteId: old.remoteId }))
      const route = "/v1/sessions/" + encodeURIComponent(old.remoteId)
      const upload = route + "/uploads/v2?id=reuse&path=" + encodeURIComponent(join(old.workdir, "f")) +
        "&offset=0&total=3&upload=receipt&incarnation="
      const remove = route + "?id=reuse&incarnation="
      expect((yield* raw(handler, "PUT", upload + old.incarnation, { body: "old" })).status).toBe(204)
      expect(existsSync(join(held.stateDirectory!, old.incarnation))).toBe(true)
      expect((yield* raw(handler, "DELETE", remove + old.incarnation)).status).toBe(204)
      expect(existsSync(held.stateDirectory!)).toBe(false)
      const fresh = yield* acquire()
      expect(fresh.incarnation).not.toBe(old.incarnation)
      expect((yield* raw(handler, "PUT", upload + fresh.incarnation, { body: "new" })).status).toBe(204)
      expect((yield* raw(handler, "PUT", upload + old.incarnation, { body: "old" })).status).toBe(409)
      expect((yield* raw(handler, "DELETE", remove + old.incarnation)).status).toBe(409)
      expect(readFileSync(join(fresh.workdir, "f"), "utf8")).toBe("new")
      yield* directory.destroy!(held)
      expect(existsSync(held.stateDirectory!)).toBe(false)
    }))

  it.live("a duplicate delete cannot destroy the next incarnation", () =>
    Effect.scoped(Effect.gen(function*() {
      const actual = machines()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let destroys = 0
      const handler = HttpSandbox.serve({
        token,
        provider: {
          ...actual,
          destroy: (held) =>
            Effect.gen(function*() {
              destroys++
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              yield* actual.destroy!(held)
            })
        }
      })
      const acquire = () =>
        raw(handler, "POST", "/v1/sessions", { body: JSON.stringify({ key: "race", uploadVersion: 2 }) })
      const old = JSON.parse((yield* acquire()).body)
      const url = "/v1/sessions/" + encodeURIComponent(old.remoteId) + "?id=race&incarnation=" + old.incarnation
      const deleting = yield* Effect.forkChild(raw(handler, "DELETE", url))
      yield* Deferred.await(entered)
      const duplicate = yield* Effect.forkChild(raw(handler, "DELETE", url))
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(deleting)).status).toBe(204)
      const next = JSON.parse((yield* acquire()).body)
      expect(next.incarnation).not.toBe(old.incarnation)
      expect([204, 409]).toContain((yield* Fiber.join(duplicate)).status)
      expect(destroys).toBe(1)
      expect(existsSync(next.workdir)).toBe(true)
    })), 30_000)

  it.live("private staging preserves the destination owner, group and mode on publication", () =>
    Effect.scoped(Effect.gen(function*() {
      const session = yield* machines().acquire("upload-mode")
      const root = fresh("receipts")
      const path = join(session.workdir, "existing")
      writeFileSync(path, "old")
      for (const mode of [0o600, 0o751]) {
        chmodSync(path, mode)
        const { uid, gid } = statSync(path)
        const id = String(mode)
        expect((yield* runIn(session, uploadScript(path, root, id, 0, 1, 2), { stdin: new Uint8Array([1]) })).code)
          .toBe(0)
        expect(statSync(uploadStage(path, id)).mode & 0o7777).toBe(0o600)
        expect((yield* runIn(session, uploadScript(path, root, id, 1, 2, 2), { stdin: new Uint8Array([2]) })).code)
          .toBe(0)
        expect(statSync(path)).toMatchObject({ uid, gid })
        expect(statSync(path).mode & 0o7777).toBe(mode)
        expect([...readFileSync(path)]).toEqual([1, 2])
      }
      const http = yield* client(HttpSandbox.serve({ provider: machines(), token })).acquire("fs-modes")
      const target = join(http.workdir, "tool")
      writeFileSync(target, "old", { mode: 0o751 })
      yield* Sandbox.fileSystem(http).writeFileString("tool", "updated")
      expect(statSync(target).mode & 0o7777).toBe(0o751)
      expect(readFileSync(target, "utf8")).toBe("updated")
    })))

  it.live("writes a file larger than a chunk in chunks, and a resent chunk lands once", () =>
    Effect.gen(function*() {
      const offsets: Array<string | null> = []
      const observed: Fault = (request, forward, lose) => {
        if (request.method === "PUT") offsets.push(new URL(request.url).searchParams.get("offset"))
        return lost.fault(request, forward, lose)
      }
      // The answer to the second chunk is lost after the service appended it.
      const lost = counted(
        (request) => Effect.succeed(new URL(request.url).searchParams.get("offset") === "1000"),
        (_request, forward, lose) => Effect.andThen(forward, lose)
      )
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
        chunkBytes: 1000,
        fault: observed
      }).acquire("chunks")
      const content = Uint8Array.from({ length: 2500 }, (_, index) => (index * 7) % 256)
      const path = `${session.workdir}/nested/blob.bin`
      yield* session.writeFile(path, content)
      expect(offsets).toEqual(["0", "1000", "1000", "2000"])
      expect(Array.from(yield* session.readFile(path))).toEqual(Array.from(content))
      const empty = `${session.workdir}/empty`
      yield* session.writeFile(empty, new Uint8Array())
      expect((yield* session.readFile(empty)).length).toBe(0)
    }).pipe(Effect.scoped), 120_000)

  it.live(
    "late first deliveries cannot truncate either their completed upload or a newer replacement",
    () =>
      Effect.gen(function*() {
        const provider = machines()
        const handler = HttpSandbox.serve({ provider, token })
        const delayed: Array<Request> = []
        let first = true
        const fault: Fault = (request, forward, lose) => {
          if (request.method === "PUT" && new URL(request.url).searchParams.get("offset") === "0" && first) {
            first = false
            delayed.push(request.clone())
            return lose
          }
          return forward
        }
        const session = yield* client(handler, { chunkBytes: 3, fault }).acquire("delayed-first")
        const path = `${session.workdir}/nested/file`
        const original = new TextEncoder().encode("original-complete")
        yield* session.writeFile(path, original)
        // The first delivery was already in flight; finish it through an independent handler.
        const independent = HttpSandbox.serve({ provider, token })
        expect((yield* independent(delayed[0]!.clone())).status).toBe(204)
        expect(yield* session.readFile(path)).toEqual(original)
        const replacement = new TextEncoder().encode("newer-file")
        yield* session.writeFile(path, replacement)
        expect((yield* independent(delayed[0]!.clone())).status).toBe(204)
        expect(yield* session.readFile(path)).toEqual(replacement)
      }).pipe(Effect.scoped),
    60_000
  )

  it.live("bounds file output on the server and releases the provider scope on refusal", () =>
    Effect.gen(function*() {
      const actual = machines()
      let released = 0
      let reads = 0
      const observed: Sandbox.Provider = {
        ...actual,
        attach: (handle) =>
          Effect.gen(function*() {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                released++
              })
            )
            const session = yield* actual.attach!(handle)
            return {
              ...session,
              // GET must use the bounded process stream, never this whole-file API.
              readFile: () => Effect.die("unbounded readFile"),
              spawn: (command: string, options: RemoteOptions) =>
                Effect.map(session.spawn(command, options), (child) => ({
                  ...child,
                  stdout: child.stdout.pipe(Stream.tap((chunk) =>
                    Effect.sync(() => {
                      reads += chunk.length
                    })
                  ))
                }))
            }
          })
      }
      const handler = HttpSandbox.serve({ provider: observed, token, maxFileBytes: 1024 })
      const session = yield* client(handler).acquire("server-budget")
      const path = `${session.workdir}/file`
      yield* session.writeFile(path, new Uint8Array(100_000))
      reads = 0
      const before = released
      expect((yield* failureOf(session.readFile(path))).message).toBe("byte limit exceeded")
      expect(reads).toBeLessThanOrEqual(1025)
      expect(released).toBe(before + 1)
      yield* session.writeFile(path, new Uint8Array([1, 2, 3]))
      expect(yield* session.readFile(path)).toEqual(new Uint8Array([1, 2, 3]))
    }).pipe(Effect.scoped), 60_000)

  it.live(
    "upload locks release after a killed writer and leave no receipts in the worktree",
    () =>
      Effect.gen(function*() {
        const session = yield* machines().acquire("killed-upload")
        const path = `${session.workdir}/file`
        const receipt = fresh("upload-receipt")
        const content = new TextEncoder().encode("complete")
        const script = uploadScript(path, receipt, "killed-1", 0, content.length, content.length)
        yield* Effect.scoped(Effect.gen(function*() {
          // A process crash must release the OS lock even when no provider finalizer runs.
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              spawn("sh", [
                "-c",
                script.replaceAll("cat >&3", "printf ready; sleep 3019; cat >&3")
              ], { cwd: session.workdir, detached: true, stdio: ["pipe", "pipe", "pipe"] })
            ),
            (child) =>
              Effect.sync(() => {
                if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL")
              })
          )
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
          const ready = new Promise<void>((resolve, reject) => {
            child.stdout.once("data", () => resolve())
            child.once("error", reject)
            child.once("exit", () => reject(new Error("writer exited before readiness")))
          })
          child.stderr.resume()
          child.stdin.end(content)
          yield* Effect.promise(() => ready).pipe(Effect.timeout("5 seconds"))
          process.kill(-child.pid!, "SIGKILL")
          yield* Effect.promise(() => closed)
        }))
        const retry = yield* runIn(session, script, { stdin: content })
        expect(retry.code).toBe(0)
        expect(Array.from(yield* session.readFile(path))).toEqual(Array.from(content))
        expect(readdirSync(session.workdir)).toEqual(["file"])
        // An upload may not redirect staging through a pre-planted symlink.
        const victim = join(fresh("victim"), "file")
        writeFileSync(victim, "kept")
        symlinkSync(victim, uploadStage(path, "symlink"))
        expect(
          (yield* runIn(session, uploadScript(path, receipt, "symlink", 0, 1, 1), { stdin: new Uint8Array([1]) })).code
        ).not.toBe(0)
        expect(readFileSync(victim, "utf8")).toBe("kept")
        const poisoned = join(fresh("poisoned-receipts"), "link")
        symlinkSync(receipt, poisoned)
        expect(
          (yield* runIn(session, uploadScript(path, poisoned, "outside", 0, 1, 1), { stdin: new Uint8Array([1]) })).code
        ).not.toBe(0)
        for (const id of ["lock", "pending"]) {
          expect((yield* runIn(session, uploadScript(path, receipt, id, 0, 1, 1), { stdin: new Uint8Array([2]) })).code)
            .toBe(0)
        }
        const longPath = `${session.workdir}/line\n/${"x".repeat(255)}`
        expect(
          (yield* runIn(session, uploadScript(longPath, receipt, "long", 0, 1, 1), { stdin: new Uint8Array([3]) })).code
        ).toBe(0)
        expect(Array.from(yield* session.readFile(longPath))).toEqual([3])
        expect(
          (yield* runIn(session, uploadScript(session.workdir, receipt, "directory", 0, 1, 1), {
            stdin: new Uint8Array([1])
          })).code
        ).not.toBe(0)
      }).pipe(Effect.scoped),
    60_000
  )

  it.live("preserves non-UTF8 files through a provider with text-only command output", () =>
    Effect.gen(function*() {
      const actual = machines()
      const provider: Sandbox.Provider = {
        ...actual,
        attach: (handle) =>
          Effect.map(actual.attach!(handle), (session) => ({
            ...session,
            spawn: (command: string, options: RemoteOptions) =>
              Effect.map(session.spawn(command, options), (child) => ({
                ...child,
                stdout: child.stdout.pipe(Stream.decodeText, Stream.encodeText)
              }))
          }))
      }
      const session = yield* client(HttpSandbox.serve({ provider, token, maxFileBytes: 256 })).acquire("binary-text")
      const path = `${session.workdir}/binary`
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
      yield* session.writeFile(path, bytes)
      expect(yield* session.readFile(path)).toEqual(bytes)
      yield* session.writeFile(path, new Uint8Array(257))
      expect((yield* failureOf(session.readFile(path))).message).toBe("byte limit exceeded")
    }).pipe(Effect.scoped), 60_000)

  it.live(
    "disconnecting a file request interrupts provider reads and releases their scope",
    () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        let released = false
        const actual = machines()
        const session = yield* actual.acquire("disconnect")
        const provider: Sandbox.Provider = {
          ...actual,
          attach: (handle) =>
            Effect.gen(function*() {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true
                })
              )
              const attached = yield* actual.attach!(handle)
              return {
                ...attached,
                spawn: () =>
                  Effect.gen(function*() {
                    yield* Deferred.succeed(started, undefined)
                    return { stdout: Stream.never, stderr: Stream.empty, exitCode: Effect.never }
                  })
              }
            })
        }
        const abort = new AbortController()
        const request = new Request(
          `${base}/v1/sessions/${encodeURIComponent(session.remoteId)}/files?id=disconnect&path=/file`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: abort.signal
          }
        )
        const running = yield* Effect.forkChild(HttpSandbox.serve({ provider, token })(request))
        yield* Deferred.await(started)
        abort.abort()
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true)
        expect(released).toBe(true)
      }).pipe(Effect.scoped),
    60_000
  )

  it.live("bounds requests and combined command output and rejects unsafe offsets", () =>
    Effect.gen(function*() {
      const handler = HttpSandbox.serve({ provider: machines(), token, maxRequestBytes: 128, maxOutputBytes: 5 })
      const acquired = yield* raw(handler, "POST", "/v1/sessions", {
        body: JSON.stringify({ key: "bounds", uploadVersion: 2 })
      })
      const info = JSON.parse(acquired.body) as { readonly id: string; readonly remoteId: string }
      const session = `/v1/sessions/${encodeURIComponent(info.remoteId)}`
      const file = `${session}/files?id=bounds&path=${encodeURIComponent(info.remoteId + "/f")}`
      const upload = file.replace("/files?", "/uploads/v2?") + "&upload=bounded&total=0&incarnation=" +
        JSON.parse(acquired.body).incarnation
      expect((yield* raw(handler, "PUT", upload + "&offset=0")).status).toBe(204)
      expect((yield* raw(handler, "GET", file)).body).toBe("")
      for (const offset of ["99999999999999999999999", String(Number.MAX_SAFE_INTEGER)]) {
        expect((yield* raw(handler, "PUT", upload + "&offset=" + offset, { body: "x" })).status).toBe(400)
      }
      expect((yield* raw(handler, "PUT", upload + "&offset=0", { body: "x".repeat(129) })).status).toBe(413)
      expect((yield* raw(handler, "POST", "/v1/sessions", { body: "x".repeat(129) })).status).toBe(413)
      for (const [payload, status] of [["abc", 413], ["ab", 200]] as const) {
        expect(
          (yield* raw(handler, "POST", session + "/commands", {
            body: JSON.stringify({ id: info.id, command: `printf abc; printf ${payload} >&2` })
          })).status
        ).toBe(status)
      }
    }), 60_000)

  it.live("checks file responses as bytes arrive", () =>
    Effect.scoped(Effect.gen(function*() {
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), { maxResponseBytes: 1024 })
        .acquire("bounded-read")
      const path = `${session.workdir}/file`
      yield* session.writeFile(path, new Uint8Array(1024))
      expect((yield* session.readFile(path)).length).toBe(1024)
      yield* session.writeFile(path, new Uint8Array(1025))
      expect((yield* failureOf(session.readFile(path))).message).toContain("response byte limit exceeded")
    })), 60_000)

  it.live("concurrent final chunks through independent handlers write one byte range", () =>
    Effect.gen(function*() {
      const provider = machines()
      const handlers = Array.from({ length: 4 }, () => HttpSandbox.serve({ provider, token }))
      const acquired = yield* raw(handlers[0]!, "POST", "/v1/sessions", {
        body: JSON.stringify({ key: "repeat", uploadVersion: 2 })
      })
      const info = JSON.parse(acquired.body) as { readonly remoteId: string }
      const file = `/v1/sessions/${encodeURIComponent(info.remoteId)}/files?id=repeat&path=${
        encodeURIComponent(info.remoteId + "/f")
      }`
      const chunk = "last".repeat(1024)
      const upload = file.replace("/files?", "/uploads/v2?") + "&upload=repeat&total=" + (5 + chunk.length) +
        "&incarnation=" + JSON.parse(acquired.body).incarnation
      expect((yield* raw(handlers[0]!, "PUT", upload + "&offset=0", { body: "first" })).status).toBe(204)
      const answers = yield* Effect.forEach(handlers, (handler) =>
        raw(handler, "PUT", upload + "&offset=5", { body: chunk }), { concurrency: "unbounded" })
      expect(answers.map(({ status }) =>
        status
      )).toEqual([204, 204, 204, 204])
      expect((yield* raw(handlers[0]!, "GET", file)).body).toBe("first" + chunk)
    }), 60_000)

  it.live(
    "stops polling when the consumer falls behind, then drains the command in order",
    () =>
      Effect.gen(function*() {
        const polls = counted(isCommand("tail -c"), pass, Infinity)
        const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
          pollBytes: 1,
          fault: polls.fault
        })
          .acquire("backpressure")
        const child = yield* session.spawn("printf abcdefgh; printf ijklmnop >&2; exit 7", {})
        expect(yield* child.exitCode).toBe(7)
        expect(polls.state.seen).toBe(0)
        expect(text(yield* Stream.runCollect(child.stdout))).toBe("abcdefgh")
        expect(text(yield* Stream.runCollect(child.stderr))).toBe("ijklmnop")
        const reads = polls.state.seen
        expect(yield* Stream.runCollect(child.stdout)).toEqual([])
        expect(polls.state.seen).toBe(reads)
      }).pipe(Effect.scoped),
    60_000
  )

  it.live("keeps not_found across the wire", () =>
    Effect.gen(function*() {
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token })).acquire("absent")
      const error = yield* failureOf(session.readFile(`${session.workdir}/absent`))
      expect(error.code).toBe("not_found")
    }).pipe(Effect.scoped), 60_000)

  it.live("refuses a missing or wrong token with 401 and no detail", () =>
    Effect.gen(function*() {
      const handler = HttpSandbox.serve({ provider: machines(), token })
      expect(yield* raw(handler, "POST", "/v1/sessions", { body: "{\"key\":\"k\"}", authorization: null }))
        .toEqual({ status: 401, body: "" })
      expect(yield* raw(handler, "POST", "/v1/sessions", { body: "{\"key\":\"k\"}", authorization: "Bearer a-test" }))
        .toEqual({ status: 401, body: "" })
      const error = yield* failureOf(Effect.scoped(client(handler, { token: "wrong" }).acquire("k")))
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("refused the token")
    }), 60_000)

  it.live("retries a poll answered 503, and the command runs once", () =>
    Effect.gen(function*() {
      const count = join(fresh("count"), "runs")
      const unavailable = counted(isCommand("tail -c"), () => Effect.succeed(new Response("", { status: 503 })))
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
        fault: unavailable.fault
      }).acquire("poll-503")
      const run = yield* runIn(session, `echo run >> ${count}; echo done`)
      expect(run).toMatchObject({ stdout: "done\n", code: 0 })
      expect(unavailable.state.seen).toBeGreaterThan(1)
      expect(readFileSync(count, "utf8")).toBe("run\n")
    }).pipe(Effect.scoped), 120_000)

  it.live("resends a start whose answer was lost without starting the command twice", () =>
    Effect.gen(function*() {
      const count = join(fresh("count"), "runs")
      const lost = counted(isCommand("setsid"), (_request, forward, lose) => Effect.andThen(forward, lose))
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
        fault: lost.fault
      }).acquire("start-lost")
      const run = yield* runIn(session, `echo run >> ${count}; cat`, { stdin: new TextEncoder().encode("input") })
      expect(run).toMatchObject({ stdout: "input", code: 0 })
      expect(lost.state.seen).toBe(2)
      expect(readFileSync(count, "utf8")).toBe("run\n")
    }).pipe(Effect.scoped), 120_000)

  it.live("closing the spawn's scope ends the command and removes its records", () =>
    Effect.gen(function*() {
      const processes = fresh("processes")
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
        processDirectory: processes
      }).acquire("scope-close")
      yield* Effect.scoped(Effect.gen(function*() {
        const child = yield* session.spawn("echo up; exec sleep 3017", {})
        yield* Stream.runHead(child.stdout)
        expect(pgrep("sleep 301[7]")).toBe(true)
      }))
      expect(yield* gone("sleep 301[7]")).toBe(true)
      expect(readdirSync(processes)).toEqual([])
    }).pipe(Effect.scoped), 120_000)

  it.live("fails a command whose runner ended without recording an exit", () =>
    Effect.gen(function*() {
      const processes = fresh("processes")
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
        processDirectory: processes
      }).acquire("runner-lost")
      const exit = yield* Effect.scoped(Effect.gen(function*() {
        const child = yield* session.spawn("echo up; exec sleep 3018", {})
        yield* Stream.runHead(child.stdout)
        const [directory] = readdirSync(processes)
        process.kill(Number(readFileSync(join(processes, directory!, "runner"), "utf8")), "SIGKILL")
        return yield* failureOf(child.exitCode)
      }))
      expect(exit.code).toBe("unavailable")
      expect(exit.message).toContain("ended without recording its exit")
      // The scope's close still signals the orphaned command.
      expect(yield* gone("sleep 301[8]")).toBe(true)
    }).pipe(Effect.scoped), 120_000)

  it.live(
    "refuses malformed or oversized output pages without echoing their contents",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const handler = HttpSandbox.serve({ provider: machines(), token })
        for (const payload of ["incomplete", "unrecognized\n", "x 0\noversized"]) {
          const fault = counted(isCommand("tail -c"), () => fabricated(0, "", payload))
          const session = yield* client(handler, { pollBytes: 1, fault: fault.fault }).acquire("malformed-page")
          const child = yield* session.spawn("printf x", {})
          const error = yield* failureOf(Stream.runCollect(child.stdout))
          expect(error.code).toBe("unknown")
          expect(error.message).toContain("invalid command poll")
          expect(error.message).not.toContain(payload.trim())
        }
      })),
    60_000
  )

  it.live("fails the streams and the exit of a command that cannot be observed", () =>
    Effect.gen(function*() {
      const failing = counted(isCommand("tail -c"), () => fabricated(2, "poll broke"), Infinity)
      const session = yield* client(HttpSandbox.serve({ provider: machines(), token }), {
        fault: failing.fault
      }).acquire("unobservable")
      const error = yield* failureOf(runIn(session, "exec sleep 3019"))
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("could not be observed")
      expect(error.message).not.toContain("poll broke")
      expect(error.message).not.toContain("3019")
      expect(yield* gone("sleep 301[9]")).toBe(true)
    }).pipe(Effect.scoped), 120_000)

  it.live(
    "reports a signal that could not be delivered, a start that failed, and a ping that failed",
    () =>
      Effect.gen(function*() {
        const killFails = counted(isCommand("kill -s"), () => fabricated(1, "no such process"))
        const pingFails = counted(
          (request) => Effect.map(commandOf(request), (command) => command === "true"),
          () => fabricated(1, "down")
        )
        const handler = HttpSandbox.serve({ provider: machines(), token })
        const session = yield* client(handler, {
          fault: (request, forward, lose) => killFails.fault(request, pingFails.fault(request, forward, lose), lose)
        }).acquire("refusals")
        yield* Effect.scoped(Effect.gen(function*() {
          const child = yield* session.spawn("echo up; exec sleep 3020", {})
          yield* Stream.runHead(child.stdout)
          const error = yield* failureOf(session.kill!(child, "SIGTERM"))
          expect(error.message).toContain("signal SIGTERM could not be delivered")
        }))
        expect(yield* gone("sleep 302[0]")).toBe(true)
        expect((yield* failureOf(session.ping!)).code).toBe("unavailable")
        const unstartable = yield* client(handler, { processDirectory: "/proc/smthrs-http-sandbox" }).acquire(
          "refusals"
        )
        expect((yield* failureOf(runIn(unstartable, "true"))).code).toBe("spawn_error")
      }).pipe(Effect.scoped),
    120_000
  )

  it.live("refuses to signal a process another session started, and leaves it running", () =>
    Effect.gen(function*() {
      const provider = client(HttpSandbox.serve({ provider: machines(), token }))
      const owner = yield* provider.acquire("signal-owner")
      const stranger = yield* provider.acquire("signal-stranger")
      yield* Effect.scoped(Effect.gen(function*() {
        const child = yield* owner.spawn("echo up; exec sleep 3021", {})
        yield* Stream.runHead(child.stdout)
        const error = yield* failureOf(stranger.kill!(child, "SIGKILL"))
        expect(error.code).toBe("unknown")
        expect(error.message).toBe("unrecognized process")
        expect(pgrep("sleep 302[1]")).toBe(true)
      }))
      expect(yield* gone("sleep 302[1]")).toBe(true)
    }).pipe(Effect.scoped), 120_000)

  it.live("destroys a machine idempotently", () =>
    Effect.gen(function*() {
      const handler = HttpSandbox.serve({ provider: machines(), token })
      const acquired = yield* raw(handler, "POST", "/v1/sessions", {
        body: JSON.stringify({ key: "doomed", uploadVersion: 2 })
      })
      expect(acquired.status).toBe(200)
      const info = JSON.parse(acquired.body) as { readonly id: string; readonly remoteId: string }
      const machine = `/v1/sessions/${encodeURIComponent(info.remoteId)}?id=${info.id}&incarnation=${
        JSON.parse(acquired.body).incarnation
      }`
      expect((yield* raw(handler, "DELETE", machine)).status).toBe(204)
      expect((yield* raw(handler, "DELETE", machine)).status).toBe(204)
      const read = yield* raw(
        handler,
        "GET",
        `/v1/sessions/${encodeURIComponent(info.remoteId)}/files?id=${info.id}&path=/x`
      )
      expect(read.status).toBe(404)
      expect(JSON.parse(read.body)).toMatchObject({ code: "not_found" })
    }), 60_000)

  it("refuses a provider that is not retained, and an empty token", () => {
    expect(() => HttpSandbox.serve({ provider: DirectorySandbox.make({ ...services, root }), token })).toThrow(
      "retained provider with attach and destroy"
    )
    expect(() => HttpSandbox.serve({ provider: machines(), token: "" })).toThrow("token")
    expect(() => HttpSandbox.serve({ provider: machines(), token, maxRequestBytes: 0 })).toThrow("maxRequestBytes")
    expect(() => HttpSandbox.serve({ provider: machines(), token, maxOutputBytes: 0.5 })).toThrow("maxOutputBytes")
  })

  it.live("hands the session's limits to the provider choice on every request", () =>
    Effect.gen(function*() {
      const seen: Array<ResourceLimits | undefined> = []
      const provider = machines()
      const handler = HttpSandbox.serve({
        token,
        provider: (limits) => {
          seen.push(limits)
          if ((limits?.cpus ?? 0) > 4) throw new TypeError("cpus above 4")
          return provider
        }
      })
      const limits = { cpus: 2, memoryMib: 512 }
      yield* Effect.scoped(Effect.gen(function*() {
        const session = yield* client(handler, { limits }).acquire("limits")
        yield* session.writeFile(`${session.workdir}/a`, new Uint8Array([1]))
        yield* session.readFile(`${session.workdir}/a`)
        yield* runIn(session, "true")
        yield* session.ping!
      }))
      // Acquire, write, read, start, polls, cleanup, ping and destroy all chose by the same limits.
      expect(seen.length).toBeGreaterThanOrEqual(8)
      expect(seen.every((each) => JSON.stringify(each) === JSON.stringify(limits))).toBe(true)
      seen.length = 0
      yield* Effect.scoped(client(handler).acquire("no-limits"))
      expect(seen).toEqual([undefined, undefined])
      const refused = yield* failureOf(Effect.scoped(client(handler, { limits: { cpus: 8 } }).acquire("too-big")))
      expect(refused.message).toContain("no provider serves these limits: cpus above 4")
    }), 120_000)

  it.live(
    "answers a malformed request 400, a gap in an append 409, and an unknown route 404",
    () =>
      Effect.gen(function*() {
        const handler = HttpSandbox.serve({ provider: machines(), token })
        const acquired = yield* raw(handler, "POST", "/v1/sessions", {
          body: JSON.stringify({ key: "malformed", uploadVersion: 2 })
        })
        const info = JSON.parse(acquired.body) as { readonly id: string; readonly remoteId: string }
        const files = `/v1/sessions/${encodeURIComponent(info.remoteId)}/files?id=${info.id}`
        const upload = files.replace("/files?", "/uploads/v2?") + "&upload=case&total=8&incarnation=" +
          JSON.parse(acquired.body).incarnation
        const cut = () =>
          new ReadableStream({
            start(controller) {
              controller.error(new Error("cut"))
            }
          })
        const cases: ReadonlyArray<readonly [string, string, BodyInit | undefined, number, string]> = [
          ["POST", "/v1/sessions", "{", 400, "the request body is malformed"],
          ["POST", "/v1/sessions", cut(), 400, "could not be read"],
          ["GET", "/v1/sessions", undefined, 404, "no such route"],
          ["GET", "/v2/sessions", undefined, 404, "no such route"],
          ["POST", "/v1/sessions/%E0%A4%A/commands", "{}", 400, "not URI encoded"],
          ["DELETE", `/v1/sessions/${encodeURIComponent(info.remoteId)}`, undefined, 400, "the query lacks id"],
          ["GET", `${files}&path=relative`, undefined, 400, "not absolute"],
          ["GET", `${files}`, undefined, 400, "the query lacks path"],
          ["GET", `${files}&path=/x&cpus=many`, undefined, 400, "the limits are malformed"],
          ["PUT", `${upload}&path=/x&offset=-1`, "x", 400, "not a byte count"],
          ["PUT", `${upload}&path=/tmp/x`, cut(), 400, "could not be read"],
          ["PUT", `${upload}&path=${root}/gap&offset=5`, "x", 409, "file upload range could not be stored"]
        ]
        for (const [method, path, body, status, message] of cases) {
          const answer = yield* raw(handler, method, path, body === undefined ? {} : { body })
          expect({ method, path, status: answer.status }).toEqual({ method, path, status })
          expect(answer.body).toContain(message)
        }
      }),
    60_000
  )

  it.live("sends again what was lost on the way, and gives up after its retries", () =>
    Effect.gen(function*() {
      const handler = HttpSandbox.serve({ provider: machines(), token })
      const isAcquire = isRoute("POST", "/v1/sessions")
      const transient: ReadonlyArray<Fault> = [
        (_request, _forward, lose) => lose,
        () => Effect.never,
        () => broken(200),
        () => broken(404)
      ]
      for (const act of transient) {
        const once = counted(isAcquire, act)
        yield* Effect.scoped(client(handler, { fault: once.fault, requestTimeout: "2 seconds" }).acquire("lost"))
        expect(once.state.seen).toBe(2)
      }
      const brokenRead = counted(isRoute("GET", "/files"), () => broken(200))
      yield* Effect.scoped(Effect.gen(function*() {
        const session = yield* client(handler, { fault: brokenRead.fault }).acquire("lost-read")
        yield* session.writeFile(`${session.workdir}/f`, new Uint8Array([9]))
        expect(Array.from(yield* session.readFile(`${session.workdir}/f`))).toEqual([9])
      }))
      expect(brokenRead.state.seen).toBe(2)
      const down = counted(isAcquire, () => Effect.succeed(new Response("", { status: 503 })), Infinity)
      const exhausted = yield* failureOf(
        Effect.scoped(client(handler, { fault: down.fault, retries: 2 }).acquire("down"))
      )
      expect(exhausted.code).toBe("unavailable")
      expect(exhausted.message).toContain("lost 3 times; last: HTTP 503")
      expect(down.state.seen).toBe(3)
    }), 120_000)

  it.live("reads an answer that is not the protocol's as unknown", () =>
    Effect.gen(function*() {
      const handler = HttpSandbox.serve({ provider: machines(), token })
      const teapot = counted(
        isRoute("POST", "/v1/sessions"),
        () => Effect.succeed(new Response("tea", { status: 418 }))
      )
      const refused = yield* failureOf(Effect.scoped(client(handler, { fault: teapot.fault }).acquire("teapot")))
      expect(refused.message).toContain("answered HTTP 418")
      const garbled = counted(isRoute("POST", "/v1/sessions"), () => Effect.succeed(new Response("nope")))
      const malformed = yield* failureOf(Effect.scoped(client(handler, { fault: garbled.fault }).acquire("garbled")))
      expect(malformed.message).toContain("malformed JSON")
    }), 60_000)

  it("refuses options it cannot use", () => {
    const valid = { url: base, token, client: inProcess(() => Effect.die("unused"), pass) }
    const invalid: ReadonlyArray<Partial<HttpSandbox.HttpSandboxOptions>> = [
      { url: "not a url" },
      { token: "" },
      { chunkBytes: 0 },
      { pollBytes: 1.5 },
      { maxResponseBytes: Infinity },
      { retries: -1 },
      { processDirectory: "relative" },
      { processDirectory: "/a/../b" },
      { processDirectory: "/a b" },
      { limits: { cpus: -1 } }
    ]
    for (const options of invalid) expect(() => HttpSandbox.make({ ...valid, ...options })).toThrow(TypeError)
    expect(HttpSandbox.make({ ...valid, url: `${base}/`, limits: {} }).retained).toBeUndefined()
  })
})
