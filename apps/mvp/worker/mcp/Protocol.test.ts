// MCP's Streamable HTTP routes (worker/mcp/Api.ts) and JSON-RPC handler (worker/mcp/Protocol.ts) through the real
// handler, over stubbed `McpAuthService` and `McpToolRegistry`. The stubs record what reached them, so a test can prove a
// refused request never reached a tool.
import { Effect, Option } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import {
  MCP_BLOCKED_ACTS,
  MCP_MAX_REQUEST_BYTES,
  MCP_OAUTH_AUTH_SERVER_ROUTE,
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_ROUTE,
  MCP_TOKENS_ROUTE,
  repoMcpRoute,
} from "../../src/features/mcp/contract.ts"
import * as Api from "./Api.ts"
import {
  McpAuthService,
  type McpAuthResult,
  type McpPrincipal,
  McpToolError,
  McpToolRegistry,
  type McpToolContext,
} from "./Contract.ts"

const ORIGIN = "https://smithers.test"
const TOKEN = "sma_" + "ab".repeat(32)
const CHALLENGE = `Bearer resource_metadata="${ORIGIN}${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}"`

const principal: McpPrincipal = {
  tokenId: "tok-1",
  personId: "person-1",
  login: "maya",
  clientName: "Claude Code",
  repoScope: null,
  scopes: ["mcp:read", "mcp:write"],
  actor: {
    subject: { kind: "person", id: "person-1" },
    role: "maintainer",
    login: "maya",
    act: { kind: "agent", id: "mcp:tok-1" },
  },
}

type Call = { readonly name: string; readonly args: Record<string, unknown>; readonly ctx: McpToolContext }

interface Options {
  /** What `authenticate` answers: `Authenticated` with `principal` when a bearer is sent, else `Anonymous`. */
  readonly auth?: (bearer: string | undefined, targetRepoId: string | undefined) => McpAuthResult
  /** What `callTool` answers. */
  readonly tool?: (call: Call) => Effect.Effect<
    { readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly isError?: boolean },
    McpToolError
  >
}

const open = (options: Options = {}) => {
  const calls: Array<Call> = []
  const authenticated: Array<string | undefined> = []
  const oauth: Array<string> = []
  const auth = McpAuthService.of({
    authenticate: (request, targetRepoId) =>
      Effect.sync(() => {
        authenticated.push(targetRepoId)
        const header = request.headers["authorization"]
        const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined
        if (options.auth !== undefined) return options.auth(bearer, targetRepoId)
        return bearer === undefined ? { _tag: "Anonymous" } : { _tag: "Authenticated", principal }
      }),
    resolveRepoAccess: () => Effect.die("unused"),
    requireWriteAccess: () => Effect.die("unused"),
    listTokens: () => Effect.die("unused"),
    revokeToken: () => Effect.die("unused"),
    handleOAuthOrTokenRoute: (request) =>
      Effect.sync(() => {
        oauth.push(request.url)
        return Option.some(HttpServerResponse.jsonUnsafe({ handled: "oauth" }, { status: 200 }))
      }),
  })
  const registry = McpToolRegistry.of({
    listTools: (who, defaultRepo) =>
      Effect.succeed([
        {
          name: "issue_read",
          description: `for ${Option.isSome(who) ? "agent" : "anonymous"} on ${defaultRepo?.name ?? "any"}`,
          inputSchema: { type: "object" },
        },
      ]),
    callTool: (name, args, ctx) => {
      const call = { name, args, ctx }
      calls.push(call)
      return options.tool === undefined
        ? Effect.succeed({ content: [{ type: "text" as const, text: `ran ${name}` }] })
        : options.tool(call)
    },
  })
  const handler = HttpEffect.toWebHandler(
    Api.make().fetch.pipe(Effect.provideService(McpAuthService, auth), Effect.provideService(McpToolRegistry, registry)),
  )
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    )
  const rpc = (method: string, params?: Record<string, unknown>, headers?: Record<string, string>, id: number = 1) =>
    post(MCP_ROUTE, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, headers)
  return { handler, post, rpc, calls, authenticated, oauth }
}

const readJson = (response: Response) => response.json() as Promise<any>

const bearer = { authorization: `Bearer ${TOKEN}` }

describe("JSON-RPC lifecycle", () => {
  test("initialize answers the client's supported version, capabilities and server info", async () => {
    const { rpc } = open()
    const response = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2" },
    })
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "smithers-mcp", version: "1.0.0" },
      },
    })
    expect(typeof body.result.instructions).toBe("string")
  })

  test("initialize with an unknown version answers the latest", async () => {
    const { rpc } = open()
    const body = await readJson(await rpc("initialize", { protocolVersion: "1999-01-01" }))
    expect(body.result.protocolVersion).toBe("2025-11-25")
  })

  test("ping answers an empty result", async () => {
    const { rpc } = open()
    expect(await readJson(await rpc("ping"))).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })

  test("notifications/initialized answers 202 with no body", async () => {
    const { post } = open()
    const response = await post(MCP_ROUTE, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe("")
  })

  test("an unknown method answers -32601", async () => {
    const { rpc } = open()
    const body = await readJson(await rpc("resources/list"))
    expect(body.error.code).toBe(-32601)
    expect(body.error.message).toBe("Method not found")
  })

  test("malformed JSON answers -32700; a non-JSON-RPC envelope answers -32600", async () => {
    const { post } = open()
    const parse = await post(MCP_ROUTE, "{not json")
    expect(parse.status).toBe(400)
    expect((await readJson(parse)).error.code).toBe(-32700)
    for (const invalid of [[{ jsonrpc: "2.0", id: 1, method: "ping" }], { id: 1, method: "ping" }, {
      jsonrpc: "2.0",
      id: 1,
    }, { jsonrpc: "2.0", id: { no: 1 }, method: "ping" }]) {
      const response = await post(MCP_ROUTE, invalid)
      expect(response.status).toBe(400)
      expect((await readJson(response)).error.code).toBe(-32600)
    }
  })
})

describe("tools", () => {
  test("tools/list passes the principal and the repository-scoped default", async () => {
    const { post, rpc } = open()
    const global = await readJson(await rpc("tools/list", undefined, bearer))
    expect(global.result.tools[0]).toMatchObject({ name: "issue_read", description: "for agent on any" })
    const scoped = await readJson(await post(repoMcpRoute("acme", "web"), { jsonrpc: "2.0", id: 2, method: "tools/list" }))
    expect(scoped.result.tools[0].description).toBe("for anonymous on web")
  })

  test("tools/call runs the tool with its arguments, the principal, request id and origin", async () => {
    const { calls, rpc } = open()
    const response = await rpc("tools/call", { name: "issue_read", arguments: { number: 7 } }, bearer, 42)
    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: { content: [{ type: "text", text: "ran issue_read" }] },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual({ number: 7 })
    expect(calls[0]!.ctx.requestId).toBe("42")
    expect(calls[0]!.ctx.origin).toBe(ORIGIN)
    expect(Option.getOrUndefined(calls[0]!.ctx.principal)?.tokenId).toBe("tok-1")
  })

  test("a tool's error is an MCP error result on HTTP 200", async () => {
    const { rpc } = open({
      tool: () => Effect.fail(new McpToolError({ code: "forbidden", message: "Needs the Maintainer role" })),
    })
    const response = await rpc("tools/call", { name: "issue_comment", arguments: {} }, bearer)
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.result.isError).toBe(true)
    expect(JSON.parse(body.result.content[0].text)).toEqual({ code: "forbidden", message: "Needs the Maintainer role" })
  })

  test("an anonymous call a tool refuses for authentication answers 401 with the RFC 9728 challenge", async () => {
    const { rpc } = open({
      tool: () => Effect.fail(new McpToolError({ code: "authentication", message: "Sign in" })),
    })
    const response = await rpc("tools/call", { name: "issue_comment", arguments: {} })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE)
  })

  test("invalid name or arguments answer -32602 and never reach the registry", async () => {
    const { calls, rpc } = open()
    for (const params of [{}, { name: 3 }, { name: "issue_read", arguments: [1] }, { name: "x", arguments: "y" }]) {
      const body = await readJson(await rpc("tools/call", params, bearer))
      expect(body.error.code).toBe(-32602)
    }
    expect(calls).toHaveLength(0)
  })

  test("every person-only act is refused with -32602 person_only, even called directly", async () => {
    const { calls, rpc } = open()
    for (const act of [...MCP_BLOCKED_ACTS, "pull_merge", "todo.commit"]) {
      const response = await rpc("tools/call", { name: act, arguments: {} }, bearer)
      expect(response.status).toBe(200)
      const body = await readJson(response)
      expect(body.error).toMatchObject({ code: -32602, data: { code: "person_only" } })
    }
    expect(calls).toHaveLength(0)
  })
})

describe("authentication", () => {
  test("a rejected token answers 401 with the RFC 9728 WWW-Authenticate challenge", async () => {
    const { calls, rpc } = open({ auth: () => ({ _tag: "Rejected", status: 401, code: "token_revoked" }) })
    const response = await rpc("tools/list", undefined, bearer)
    expect(response.status).toBe(401)
    const challenge = response.headers.get("www-authenticate")
    expect(challenge).toContain(`resource_metadata="${ORIGIN}${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}"`)
    expect(challenge).toMatch(/^Bearer /)
    expect(await response.json()).toEqual({ code: "token_revoked" })
    expect(calls).toHaveLength(0)
  })

  test("a token pinned to another repository answers 403 repo_scope_mismatch", async () => {
    const { authenticated, calls, post } = open({
      auth: (_, target) =>
        target === "github/acme/web"
          ? { _tag: "Rejected", status: 403, code: "repo_scope_mismatch" }
          : { _tag: "Authenticated", principal },
    })
    const response = await post(
      repoMcpRoute("Acme", "Web"),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "issue_read" } },
      bearer,
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: "repo_scope_mismatch" })
    expect(authenticated).toEqual(["github/acme/web"])
    expect(calls).toHaveLength(0)
  })

  test("the response never echoes the bearer token", async () => {
    const { rpc } = open({ auth: () => ({ _tag: "Rejected", status: 401, code: "invalid_token" }) })
    const response = await rpc("ping", undefined, bearer)
    expect(JSON.stringify([...response.headers]) + (await response.text())).not.toContain(TOKEN)
  })
})

describe("transport", () => {
  test("a body over 256 KiB answers 413 before authenticating", async () => {
    const { authenticated, post } = open()
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MCP_MAX_REQUEST_BYTES) } })
    const response = await post(MCP_ROUTE, huge, bearer)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ code: "too_large" })
    expect(authenticated).toHaveLength(0)
  })

  test("GET on an MCP endpoint answers 405 allowing POST", async () => {
    const { handler } = open()
    for (const path of [MCP_ROUTE, repoMcpRoute("acme", "web")]) {
      const response = await handler(new Request(`${ORIGIN}${path}`, { headers: { accept: "text/event-stream" } }))
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("POST")
    }
  })

  test("an invalid repository path answers 404 without authenticating", async () => {
    const { authenticated, post } = open()
    const response = await post("/api/repos/-bad-/web/mcp", { jsonrpc: "2.0", id: 1, method: "ping" })
    expect(response.status).toBe(404)
    expect(authenticated).toHaveLength(0)
  })

  test("OAuth and token routes go to McpAuthService", async () => {
    const { handler, oauth } = open()
    const response = await handler(new Request(`${ORIGIN}${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}`))
    expect(await response.json()).toEqual({ handled: "oauth" })
    expect(oauth).toHaveLength(1)
  })
})

describe("handles", () => {
  test("matches every MCP and OAuth route", () => {
    for (const path of [
      MCP_ROUTE,
      repoMcpRoute("acme", "web"),
      MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
      `${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/api/mcp`,
      MCP_OAUTH_AUTH_SERVER_ROUTE,
      MCP_OAUTH_REGISTER_ROUTE,
      MCP_OAUTH_AUTHORIZE_ROUTE,
      MCP_OAUTH_TOKEN_ROUTE,
      MCP_TOKENS_ROUTE,
      `${MCP_TOKENS_ROUTE}/tok-1`,
    ]) expect(Api.handles(path), path).toBe(true)
  })

  test("does not take other repository or API routes", () => {
    for (const path of [
      "/api/repos/acme/web/issues",
      "/api/repos/acme/web/stack",
      "/api/repos/acme/web/mcp/extra",
      "/api/repos/acme/mcp",
      "/api/mcpx",
      "/api/me",
      `${MCP_TOKENS_ROUTE}/tok-1/extra`,
      "/.well-known/openid-configuration",
      "/acme/web/mcp",
    ]) expect(Api.handles(path), path).toBe(false)
  })
})
