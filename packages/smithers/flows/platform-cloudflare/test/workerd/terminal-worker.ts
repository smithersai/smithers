/**
 * The container terminal suite's Worker: a raw Durable Object with a real
 * container, which adapts `ctx.container` and a `WebSocketPair` to the
 * structural slices `SandboxObject` and `ContainerTerminal` take, as an
 * Alchemy object's container handle does (its `ContainerClient` is the model
 * for `processOf`), and a `Forge` entrypoint the box reaches through an
 * outbound intercept.
 *
 * Routes, on the object `?object=`:
 *
 * - `POST /wake`: `SandboxObject.wake` with one intercept,
 *   `forge.smithers.internal` to `Forge`, whose props hold `FORGE_TOKEN`.
 * - `POST /session?name=&user=&cwd=`: `ContainerTerminal.ensureSession`.
 * - `GET /attach?name=&user=&access=&cols=&rows=`: accepts a WebSocket with
 *   `accept()` and runs `ContainerTerminal.attach` for its lifetime.
 * - `POST /run` with `{ argv, user }`: `SandboxObject.run`, the exit code.
 * - `POST /exec` with `{ argv, user }`: runs a command to completion and
 *   answers its exit code and output, for the suite's own checks.
 * - `GET /reports?count=`: every attach's report once `count` have ended.
 *
 * `Forge` answers a smart-HTTP ref advertisement for `/acme/widgets`, its
 * one ref at `FORGE_SHA`, only when its props carry the token, as a forge proxy that adds a credential
 * outside the box does, and refuses everything else.
 *
 * Effects run here, at the program boundary.
 */
import { WorkerEntrypoint } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { ContainerTerminal, SandboxObject } from "../../src/index.ts"

interface RawProcess {
  readonly stdin: WritableStream<Uint8Array> | null
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly exitCode: Promise<number>
  output(): Promise<{ readonly exitCode: number; readonly stdout: ArrayBuffer; readonly stderr: ArrayBuffer }>
  kill(signal?: number): void
  resize(cols: number, rows: number): void
}

interface RawFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>
}

interface RawContainer {
  readonly running: boolean
  readonly images: Record<string, string>
  monitor(): Promise<void>
  start(options: { readonly image: string; readonly enableInternet: boolean }): void
  exec(cmd: Array<string>, options?: Record<string, unknown>): Promise<RawProcess>
  setInactivityTimeout(durationMs: number): Promise<void>
  interceptOutboundHttp(addr: string, binding: RawFetcher): Promise<void>
  interceptAllOutboundHttp(binding: RawFetcher): Promise<void>
  interceptOutboundHttps(addr: string, binding: RawFetcher): Promise<void>
}

interface State {
  readonly container: RawContainer
  readonly exports: { Forge(options: { readonly props: { readonly token: string } }): RawFetcher }
}

interface Env {
  readonly FORGE_TOKEN: string
  readonly FORGE_SHA: string
  readonly SANDBOX: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
}

interface ServerSocket extends ContainerTerminal.Socket {
  accept(): void
}

declare const WebSocketPair: new() => { 0: WebSocket; 1: ServerSocket }

class ContainerFailure extends Error {
  readonly _tag = "ContainerFailure"
}

const failure = (cause: unknown) => new ContainerFailure(cause instanceof Error ? cause.message : String(cause))

/** A raw process as an Effect process, as Alchemy's `fromProcess` adapts one: no signal after its exit is seen. */
const processOf = (raw: RawProcess): ContainerTerminal.Process<ContainerFailure> => {
  let exited = false
  return {
    stdin: raw.stdin === null
      ? undefined
      : Sink.fromWritableStream({ evaluate: () => raw.stdin!, onError: failure }),
    stdout: raw.stdout === null
      ? undefined
      : Stream.fromReadableStream({ evaluate: () => raw.stdout!, onError: failure }),
    exitCode: Effect.tryPromise({ try: () => raw.exitCode, catch: failure }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          exited = true
        })
      )
    ),
    kill: (signal) =>
      Effect.try({
        try: () => {
          if (!exited) raw.kill(signal)
        },
        catch: failure
      }),
    resize: (cols, rows) => Effect.try({ try: () => raw.resize(cols, rows), catch: failure })
  }
}

/** `ctx.container` as the slice `ContainerTerminal` takes: each process killed when its scope closes. */
const containerOf = (raw: RawContainer): ContainerTerminal.Container<ContainerFailure> => ({
  exec: (cmd, options) =>
    Effect.acquireRelease(
      Effect.tryPromise({ try: () => raw.exec(cmd, { ...options }), catch: failure }).pipe(Effect.map(processOf)),
      (process) => Effect.ignore(process.kill(9))
    )
})

/** `ctx.container` as the slice `SandboxObject` takes, starting the object's one image. */
const machineOf = (raw: RawContainer): SandboxObject.Machine<RawFetcher, ContainerFailure> => ({
  running: Effect.sync(() => raw.running),
  start: (options) => Effect.try({ try: () => raw.start({ ...options, image: raw.images.sandbox! }), catch: failure }),
  setInactivityTimeout: (ms) => Effect.tryPromise({ try: () => raw.setInactivityTimeout(ms), catch: failure }),
  interceptOutboundHttp: (addr, fetcher) =>
    Effect.tryPromise({ try: () => raw.interceptOutboundHttp(addr, fetcher), catch: failure }),
  interceptAllOutboundHttp: (fetcher) =>
    Effect.tryPromise({ try: () => raw.interceptAllOutboundHttp(fetcher), catch: failure }),
  interceptOutboundHttps: (addr, fetcher) =>
    Effect.tryPromise({ try: () => raw.interceptOutboundHttps(addr, fetcher), catch: failure })
})

/** A pkt-line: four hex digits of length, then the payload. */
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`

export class Forge extends WorkerEntrypoint<Env, { readonly token: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (this.ctx.props.token !== this.env.FORGE_TOKEN) return new Response("no token", { status: 401 })
    if (
      request.method !== "GET" || url.host !== "forge.smithers.internal" ||
      url.pathname !== "/acme/widgets/info/refs" ||
      url.searchParams.get("service") !== "git-upload-pack"
    ) {
      return new Response("refused", { status: 403 })
    }
    const sha = this.env.FORGE_SHA
    const body = pkt("# service=git-upload-pack\n") + "0000" +
      pkt(`${sha} HEAD\0symref=HEAD:refs/heads/main agent=forge\n`) + pkt(`${sha} refs/heads/main\n`) + "0000"
    return new Response(body, {
      headers: { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" }
    })
  }
}

const decoder = new TextDecoder()

export class Sandbox {
  readonly state: State
  readonly env: Env
  readonly reports: Array<ContainerTerminal.Report> = []
  startupFailed = false
  waiters: Array<() => void> = []

  constructor(state: State, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const param = (name: string) => url.searchParams.get(name) ?? ""
    const container = containerOf(this.state.container)
    switch (url.pathname) {
      case "/wake": {
        const fetcher = this.state.exports.Forge({ props: { token: this.env.FORGE_TOKEN } })
        const exit = await Effect.runPromiseExit(
          SandboxObject.wake(machineOf(this.state.container), {
            intercepts: [{ host: "forge.smithers.internal", fetcher }]
          })
        )
        this.startupFailed = false
        void this.state.container.monitor().catch(() => {
          this.startupFailed = true
        })
        return Exit.isSuccess(exit)
          ? Response.json({ outcome: exit.value })
          : Response.json({ error: String(exit.cause) }, { status: 500 })
      }
      case "/session": {
        const exit = await Effect.runPromiseExit(
          ContainerTerminal.ensureSession(container, { name: param("name"), user: param("user"), cwd: param("cwd") })
        )
        return Exit.isSuccess(exit)
          ? Response.json({ outcome: exit.value })
          : Response.json({ error: String(exit.cause) }, { status: 500 })
      }
      case "/attach": {
        const pair = new WebSocketPair()
        const server = pair[1]
        server.accept()
        // The bridge runs for the socket's lifetime, after this response.
        void Effect.runPromise(
          ContainerTerminal.attach(container, server, {
            name: param("name"),
            user: param("user"),
            access: param("access") === "write" ? "write" : "read",
            cols: Number(param("cols")),
            rows: Number(param("rows"))
          })
        ).then((report) => {
          this.reports.push(report)
          for (const waiter of this.waiters) waiter()
        })
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
      }
      case "/run": {
        const { argv, user } = (await request.json()) as { readonly argv: Array<string>; readonly user: string }
        const exit = await Effect.runPromiseExit(SandboxObject.run(container, argv, { user }))
        return Exit.isSuccess(exit)
          ? Response.json({ exitCode: exit.value })
          : Response.json({ error: String(exit.cause) }, { status: 500 })
      }
      case "/exec": {
        const { argv, user } = (await request.json()) as { readonly argv: Array<string>; readonly user: string }
        let stage = "spawn"
        try {
          const process = await this.state.container.exec(argv, { user })
          stage = "output"
          const output = await process.output()
          return Response.json({
            exitCode: output.exitCode,
            stdout: decoder.decode(output.stdout),
            stderr: decoder.decode(output.stderr)
          })
        } catch (error) {
          const diagnostic = {
            stage,
            startupFailed: this.startupFailed,
            imageAvailable: this.state.container.images.sandbox !== undefined,
            running: this.state.container.running,
            errorType: error instanceof Error ? error.name : typeof error
          }
          console.error("container.exec.failed", diagnostic)
          return Response.json(diagnostic, { status: 500 })
        }
      }
      default: {
        const count = Number(param("count"))
        await new Promise<void>((resolve) => {
          const check = () => {
            if (this.reports.length < count) return
            this.waiters = this.waiters.filter((waiter) => waiter !== check)
            resolve()
          }
          this.waiters.push(check)
          check()
        })
        return Response.json(this.reports)
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get("object") ?? "default"
    return env.SANDBOX.get(env.SANDBOX.idFromName(name)).fetch(request)
  }
}
