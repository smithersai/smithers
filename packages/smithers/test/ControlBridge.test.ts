import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Audience from "@smthrs/build-cli/Audience"
import { ApprovalAuthority, Control } from "@smthrs/control"
import { Unavailable } from "@smthrs/control/ControlError"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { Cause, Effect, Layer, Logger, References, Stream } from "effect"
import { HttpServer } from "effect/http"
import { getEventListeners } from "node:events"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  watch,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Bridge from "../src/cli/ControlBridge.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as BugCommand from "../src/commands/Bug.ts"
import * as CommandStatus from "../src/internal/CommandStatus.ts"
import * as ControlDatabase from "../src/internal/ControlDatabase.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Project from "../src/Project.ts"
import * as Ui from "../src/Ui.ts"

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-control-bridge-"))
  roots.push(root)
  return { root, quiet: false }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const plain = Audience.resolve({ env: {}, audience: "human", stdout: false, stderr: false })
const silent = { ...plain, progress: "silent" as const, interactive: false }
const runtime = { environment: {}, presentation: plain, evaluator: ScriptedJudge.layer }
const bind = { host: "127.0.0.1", port: 0, listen: false, credential: undefined }

// The RPC server and client are real, backed by the production SQLite control
// host. Only unhappy paths decorate that public service with a failing Effect.
const remote = <A>(
  root: string,
  use: (options: Bridge.ConnectionOptions) => Promise<A>,
  fault?: (service: Control.Service) => Control.Service
) => {
  const live = NodeControl.layerControl({ root, startsRuns: false })
  const control = fault === undefined ? live : Layer.effect(
    Control.Control,
    Effect.map(Control.Control, fault)
  ).pipe(Layer.provide(live))
  return Effect.runPromise(
    Effect.gen(function*() {
      const { address } = yield* HttpServer.HttpServer
      if (address._tag !== "InetAddressV4") throw new Error("expected a loopback TCP server")
      return yield* Effect.tryPromise({
        try: () => use({ root, quiet: false, remote: `http://127.0.0.1:${address.port}` }),
        catch: (cause) => cause
      })
    }).pipe(
      Effect.provide(NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(Layer.provide(control))),
      Effect.scoped
    )
  )
}

const seedEvents = (root: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      for (const eventType of ["first", "second"]) {
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("watched"),
            sourceId: JournalEvent.SourceId.make("test"),
            eventType,
            payload: {}
          })
        )
      }
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
          Layer.provide(ControlDatabase.layer(NodeControl.databasePath(root)))
        )
      ),
      Effect.scoped
    )
  )

describe("control bridge configuration", () => {
  it("preserves explicit connection arguments and quiet defaults", () => {
    expect(Bridge.connectionOptions.parse({})).toEqual({ quiet: false })
    expect(Bridge.connectionArguments({ quiet: false })).toEqual([])
    expect(
      Bridge.connectionArguments({
        root: "some project",
        remote: "https://control.invalid",
        mcpConfig: "servers.json",
        quiet: true
      })
    )
      .toEqual([
        "--root",
        "some project",
        "--remote",
        "https://control.invalid",
        "--mcp-config",
        "servers.json",
        "--quiet"
      ])
  })

  it("resolves relative roots and explicit transport precedence", () => {
    const local = fixture()
    const root = relative(process.cwd(), local.root)
    const environment = { SMITHERS_REMOTE: "https://env.invalid", SMITHERS_TOKEN: "env-fixture" }
    expect(Bridge.configuration({ root, quiet: false }, { environment })).toMatchObject({
      root: resolve(root),
      remote: "https://env.invalid",
      credential: "env-fixture",
      executionRoot: undefined
    })
    expect(Bridge.configuration({ ...local, remote: "https://explicit.invalid" }, {
      environment,
      executionRoot: join(local.root, "snapshot")
    })).toMatchObject({
      root: local.root,
      remote: "https://explicit.invalid",
      credential: "env-fixture",
      executionRoot: join(local.root, "snapshot")
    })
  })

  it("has records only over a remote plane or an existing local control store", () => {
    const local = fixture()
    expect(Bridge.hasRecords(local, runtime)).toBe(false)
    expect(Bridge.isRemote(local, runtime)).toBe(false)
    expect(Bridge.hasRecords(local, { environment: { SMITHERS_REMOTE: "https://control.invalid" } })).toBe(true)
    mkdirSync(join(local.root, ".flows"))
    writeFileSync(NodeControl.databasePath(local.root), "")
    expect(Bridge.hasRecords(local, runtime)).toBe(true)
  })

  it("binds MCP identity and host policy independently of presentation", async () => {
    const local = fixture()
    const host = { ...runtime, approvalAuthority: ApprovalAuthority.local }
    for (
      const context of [{ agent: true, formatExplicit: true, globals: {} }, {
        request: {},
        globals: { audience: "human" as const }
      }]
    ) {
      await Presentation.scope(context, host, async () => {
        expect(Presentation.current()?.transport).toBe("mcp")
        expect(Bridge.configuration({ quiet: false }, host)).toMatchObject({
          principal: { id: "mcp", kind: "agent" },
          approvalAuthority: ApprovalAuthority.local
        })
      })
    }
    expect(Bridge.configuration(local, host).principal).toBeUndefined()
    expect(Bridge.connectionOptions.parse({ approvalAuthority: { authorize: "untrusted" } })).not.toHaveProperty(
      "approvalAuthority"
    )
  })

  it("refuses caller-selected MCP destinations before opening a host", async () => {
    const local = fixture()
    const host = { ...runtime, environment: { SMITHERS_REMOTE: "https://host.invalid", SMITHERS_TOKEN: "host-bearer" } }
    await Presentation.scope({ request: {}, command: "flow_list" }, host, async () => {
      for (
        const override of [{ remote: "https://attacker.invalid" }, { root: local.root }, {
          mcpConfig: "untrusted.json"
        }]
      ) {
        await expect(Bridge.invoke(["ls"], { quiet: false, ...override }, host)).rejects.toThrow(
          /is not accepted over MCP/
        )
        await expect(Bridge.query(Effect.void, { quiet: false, ...override }, host)).rejects.toThrow(
          /is not accepted over MCP/
        )
      }
      expect(Bridge.configuration({ quiet: false }, host)).toMatchObject({
        remote: "https://host.invalid",
        credential: "host-bearer",
        principal: { id: "mcp", kind: "agent" }
      })
    })
    expect(existsSync(join(local.root, ".flows"))).toBe(false)
  })

  it("keeps concurrent CLI and MCP identities separate", async () => {
    const local = fixture()
    await Promise.all([
      Presentation.scope({ agent: true, formatExplicit: true, globals: {} }, runtime, async () => {
        await Promise.resolve()
        expect(Bridge.configuration({ quiet: false }, runtime).principal).toEqual({ id: "mcp", kind: "agent" })
      }),
      Presentation.scope({ globals: { audience: "human" } }, runtime, async () => {
        await Promise.resolve()
        expect(Bridge.configuration(local, runtime).principal).toBeUndefined()
      })
    ])
  })
})

describe("control bridge with production dependencies", () => {
  it.each([false, true])(
    "parses the emitted invocation and captures the actual flow document (remote=%s)",
    async (overRpc) => {
      const local = fixture()
      const flow = join(local.root, ".smithers", "flows", "failing", "flow.ts")
      mkdirSync(join(local.root, ".smithers", "flows", "failing"), { recursive: true })
      writeFileSync(flow, readFileSync(new URL("./fixtures/bin-failing/flow.ts", import.meta.url)))
      symlinkSync(resolve("node_modules"), join(local.root, "node_modules"), "dir")
      const check = async (options: Bridge.ConnectionOptions) => {
        const document = await Bridge.invoke(["ls"], options, runtime)
        expect(document).toMatchObject({
          _tag: "flows",
          items: [{ flowId: "failing", description: "Fail at the native flow boundary." }]
        })
        expect(await Bridge.invoke(["ls"], { ...options, quiet: true }, runtime)).toEqual(document)
        // This used to pass with the canned handler even though "list" is not a
        // production flat command. Parser regressions must cross this boundary.
        await expect(Bridge.invoke(["not-a-command"], options, runtime)).rejects.toBeDefined()
      }
      if (overRpc) await remote(local.root, check)
      else await check(local)
      expect(existsSync(NodeControl.databasePath(local.root))).toBe(true)
    }
  )

  it.each([undefined, "{", "null", "{}", "{\"target\":{\"_tag\":\"Node\",\"runId\":4}}"])(
    "lets the production approval parser reject malformed input (%s)",
    async (payload) => {
      const local = fixture()
      await expect(Bridge.invoke(payload === undefined ? ["approve"] : ["approve", payload], local, runtime))
        .rejects.toBeDefined()
    }
  )

  it.each([
    { verb: "resume", args: ["resume", "missing-run"] },
    { verb: "cancel", args: ["cancel", "missing-run"] },
    { verb: "signal", args: ["signal", "missing-run", JSON.stringify({ name: "continue", payload: {} })] },
    { verb: "steer", args: ["steer", "missing-run", "--message", "continue"] }
  ])("runs the real local $verb handler after history preparation", async ({ args }) => {
    const local = fixture()
    await expect(Bridge.invoke(args, local, runtime)).rejects.toThrow(/missing-run/)
    expect(existsSync(NodeControl.databasePath(local.root))).toBe(true)
  })

  it("provides real project and registry layers without creating a control database", async () => {
    const local = fixture()
    const seen = await Bridge.local(
      Effect.gen(function*() {
        expect(yield* Project.ProjectRoot).toBe(local.root)
        expect((yield* RunProgress.Configuration)?.policy.progress).toBe("silent")
        expect(yield* References.MinimumLogLevel).toBe("Error")
        return (yield* Ui.Ui).interactive
      }),
      { ...local, quiet: true },
      runtime
    )
    expect(seen).toBe(false)
    expect(existsSync(NodeControl.databasePath(local.root))).toBe(false)
  })

  it.each([undefined, plain, silent])(
    "queries real SQLite with the requested presentation (%j)",
    async (presentation) => {
      const local = fixture()
      const rows = await Bridge.query(
        Effect.gen(function*() {
          expect(yield* Logger.LogToStderr).toBe(true)
          expect(yield* References.MinimumLogLevel).toBe(presentation === silent ? "Error" : "Info")
          return yield* (yield* Control.Control).list({ _tag: "runs" })
        }),
        local,
        { ...runtime, presentation }
      )
      expect(rows).toEqual({ _tag: "runs", items: [] })
      expect(existsSync(NodeControl.databasePath(local.root))).toBe(true)
      await Presentation.scope({ command: "list" }, { ...runtime, presentation: silent }, async () => {
        expect(await Bridge.query(References.MinimumLogLevel, local, runtime)).toBe("Error")
      })
    }
  )

  it.each(["query", "launch"] as const)(
    "reports %s status to its host without changing process.exitCode",
    async (kind) => {
      const local = fixture()
      const codes: number[] = []
      const before = process.exitCode
      const result = await Bridge[kind](Effect.as(CommandStatus.set(130), "cancelled"), local, {
        ...runtime,
        exit: (code) => {
          codes.push(code)
        }
      })
      expect(result).toBe("cancelled")
      expect(codes).toEqual([130])
      expect(process.exitCode).toBe(before)
      // Reopening the real database after the scope closes must succeed.
      expect(
        await Bridge.query(Effect.flatMap(Control.Control, (control) => control.list({ _tag: "runs" })), local, runtime)
      )
        .toEqual({ _tag: "runs", items: [] })
    }
  )

  it.each(["query", "launch"] as const)("preserves %s failure identity and runs acquired finalizers", async (kind) => {
    const local = fixture()
    const failure = new Error("operation failed")
    let released = false
    const operation = Effect.gen(function*() {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          released = true
        }))
      return yield* Effect.fail(failure)
    }).pipe(Effect.scoped)
    await expect(Bridge[kind](operation, local, runtime)).rejects.toBe(failure)
    expect(released).toBe(true)
  })

  it("interrupts an active query and releases its resources", async () => {
    const local = fixture()
    const abort = new AbortController()
    const ready = Promise.withResolvers<void>()
    let released = false
    const operation = Effect.gen(function*() {
      yield* Effect.acquireRelease(Effect.sync(() => ready.resolve()), () =>
        Effect.sync(() => {
          released = true
        }))
      return yield* Effect.never
    }).pipe(Effect.scoped)
    const running = Bridge.query(operation, local, { ...runtime, signal: abort.signal })
    const result = running.catch((error: unknown) => error)
    await ready.promise
    abort.abort(new Error("test cancellation"))
    expect(await result).toMatchObject({ code: "interrupted", fault: "user" })
    expect(released).toBe(true)
  })

  it("surfaces a failing Control Effect through the real parser and RPC transport", async () => {
    const local = fixture()
    await remote(local.root, async (options) => {
      await expect(Bridge.invoke(["ls"], options, runtime)).rejects.toMatchObject({
        _tag: "/control/Unavailable",
        feature: "list"
      })
    }, (service) => ({ ...service, list: () => Effect.fail(new Unavailable({ feature: "list", ticket: "fixture" })) }))
  })

  it("observes existing stores without changing the database", async () => {
    const local = fixture()
    await Bridge.query(Effect.void, local, runtime)
    const before = statSync(NodeControl.databasePath(local.root)).mtimeMs
    expect(
      await Bridge.read(Effect.flatMap(Control.Control, (control) => control.list({ _tag: "runs" })), local, runtime)
    )
      .toEqual({ _tag: "runs", items: [] })
    const rows: unknown[] = []
    for await (const row of Bridge.events("missing", false, local, runtime)) rows.push(row)
    expect(rows).toEqual([])
    expect(statSync(NodeControl.databasePath(local.root)).mtimeMs).toBe(before)
  })

  it.each(["abort", "return"] as const)(
    "releases an acquired remote watch on %s and removes its listener",
    async (stop) => {
      const local = fixture()
      await seedEvents(local.root)
      const released = Promise.withResolvers<void>()
      await remote(local.root, async (options) => {
        const abort = new AbortController()
        const iterator = Bridge.events("watched", true, options, { ...runtime, signal: abort.signal })
          [Symbol.asyncIterator]()
        const first = await iterator.next()
        expect(first).toMatchObject({ done: false, value: { kind: "first", runId: "watched" } })
        if (stop === "abort") {
          abort.abort()
          // A buffered second event may be delivered before the interruption;
          // exhaust it to observe closure of the acquired RPC stream.
          while (!(await iterator.next()).done) {}
        } else await iterator.return!()
        await released.promise
        expect(getEventListeners(abort.signal, "abort")).toEqual([])
      }, (service) => ({
        ...service,
        watch: (request) => service.watch(request).pipe(Stream.ensuring(Effect.sync(() => released.resolve())))
      }))
    }
  )

  it("forwards real watch cursors without redelivering earlier events", async () => {
    const local = fixture()
    await seedEvents(local.root)
    await remote(local.root, async (options) => {
      const rows = []
      for await (const row of Bridge.events("watched", false, options, runtime)) rows.push(row)
      expect(rows.map((row) => row.kind)).toEqual(["first", "second"])
      for (const after of [{ sequence: rows[0]!.sequence }, { sequence: rows[0]!.sequence, offset: 0 }]) {
        const resumed = []
        for await (const row of Bridge.events("watched", false, options, runtime, after)) resumed.push(row)
        expect(resumed.map((row) => row.kind)).toEqual(["second"])
      }
    })
  })

  it("releases a failed watch through the public service boundary", async () => {
    const local = fixture()
    const released = Promise.withResolvers<void>()
    await remote(local.root, async (options) => {
      const iterator = Bridge.events("watched", false, options, runtime)[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ _tag: "/control/Unavailable", feature: "watch" })
      await released.promise
    }, (service) => ({
      ...service,
      watch: () =>
        Stream.fail(new Unavailable({ feature: "watch", ticket: "fixture" })).pipe(
          Stream.ensuring(Effect.sync(() => released.resolve()))
        )
    }))
  })

  it("completes an already-cancelled watch without retaining a listener", async () => {
    const local = fixture()
    await seedEvents(local.root)
    const abort = new AbortController()
    abort.abort()
    const iterator = Bridge.events("missing", true, local, { ...runtime, signal: abort.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(getEventListeners(abort.signal, "abort")).toEqual([])
  })
})

// A token file is written by Serve.Ready only after the real socket and
// scheduler layers have acquired. Watching its publication is a readiness
// barrier, and the HTTP probe proves the executable is actually serving.
describe("real serve command", () => {
  it.each([false, true])("serves authenticated loopback RPC and keeps the token private (quiet=%s)", async (quiet) => {
    const local = fixture()
    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("expected a TCP port")
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
    const tokenFile = join(local.root, "operator.token")
    const ready = Promise.withResolvers<void>()
    const watcher = watch(local.root, () => {
      if (existsSync(tokenFile)) ready.resolve()
    })
    const abort = new AbortController()
    let stdout = ""
    let stderr = ""
    const codes: number[] = []
    const running = makeCli({
      ...runtime,
      signal: abort.signal,
      stderr: {
        isTTY: false,
        columns: 80,
        write: (text) => {
          stderr += text
        }
      }
    }).serve([
      "serve",
      "--root",
      local.root,
      "--port",
      String(address.port),
      "--operator-token-file",
      tokenFile,
      ...(quiet ? ["--quiet"] : [])
    ], {
      env: {},
      stdout: (text) => {
        stdout += text
      },
      exit: (code) => {
        codes.push(code)
      }
    })
    const settled = running.then(() => "settled", (error: unknown) => error)
    try {
      await Promise.race([
        ready.promise,
        settled.then((error) => {
          throw new Error(`serve ended before readiness: ${String(error)}`)
        })
      ])
      const url = `http://127.0.0.1:${address.port}`
      expect((await fetch(`${url}/health`)).ok).toBe(true)
      const token = readFileSync(tokenFile, "utf8").trim()
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
      expect(
        await Bridge.invoke(["ls"], { ...local, remote: url }, { ...runtime, environment: { SMITHERS_TOKEN: token } })
      )
        .toMatchObject({ _tag: "flows", items: expect.any(Array) })
      expect(stdout + stderr).not.toContain(token)
      if (quiet) expect(stdout + stderr).toBe("")
      else expect(stderr).toContain(String(address.port))
    } finally {
      watcher.close()
      abort.abort()
      await settled
    }
    expect(codes.every((code) => code === 0 || code === 1)).toBe(true)
    await expect(fetch(`http://127.0.0.1:${address.port}/health`)).rejects.toThrow()
  })

  it("refuses remote or public hosting before opening a store or token file", async () => {
    const local = fixture()
    await expect(Bridge.host(bind, { ...local, remote: "https://control.invalid" }, runtime)).rejects.toThrow(
      "--remote is not supported"
    )
    await expect(Bridge.host({ ...bind, host: "0.0.0.0" }, local, runtime)).rejects.toThrow("pass --listen")
    expect(existsSync(join(local.root, ".flows"))).toBe(false)
  })
})

describe("bug report consent through real local dependencies", () => {
  const summary = `${"two  spaces of diagnostic context; ".repeat(30)}Authorization: Bearer private-preview-token`
  const receiver = async (use: (endpoint: string, posts: string[]) => Promise<void>) => {
    const posts: string[] = []
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += String(chunk)
      posts.push(body)
      response.writeHead(202).end("{}")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("expected a loopback port")
    try {
      await use(`http://127.0.0.1:${address.port}/report`, posts)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
  const preview = (stderr: string, endpoint: string) => {
    const [shownEndpoint, payload] = stderr.trimEnd().split("\n")
    expect(shownEndpoint).toBe(endpoint)
    expect(payload!.length).toBeGreaterThan(500)
    expect(payload).not.toContain("private-preview-token")
    expect(JSON.parse(payload!).summary).toContain("two  spaces")
    return payload!
  }

  it.each([{ flags: ["--yes", "--quiet"] }, { flags: ["--yes", "--dry-run", "--quiet"] }, { flags: ["--quiet"] }])(
    "previews the full redacted document and obeys consent flags %j",
    async ({ flags }) => {
      const local = fixture()
      await receiver(async (endpoint, posts) => {
        let stderr = ""
        let stdout = ""
        const codes: number[] = []
        const config = {
          ...runtime,
          environment: { SMITHERS_BUG_ENDPOINT: endpoint },
          stderr: {
            isTTY: false,
            columns: 80,
            write: (text: string) => {
              stderr += text
            }
          }
        }
        await makeCli(config).serve(["bug", summary, "--root", local.root, "--json", ...flags], {
          env: config.environment,
          stdout: (text) => {
            stdout += text
          },
          exit: (code) => {
            codes.push(code)
          }
        })
        const payload = preview(stderr, endpoint)
        if (flags.includes("--dry-run")) {
          expect(JSON.parse(stdout)).toMatchObject({ reported: false, endpoint, payload: JSON.parse(payload) })
          expect(posts).toEqual([])
        } else if (flags.includes("--yes")) {
          expect(JSON.parse(stdout)).toMatchObject({ reported: true, endpoint })
          expect(posts).toEqual([payload])
        } else {
          expect(stdout).toContain("Report not sent")
          expect(codes).toContain(2)
          expect(posts).toEqual([])
        }
      })
    }
  )

  it.each([false, true])("previews before a real prompt accepts or declines (%s)", async (accepted) => {
    const local = fixture()
    await receiver(async (endpoint, posts) => {
      let stderr = ""
      let prompted = false
      const input = new PassThrough()
      const output = new Writable({
        write(chunk, _encoding, done) {
          if (!prompted && String(chunk).includes("Post this report")) {
            prompted = true
            preview(stderr, endpoint)
            expect(posts).toEqual([])
            queueMicrotask(() => input.write(accepted ? "y\r" : "n\r"))
          }
          done()
        }
      })
      const ui = Ui.make({ output, input, interactive: true })
      try {
        const operation = BugCommand.submit({
          summary,
          yes: false,
          dryRun: false,
          preview: (line) =>
            Effect.sync(() => {
              stderr += `${line}\n`
            })
        }, { environment: { SMITHERS_BUG_ENDPOINT: endpoint } }).pipe(
          Effect.provideService(Ui.Ui, ui)
        )
        const result = Bridge.query(operation, local, runtime)
        if (accepted) expect(await result).toMatchObject({ reported: true, endpoint })
        else await expect(result).rejects.toThrow("Report not sent")
        expect(prompted).toBe(true)
        expect(posts).toEqual(accepted ? [preview(stderr, endpoint)] : [])
      } finally {
        input.destroy()
        output.destroy()
      }
    })
  })
})

describe("failureOf", () => {
  it("names the signal that interrupted a command", () => {
    const controller = new AbortController()
    controller.abort(new Error("smthrs interrupted by SIGINT"))
    expect(Bridge.failureOf(Cause.interrupt(), controller.signal)).toMatchObject({
      fault: "user",
      code: "interrupted",
      message: "smthrs interrupted by SIGINT before the command finished."
    })
  })
  it("names an internal interruption and preserves ordinary failures", () => {
    expect(Bridge.failureOf(Cause.interrupt(), new AbortController().signal)).toMatchObject({
      fault: "bug",
      code: "interrupted"
    })
    const failure = new Error("down")
    expect(Bridge.failureOf(Cause.fail(failure), undefined)).toBe(failure)
  })
})
