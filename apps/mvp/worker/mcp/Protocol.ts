import { Effect, Metric, Option } from "effect"
import { HttpServerResponse } from "effect/http"
import {
  MCP_BLOCKED_ACTS,
  MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
  MCP_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
} from "../../src/features/mcp/contract.ts"
import { type McpPrincipal, type McpToolError, McpToolRegistry } from "./Contract.ts"
import * as Metrics from "./Metrics.ts"

// Stateless Streamable HTTP MCP (JSON-RPC 2.0) over `McpToolRegistry`. One POST carries one JSON-RPC message; the answer
// is one JSON body (no SSE stream, no session id). worker/mcp/Api.ts authenticates before it calls here, so this module
// reads who is asking from `McpHttpMessage.principal` alone.
//
// No span, log or metric carries a token, a tool's arguments or result, or a login (OBS-5).

/** The protocol version this server prefers when a client asks for one it doesn't speak. */
export const LATEST_PROTOCOL_VERSION: McpProtocolVersion = "2025-11-25"

export const SERVER_INFO = { name: "smithers-mcp", version: "1.0.0" } as const

export const INSTRUCTIONS =
  "Smithers repository tools. Every write is attributed to you as `<login> (agent)` and runs with your live role on " +
  "the repository. Person-only actions (merging, final triage, committing TODOs, secrets) are never available here."

/** JSON-RPC 2.0 error codes this server answers with. */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

/** One MCP POST, after worker/mcp/Api.ts read its bounded body and authenticated it. */
export interface McpHttpMessage {
  /** The request body as UTF-8 text. */
  readonly body: string
  /** Who is asking: none for an anonymous caller. */
  readonly principal: Option.Option<McpPrincipal>
}

type Id = string | number | null

const noStore = { "cache-control": "no-store" }

/** RFC 9728 `WWW-Authenticate` value that makes Claude Code and Codex start OAuth discovery. */
export const wwwAuthenticate = (
  origin: string,
  error?: string,
  defaultRepo?: { readonly owner: string; readonly name: string },
): string => {
  const suffix = defaultRepo === undefined
    ? ""
    : `/${encodeURIComponent(defaultRepo.owner)}/${encodeURIComponent(defaultRepo.name)}/mcp`
  const metadata = `${origin.replace(/\/+$/, "")}${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}${suffix}`
  return error === undefined
    ? `Bearer resource_metadata="${metadata}"`
    : `Bearer error="${error}", resource_metadata="${metadata}"`
}

/** A 401 asking the client to authorize, with the RFC 9728 challenge. */
export const unauthorized = (
  origin: string,
  code: string,
  error?: string,
  defaultRepo?: { readonly owner: string; readonly name: string },
) =>
  HttpServerResponse.jsonUnsafe({ code }, {
    status: 401,
    headers: { ...noStore, "www-authenticate": wwwAuthenticate(origin, error, defaultRepo) },
  })

const result = (id: Id, value: unknown) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, result: value }, { status: 200, headers: noStore })

const rpcError = (id: Id, code: number, message: string, data?: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } },
    { status, headers: noStore },
  )

const accepted = () => HttpServerResponse.empty({ status: 202, headers: noStore })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const isId = (value: unknown): value is Id =>
  value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))

/** Whether `name` names a person-only act, as written or with `_`/`.` in place of `/`. */
export const isBlockedAct = (name: string): boolean => {
  const normalized = name.replace(/[_.]/g, "/")
  return MCP_BLOCKED_ACTS.some((act) => act === name || act === normalized)
}

/** The version this server answers `initialize` with: the client's when supported, else the latest. */
export const negotiateVersion = (requested: unknown): McpProtocolVersion =>
  (MCP_PROTOCOL_VERSIONS as ReadonlyArray<unknown>).includes(requested)
    ? requested as McpProtocolVersion
    : LATEST_PROTOCOL_VERSION

/** A tool name safe and bounded enough to be a metric attribute; anything else counts as `other`. */
const toolLabel = (name: string): string => /^[a-z][a-z0-9_/-]{0,63}$/.test(name) ? name : "other"

const roleLabel = (principal: Option.Option<McpPrincipal>): string =>
  Option.isNone(principal) ? "anonymous" : principal.value.actor.role ?? "none"

/** The MCP tool error result for a failed call: HTTP 200, `isError: true`, its `{ code, message }` as text. */
export const toolErrorResult = (error: McpToolError) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ code: error.code, message: error.message }) }],
  isError: true,
})

const countTool = (tool: string, principal: Option.Option<McpPrincipal>, outcome: string) =>
  Metric.update(Metric.withAttributes(Metrics.toolCalls, { tool: toolLabel(tool), role: roleLabel(principal), outcome }), 1)

const callTool = (
  id: Id,
  params: Record<string, unknown>,
  message: McpHttpMessage,
  origin: string,
  defaultRepo: { readonly owner: string; readonly name: string } | undefined,
) =>
  Effect.gen(function* () {
    const name = params.name
    if (typeof name !== "string" || name === "") {
      return rpcError(id, JSON_RPC.invalidParams, "params.name must be a non-empty string", { code: "invalid_params" })
    }
    const args = params.arguments === undefined ? {} : params.arguments
    if (!isRecord(args)) {
      return rpcError(id, JSON_RPC.invalidParams, "params.arguments must be an object", { code: "invalid_params" })
    }
    if (isBlockedAct(name)) {
      yield* countTool(name, message.principal, "person_only")
      return rpcError(id, JSON_RPC.invalidParams, "This action is person-only and never available to agents", {
        code: "person_only",
      })
    }
    const registry = yield* McpToolRegistry
    const called = yield* registry.callTool(name, args, {
      principal: message.principal,
      ...(defaultRepo === undefined ? {} : { defaultRepo }),
      requestId: String(id),
      origin,
    }).pipe(Effect.result)
    if (called._tag === "Success") {
      yield* countTool(name, message.principal, called.success.isError === true ? "tool_error" : "ok")
      return result(id, called.success)
    }
    const error = called.failure
    yield* countTool(name, message.principal, error.code)
    yield* Effect.annotateCurrentSpan({ "mcp.tool.error": error.code })
    // Unauthenticated: a 401 with the RFC 9728 challenge, so the client starts OAuth instead of showing an error.
    if (error.code === "authentication" && Option.isNone(message.principal)) {
      return unauthorized(origin, "authentication", undefined, defaultRepo)
    }
    return result(id, toolErrorResult(error))
  })

/**
 * Answers one Streamable HTTP MCP POST body: `initialize`, `ping`, `tools/list`, `tools/call`, and notifications (202).
 * `origin` is the public origin the RFC 9728 challenge and tool links name; `defaultRepo` is the repository a
 * repository-scoped endpoint pins.
 */
export const handleMcpMessage = (
  message: McpHttpMessage,
  origin: string,
  defaultRepo?: { readonly owner: string; readonly name: string },
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, McpToolRegistry> =>
  Effect.gen(function* () {
    let parsed: unknown
    try {
      parsed = JSON.parse(message.body)
    } catch {
      return rpcError(null, JSON_RPC.parseError, "Parse error", undefined, 400)
    }
    // Batches were removed in 2025-06-18; one message per POST.
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
      return rpcError(null, JSON_RPC.invalidRequest, "Invalid Request", undefined, 400)
    }
    const hasId = "id" in parsed && parsed.id !== undefined
    if (hasId && !isId(parsed.id)) return rpcError(null, JSON_RPC.invalidRequest, "Invalid Request", undefined, 400)
    const id: Id = hasId ? parsed.id as Id : null
    // A client's response to a server request: nothing to answer on a stateless server.
    if (!("method" in parsed) && hasId && ("result" in parsed || "error" in parsed)) return accepted()
    const method = parsed.method
    if (typeof method !== "string" || method === "") {
      return rpcError(id, JSON_RPC.invalidRequest, "Invalid Request", undefined, 400)
    }
    if (parsed.params !== undefined && !isRecord(parsed.params)) {
      return rpcError(id, JSON_RPC.invalidRequest, "Invalid Request", undefined, 400)
    }
    const params: Record<string, unknown> = isRecord(parsed.params) ? parsed.params : {}
    yield* Effect.annotateCurrentSpan({ "mcp.method": method.length <= 64 ? method : "other" })
    // A notification gets no JSON-RPC answer and runs nothing: `notifications/initialized` and any other.
    if (!hasId) return accepted()
    switch (method) {
      case "initialize":
        return result(id, {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        })
      case "ping":
        return result(id, {})
      case "tools/list": {
        const registry = yield* McpToolRegistry
        const tools = yield* registry.listTools(message.principal, defaultRepo)
        return result(id, { tools })
      }
      case "tools/call":
        return yield* callTool(id, params, message, origin, defaultRepo)
      default:
        return rpcError(id, JSON_RPC.methodNotFound, "Method not found")
    }
  })
