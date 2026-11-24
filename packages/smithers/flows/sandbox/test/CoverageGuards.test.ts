import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as CloudflareSandbox from "../src/CloudflareSandbox/index.ts"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as DaytonaSandbox from "../src/DaytonaSandbox/index.ts"
import * as HttpSandbox from "../src/HttpSandbox/index.ts"
import { uploadScript, uploadStage } from "../src/HttpSandbox/upload.ts"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import type { Provider, Session } from "../src/Sandbox/index.ts"

const token = "guard-token"
const auth = { authorization: `Bearer ${token}` }
const base = "https://sandbox.test"

const makeHandle = (stdout: string, stderr: string, exitCode: number): ChildProcessSpawner.ChildProcessHandle =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.die("unused"),
    stdin: undefined as never,
    stdout: stdout === "" ? Stream.empty : Stream.make(new TextEncoder().encode(stdout)),
    stderr: stderr === "" ? Stream.empty : Stream.make(new TextEncoder().encode(stderr)),
    all: Stream.empty,
    getInputFd: () => undefined as never,
    getOutputFd: () => Stream.empty
  })

const spawnerLayer = (
  handler: (args: ReadonlyArray<string>, command: string) => { stdout?: string; stderr?: string; code: number }
) =>
  ChildProcessSpawner.ChildProcessSpawner.of({
    spawn: (cmd) => {
      const standard = cmd as unknown as { readonly command?: string; readonly args?: ReadonlyArray<string> }
      const res = handler(standard.args ?? [], standard.command ?? "")
      return Effect.succeed(makeHandle(res.stdout ?? "", res.stderr ?? "", res.code))
    },
    exitCode: () => Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    lines: () => Effect.succeed([]),
    string: () => Effect.succeed(""),
    streamLines: () => Stream.empty,
    streamString: () => Stream.empty
  })

const fakeSession = (
  onSpawn: (command: string) => { stdout?: string; stderr?: string; exitCode: number },
  overrides: Partial<Session> = {}
): Session => ({
  id: "s1",
  remoteId: "r1",
  workdir: "/work",
  spawn: (command) => {
    const out = onSpawn(command)
    return Effect.succeed({
      stdout: out.stdout === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(out.stdout)),
      stderr: out.stderr === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(out.stderr)),
      exitCode: Effect.succeed(out.exitCode)
    })
  },
  readFile: () => Effect.succeed(new Uint8Array()),
  writeFile: () => Effect.void,
  ...overrides
})

const retainedProvider = (session: Session, onDestroy?: () => void): Provider => ({
  retained: true,
  acquire: () => Effect.succeed(session),
  attach: () => Effect.succeed(session),
  destroy: () => Effect.sync(() => onDestroy?.())
})

describe("sandbox coverage guards", () => {
  it("handles root-level paths in uploadStage and uploadScript", () => {
    expect(uploadStage("/file.txt", "u1")).toMatch(/^\/\/\.smthrs-upload-[0-9a-f]{32}-u1$/)
    const script = uploadScript("/file.txt", "/tmp/r", "u1", 0, 1, 1)
    expect(script).toContain("mkdir -p -- / \"$u\"")
  })

  it.effect("covers HttpSandbox serve validation, error mappings, abort signal, and legacy fallback", () =>
    Effect.gen(function*() {
      const dummy = retainedProvider(fakeSession(() => ({ exitCode: 0 })))
      expect(() => HttpSandbox.serve({ provider: dummy, token, processDirectory: "../escape" })).toThrow(TypeError)
      expect(() =>
        HttpSandbox.serve({ provider: dummy, token, maxFileBytes: Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1 })
      ).toThrow(TypeError)

      // 1. uploadVersion !== 2 returns basic info without incarnation
      const plainHandler = HttpSandbox.serve({
        provider: retainedProvider(fakeSession(() => ({ exitCode: 0 }), { stateDirectory: "/tmp/custom-state" })),
        token
      })
      const plainRes = yield* plainHandler(
        new Request(`${base}/v1/sessions`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ key: "k1", uploadVersion: 1 })
        })
      )
      expect(plainRes.status).toBe(200)
      const plainJson = yield* Effect.promise(() => plainRes.json() as Promise<Record<string, unknown>>)
      expect(plainJson.incarnation).toBeUndefined()

      // 2. Exit codes 69 (spawn_error fallback on acquire & delete), 75 (503 busy), 76 (409 ended), 3 (409 failed)
      let destroyed = false
      const noLockHandler = HttpSandbox.serve({
        provider: retainedProvider(fakeSession(() => ({ exitCode: 69 })), () => {
          destroyed = true
        }),
        token
      })
      const fallbackAcquire = yield* noLockHandler(
        new Request(`${base}/v1/sessions`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ key: "k-nolock", uploadVersion: 2 })
        })
      )
      expect(fallbackAcquire.status).toBe(200)
      const fallbackInfo = yield* Effect.promise(() => fallbackAcquire.json() as Promise<Record<string, unknown>>)
      expect(fallbackInfo.incarnation).toBeUndefined()

      const badIncDel = yield* noLockHandler(
        new Request(`${base}/v1/sessions/r1?id=s1&incarnation=BAD`, { method: "DELETE", headers: auth })
      )
      expect(badIncDel.status).toBe(400)

      const fallbackDel = yield* noLockHandler(
        new Request(`${base}/v1/sessions/r1?id=s1`, { method: "DELETE", headers: auth })
      )
      expect(fallbackDel.status).toBe(204)
      expect(destroyed).toBe(true)

      // DELETE where holding fiber finishes cleanly without acquiring (acquired === false)
      let destroyedFalse = false
      const heldExitHandler = HttpSandbox.serve({
        provider: retainedProvider(
          fakeSession((cmd) => cmd.includes("cmp -s") ? { exitCode: 1 } : { exitCode: 0 }),
          () => {
            destroyedFalse = true
          }
        ),
        token
      })
      const nonAcqDel = yield* heldExitHandler(
        new Request(`${base}/v1/sessions/r1?id=s1`, { method: "DELETE", headers: auth })
      )
      expect(nonAcqDel.status).toBe(204)
      expect(destroyedFalse).toBe(false)

      for (const [code, expectedStatus] of [[75, 503], [76, 409], [3, 409]] as const) {
        const h = HttpSandbox.serve({ provider: retainedProvider(fakeSession(() => ({ exitCode: code }))), token })
        const r = yield* h(
          new Request(`${base}/v1/sessions`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ key: `k-${code}`, uploadVersion: 2 })
          })
        )
        expect(r.status).toBe(expectedStatus)
      }

      // 3. GET /files: non-44 failure (422), invalid base64 (422), decoded > maxFileBytes (413)
      const failReadHandler = HttpSandbox.serve({
        provider: retainedProvider(fakeSession(() => ({ exitCode: 2 }))),
        token
      })
      const failRead = yield* failReadHandler(
        new Request(`${base}/v1/sessions/r1/files?id=s1&path=/a`, { method: "GET", headers: auth })
      )
      expect(failRead.status).toBe(422)

      const badB64Handler = HttpSandbox.serve({
        provider: retainedProvider(fakeSession(() => ({ exitCode: 0, stdout: "!!!not-base64!!!" }))),
        token
      })
      const badB64 = yield* badB64Handler(
        new Request(`${base}/v1/sessions/r1/files?id=s1&path=/a`, { method: "GET", headers: auth })
      )
      expect(badB64.status).toBe(422)

      const bigReadHandler = HttpSandbox.serve({
        provider: retainedProvider(
          fakeSession(() => ({ exitCode: 0, stdout: Buffer.from("abcdef").toString("base64") }))
        ),
        token,
        maxFileBytes: 4
      })
      const bigRead = yield* bigReadHandler(
        new Request(`${base}/v1/sessions/r1/files?id=s1&path=/a`, { method: "GET", headers: auth })
      )
      expect(bigRead.status).toBe(413)

      // 4. PUT /uploads/v2 malformed upload range & invalid incarnation
      const badRange = yield* plainHandler(
        new Request(`${base}/v1/sessions/r1/uploads/v2?id=s1&path=/a&offset=0&upload=bad!`, {
          method: "PUT",
          headers: auth,
          body: new Uint8Array([1])
        })
      )
      expect(badRange.status).toBe(400)

      const badIncPut = yield* plainHandler(
        new Request(`${base}/v1/sessions/r1/uploads/v2?id=s1&path=/a&offset=0&upload=u1&total=1&incarnation=BAD`, {
          method: "PUT",
          headers: auth,
          body: new Uint8Array([1])
        })
      )
      expect(badIncPut.status).toBe(400)

      // 5. Already-aborted Request signal hits request.signal.aborted branch
      const hangingHandler = HttpSandbox.serve({
        provider: {
          retained: true,
          acquire: () => Effect.never,
          attach: () => Effect.never,
          destroy: () => Effect.void
        },
        token
      })
      const ac = new AbortController()
      ac.abort()
      const abortedExit = yield* Effect.exit(
        hangingHandler(
          new Request(`${base}/v1/sessions`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ key: "hang" }),
            signal: ac.signal
          })
        )
      )
      expect(Exit.hasInterrupts(abortedExit)).toBe(true)
    }))

  it.live("covers HttpSandbox make unpaired surrogates and polling sleep", () =>
    Effect.gen(function*() {
      const badClient = HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ id: "bad\uD800id", remoteId: "r1", workdir: "/w" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          )
        )
      )
      const provider = HttpSandbox.make({ url: base, token, client: badClient })
      const badKey = yield* Effect.flip(Effect.scoped(provider.acquire("bad\uD800key")))
      expect(badKey.message).toContain("unpaired surrogate")
      const badAns = yield* Effect.flip(Effect.scoped(provider.acquire("good-key")))
      expect(badAns.message).toContain("unpaired surrogate")

      // Slow command poll: first poll returns empty bytes & ended:false, second returns ended:true exitCode:0
      let cmdCalls = 0
      const pollClient = HttpClient.make((req) => {
        const u = new URL(req.url)
        if (req.method === "POST" && u.pathname === "/v1/sessions") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(JSON.stringify({ id: "s1", remoteId: "r1", workdir: "/w" }), { status: 200 })
            )
          )
        }
        if (req.method === "POST" && u.pathname.endsWith("/commands")) {
          cmdCalls += 1
          // 1: start script, 2: first stdout poll -> running with 0 bytes (hits sleep line 406), 3+: exited with "hi"
          const stdout = cmdCalls === 1 ? "" : cmdCalls === 2 ? "r\n" : "x 0\nhi"
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(
                JSON.stringify({ exitCode: 0, stdout: Buffer.from(stdout).toString("base64"), stderr: "" }),
                { status: 200 }
              )
            )
          )
        }
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 204 })))
      })
      const pollProvider = HttpSandbox.make({ url: base, token, client: pollClient, pollInterval: "1 millis" })
      yield* Effect.scoped(Effect.gen(function*() {
        const s = yield* pollProvider.acquire("poll-key")
        const proc = yield* s.spawn("echo hi", {})
        const chunks = yield* Stream.runCollect(proc.stdout)
        expect(Buffer.concat(Array.from(chunks)).toString("utf8")).toBe("hi")
        expect(yield* proc.exitCode).toBe(0)
      }))
    }))

  it.live("covers legacy lookup failure guards across Command, Container, Daytona, Kubernetes, Microsandbox, Cloudflare, and Sandbox.job", () =>
    Effect.gen(function*() {
      // 1. CommandSandbox: test -d legacy returns exit code 2
      let cmdStep = 0
      const cmdProv = CommandSandbox.make({
        name: "cmd-guard",
        workdir: "/tmp",
        prefix: ["sh"],
        spawner: spawnerLayer(() => {
          cmdStep += 1
          return cmdStep === 1 ? { code: 0, stdout: "Linux\n1000\nboot-1\n" } : { code: 2 }
        })
      })
      const cmdErr = yield* Effect.flip(Effect.scoped(cmdProv.acquire("k1")))
      expect(cmdErr.message).toContain("legacy pid directory lookup failed")

      // 2. ContainerSandbox: container inspect returns non-missing stderr
      const ctrProv = ContainerSandbox.make({
        image: "alpine:3",
        spawner: spawnerLayer(() => ({ code: 1, stderr: "daemon unreachable" }))
      })
      const ctrErr = yield* Effect.flip(Effect.scoped(ctrProv.acquire("k1")))
      expect(ctrErr.message).toContain("legacy container lookup failed")

      // 3. DaytonaSandbox: sdk.get(legacy) missing, sdk.get(name) throws non-missing
      let getCalls = 0
      const daytonaProv = DaytonaSandbox.make({
        sdk: {
          get: async () => {
            getCalls += 1
            if (getCalls === 1) throw Object.assign(new Error("not found"), { statusCode: 404 })
            throw new Error("internal server failure")
          },
          create: async () => {
            throw new Error("unreachable")
          }
        } as never
      })
      const dayErr = yield* Effect.flip(Effect.scoped(daytonaProv.acquire("k1")))
      expect(dayErr.code).toBe("unavailable")

      // 4. KubernetesSandbox: kubectl get pod legacy fails
      const k8sProv = KubernetesSandbox.make({
        namespace: "default",
        image: "alpine:3",
        spawner: spawnerLayer(() => ({ code: 1, stderr: "api unavailable" }))
      })
      const k8sErr = yield* Effect.flip(Effect.scoped(k8sProv.acquire("k1")))
      expect(k8sErr.message).toContain("legacy pod could not be inspected")

      // 5. MicrosandboxSandbox: sdk.Sandbox.get(legacy) throws non-sandboxNotFound error
      const msbProv = MicrosandboxSandbox.make({
        backend: "any",
        image: "alpine:3",
        collector: { collect: () => Effect.void } as never,
        sdk: {
          Sandbox: {
            get: async () => {
              throw Object.assign(new Error("daemon down"), { code: "internalError" })
            },
            create: async () => {
              throw new Error("unreachable")
            }
          }
        } as never
      })
      const msbErr = yield* Effect.flip(Effect.scoped(msbProv.acquire("k1")))
      expect(msbErr.message).toContain("could not look up legacy microVM")

      // 6. Sandbox.job: test -d legacyDirectory returns exit code 2
      const jobProv = retainedProvider(fakeSession((cmd) => ({ exitCode: cmd.includes("test -d") ? 2 : 0 })))
      const job = Sandbox.job(jobProv, { command: () => "true" })
      const jobErr = yield* Effect.flip(job.start({}, "k1"))
      expect(jobErr.message).toContain("could not look up legacy admission")

      // 7. CloudflareSandbox: process.kill() throws on teardown (warnTeardown line 289)
      const cfProv = CloudflareSandbox.make({
        execution: "process",
        workdir: "/work",
        binding: {} as never,
        sdk: {
          getSandbox: () => ({
            startProcess: async () => ({
              id: "p1",
              waitForExit: async () => {
                throw new Error("wait failed")
              },
              kill: async () => {
                throw new Error("kill rejected")
              },
              getLogs: async () => ({ stdout: "", stderr: "" })
            }),
            exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
            readFile: async () => ({ content: "" }),
            writeFile: async () => {},
            mkdir: async () => {},
            destroy: async () => {}
          })
        } as never
      })
      const scope = yield* Scope.make()
      const cfSession = yield* Scope.provide(cfProv.acquire("k-cf"), scope)
      yield* Effect.flip(Scope.provide(cfSession.spawn("sleep 10", {}), scope))
      yield* Scope.close(scope, Exit.void)
    }))
})
