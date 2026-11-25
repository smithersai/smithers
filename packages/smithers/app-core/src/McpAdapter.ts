/**
 * The catalog as a Model Context Protocol server: JSON-RPC 2.0 `initialize`,
 * `tools/list` and `tools/call` over text.
 *
 * Every tool is a catalog entry. `tools/list` leaves out person-only and
 * protected flows; a call to one still reaches the core, which refuses it
 * `person_only`. A tag `a/b` is the tool `a__b`; two tags that would share a
 * name are both left out and refuse `ambiguous_tool`.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as Cause from "./CauseReceipt.ts"
import * as Core from "./Core.ts"
import type * as Principal from "./Principal.ts"

/**
 * The protocol revision this server speaks.
 *
 * @category constants
 * @since 1.0.0
 */
export const protocolVersion = "2025-06-18"

/**
 * One tool in `tools/list`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Tool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Core.Entry["payload"]
  readonly annotations: { readonly readOnlyHint: boolean }
}

/**
 * An MCP server over one wire: a request's text in, its response's text out,
 * or `undefined` for a notification.
 *
 * @category models
 * @since 1.0.0
 */
export interface McpServer {
  readonly handle: (wire: string) => Effect.Effect<string | undefined>
}

/**
 * A flow tag as a tool name: `/` becomes `__`.
 *
 * @category encoding
 * @since 1.0.0
 */
export const toolName = (tag: string): string => tag.replaceAll("/", "__")

/**
 * The catalog as tools: every entry by tool name, the names two entries
 * share, and the tools a delegate is offered.
 *
 * @category projections
 * @since 1.0.0
 */
export const project = (entries: ReadonlyArray<Core.Entry>): {
  readonly tools: ReadonlyArray<Tool>
  readonly byName: ReadonlyMap<string, Core.Entry>
  readonly collisions: ReadonlySet<string>
} => {
  const byName = new Map<string, Core.Entry>()
  const collisions = new Set<string>()
  for (const entry of entries) {
    const name = toolName(entry.tag)
    if (byName.has(name)) collisions.add(name)
    else byName.set(name, entry)
  }
  const tools = Array.from(byName)
    .filter(([name, entry]) => !collisions.has(name) && Core.delegable(entry))
    .map(([name, entry]): Tool => ({
      name,
      title: entry.title,
      description: entry.description,
      inputSchema: entry.payload,
      annotations: { readOnlyHint: entry.readOnly }
    }))
  return { tools, byName, collisions }
}

const failure = (code: string, target: string, detail: string, extra: { readonly [key: string]: Schema.Json } = {}) => {
  const structuredContent = { code, operation: target, detail, ...extra }
  return { isError: true, content: [{ type: "text", text: Cause.canonical(structuredContent) }], structuredContent }
}

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Builds the server for one MCP connection. The principal it mints is always
 * an agent.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly engine: Core.Engine
  readonly evidence: Principal.McpEvidence
  readonly name?: string
  readonly version?: string
}): Effect.Effect<McpServer, Principal.AuthRefused> =>
  Effect.map(options.engine.openMcp(options.evidence), (core): McpServer => {
    const reply = (id: string | number | null, body: { readonly [key: string]: unknown }): string =>
      JSON.stringify({ jsonrpc: "2.0", id, ...body })
    const invalid = (id: string | number | null, code: number, message: string) =>
      reply(id, { error: { code, message } })

    const callTool = (params: unknown): Effect.Effect<{ readonly [key: string]: unknown } | undefined> =>
      Effect.gen(function*() {
        if (!isRecord(params) || typeof params["name"] !== "string") return undefined
        const name = params["name"]
        const catalog = yield* Effect.result(Core.entries(core))
        if (catalog._tag === "Failure") return failure(catalog.failure.reason, name, catalog.failure.detail)
        const { byName, collisions } = project(catalog.success)
        const entry = byName.get(name)
        if (entry === undefined) return undefined
        if (collisions.has(name)) return failure("ambiguous_tool", name, "two flows share this tool name")
        const outcome = yield* Effect.result(Core.call(core, entry.tag, params["arguments"]))
        if (outcome._tag === "Failure") {
          const refused = outcome.failure
          return failure(refused.reason, refused.target, refused.detail, {
            ...(refused.code === undefined ? {} : { cause: refused.code }),
            ...(refused.missingFields === undefined ? {} : { missingFields: [...refused.missingFields] })
          })
        }
        const structuredContent: Schema.Json = { ...outcome.success }
        return { content: [{ type: "text", text: Cause.canonical(structuredContent) }], structuredContent }
      })

    return {
      handle: (wire) =>
        Effect.gen(function*() {
          let request: unknown
          try {
            request = JSON.parse(wire)
          } catch {
            return invalid(null, -32700, "Parse error")
          }
          if (!isRecord(request) || request["jsonrpc"] !== "2.0" || typeof request["method"] !== "string") {
            return invalid(null, -32600, "Invalid request")
          }
          const method = request["method"]
          const rawId = request["id"]
          // A notification carries no id and gets no answer.
          if (rawId === undefined) return undefined
          if (typeof rawId !== "string" && !(typeof rawId === "number" && Number.isInteger(rawId))) {
            return invalid(null, -32600, "Invalid request")
          }
          const id = rawId
          switch (method) {
            case "initialize":
              return reply(id, {
                result: {
                  protocolVersion,
                  capabilities: { tools: { listChanged: false } },
                  serverInfo: { name: options.name ?? "smithers", version: options.version ?? "1.0.0" }
                }
              })
            case "ping":
              return reply(id, { result: {} })
            case "tools/list": {
              const catalog = yield* Effect.result(Core.entries(core))
              if (catalog._tag === "Failure") return invalid(id, -32603, catalog.failure.reason)
              return reply(id, { result: { tools: project(catalog.success).tools } })
            }
            case "tools/call": {
              const result = yield* callTool(request["params"])
              return result === undefined ? invalid(id, -32602, "Unknown tool") : reply(id, { result })
            }
            default:
              return invalid(id, -32601, "Method not found")
          }
        })
    }
  })
