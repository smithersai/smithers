import { Deferred, Effect, Fiber } from "effect"
import { EventEmitter, once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Host, main, mainEffect } from "../src/cli/Entry.ts"
import { ModuleLoader } from "../src/internal/ProviderModules.ts"
import { packageVersion } from "../src/Version.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = (argv = ["--help"], env: Host["env"] = {}) => {
  const signals = new EventEmitter()
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const host: Host = {
    argv,
    env,
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    on: (signal, listener) => {
      signals.on(signal, listener)
    },
    removeListener: (signal, listener) => {
      signals.removeListener(signal, listener)
    },
    setExitCode: (code) => {
      result.codes.push(code)
    }
  }
  return { host, signals, result }
}
const clean = (signals: EventEmitter) => {
  expect(signals.listenerCount("SIGINT")).toBe(0)
  expect(signals.listenerCount("SIGTERM")).toBe(0)
}

describe("unified process entry with the real command tree", () => {
  it("isolates cache credentials and prints real help without loading a provider", async () => {
    const env = { SMITHERS_CACHE_URL: "https://cache.invalid", SMITHERS_CACHE_TOKEN: "fixture-token", KEEP: "yes" }
    const { host, signals, result } = fixture(["flow", "--help"], env)
    await Effect.runPromise(
      mainEffect(host).pipe(Effect.provideService(ModuleLoader, {
        load: () => Effect.die(new Error("Help must not load a provider"))
      }))
    )
    expect(env).toEqual({ KEEP: "yes" })
    expect(result.stdout).toContain("start")
    expect(result.stdout).toContain("plan")
    expect(result.stdout + result.stderr).not.toContain("fixture-token")
    expect(result.codes.at(-1)).toBe(0)
    clean(signals)
  })

  it("anchors relative PATH entries before serving the actual version command", async () => {
    const launch = resolve("launch")
    const absolute = resolve("bin")
    const env = { PATH: ["./node_modules/.bin", "", absolute].join(delimiter) }
    const { host, signals, result } = fixture(["--version"], env)
    await main({ ...host, cwd: launch })
    expect(env.PATH).toBe([join(launch, "node_modules", ".bin"), absolute].join(delimiter))
    expect(result.stdout).toContain(packageVersion)
    expect(result.codes.at(-1)).toBe(0)
    clean(signals)
  })

  it("preserves a real command failure through final process cleanup", async () => {
    const { host, signals, result } = fixture(["serve", "--port=-1", "--json"])
    await main(host)
    expect(result.codes.at(-1)).toBe(1)
    expect(result.stdout + result.stderr).toContain("port")
    clean(signals)
  })

  it("rejects invalid presentation settings and cleans listeners", async () => {
    const { host, signals, result } = fixture(["--help"], { SMITHERS_AUDIENCE: "unknown" })
    await main(host)
    expect(result.codes.at(-1)).toBe(1)
    expect(result.stderr).toContain("SMITHERS_AUDIENCE")
    expect(result.stdout).toBe("")
    clean(signals)
  })

  it.each(
    [
      [["tui"], false],
      [["--ui", "plain", "tui"], false],
      [["--ui=plain", "tui"], false],
      [["--audience", "human", "tui"], false],
      [["tui", "--print=once"], true],
      [["tui", "-p", "once"], true]
    ] as const
  )(
    "gives interactive TUI ownership of Ctrl+C, while print mode is cancellable: %j",
    async (argv, print) => {
      const root = await mkdtemp(join(tmpdir(), "smthrs-entry-tui-"))
      roots.push(root)
      const server = createServer()
      server.listen(0, "127.0.0.1")
      await once(server, "listening", { signal: AbortSignal.timeout(10_000) })
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Expected TCP listener")
      const script = join(root, "tui.cjs")
      await writeFile(
        script,
        "const socket = require('node:net').createConnection(" + address.port + ", '127.0.0.1')\n"
          + "socket.on('connect', () => socket.write('ready'))\n"
          + "socket.on('data', () => socket.write('alive'))\n"
          + "socket.on('end', () => process.exit(0))\n"
          + "socket.on('error', () => process.exit(0))\n"
      )
      const executable = join(root, "tui")
      await writeFile(
        executable,
        "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(script) + "\n",
        { mode: 0o755 }
      )
      const { host, signals, result } = fixture([...argv], {
        SMITHERS_TUI_BIN: executable
      })
      const connected = once(server, "connection", { signal: AbortSignal.timeout(10_000) })
      let settled = false
      const running = main(host).finally(() => {
        settled = true
      })
      let socket: Socket | undefined
      try {
        const connection = await Promise.race([
          connected,
          running.then(() => {
            throw new Error("TUI exited before connecting: " + result.stderr)
          })
        ])
        socket = connection[0] as Socket
        await Promise.race([
          once(socket, "data", { signal: AbortSignal.timeout(10_000) }),
          running.then(() => {
            throw new Error("TUI exited before its ready frame")
          })
        ])
        signals.emit("SIGINT")
        if (print) {
          await Effect.runPromise(Effect.promise(() => running).pipe(Effect.timeout("10 seconds")))
          expect(result.codes.at(-1)).toBe(130)
        } else {
          const response = Promise.race([
            once(socket, "data", { signal: AbortSignal.timeout(10_000) }),
            running.then(() => {
              throw new Error("Interactive TUI exited on Ctrl+C")
            })
          ])
          socket.write("ping")
          expect(String((await response)[0])).toBe("alive")
          expect(settled).toBe(false)
          expect(result.codes).not.toContain(130)
          socket.end()
          await Effect.runPromise(Effect.promise(() => running).pipe(Effect.timeout("10 seconds")))
          expect(result.codes.at(-1)).toBe(0)
        }
        clean(signals)
      } finally {
        if (!settled) signals.emit("SIGTERM")
        socket?.destroy()
        await Promise.all([
          Effect.runPromise(Effect.promise(() => running).pipe(Effect.timeout("10 seconds"))),
          Effect.runPromise(
            Effect.promise(() =>
              new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
            ).pipe(Effect.timeout("10 seconds"))
          )
        ])
      }
    }
  )

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)(
    "cancels an injected pending Effect service on %s and awaits its cleanup",
    async (signal, code) => {
      const root = await mkdtemp(join(tmpdir(), "smthrs-entry-cancel-"))
      roots.push(root)
      await writeFile(
        join(root, "claude"),
        "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}'\n",
        { mode: 0o755 }
      )
      const { host, signals, result } = fixture(["flwo"], { PATH: root, SMITHERS_AUDIENCE: "human" })
      let released = false
      await Effect.runPromise(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const pending = yield* mainEffect({ ...host, cwd: root, stdout: { ...host.stdout, isTTY: true } }).pipe(
          Effect.provideService(ModuleLoader, {
            load: () =>
              Effect.acquireUseRelease(
                Deferred.succeed(entered, undefined),
                () => Effect.never,
                () =>
                  Effect.sync(() => {
                    released = true
                  })
              )
          }),
          Effect.forkChild
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"))
        signals.emit(signal)
        yield* Fiber.join(pending)
      }))
      expect(released).toBe(true)
      expect(result.codes.at(-1)).toBe(code)
      expect(result.stderr).toBe("")
      clean(signals)
    }
  )
})
