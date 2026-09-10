import * as Capability from "@smthrs/capability/Capability"
import * as Cell from "@smthrs/harness/Cell"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Redacted, Ref, Schema, Sink, Stream } from "effect"
import type { Scope } from "effect"
import * as PlatformError from "effect/PlatformError"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as McpClient from "../src/McpClient.ts"
import { McpError } from "../src/McpError.ts"
import * as McpFlows from "../src/McpFlows.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const waitFor = (assertion: () => void): Effect.Effect<void> =>
  Effect.promise(() => vi.waitFor(assertion, { timeout: 1_000 }))

const typedFailure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) throw new Error("expected the effect to fail")
  expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false)
  const failure = exit.cause.reasons.find(Cause.isFailReason)
  if (failure === undefined) throw new Error("expected a typed failure")
  return failure.error
}

type HandleOptions = Parameters<typeof makeHandle>[0]

/** A process handle with inert defaults; each case overrides only the seam it drives. */
const fakeProcess = (
  overrides: Pick<HandleOptions, "pid"> & Partial<HandleOptions>
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.makeNoop({
    spawn: (_command: ChildProcess.Command) =>
      Effect.succeed(makeHandle({
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.never,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
        ...overrides
      }))
  })

const provideSpawner = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
) => Effect.provide(effect, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner))

/**
 * A fake MCP server: a stdin sink that parses each JSON-RPC line written to
 * it and, for every request it recognizes, pushes the scripted reply onto the
 * queue the fake's stdout stream drains. Unlike a static canned stream, this
 * reacts to what the client actually sends, so a reply is never available
 * before the client has registered the request it answers.
 */
const fakeServer = (
  respond: (request: Rpc.Outbound) => unknown,
  options: {
    readonly delimiter?: string | undefined
    readonly closeAfterReply?: boolean | undefined
    readonly envelope?: ((request: Rpc.Outbound, result: unknown) => unknown) | undefined
  } = {}
): Effect.Effect<ChildProcessSpawner.ChildProcessSpawner["Service"]> =>
  Effect.gen(function*() {
    const replies = yield* Queue.unbounded<Uint8Array>()
    const buffer = yield* Ref.make("")
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function*() {
        const combined = yield* Ref.updateAndGet(buffer, (existing) => existing + decoder.decode(chunk))
        const lines = combined.split("\n")
        yield* Ref.set(buffer, lines.pop() ?? "")
        for (const line of lines) {
          const request = Rpc.parse(line)
          if (request === undefined) continue
          const outbound = request as unknown as Rpc.Outbound
          const result = respond(outbound)
          if (request.id === undefined || result === undefined) continue
          const reply = options.envelope?.(outbound, result) ?? { jsonrpc: "2.0", id: request.id, result }
          yield* Queue.offer(
            replies,
            encoder.encode(`${JSON.stringify(reply)}${options.delimiter ?? "\n"}`)
          )
        }
      })
    )

    return fakeProcess({
      pid: ProcessId(1),
      stdin,
      stdout: options.closeAfterReply === true
        ? Stream.take(Stream.fromQueue(replies), 1)
        : Stream.fromQueue(replies)
    })
  })

/** Tracks process ownership and every transport fiber independently for each spawn. */
const trackedServer = (respond: (request: Rpc.Outbound) => unknown) => {
  const counts = { acquired: 0, released: 0, stopped: 0 }
  const stopped = Effect.sync(() => {
    counts.stopped += 1
  })
  const spawner = ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.gen(function*() {
        const server = yield* fakeServer(respond)
        const handle = yield* server.spawn(command)
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            counts.acquired += 1
            return makeHandle({
              ...handle,
              stdin: handle.stdin.pipe(Sink.ensuring(stopped)),
              stdout: handle.stdout.pipe(
                // Let every transport fiber start before delivering a rejection.
                Stream.mapEffect((chunk) => Effect.yieldNow.pipe(Effect.as(chunk))),
                Stream.ensuring(stopped)
              ),
              stderr: Stream.never.pipe(Stream.ensuring(stopped)),
              exitCode: handle.exitCode.pipe(Effect.ensuring(stopped))
            })
          }),
          () =>
            Effect.sync(() => {
              counts.released += 1
            })
        )
      })
  })
  return { counts, spawner }
}

const TOOLS = [
  { name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: {}, b: {} } } }
]

const respondToEcho = (request: Rpc.Outbound): unknown => {
  if (request.method === "initialize") {
    return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} }
  }
  if (request.method === "tools/list") return { tools: TOOLS }
  if (request.method === "tools/call") {
    const params = request.params as {
      readonly name: string
      readonly arguments: { readonly a: number; readonly b: number }
    }
    return { content: [{ type: "text", text: String(params.arguments.a + params.arguments.b) }], isError: false }
  }
  return undefined
}

const respondWithStructured = (
  outputSchema: Record<string, unknown>,
  structuredContent: Record<string, unknown>
) =>
(request: Rpc.Outbound): unknown => {
  if (request.method === "initialize") {
    return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} }
  }
  if (request.method === "tools/list") {
    return { tools: [{ ...TOOLS[0], outputSchema }] }
  }
  if (request.method === "tools/call") {
    return { content: [], structuredContent, isError: false }
  }
  return undefined
}

const withFakeServer = <A, E>(
  respond: (request: Rpc.Outbound) => unknown,
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  options?: {
    readonly delimiter?: string | undefined
    readonly closeAfterReply?: boolean | undefined
    readonly envelope?: ((request: Rpc.Outbound, result: unknown) => unknown) | undefined
  }
): Promise<A> =>
  execute(Effect.scoped(Effect.gen(function*() {
    const spawner = yield* fakeServer(respond, options)
    return yield* provideSpawner(effect, spawner)
  })))

describe("connection attempt scopes", () => {
  it.each(["negotiation", "catalog", "projection"] as const)(
    "releases caught %s failures before retrying in an open scope",
    async (stage) => {
      const { counts, spawner } = trackedServer((request) => {
        if (stage === "negotiation" && request.method === "initialize") {
          return { protocolVersion: "unsupported", capabilities: { tools: {} } }
        }
        if (stage === "catalog" && request.method === "tools/list") return { tools: [{}] }
        return respondToEcho(request)
      })
      const snapshots: Array<typeof counts> = []
      await execute(Effect.scoped(provideSpawner(
        Effect.gen(function*() {
          for (let attempt = 0; attempt < 3; attempt++) {
            const options = { server: "retry", command: "mcp", args: [] }
            const error = yield* Effect.flip(
              stage === "projection"
                ? McpFlows.connected({ ...options, include: ["missing"] }).pipe(Effect.asVoid)
                : McpClient.connect(options).pipe(Effect.asVoid)
            )
            expect(error.code).toBe(
              { negotiation: "protocol_error", catalog: "invalid_response", projection: "tool_not_found" }[stage]
            )
            snapshots.push({ ...counts })
          }
          expect(snapshots).toEqual([
            { acquired: 1, released: 1, stopped: 4 },
            { acquired: 2, released: 2, stopped: 8 },
            { acquired: 3, released: 3, stopped: 12 }
          ])
        }),
        spawner
      )))
      expect({ ...counts }).toEqual({ acquired: 3, released: 3, stopped: 12 })
    }
  )

  it.each(["client", "flows"] as const)("releases interrupted %s initialization in an open scope", async (entry) => {
    const requests: Array<Rpc.Outbound> = []
    const { counts, spawner } = trackedServer((request) => {
      requests.push(request)
    })
    await execute(Effect.scoped(provideSpawner(
      Effect.gen(function*() {
        const options = { server: "interrupted", command: "mcp", args: [] }
        const pending = yield* Effect.forkChild(
          entry === "client" ? McpClient.connect(options) : McpFlows.connected(options)
        )
        yield* waitFor(() => expect(requests.some((request) => request.method === "initialize")).toBe(true))
        yield* Fiber.interrupt(pending)
        expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true)
        expect({ ...counts }).toEqual({ acquired: 1, released: 1, stopped: 4 })
      }),
      spawner
    )))
    expect({ ...counts }).toEqual({ acquired: 1, released: 1, stopped: 4 })
  })

  it.each(["client", "flows"] as const)(
    "retains successful %s acquisition until its caller scope closes",
    async (entry) => {
      const { counts, spawner } = trackedServer(respondToEcho)
      await execute(Effect.scoped(provideSpawner(
        Effect.gen(function*() {
          const options = { server: "success", command: "mcp", args: [] }
          if (entry === "client") {
            const client = yield* McpClient.connect(options)
            expect((yield* client.callTool("add", { a: 2, b: 3 })).isError).toBe(false)
          } else {
            const source = yield* McpFlows.connected(options)
            expect((yield* source.bindings()).map((binding) => binding.descriptor.name)).toEqual(["mcp/success/add"])
          }
          expect({ ...counts }).toEqual({ acquired: 1, released: 0, stopped: 0 })
        }),
        spawner
      )))
      expect({ ...counts }).toEqual({ acquired: 1, released: 1, stopped: 4 })
    }
  )
})

describe("McpClient.connect", () => {
  it("sends the frozen Smithers initialize payload using the package version", async () => {
    const requests: Array<Rpc.Outbound> = []
    await withFakeServer(
      (request) => {
        requests.push(request)
        return respondToEcho(request)
      },
      McpClient.connect({ server: "handshake", command: "echo-mcp", args: [] })
    )
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly version: string }

    expect(McpClient.clientInfo).toEqual({ name: "smithers", version: manifest.version })
    expect(requests[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smithers", version: "1.0.0-rc.0" }
      }
    })
  })

  it("freezes the exported wire identity constants", () => {
    expect(Object.isFrozen(McpClient.clientInfo)).toBe(true)
    expect(Object.isFrozen(McpClient.supportedProtocolVersions)).toBe(true)

    expect(() => {
      ;(McpClient.clientInfo as { name: string }).name = "mutated"
    }).toThrow(TypeError)
    expect(() => {
      ;(McpClient.supportedProtocolVersions as Array<string>)[0] = "mutated"
    }).toThrow(TypeError)

    expect(McpClient.clientInfo.name).toBe("smithers")
    expect(McpClient.supportedProtocolVersions[0]).toBe("2025-06-18")
  })

  it("points the README at the published documentation instead of the source tree", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

    // npm renders this file, so every reference has to resolve for a reader who
    // has only the tarball. A relative `docs/` path does not: `docs/` is not
    // published, and its pages link on into `guides/` and `concepts/` anyway.
    expect(readme).toContain("https://mcp.smithers.sh")
    expect(readme).not.toMatch(/\]\(\.\/docs\//)

    // Nothing is published yet, and an install command paired with an admission
    // that it does not work reads as a note to self, so the README states
    // availability before it states the command.
    const install = readme.indexOf("pnpm add @smthrs/mcp")
    expect(install).toBeGreaterThan(-1)
    expect(readme.indexOf("not published to npm yet")).toBeLessThan(install)

    // The links a reader without the repository can still follow.
    for (const path of [new URL("../LICENSE", import.meta.url)]) {
      expect(existsSync(path)).toBe(true)
    }

    expect(readme.match(/^## .+$/gm)?.at(-1)).toBe("## License")
    expect(readme.trim().split("## License\n").at(-1)?.trim()).toBe("MIT. See [LICENSE](./LICENSE).")
    expect(readme.slice(0, readme.indexOf("## License"))).toContain("`maxStderrBytes` (2048 by default)")
  })

  it.each([
    "../README.md",
    "../docs/guides/connect-a-server.md",
    "../docs/guides/configure-servers-for-the-cli.md"
  ])("separates locked server installation from credentials in %s", (path) => {
    const document = readFileSync(new URL(path, import.meta.url), "utf8")
    expect(document).not.toMatch(/npx(?: -y|["']\s*,)/)

    const installRecipe = (text: string) =>
      [...text.matchAll(/```bash\n([\s\S]*?)```/g)].find((match) =>
        match[1]?.includes("@modelcontextprotocol/server-github")
      )?.[1]
    const recipe = installRecipe(document)
    expect(recipe).toBeDefined()
    expect(recipe).toContain(
      "--package-lock-only --ignore-scripts --save-exact @modelcontextprotocol/server-github@2025.4.8"
    )
    expect(recipe).toContain("npm ci --prefix /path/to/mcp-servers --ignore-scripts")
    const commands = recipe?.split("\n").filter((line) => line.includes("npm ")) ?? []
    expect(commands).toHaveLength(2)
    for (const command of commands) {
      expect(command).toMatch(/^env -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN npm /)
    }
    expect(recipe).toBe(installRecipe(readFileSync(new URL("../README.md", import.meta.url), "utf8")))
    expect(document).toMatch(/command"?: "\/path\/to\/mcp-servers\/node_modules\/\.bin\/mcp-server-github"/)
    expect(document).toMatch(/args"?: \[\]/)
    expect(document).toMatch(
      /env"?: \{ GITHUB_PERSONAL_ACCESS_TOKEN: process\.env\.GITHUB_TOKEN \}|env": \{ "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_\.\.\." \}/
    )
  })

  it("keeps the source tree's docs out of the published tarball", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly files: ReadonlyArray<string> }

    // `docs/*.md` shipped the four top-level pages and none of the `guides/`
    // and `concepts/` pages they link to, so the tarball carried a docs tree
    // whose own links were broken. mcp.smithers.sh is the whole tree.
    expect(manifest.files.some((pattern) => pattern.startsWith("docs/"))).toBe(false)
    expect(manifest.files).toContain("README.md")
  })

  it("completes the handshake and fetches the tool catalog", async () => {
    const client = await withFakeServer(
      respondToEcho,
      McpClient.connect({ server: "echo", command: "echo-mcp", args: [] })
    )
    expect(client.server).toBe("echo")
    expect(client.tools).toEqual([{
      name: "add",
      description: "Adds two numbers",
      inputSchema: TOOLS[0]!.inputSchema,
      outputSchema: undefined
    }])
  })

  it("calls a remote tool and decodes its result", async () => {
    const result = await withFakeServer(
      respondToEcho,
      Effect.flatMap(
        McpClient.connect({ server: "echo", command: "echo-mcp", args: [] }),
        (client) => client.callTool("add", { a: 2, b: 3 })
      )
    )
    expect(result).toEqual({
      content: [{ type: "text", text: "5" }],
      isError: false,
      structuredContent: undefined
    })
  })

  it("fails with invalid_response when tools/list is malformed", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = yield* fakeServer((request) =>
        request.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
          : { notTools: [] }
      )
      return yield* Effect.provide(
        Effect.flip(McpClient.connect({ server: "broken", command: "broken-mcp", args: [] })),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)
      )
    })))
    expect(error).toMatchObject({
      code: "invalid_response",
      server: "broken",
      message: "MCP server \"broken\" returned a tools/list result with no tools array"
    })
  })

  it("exports every documented default from the public client module", () => {
    expect(McpClient.defaultHandshakeTimeoutMs).toBe(10_000)
    expect(McpClient.defaultRequestTimeoutMs).toBe(StdioTransport.defaultRequestTimeoutMs)
    expect(McpClient.defaultQueueCapacity).toBe(StdioTransport.defaultQueueCapacity)
    expect(McpClient.defaultMaxFrameBytes).toBe(StdioTransport.defaultMaxFrameBytes)
    expect(McpClient.defaultMaxOutboundFrameBytes).toBe(StdioTransport.defaultMaxOutboundFrameBytes)
    expect(McpClient.defaultMaxStderrBytes).toBe(StdioTransport.defaultMaxStderrBytes)
    expect(McpClient.defaultMaxTools).toBe(256)
    expect(McpClient.defaultMaxToolNameBytes).toBe(128)
    expect(McpClient.defaultMaxCatalogPages).toBe(32)
  })

  it("preserves tool outputSchema objects", async () => {
    const client = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") {
          return {
            tools: [{
              name: "typed",
              inputSchema: { type: "object" },
              outputSchema: { type: "object", properties: { answer: { type: "number" } } }
            }]
          }
        }
        return undefined
      },
      McpClient.connect({ server: "schemas", command: "schema-mcp", args: [] })
    )

    expect(client.tools[0]?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "number" } }
    })
  })

  it.each([
    {
      label: "missing inputSchema",
      tool: { name: "bad" },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "null inputSchema",
      tool: { name: "bad", inputSchema: null },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "array inputSchema",
      tool: { name: "bad", inputSchema: [] },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "non-object inputSchema type",
      tool: { name: "bad", inputSchema: { type: "string" } },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "missing inputSchema type",
      tool: { name: "bad", inputSchema: {} },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "null outputSchema",
      tool: { name: "bad", inputSchema: { type: "object" }, outputSchema: null },
      message: "MCP server \"catalog\" returned a tool whose outputSchema is not a JSON object"
    },
    {
      label: "array outputSchema",
      tool: { name: "bad", inputSchema: { type: "object" }, outputSchema: [] },
      message: "MCP server \"catalog\" returned a tool whose outputSchema is not a JSON object"
    },
    {
      label: "scalar outputSchema",
      tool: { name: "bad", inputSchema: { type: "object" }, outputSchema: true },
      message: "MCP server \"catalog\" returned a tool whose outputSchema is not a JSON object"
    },
    {
      label: "slash in the name",
      tool: { name: "bad/name", inputSchema: { type: "object" } },
      message: "MCP server \"catalog\" returned a tool name containing a control character or \"/\""
    },
    {
      label: "C0 control in the name",
      tool: { name: "bad\nname", inputSchema: { type: "object" } },
      message: "MCP server \"catalog\" returned a tool name containing a control character or \"/\""
    },
    {
      label: "DEL in the name",
      tool: { name: "bad\u007fname", inputSchema: { type: "object" } },
      message: "MCP server \"catalog\" returned a tool name containing a control character or \"/\""
    },
    {
      label: "C1 control in the name",
      tool: { name: "bad\u0085name", inputSchema: { type: "object" } },
      message: "MCP server \"catalog\" returned a tool name containing a control character or \"/\""
    }
  ])("rejects a catalog tool with $label", async ({ message, tool }) => {
    const error = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") return { tools: [tool] }
        return undefined
      },
      Effect.flip(McpClient.connect({ server: "catalog", command: "catalog-mcp", args: [] }))
    )

    expect(error).toMatchObject({ code: "invalid_response", server: "catalog", message })
  })

  it("accepts each catalog bound exactly at its configured limit", async () => {
    const client = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") {
          return {
            tools: [
              { name: "éé", inputSchema: { type: "object" } },
              { name: "okay", inputSchema: { type: "object" } }
            ]
          }
        }
        return undefined
      },
      McpClient.connect({
        server: "catalog-boundary",
        command: "catalog-mcp",
        args: [],
        maxTools: 2,
        maxToolNameBytes: 4,
        maxCatalogPages: 1
      })
    )

    expect(client.tools.map((tool) => tool.name)).toEqual(["éé", "okay"])
  })

  it.each([
    {
      options: { maxTools: 1 },
      tools: [
        { name: "one", inputSchema: { type: "object" } },
        { name: "two", inputSchema: { type: "object" } }
      ],
      message: "MCP server \"catalog-limit\" returned more than 1 tools"
    },
    {
      options: { maxToolNameBytes: 3 },
      tools: [{ name: "éé", inputSchema: { type: "object" } }],
      message: "MCP server \"catalog-limit\" returned a tool name longer than 3 bytes"
    }
  ])("rejects a catalog one past $options", async ({ message, options, tools }) => {
    const error = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") return { tools }
        return undefined
      },
      Effect.flip(McpClient.connect({
        server: "catalog-limit",
        command: "catalog-mcp",
        args: [],
        ...options
      }))
    )

    expect(error).toMatchObject({ code: "invalid_response", server: "catalog-limit", message })
  })

  it.each(
    [
      ["handshakeTimeoutMs", 0],
      ["maxTools", 0],
      ["maxToolNameBytes", -1],
      ["maxCatalogPages", 1.5],
      ["handshakeTimeoutMs", Number.MAX_SAFE_INTEGER + 1],
      ["maxTools", Number.MAX_SAFE_INTEGER + 1],
      ["maxToolNameBytes", Number.MAX_SAFE_INTEGER + 1],
      ["maxCatalogPages", Number.MAX_SAFE_INTEGER + 1],
      ["requestTimeoutMs", Number.MAX_SAFE_INTEGER + 1],
      ["queueCapacity", Number.MAX_SAFE_INTEGER + 1],
      ["maxFrameBytes", Number.MAX_SAFE_INTEGER + 1],
      ["maxOutboundFrameBytes", Number.MAX_SAFE_INTEGER + 1],
      ["maxStderrBytes", Number.MAX_SAFE_INTEGER + 1]
    ] as const
  )("rejects an invalid public limit %s", async (name, value) => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.flip(McpClient.connect({
        server: "client-limit",
        command: "mcp",
        args: [],
        [name]: value
      }))
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "client-limit",
      message: `MCP option "${name}" must be a positive integer`
    })
  })

  it("bounds every numeric ConnectOptionsSchema field before spawning", async () => {
    const nonNumeric = ["server", "command", "args", "cwd", "env"]
    const numeric = Object.keys(McpClient.ConnectOptionsSchema.fields).filter((name) => !nonNumeric.includes(name))
    expect(numeric).toHaveLength(9)

    for (const name of numeric) {
      const error = await withFakeServer(
        respondToEcho,
        Effect.flip(McpClient.connect({ server: "schema-limit", command: "mcp", args: [], [name]: 0 }))
      )

      expect(error).toMatchObject({
        code: "protocol_error",
        server: "schema-limit",
        message: `MCP option "${name}" must be a positive integer`
      })
    }
  })

  it("treats an explicit undefined nextCursor as the end of the catalog", async () => {
    const client = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") return { tools: TOOLS, nextCursor: undefined }
        return undefined
      },
      McpClient.connect({ server: "undefined-cursor", command: "mcp", args: [] })
    )

    expect(client.tools).toHaveLength(1)
  })

  it("fails an unknown tool before writing a tools/call frame", async () => {
    const methods: Array<string> = []
    const error = await withFakeServer(
      (request) => {
        methods.push(request.method)
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "known-tools", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("nope", {}))
      })
    )

    expect(error).toMatchObject({
      code: "tool_not_found",
      server: "known-tools",
      message: "MCP server \"known-tools\" has no requested tool"
    })
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"])
  })

  it.each([
    {
      label: "BigInt",
      value: 1n,
      path: "arguments.value",
      reason: "a bigint"
    },
    {
      label: "NaN",
      value: Number.NaN,
      path: "arguments.value",
      reason: "a non-finite number"
    },
    {
      label: "Infinity",
      value: Number.POSITIVE_INFINITY,
      path: "arguments.value",
      reason: "a non-finite number"
    },
    {
      label: "undefined",
      value: undefined,
      path: "arguments.value",
      reason: "undefined"
    },
    {
      label: "function",
      value: () => undefined,
      path: "arguments.value",
      reason: "a function"
    },
    {
      label: "symbol",
      value: Symbol("value"),
      path: "arguments.value",
      reason: "a symbol"
    },
    {
      label: "Date",
      value: new Date(0),
      path: "arguments.value",
      reason: "an object with a non-plain prototype"
    },
    {
      label: "inherited prototype",
      value: Object.create({ inherited: 1 }) as Record<string, unknown>,
      path: "arguments.value",
      reason: "an object with a non-plain prototype"
    },
    {
      label: "enumerable symbol key",
      value: Object.defineProperty({}, Symbol("hidden"), { enumerable: true, value: 1 }),
      path: "arguments.value",
      reason: "a symbol-keyed property"
    }
  ])("rejects a non-JSON $label tool argument", async ({ reason, value }) => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "arguments",
      message: `MCP server "arguments" was sent a tool argument that is not JSON: ${reason}; property path withheld`
    })
  })

  it("keeps the exact invalid-argument path in redacted host diagnostics only", async () => {
    const diagnostics: Array<Diagnostics.Event> = []
    const longKey = "x".repeat(140)
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", {
          nested: { items: [0, { [longKey]: undefined }] }
        }))
      }).pipe(Effect.provide(Diagnostics.layer((event) => diagnostics.push(event))))
    )

    expect(error.code).toBe("protocol_error")
    expect(error.server).toBe("arguments")
    expect(error.message).not.toContain(longKey)
    expect(JSON.stringify(diagnostics)).not.toContain(longKey)
    expect(Redacted.value(diagnostics[0]!.detail)).toContain(`arguments.nested.items[1].${longKey}`)
  })

  it("rejects cyclic arguments without a serialization defect", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", cyclic))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "arguments",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: a cyclic reference; property path withheld"
    })
  })

  it("rejects an accessor argument without invoking it or writing tools/call", async () => {
    const methods: Array<string> = []
    let invoked = false
    const args = Object.defineProperty({}, "lazy", {
      enumerable: true,
      get() {
        invoked = true
        return "invoked"
      }
    })
    const exit = await withFakeServer(
      (request) => {
        methods.push(request.method)
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", args))
      })
    )

    const error = typedFailure(exit)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: an accessor property; property path withheld"
    })
    expect(invoked).toBe(false)
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"])
  })

  it("turns a throwing accessor into an McpError instead of a defect", async () => {
    let invoked = false
    const args = Object.defineProperty({}, "lazy", {
      enumerable: true,
      get() {
        invoked = true
        throw new Error("must not run")
      }
    })
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", args))
      })
    )

    expect(typedFailure(exit)).toBeInstanceOf(McpError)
    expect(invoked).toBe(false)
  })

  it("turns a throwing proxy get trap into an McpError instead of a defect", async () => {
    const value = new Proxy([1], {
      get() {
        throw new Error("get trap")
      }
    })
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", { value }))
      })
    )

    const error = typedFailure(exit)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: a property that threw when read; property path withheld"
    })
  })

  it("turns a throwing proxy reflection trap into an McpError instead of a defect", async () => {
    const value = new Proxy({ okay: true }, {
      ownKeys() {
        throw new Error("ownKeys trap")
      }
    })
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", { value }))
      })
    )

    expect(typedFailure(exit)).toBeInstanceOf(McpError)
  })

  it("rejects a toJSON method instead of executing JSON customization", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { toJSON: () => ({ hidden: true }) }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"arguments\" was sent a tool argument that is not JSON: a function; property path withheld"
    })
  })

  it("omits non-enumerable own arguments from the wire frame", async () => {
    let sent: unknown
    const hiddenSymbol = Symbol("hidden")
    const target = Object.defineProperties({ visible: true }, {
      hidden: {
        enumerable: false,
        value: "omit"
      },
      [hiddenSymbol]: {
        enumerable: false,
        value: "omit"
      }
    })
    const args = new Proxy(target, {
      ownKeys(value) {
        return [...Reflect.ownKeys(value), "missing-descriptor"]
      },
      getOwnPropertyDescriptor(value, key) {
        return key === "missing-descriptor" ? undefined : Reflect.getOwnPropertyDescriptor(value, key)
      }
    })
    await withFakeServer(
      (request) => {
        if (request.method === "tools/call") {
          sent = (request.params as { readonly arguments: unknown }).arguments
          return { content: [], isError: false }
        }
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        yield* client.callTool("add", args)
      })
    )

    expect(sent).toEqual({ visible: true })
  })

  it.each([
    {
      label: "revoked proxy",
      make: () => {
        const revocable = Proxy.revocable({}, {})
        revocable.revoke()
        return revocable.proxy
      }
    },
    {
      label: "throwing getPrototypeOf trap",
      make: () =>
        new Proxy({}, {
          getPrototypeOf() {
            throw new Error("getPrototypeOf trap")
          }
        })
    },
    {
      label: "throwing propertyIsEnumerable reflection",
      make: () => {
        const key = Symbol("key")
        return new Proxy({ [key]: true }, {
          getOwnPropertyDescriptor(target, property) {
            if (typeof property === "symbol") throw new Error("descriptor trap")
            return Reflect.getOwnPropertyDescriptor(target, property)
          }
        })
      }
    },
    {
      label: "throwing getOwnPropertyNames reflection",
      make: () => {
        let calls = 0
        return new Proxy({}, {
          ownKeys() {
            calls += 1
            if (calls === 1) return []
            throw new Error("second ownKeys trap")
          }
        })
      }
    },
    {
      label: "throwing object descriptor reflection",
      make: () =>
        new Proxy({ value: true }, {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap")
          }
        })
    },
    {
      label: "throwing array descriptor reflection",
      make: () =>
        new Proxy([1], {
          get(target, key, receiver) {
            return Reflect.get(target, key, receiver)
          },
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap")
          }
        })
    }
  ])("turns a $label into an McpError", async ({ make }) => {
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", { value: make() }))
      })
    )

    const error = typedFailure(exit)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: "protocol_error" })
  })

  it("rejects an invalid proxied array length without iterating it", async () => {
    const value = new Proxy([1], {
      get(target, key, receiver) {
        return key === "length" ? "invalid" : Reflect.get(target, key, receiver)
      }
    })
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: a property that threw when read; property path withheld"
    })
  })

  it("rejects an accessor array element without invoking it", async () => {
    let invoked = false
    const value: Array<unknown> = []
    Object.defineProperty(value, "0", {
      configurable: true,
      enumerable: true,
      get() {
        invoked = true
        return "must not run"
      }
    })
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: an accessor property; property path withheld"
    })
    expect(invoked).toBe(false)
  })

  it("keeps sparse array holes on the typed undefined rejection path", async () => {
    const value = new Array<unknown>(1)
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"arguments\" was sent a tool argument that is not JSON: undefined; property path withheld"
    })
  })

  it("reports the bounded path to a nested accessor", async () => {
    const nested = Object.defineProperty({}, "inner", {
      enumerable: true,
      get() {
        return "must not run"
      }
    })
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { outer: nested }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: an accessor property; property path withheld"
    })
  })

  it("snapshots valid JSON arguments before the returned effect runs", async () => {
    let sent: unknown
    const arguments_: { a: number; nested: Array<unknown> } = {
      a: 2,
      nested: [null, true, "text", { value: 3 }]
    }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { okay: true })
    arguments_.nested.push(nullPrototype)
    await withFakeServer(
      (request) => {
        if (request.method === "tools/call") {
          sent = (request.params as { readonly arguments: unknown }).arguments
          return { content: [], isError: false }
        }
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "snapshot", command: "mcp", args: [] })
        const call = client.callTool("add", arguments_)
        arguments_.a = 99
        ;(arguments_.nested[3] as { value: number }).value = 99
        yield* call
      })
    )

    expect(sent).toEqual({
      a: 2,
      nested: [null, true, "text", { value: 3 }, { okay: true }]
    })
  })

  it("snapshots the 1 MiB probe argument with one descriptor batch per container", async () => {
    const args = {
      rows: Array.from({ length: 12_000 }, (_, i) => ({
        id: i,
        name: `row-${i}`,
        ok: i % 2 === 0,
        tags: ["a", "b"],
        score: i / 7
      }))
    }
    const encoded = JSON.stringify(args)
    expect(encoded.length).toBe(985_531)
    let sent: unknown
    await withFakeServer(
      (request) => {
        if (request.method === "tools/call") {
          sent = (request.params as { arguments: unknown }).arguments
          return { content: [] }
        }
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "snapshot-budget", command: "mcp", args: [] })
        const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor")
        const batches = vi.spyOn(Object, "getOwnPropertyDescriptors")
        descriptors.mockClear()
        let call: ReturnType<typeof client.callTool>
        let perMemberCalls: number
        let batchCalls: number
        try {
          call = client.callTool("add", args)
          perMemberCalls = descriptors.mock.calls.length
          batchCalls = batches.mock.calls.length
        } finally {
          descriptors.mockRestore()
          batches.mockRestore()
        }
        expect(perMemberCalls).toBe(0)
        expect(batchCalls).toBe(24_002)
        yield* call
      })
    )
    expect(JSON.stringify(sent)).toBe(encoded)
  })

  it("bounds large enum membership across a long result array", async () => {
    const count = 10_000
    const rows = Array(count).fill(count - 1)
    const outputSchema = {
      type: "object",
      properties: {
        rows: { type: "array", items: { enum: Array.from({ length: count }, (_, i) => i) } }
      }
    }
    await withFakeServer(
      respondWithStructured(outputSchema, { rows }),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "enum-budget", command: "mcp", args: [] })
        const start = performance.now()
        const result = yield* client.callTool("add", {})
        expect(result.structuredContent).toEqual({ rows })
        expect(performance.now() - start).toBeLessThan(1_000)
      })
    )
  })

  it.each([
    { value: { z: [1, null, true], a: { b: "x" } }, member: { a: { b: "x" }, z: [1, null, true] }, accepts: true },
    { value: { a: [1, 2] }, member: { a: [2, 1] }, accepts: false },
    { value: { a: "1" }, member: { a: 1 }, accepts: false },
    { value: { a: 0 }, member: { a: -0 }, accepts: true },
    { value: { a: {} }, member: { a: [] }, accepts: false },
    { value: { a: { b: 1 } }, member: { "a\":{\"b": 1 }, accepts: false }
  ])("preserves composite enum equality: $accepts ($value)", async ({ value, member, accepts }) => {
    await withFakeServer(
      respondWithStructured({ enum: [member] }, value),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "enum-json", command: "mcp", args: [] })
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const exit = yield* Effect.exit(client.callTool("add", {}))
          expect(Exit.isSuccess(exit)).toBe(accepts)
          if (!accepts) expect(typedFailure(exit)).toMatchObject({ code: "invalid_response" })
        }
      })
    )
  })

  it("ignores a proxy symbol that disappears during descriptor collection", async () => {
    const symbol = Symbol("gone")
    const args = new Proxy({}, { ownKeys: () => [symbol] })
    await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "snapshot-symbol", command: "mcp", args: [] })
        yield* client.callTool("add", args)
      })
    )
  })

  it("lets a host timer interrupt structured validation", async () => {
    const rows = Array(100_000).fill(999)
    const outputSchema = {
      required: ["validationStart"],
      properties: {
        rows: { items: { enum: Array.from({ length: 1_000 }, (_, i) => i) } }
      }
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let started = 0
    const hasOwn = Object.hasOwn
    try {
      await withFakeServer(
        respondWithStructured(outputSchema, { validationStart: true, rows }),
        Effect.gen(function*() {
          const client = yield* McpClient.connect({ server: "enum-interrupt", command: "mcp", args: [] })
          // Arm only when the validator checks required, after transport parsing.
          const reflection = vi.spyOn(Object, "hasOwn").mockImplementation((value, key) => {
            if (key === "validationStart" && started === 0) {
              started = performance.now()
              timer = setTimeout(() => controller.abort(), 25)
            }
            return hasOwn(value, key)
          })
          const exit = yield* Effect.promise(() =>
            Effect.runPromiseExit(client.callTool("add", {}), {
              signal: controller.signal
            })
          ).pipe(Effect.ensuring(Effect.sync(() => reflection.mockRestore())))
          expect(started).toBeGreaterThan(0)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(performance.now() - started).toBeLessThan(1_000)
        })
      )
    } finally {
      clearTimeout(timer)
    }
  })

  it("supports every documented outputSchema type and type arrays", async () => {
    const structuredContent = {
      nullValue: null,
      booleanValue: true,
      objectValue: {},
      arrayValue: [1],
      numberValue: 1.5,
      integerValue: 2,
      stringValue: "accepted",
      ignoredSchema: "accepted"
    }
    const result = await withFakeServer(
      respondWithStructured({
        type: "object",
        required: [42],
        properties: {
          nullValue: { type: "null" },
          booleanValue: { type: "boolean" },
          objectValue: { type: "object" },
          arrayValue: { type: "array" },
          numberValue: { type: "number" },
          integerValue: { type: "integer" },
          stringValue: { type: ["unsupported", 42, "null", "string"] },
          optionalMissing: { type: "string" },
          ignoredSchema: true
        }
      }, structuredContent),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-types", command: "mcp", args: [] })
        return yield* client.callTool("add", {})
      })
    )

    expect(result.structuredContent).toEqual(structuredContent)
  })

  it.each([1.5, "not-an-integer"])("rejects %j against the integer outputSchema type", async (value) => {
    const error = await withFakeServer(
      respondWithStructured({
        type: "object",
        properties: { value: { type: "integer" } }
      }, { value }),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-integer", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", {}))
      })
    )

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"schema-integer\" returned structuredContent that its own outputSchema rejects: expected integer; property path withheld"
    })
  })

  it("exposes an immutable catalog so callers cannot change later validation or dispatch", async () => {
    const result = await withFakeServer(
      respondWithStructured({ type: "object", properties: { value: { type: "number" } } }, { value: "wrong" }),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "catalog-snapshot", command: "mcp", args: [] })
        const tool = client.tools[0]!
        expect(Reflect.set(client.tools, "length", 0)).toBe(false)
        expect(Reflect.set(tool, "name", "changed")).toBe(false)
        expect(Reflect.set(tool.inputSchema, "type", "array")).toBe(false)
        const properties = tool.outputSchema!.properties as Record<string, unknown>
        expect(Reflect.set(properties, "value", {})).toBe(false)
        expect(Reflect.set(properties.value as object, "type", "string")).toBe(false)
        return yield* Effect.flip(client.callTool("add", {}))
      })
    )
    expect(result.code).toBe("invalid_response")
  })

  it("bounds error prose when a schema repeats a supported type", async () => {
    const error = await withFakeServer(
      respondWithStructured({ type: Array.from({ length: 2_000 }, () => "number") }, {}),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-types", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", {}))
      })
    )
    expect(error.message).toBe(
      "MCP server \"schema-types\" returned structuredContent that its own outputSchema rejects: expected number; property path withheld"
    )
  })

  it("compares structured enum values by JSON value", async () => {
    const structuredContent = {
      scalar: "ok",
      array: [1, 2],
      object: { target: { nested: [1, 2] } }
    }
    const result = await withFakeServer(
      respondWithStructured({
        type: "object",
        properties: {
          scalar: { enum: ["ok"] },
          array: { enum: [[0], [1, 2]] },
          object: {
            enum: [
              ["not-an-object"],
              { extra: true, other: true },
              { wrong: { nested: [1, 2] } },
              { target: { nested: [1, 3] } },
              { target: { nested: [1, 2] } }
            ]
          }
        }
      }, structuredContent),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-enum", command: "mcp", args: [] })
        return yield* client.callTool("add", {})
      })
    )

    expect(result.structuredContent).toEqual(structuredContent)
  })
})

describe("McpClient.ConnectOptionsSchema", () => {
  it("decodes a minimal persisted server entry", () => {
    expect(
      Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)({
        server: "fixture",
        command: "node",
        args: []
      })
    ).toEqual({ server: "fixture", command: "node", args: [] })
  })

  it("decodes every supported persisted server option", () => {
    const entry = {
      server: "fixture",
      command: "node",
      args: ["server.mjs"],
      cwd: "/workspace",
      env: { TOKEN: "redacted" },
      handshakeTimeoutMs: 1,
      requestTimeoutMs: 2,
      queueCapacity: 3,
      maxFrameBytes: 4,
      maxOutboundFrameBytes: 5,
      maxStderrBytes: 6,
      maxTools: 7,
      maxToolNameBytes: 8,
      maxCatalogPages: 9
    }

    expect(Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)(entry)).toEqual(entry)
  })

  it.each([
    ["an array environment", { server: "fixture", command: "node", args: [], env: ["A", "B"] }],
    ["an empty server", { server: "", command: "node", args: [] }],
    ["an empty command", { server: "fixture", command: "", args: [] }],
    ["a non-integer limit", { server: "fixture", command: "node", args: [], handshakeTimeoutMs: 1.5 }],
    ["a zero limit", { server: "fixture", command: "node", args: [], requestTimeoutMs: 0 }],
    ["a negative limit", { server: "fixture", command: "node", args: [], maxStderrBytes: -1 }]
  ])("rejects %s", (_label, entry) => {
    expect(() => Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)(entry)).toThrow()
  })
})

describe("StdioTransport limits and terminal state", () => {
  it.each([
    { requestTimeoutMs: 0 },
    { queueCapacity: 0 },
    { maxFrameBytes: 0 },
    { maxOutboundFrameBytes: 0 },
    { maxStderrBytes: 0 },
    { requestTimeoutMs: 1.5 }
  ])("rejects invalid transport limits: %o", async (limits) => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.flip(StdioTransport.connect({ server: "limited", command: "mcp", args: [], ...limits }))
    )

    expect(error).toMatchObject({ code: "protocol_error", server: "limited" })
  })

  it("rejects an invalid per-request deadline before writing", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "deadline", command: "mcp", args: [] })
        return yield* Effect.flip(transport.request("ping", {}, 0))
      })
    )

    expect(error).toMatchObject({ code: "protocol_error", server: "deadline" })
  })

  it("rejects an invalid per-notification deadline before writing", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "notify-deadline", command: "mcp", args: [] })
        return yield* Effect.flip(transport.notify("notifications/test", {}, 0))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "notify-deadline",
      message: "MCP notification timeout must be a positive integer"
    })
    expect(frames).toEqual([])
  })

  it("does not let a full cancellation queue delay the request deadline", async () => {
    const outcome = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(8),
        exitCode: Effect.as(Effect.sleep("6 seconds"), ExitCode(0)),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "full-cancellation-queue",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 300
        }),
        spawner
      )
      const started = Date.now()
      const request = yield* Effect.forkChild(Effect.flip(transport.request("tools/call")), {
        startImmediately: true
      })
      yield* Deferred.await(writerStarted)
      yield* transport.notify("fill-outbound-queue")
      const error = yield* Fiber.join(request)
      return { elapsed: Date.now() - started, error }
    })))

    expect(outcome.error).toMatchObject({
      code: "timeout",
      server: "full-cancellation-queue",
      message: "MCP server \"full-cancellation-queue\" did not answer tools/call within 300ms"
    })
    expect(outcome.elapsed).toBeLessThan(5_000)
  })

  it("cancels exactly once when a tools/call request times out", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "cancel-timeout",
          command: "mcp",
          args: [],
          requestTimeoutMs: 25
        })
        const failure = yield* Effect.flip(transport.request("tools/call", { secret: "do-not-copy" }))
        yield* waitFor(() =>
          expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toHaveLength(1)
        )
        return failure
      })
    )
    const request = frames.find((frame) => frame.method === "tools/call")!

    expect(error).toMatchObject({
      code: "timeout",
      server: "cancel-timeout",
      message: "MCP server \"cancel-timeout\" did not answer tools/call within 25ms"
    })
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([{
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: request.id, reason: "request no longer awaited" }
    }])
  })

  it("cancels exactly once when an outer fiber interrupts tools/call", async () => {
    const frames: Array<Rpc.Outbound> = []
    await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "cancel-interrupt", command: "mcp", args: [] })
        const pending = yield* Effect.forkChild(transport.request("tools/call", {}), { startImmediately: true })
        yield* waitFor(() => expect(frames.filter((frame) => frame.method === "tools/call")).toHaveLength(1))
        yield* Fiber.interrupt(pending)
        yield* waitFor(() =>
          expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toHaveLength(1)
        )
      })
    )
    const request = frames.find((frame) => frame.method === "tools/call")!

    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([{
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: request.id, reason: "request no longer awaited" }
    }])
  })

  it("does not cancel a tools/call request that receives a normal reply", async () => {
    const frames: Array<Rpc.Outbound> = []
    const result = await withFakeServer(
      (request) => {
        frames.push(request)
        return "done"
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "settled", command: "mcp", args: [] })
        const value = yield* transport.request("tools/call", {})
        yield* Effect.sleep("25 millis")
        return value
      })
    )

    expect(result).toBe("done")
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([])
  })

  it("does not cancel a tools/call request that receives a JSON-RPC error", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return "ignored"
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "settled-error", command: "mcp", args: [] })
        const failure = yield* Effect.flip(transport.request("tools/call", {}))
        yield* Effect.sleep("25 millis")
        return failure
      }),
      {
        envelope: (request) => ({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_000, message: "remote failure" }
        })
      }
    )

    expect(error).toMatchObject({
      code: "tool_failed",
      server: "settled-error",
      message: "MCP server \"settled-error\" failed tools/call (-32000); remote details withheld"
    })
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([])
  })

  it("never cancels initialize when it times out", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "initialize-timeout", command: "mcp", args: [] })
        const failure = yield* Effect.flip(transport.request("initialize", {}, 25))
        yield* Effect.sleep("25 millis")
        return failure
      })
    )

    expect(error).toMatchObject({
      code: "timeout",
      server: "initialize-timeout",
      message: "MCP server \"initialize-timeout\" did not answer initialize within 25ms"
    })
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([])
  })

  it("accepts an outbound frame exactly at maxOutboundFrameBytes", async () => {
    const params = { value: "bounded" }
    const bytes = Rpc.encode({ jsonrpc: "2.0", id: 1, method: "ping", params }).byteLength
    const result = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "outbound-boundary",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: bytes
        })
        return yield* transport.request("ping", params)
      })
    )

    expect(result).toBe("pong")
  })

  it("rejects an outbound frame one byte past maxOutboundFrameBytes", async () => {
    const params = { value: "bounded" }
    const bytes = Rpc.encode({ jsonrpc: "2.0", id: 1, method: "ping", params }).byteLength
    const error = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "outbound-limit",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: bytes - 1
        })
        return yield* Effect.flip(transport.request("ping", params))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "outbound-limit",
      message: `MCP server "outbound-limit" tried to send a ping frame larger than ${bytes - 1} bytes`
    })
  })

  it("turns an unexpected request serialization failure into protocol_error", async () => {
    const error = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "encode", command: "mcp", args: [] })
        return yield* Effect.flip(transport.request("raw", { value: 1n }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "encode",
      message: "MCP server \"encode\" could not encode a raw frame"
    })
  })

  it("bounds and safely encodes notifications", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "notification-limit",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: 1
        })
        return yield* Effect.flip(transport.notify("large", { value: "x" }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "notification-limit",
      message: "MCP server \"notification-limit\" tried to send a large frame larger than 1 bytes"
    })
  })

  it.each([
    ["CRLF", "\r\n", false],
    ["an unterminated frame", "", true],
    ["an unterminated frame ending in CR", "\r", true]
  ])("accepts %s", async (_label, delimiter, closeAfterReply) => {
    const result = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "framing", command: "mcp", args: [] })
        return yield* transport.request("ping")
      }),
      { delimiter, closeAfterReply }
    )

    expect(result).toBe("pong")
  })

  it("bounds notifications when a server stops reading stdin", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(2),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-writer",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 25
        }),
        spawner
      )

      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      return yield* Effect.flip(transport.notify("third"))
    })))

    expect(error).toMatchObject({ code: "timeout", server: "blocked-writer" })
  })

  it("bounds server-response admission when a peer stops reading its stdin", async () => {
    const failure = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const output = yield* Queue.unbounded<Uint8Array>()
      const spawner = fakeProcess({
        pid: ProcessId(2),
        stdout: Stream.fromQueue(output),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-server-response",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 25
        }),
        spawner
      )
      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      yield* Queue.offer(output, Rpc.encode({ jsonrpc: "2.0", id: 99, method: "ping" }))
      // The reader's deadline closes the connection and unblocks this offer;
      // the request's own, longer deadline must not be what releases it.
      yield* transport.request("waiting", undefined, 1_000).pipe(Effect.exit)
      return yield* Effect.flip(transport.notify("after-close"))
    })))
    expect(failure).toMatchObject({
      code: "timeout",
      message: "MCP server \"blocked-server-response\" did not answer server-response admission within 25ms"
    })
  })

  it("applies the outbound byte limit to responses, even for an immediate server ping", async () => {
    const failure = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = fakeProcess({
        pid: ProcessId(2),
        stdout: Stream.concat(
          Stream.make(
            new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(100), method: "ping" }) + "\n")
          ),
          Stream.never
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "large-server-response",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: 64
        }),
        spawner
      )
      return yield* Effect.flip(transport.request("x"))
    })))
    expect(failure).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"large-server-response\" tried to send a server-response frame larger than 64 bytes"
    })
  })

  it("turns an exit-status failure into one terminal error for later traffic", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = fakeProcess({
        pid: ProcessId(3),
        exitCode: Effect.fail(PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "exitCode",
          description: "fixture failure"
        })),
        isRunning: Effect.succeed(false)
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "bad-exit", command: "mcp", args: [] }),
        spawner
      )
      yield* Effect.sleep("10 millis")
      const request = yield* Effect.flip(transport.request("later"))
      const notification = yield* Effect.flip(transport.notify("later"))
      yield* Effect.sleep("10 millis")
      return { request, notification }
    })))

    expect(errors.request).toMatchObject({
      code: "connection_closed",
      message: expect.stringContaining("process exited"),
      server: "bad-exit"
    })
    expect(errors.notification).toBe(errors.request)
  })

  it("ignores a late reply after the process exit has closed the state", async () => {
    const outcome = await execute(Effect.scoped(Effect.gen(function*() {
      const replies = yield* Queue.unbounded<Uint8Array>()
      const exit = yield* Deferred.make<ExitCode>()
      const requestWritten = yield* Deferred.make<void>()
      const replyHandled = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(4),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(false),
        stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(requestWritten, undefined)),
        // One frame, then end of stdout. The reader pulls that end only after
        // it has run the handler for the frame before it, so this finalizer is
        // a happens-after signal for the drop rather than a sleep long enough
        // to hope for one.
        stdout: Stream.fromQueue(replies).pipe(
          Stream.take(1),
          Stream.ensuring(Deferred.succeed(replyHandled, undefined))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "late-reply", command: "mcp", args: [] }),
        spawner
      )

      // Registers id 1: the frame reaching stdin proves the pending entry exists.
      const call = yield* Effect.forkChild(Effect.flip(transport.request("tools/call")), {
        startImmediately: true
      })
      yield* Deferred.await(requestWritten)

      // The close records `Closed` before it fails any waiter, so this request's
      // own failure is proof that the reader now observes a closed connection.
      yield* Deferred.succeed(exit, ExitCode(0))
      const closedError = yield* Fiber.join(call)

      // Only now does a well-formed reply for that id reach the reader.
      yield* Queue.offer(replies, new TextEncoder().encode("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"late\"}\n"))
      yield* Deferred.await(replyHandled)
      const afterwards = yield* Effect.flip(transport.notify("later"))
      return { afterwards, closedError }
    })))

    expect(outcome.closedError).toMatchObject({ code: "connection_closed", server: "late-reply" })
    // The dropped reply neither resolved anything nor moved the connection off
    // the error it closed with.
    expect(outcome.afterwards).toBe(outcome.closedError)
  })

  it("normalizes a host failure while reading stdout", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const failure = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "stdout",
        description: "fixture failure"
      })
      const spawner = fakeProcess({
        pid: ProcessId(5),
        stdout: Stream.fail(failure)
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "bad-stdout", command: "mcp", args: [] }),
        spawner
      )
      yield* Effect.sleep("10 millis")
      return yield* Effect.flip(transport.request("later"))
    })))

    expect(error).toMatchObject({
      code: "connection_closed",
      message: expect.stringContaining("stdout failed"),
      server: "bad-stdout"
    })
  })

  it("wakes a blocked enqueue when the process exits", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const exit = yield* Deferred.make<ExitCode>()
      const spawner = fakeProcess({
        pid: ProcessId(6),
        exitCode: Deferred.await(exit),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-enqueue",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 1_000
        }),
        spawner
      )
      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      const blocked = yield* Effect.forkChild(transport.notify("third"), { startImmediately: true })
      yield* Effect.sleep("10 millis")
      yield* Deferred.succeed(exit, ExitCode(0))
      const blockedError = yield* Effect.flip(Fiber.join(blocked))
      const laterError = yield* Effect.flip(transport.request("later"))
      return { blockedError, laterError }
    })))

    expect(errors.blockedError).toBe(errors.laterError)
    expect(errors.blockedError).toMatchObject({
      code: "connection_closed",
      server: "blocked-enqueue"
    })
  })

  it("fails every request pending at one terminal transition", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const exit = yield* Deferred.make<ExitCode>()
      const writes = yield* Ref.make(0)
      const allWritten = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(7),
        exitCode: Deferred.await(exit),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Ref.updateAndGet(writes, (count) => count + 1).pipe(
            Effect.flatMap((count) => count === 3 ? Deferred.succeed(allWritten, undefined) : Effect.void)
          )
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "pending", command: "mcp", args: [] }),
        spawner
      )
      const pending = yield* Effect.forkChild(
        Effect.all(
          ["one", "two", "three"].map((method) => Effect.flip(transport.request(method))),
          { concurrency: "unbounded" }
        ),
        { startImmediately: true }
      )
      yield* Deferred.await(allWritten)
      yield* Deferred.succeed(exit, ExitCode(0))
      return yield* Fiber.join(pending)
    })))

    expect(errors).toHaveLength(3)
    expect(errors.every((error) => error === errors[0])).toBe(true)
    expect(errors[0]).toMatchObject({ code: "connection_closed", server: "pending" })
  })
})

describe("McpFlows.mcp", () => {
  const projectionClient: McpClient.McpClient = {
    server: "catalog",
    tools: [
      { name: "first", description: undefined, inputSchema: { type: "object" }, outputSchema: undefined },
      { name: "second", description: undefined, inputSchema: { type: "object" }, outputSchema: undefined },
      { name: "third", description: undefined, inputSchema: { type: "object" }, outputSchema: undefined }
    ],
    callTool: () => Effect.succeed({ content: [], isError: false, structuredContent: undefined })
  }

  it("projects one flow per tool, disclosing the server's own input schema", async () => {
    const client = await withFakeServer(
      respondToEcho,
      McpClient.connect({ server: "echo", command: "echo-mcp", args: [] })
    )
    const source = McpFlows.mcp(client)
    const bindings = await execute(source.bindings())
    expect(source.name).toBe("mcp/echo")
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.descriptor.name).toBe("mcp/echo/add")
    expect(bindings[0]!.descriptor.capabilities).toEqual(McpFlows.capabilities)
  })

  it("derives one capability declaration for every host action", () => {
    expect(McpFlows.capabilities).toHaveLength(Capability.Action.literals.length)
  })

  it("includes every host action in the parseable capability form", () => {
    for (const action of Capability.Action.literals) {
      expect(McpFlows.capabilities).toContain(`${action}:**`)
    }
  })

  it("freezes the shared capability declarations", () => {
    expect(Object.isFrozen(McpFlows.capabilities)).toBe(true)
  })

  it("the documented exclude recipe removes the dangerous tool", async () => {
    const guide = readFileSync(new URL("../docs/guides/select-the-tools-a-run-sees.md", import.meta.url), "utf8")
    const recipe = guide.split("mostly useful server's one dangerous tool out of reach:")[1]!
      .match(/```ts\n([\s\S]*?)\n```/)![1]!
    const client: McpClient.McpClient = {
      ...projectionClient,
      tools: [
        ...projectionClient.tools,
        { name: "delete_repository", description: undefined, inputSchema: {}, outputSchema: undefined }
      ]
    }
    const source = new Function("McpFlows", "client", `${recipe}\nreturn source`)(McpFlows, client)
    const bindings = await execute(source.bindings()) as ReadonlyArray<{ descriptor: { name: string } }>
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual([
      "mcp/catalog/first",
      "mcp/catalog/second",
      "mcp/catalog/third"
    ])
  })

  it("documents CLI filtering and naming in the overview and config guide", () => {
    const overview = readFileSync(new URL("../docs/README.md", import.meta.url), "utf8")
    const guide = readFileSync(new URL("../docs/guides/configure-servers-for-the-cli.md", import.meta.url), "utf8")
    expect(overview).not.toContain("a projection the flag does not express")
    for (const option of ["include", "exclude", "namePrefix"]) {
      expect(overview).toContain(`\`${option}\``)
      expect(guide).toContain(`\`${option}\``)
    }
    expect(guide).toContain("ConnectOptionsSchema")
    expect(guide).not.toContain("are not checked by the flag")
  })

  it("applies include in catalog order", async () => {
    const bindings = await execute(McpFlows.mcp(projectionClient, { include: ["third", "first"] }).bindings())

    expect(bindings.map((binding) => binding.descriptor.name)).toEqual([
      "mcp/catalog/first",
      "mcp/catalog/third"
    ])
  })

  it("applies exclude after include", async () => {
    const bindings = await execute(
      McpFlows.mcp(projectionClient, {
        include: ["first", "second"],
        exclude: ["second"]
      }).bindings()
    )

    expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["mcp/catalog/first"])
  })

  it("uses namePrefix for the source and every projected flow", async () => {
    const source = McpFlows.mcp(projectionClient, { namePrefix: "remote/catalog" })
    const bindings = await execute(source.bindings())

    expect(source.name).toBe("remote/catalog")
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual([
      "remote/catalog/first",
      "remote/catalog/second",
      "remote/catalog/third"
    ])
  })

  it("keeps the default source and flow names when options are omitted", async () => {
    const source = McpFlows.mcp(projectionClient)
    const bindings = await execute(source.bindings())

    expect(source.name).toBe("mcp/catalog")
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual([
      "mcp/catalog/first",
      "mcp/catalog/second",
      "mcp/catalog/third"
    ])
  })

  it("fails connected when include names a tool the server does not offer", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.flip(McpFlows.connected({
        server: "checked",
        command: "mcp",
        args: [],
        include: ["missing"]
      }))
    )

    expect(error).toMatchObject({
      code: "tool_not_found",
      server: "checked",
      message: "MCP server \"checked\" offers no requested include tool"
    })
  })

  it("fails connected when namePrefix is empty", async () => {
    const { counts, spawner } = trackedServer(respondToEcho)
    const error = await execute(Effect.scoped(provideSpawner(
      Effect.flip(McpFlows.connected({ server: "checked", command: "mcp", args: [], namePrefix: "" })),
      spawner
    )))

    expect(counts.acquired).toBe(0)
    const troubleshooting = readFileSync(new URL("../docs/troubleshooting.md", import.meta.url), "utf8")
    expect(troubleshooting).toContain("## MCP server \"...\" option \"namePrefix\" must not be empty")

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "checked",
      message: "MCP server \"checked\" option \"namePrefix\" must not be empty"
    })
  })

  it("runs a tool call through the produced binding", async () => {
    const result = await withFakeServer(
      respondToEcho,
      Effect.flatMap(McpClient.connect({ server: "echo", command: "echo-mcp", args: [] }), (client) => {
        const [binding] = McpFlows.mcp(client).bindings().pipe(Effect.runSync)
        const call = new Cell.Call({
          flowName: "mcp/echo/add",
          input: { a: 2, b: 3 },
          capabilities: McpFlows.capabilities,
          effects: binding!.descriptor.effects,
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: "test",
            frame: 0,
            cell: "test",
            ordinal: 0,
            declaration: Cell.declarationDigest(binding!.descriptor),
            layers: []
          })
        })
        return binding!.run(call)
      })
    )
    expect(result.outcome).toBe("success")
    expect(result.value).toEqual({ content: [{ type: "text", text: "5" }], isError: false })
  })

  it("publishes client-authored refusals while withholding remote error bodies", async () => {
    const secret = "SYNTHETIC_MCP_REMOTE_SECRET"
    const result = await withFakeServer(
      respondToEcho,
      Effect.flatMap(McpClient.connect({ server: "echo", command: "echo-mcp", args: [] }), (client) => {
        const [binding] = Effect.runSync(McpFlows.mcp(client).bindings())
        return binding!.run(
          new Cell.Call({
            flowName: binding!.descriptor.name,
            input: { a: 2, b: 3 },
            capabilities: McpFlows.capabilities,
            effects: binding!.descriptor.effects,
            placement: Option.none(),
            identity: new Cell.CallIdentity({
              session: "test",
              frame: 0,
              cell: "test",
              ordinal: 0,
              declaration: Cell.declarationDigest(binding!.descriptor),
              layers: []
            })
          })
        )
      }),
      {
        envelope: (request, result) =>
          request.method === "tools/call"
            ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: secret } }
            : { jsonrpc: "2.0", id: request.id, result }
      }
    )
    expect(result).toMatchObject({
      outcome: "failure",
      message: "Flow mcp/echo/add failed: MCP server \"echo\" failed tools/call (-32000); remote details withheld"
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it("uses conservative metadata defaults for an incomplete tool description", async () => {
    const source = McpFlows.mcp({
      server: "partial",
      tools: [{ name: "run", description: undefined, inputSchema: { type: "object" }, outputSchema: undefined }],
      callTool: () => Effect.succeed({ content: [], isError: false, structuredContent: undefined })
    })
    const [binding] = await execute(source.bindings())
    expect(binding!.descriptor.description).toBe("MCP tool \"run\" on server \"partial\"")
    expect(binding!.descriptor.input).toMatchObject({ document: { type: "object" } })
  })

  it("passes structuredContent through the binding output schema", async () => {
    const source = McpFlows.mcp({
      server: "structured",
      tools: [{ name: "run", description: undefined, inputSchema: { type: "object" }, outputSchema: undefined }],
      callTool: () =>
        Effect.succeed({
          content: [{ type: "text", text: "done" }],
          isError: false,
          structuredContent: { answer: 42 }
        })
    })
    const [binding] = await execute(source.bindings())
    const call = new Cell.Call({
      flowName: "mcp/structured/run",
      input: {},
      capabilities: McpFlows.capabilities,
      effects: binding!.descriptor.effects,
      placement: Option.none(),
      identity: new Cell.CallIdentity({
        session: "structured",
        frame: 0,
        cell: "test",
        ordinal: 0,
        declaration: Cell.declarationDigest(binding!.descriptor),
        layers: []
      })
    })

    const result = await execute(binding!.run(call))
    expect(result.value).toEqual({
      content: [{ type: "text", text: "done" }],
      isError: false,
      structuredContent: { answer: 42 }
    })
  })

  it("exports every MCP flow contract", () => {
    expect(McpFlows.Args).toBeDefined()
    expect(McpFlows.Result).toBeDefined()
    expect(McpFlows.effects).toBeDefined()
  })
})
