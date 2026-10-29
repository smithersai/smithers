/**
 * `SandboxObject.wake`, `SandboxObject.run` and `ContainerTerminal` in local workerd with a real
 * container: Miniflare runs the Durable Object's container image through
 * Docker, as `alchemy dev` does. The image is the branch sandbox's
 * (`apps/mvp/infra/sandbox`), built before the suite.
 *
 * It proves what the in-memory suite cannot: the box reaches the
 * intercepted forge and nothing else, and holds no secret; a command run
 * for its exit code settles whatever it writes; the owner's
 * keystrokes reach a real shell while a reader's bytes, automatic replies
 * and sizes never do; `stty size` follows the owner; a reload attaches to
 * the same shell; malformed and oversized frames close the socket with
 * their codes; and a killed session ends every viewer.
 *
 * It skips only when Docker is absent: no `docker` command, or no daemon
 * behind it.
 */
import { TerminalProtocol } from "@smthrs/sandbox"
import { build } from "esbuild"
import { Log, LogLevel, Miniflare, type WebSocket } from "miniflare"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ContainerTerminal } from "../src/index.ts"

const entry = fileURLToPath(new URL("./workerd/terminal-worker.ts", import.meta.url))
const context = fileURLToPath(new URL("../../../../../apps/mvp/infra/sandbox", import.meta.url))
const image = "smithers-branch-sandbox:test"
/** The egress image pinned by Miniflare 5.20261019.0-beta; workerd never pulls it. */
const egressImage =
  "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8"
const worker = `terminal-test-${process.pid}`
/** The forge credential: it lives in the Worker and the intercept's props, never in the box. */
const token = `SENTINEL-forge-${randomUUID()}`
const sha = "0123456789abcdef0123456789abcdef01234567"
const object = randomUUID()

/** Docker's endpoint, or why there is none. */
const docker = ((): { readonly socketPath: string } | { readonly absent: string } => {
  const run = (args: ReadonlyArray<string>) =>
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  try {
    const socketPath = run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
    run(["version", "--format", "{{.Server.Version}}"])
    return { socketPath }
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code
    return { absent: code === "ENOENT" ? "no docker command" : "no Docker daemon answers" }
  }
})()

const label = "socketPath" in docker ? `Docker at ${docker.socketPath}` : `skipped: Docker is absent (${docker.absent})`

let mf: Miniflare

const call = async (path: string, init?: RequestInit) => {
  const separator = path.includes("?") ? "&" : "?"
  return mf.dispatchFetch(`http://terminal${path}${separator}object=${object}`, init as never)
}

const exec = async (argv: ReadonlyArray<string>, user = "1000:2000") => {
  const response = await call("/exec", { method: "POST", body: JSON.stringify({ argv, user }) })
  const output = await response.json()
  expect(response.status, response.status === 200 ? undefined : JSON.stringify(output)).toBe(200)
  return output as { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
}

/** One viewer's socket and everything it has received. */
class Viewer {
  text = ""
  readonly controls: Array<TerminalProtocol.ServerControl> = []
  closeCode: number | undefined
  firstByteMs: number | undefined
  private readonly decoder = new TextDecoder()
  private readonly waiters = new Set<() => void>()

  readonly socket: WebSocket

  constructor(socket: WebSocket, opened: number) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const control = TerminalProtocol.decodeServerControl(event.data)
        if (control !== undefined) this.controls.push(control)
      } else {
        this.firstByteMs ??= performance.now() - opened
        this.text += this.decoder.decode(new Uint8Array(event.data as ArrayBuffer), { stream: true })
      }
      this.notify()
    })
    socket.addEventListener("close", (event) => {
      this.closeCode = event.code
      this.notify()
    })
  }

  static async open(options: Omit<ContainerTerminal.AttachOptions, "user">): Promise<Viewer> {
    const opened = performance.now()
    const query = new URLSearchParams({
      name: options.name,
      user: "1000:2000",
      access: options.access,
      cols: String(options.cols),
      rows: String(options.rows)
    })
    const response = await call(`/attach?${query}`, { headers: { Upgrade: "websocket" } })
    expect(response.status).toBe(101)
    const viewer = new Viewer(response.webSocket!, opened)
    response.webSocket!.accept()
    await viewer.until((v) => v.controls.some((control) => control.type === "ready"), "ready")
    return viewer
  }

  private notify() {
    for (const waiter of [...this.waiters]) waiter()
  }

  /** Resolves once `check` holds; fails if the socket closes first or 30 s pass. */
  until(check: (viewer: Viewer) => boolean, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(30_000)
      const finish = (error?: Error) => {
        this.waiters.delete(test)
        signal.removeEventListener("abort", expired)
        if (error === undefined) resolve()
        else reject(error)
      }
      const tail = () => JSON.stringify(this.text.slice(-300))
      const test = () => {
        if (check(this)) finish()
        else if (this.closeCode !== undefined) {
          finish(new Error(`${what}: closed with ${this.closeCode}; tail ${tail()}`))
        }
      }
      const expired = () => finish(new Error(`${what}: not within 30 s; tail ${tail()}`))
      this.waiters.add(test)
      signal.addEventListener("abort", expired)
      test()
    })
  }

  closed(): Promise<number> {
    return this.until((v) => v.closeCode !== undefined, "close").then(() => this.closeCode!)
  }

  type(text: string) {
    this.socket.send(new TextEncoder().encode(text))
  }

  /** Types a command and waits for `expected` in the output. */
  async run(command: string, expected: string) {
    this.type(`${command}\r`)
    await this.until((v) => v.text.includes(expected), expected)
  }
}

let markers = 0

/**
 * Reads the shell's size, `<rows>x<cols>`, as the owner's shell sees it, until
 * it is `size` or 20 reads have passed: a resize and the keystrokes after it
 * travel separately, so the first read may precede the resize. Each read has
 * its own marker; the last one read is returned with the size.
 */
const sizeBecomes = async (viewer: Viewer, size: string) => {
  for (let attempt = 1;; attempt++) {
    const marker = `S${++markers}-`
    viewer.type(`echo ${marker}$(stty size | tr ' ' x)\r`)
    await viewer.until((v) => new RegExp(`${marker}\\d+x\\d+`).test(v.text), marker)
    const seen = new RegExp(`${marker}(\\d+x\\d+)`).exec(viewer.text)![1]!
    if (seen === size || attempt === 20) return { size: seen, line: `${marker}${seen}` }
  }
}

describe.skipIf(!("socketPath" in docker))(`ContainerTerminal in workerd with a real container (${label})`, () => {
  const receipts: Record<string, number> = {}

  beforeAll(async () => {
    try {
      execFileSync("docker", ["image", "inspect", egressImage], { stdio: "ignore" })
    } catch {
      execFileSync("docker", ["pull", egressImage], { stdio: "ignore" })
    }
    const before = (() => {
      try {
        return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8" }).trim()
      } catch {
        return undefined
      }
    })()
    execFileSync("docker", ["build", "--quiet", "--tag", image, context], { stdio: "ignore" })
    const after = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8" })
      .trim()
    // A rebuilt image leaves its predecessor untagged; remove it unless a container still uses it.
    if (before !== undefined && before !== after) {
      try {
        execFileSync("docker", ["image", "rm", before], { stdio: "ignore" })
      } catch {
        // In use by a running container: Docker keeps it.
      }
    }
    const bundled = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*"],
      logLevel: "silent"
    })
    class StartupLog extends Log {
      override log(message: string) {
        super.log(message.replaceAll(token, "[redacted]"))
      }
    }
    mf = new Miniflare({
      log: new StartupLog(LogLevel.WARN),
      verbose: true,
      containerEngine: {
        localDocker: {
          socketPath: (docker as { readonly socketPath: string }).socketPath,
          containerEgressInterceptorImage: egressImage
        }
      },
      workers: [{
        config: {
          name: worker,
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: bundled.outputFiles[0]!.text } }
          },
          env: {
            SANDBOX: { type: "durable-object", worker, exportName: "Sandbox" },
            FORGE_TOKEN: { type: "text", value: token },
            FORGE_SHA: { type: "text", value: sha }
          },
          exports: {
            Sandbox: { type: "durable-object", storage: "sqlite", container: { images: [{ name: "sandbox", image }] } },
            Forge: { type: "worker" }
          }
        }
      }]
    })
  }, 600_000)

  afterAll(async () => {
    await mf?.dispose()
    // dispose() leaves the object's container and its proxy running: remove this run's.
    const names = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" })
      .split("\n")
      .filter((name) => name.startsWith(`workerd-${worker}-`))
    if (names.length > 0) execFileSync("docker", ["rm", "-f", ...names], { stdio: "ignore" })
    console.info(`container terminal receipts: ${JSON.stringify(receipts)}`)
  }, 60_000)

  it(
    "wakes the container offline; the box reaches the intercepted forge, nothing else, and holds no secret",
    async () => {
      const started = performance.now()
      const woken = await call("/wake", { method: "POST" })
      expect(await woken.json()).toEqual({ outcome: "started" })
      receipts.wakeMs = Math.round(performance.now() - started)
      expect((await exec(["true"])).exitCode).toBe(0)
      receipts.coldStartToExecMs = Math.round(performance.now() - started)

      // A second wake finds it running and registers the intercept again.
      expect(await (await call("/wake", { method: "POST" })).json()).toEqual({ outcome: "running" })

      const listed = await exec(["git", "ls-remote", "http://forge.smithers.internal/acme/widgets"])
      expect(listed).toMatchObject({ exitCode: 0 })
      expect(listed.stdout).toContain(`${sha}\trefs/heads/main`)
      // Internet access is off: any other host is unreachable.
      expect((await exec(["git", "ls-remote", "http://example.com/acme/widgets"])).exitCode).not.toBe(0)

      // The token is in no environment, argument vector or file of the box.
      const processes = await exec([
        "sh",
        "-c",
        "env; for f in /proc/[0-9]*/cmdline /proc/[0-9]*/environ; do tr '\\0' ' ' < \"$f\" 2>/dev/null; echo; done"
      ], "0:0")
      expect(processes.exitCode).toBe(0)
      expect(processes.stdout).toContain("HOME=")
      expect(processes.stdout).not.toContain(token)
      // grep runs with the token split across two arguments, joined only in its own argv.
      const half = token.length / 2
      const files = await exec([
        "sh",
        "-c",
        "grep -rIlF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -e \"$1$2\" / 2>/dev/null; echo \"grep=$?\"",
        "sh",
        token.slice(0, half),
        token.slice(half)
      ], "0:0")
      expect(files.stdout.trim()).toBe("grep=1")
    },
    180_000
  )

  // workerd's exec pipes hold no bytes: over the default pipes, a command whose output nobody reads blocks on its first
  // write and its exit code never comes (this case timed out so). A branch's box provisioning a person's user hung so:
  // useradd warns on stderr about a uid above UID_MAX.
  it("a command run for its exit code settles however much it writes", async () => {
    const run = async (script: string) => {
      const response = await call("/run", {
        method: "POST",
        body: JSON.stringify({ argv: ["sh", "-c", script], user: "0:0" })
      })
      return (await response.json()) as { readonly exitCode: number }
    }
    // One line on stderr, as useradd's warning is.
    expect(await run("echo 'useradd warning: uid outside of the UID_MIN 1000 and UID_MAX 60000 range.' >&2")).toEqual({
      exitCode: 0
    })
    expect(await run("head -c 200000 /dev/zero | tr '\\0' x; head -c 200000 /dev/zero | tr '\\0' y >&2; exit 3"))
      .toEqual({ exitCode: 3 })
  }, 60_000)

  const terminal = randomUUID()

  it("the owner's keystrokes reach the shell; a reader's bytes, replies and sizes never do", async () => {
    const created = await call(`/session?name=${terminal}&user=1000:2000&cwd=/workspace`, { method: "POST" })
    expect(await created.json()).toEqual({ outcome: "created" })
    expect(await (await call(`/session?name=${terminal}&user=1000:2000&cwd=/workspace`, { method: "POST" })).json())
      .toEqual({ outcome: "existing" })

    const owner = await Viewer.open({ name: terminal, access: "write", cols: 100, rows: 30 })
    expect(owner.controls[0]).toEqual({ type: "ready", access: "write" })
    await owner.until((v) => v.firstByteMs !== undefined, "first byte")
    receipts.attachToFirstByteMs = Math.round(owner.firstByteMs!)

    // The reader attaches at another size, which must not size the window.
    const reader = await Viewer.open({ name: terminal, access: "read", cols: 60, rows: 12 })
    expect(reader.controls[0]).toEqual({ type: "ready", access: "read" })
    await reader.until((v) => v.firstByteMs !== undefined, "the reader's first byte")
    const window = await exec(["tmux", "list-windows", "-t", `=${terminal}`, "-F", "#{window_width}x#{window_height}"])
    expect(window.stdout.trim()).toBe("100x30")
    const first = await sizeBecomes(owner, "30x100")
    expect(first.size).toBe("30x100")
    // The reader watches the same shell.
    await reader.until((v) => v.text.includes(first.line), "the reader sees the owner's output")

    // Everything a reader sends is dropped: keystrokes, xterm's automatic
    // replies, a resize. The malformed frame after them closes its socket,
    // so by then the object has handled every earlier frame.
    reader.type("touch /tmp/reader-typed\r")
    reader.type("\x1b[?1;2c\x1b[12;60R")
    reader.socket.send(TerminalProtocol.encodeResize(40, 10))
    reader.socket.send("{nope")
    expect(await reader.closed()).toBe(TerminalProtocol.CloseCode.unsupported)

    const marker = `R-${randomUUID().slice(0, 8)}`
    await owner.run(`echo ${marker.slice(0, 2)}$(echo ${marker.slice(2)})`, marker)
    expect((await exec(["test", "-e", "/tmp/reader-typed"])).exitCode).toBe(1)
    expect((await sizeBecomes(owner, "30x100")).size).toBe("30x100")

    // The owner's resize sizes the shell.
    owner.socket.send(TerminalProtocol.encodeResize(120, 40))
    expect((await sizeBecomes(owner, "40x120")).size).toBe("40x120")

    // Owner input reaches the shell as typed, and the shell's state is the
    // owner's: what it sets survives the owner's socket.
    await owner.run("cd /tmp && export TERMINAL_MARK=m-$((2+3)) && echo set-$((40+2))", "set-42")
    owner.socket.close(1000)
    expect(await owner.closed()).toBe(1000)

    // A reload: a new socket, a new tmux client, the same shell.
    const reloaded = await Viewer.open({ name: terminal, access: "write", cols: 120, rows: 40 })
    await reloaded.until((v) => v.text.includes("set-42"), "tmux redraws the screen")
    await reloaded.run("echo E-$TERMINAL_MARK-$(pwd)", "E-m-5-/tmp")

    // A frame over the cap closes the socket; the shell lives on.
    reloaded.socket.send(new Uint8Array(TerminalProtocol.maxFrameBytes + 1))
    expect(await reloaded.closed()).toBe(TerminalProtocol.CloseCode.tooBig)

    // Killing the session ends every viewer: ended, then 1000.
    const last = await Viewer.open({ name: terminal, access: "write", cols: 80, rows: 24 })
    const watcher = await Viewer.open({ name: terminal, access: "read", cols: 80, rows: 24 })
    await last.run("echo still-$((1+1))-$TERMINAL_MARK", "still-2-m-5")
    expect((await exec(["tmux", "kill-session", "-t", `=${terminal}`])).exitCode).toBe(0)
    for (const viewer of [last, watcher]) {
      expect(await viewer.closed()).toBe(TerminalProtocol.CloseCode.ended)
      expect(viewer.controls.at(-1)).toEqual({ type: "ended", reason: "closed" })
    }

    // Every bridge has ended: the owner's first socket closed by the viewer,
    // the reader refused, the reload too big, and the last two ended.
    const reports = (await (await call("/reports?count=5")).json()) as Array<ContainerTerminal.Report>
    expect(reports.map((report) => `${report.outcome}:${report.closeCode}`).sort()).toEqual([
      "closed:null",
      "ended:1000",
      "ended:1000",
      "too_big:1009",
      "unsupported:1003"
    ])
    const readerReport = reports.find((report) => report.bytes.dropped > 0)!
    expect(readerReport.bytes.in).toBe(0)
    expect(readerReport.bytes.dropped).toBe("touch /tmp/reader-typed\r".length + "\x1b[?1;2c\x1b[12;60R".length)
  }, 180_000)
})
