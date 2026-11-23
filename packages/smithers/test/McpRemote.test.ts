import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, test } from "vitest"
import {
  loginMcpRemote,
  mcpEndpointUrl,
  readStoredToken,
  serveMcpStdioBridge,
  writeStoredToken
} from "../src/cli/McpRemote.ts"

const sha256Url = (v: string) =>
  createHash("sha256").update(v).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

describe("McpRemote", () => {
  test("mcpEndpointUrl resolves global and repo-scoped endpoints and rejects unsafe origins", () => {
    expect(mcpEndpointUrl("https://smithers.sh")).toBe("https://smithers.sh/api/mcp")
    expect(mcpEndpointUrl("https://smithers.sh/", "evmts/voltaire")).toBe("https://smithers.sh/evmts/voltaire/mcp")
    expect(mcpEndpointUrl("http://127.0.0.1:3000", "evmts/voltaire")).toBe("http://127.0.0.1:3000/evmts/voltaire/mcp")
    expect(() => mcpEndpointUrl("http://evil.example.com")).toThrow()
    expect(() => mcpEndpointUrl("https://smithers.sh", "../bad")).toThrow()
  })

  test("loginMcpRemote completes OAuth 2.1 + PKCE loopback flow and writes 0600 token file without leaking token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-mcp-remote-"))
    const storePath = join(dir, "mcp-tokens.json")
    const rawToken = `sma_${"a".repeat(64)}`
    let savedChallenge = ""
    let savedRedirect = ""
    const stderr = new PassThrough()
    const stderrChunks: Array<string> = []
    stderr.on("data", (c) => stderrChunks.push(c.toString("utf8")))

    try {
      const fetchImpl: typeof globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            issuer: "https://smithers.sh",
            authorization_endpoint: "https://smithers.sh/api/mcp/oauth/authorize",
            token_endpoint: "https://smithers.sh/api/mcp/oauth/token",
            registration_endpoint: "https://smithers.sh/api/mcp/oauth/register"
          })
        }
        if (url.endsWith("/api/mcp/oauth/register")) {
          const body = JSON.parse(String(init?.body)) as { redirect_uris: ReadonlyArray<string> }
          savedRedirect = body.redirect_uris[0]!
          return Response.json({ client_id: "cli-test-client" }, { status: 201 })
        }
        if (url.endsWith("/api/mcp/oauth/token")) {
          const params = new URLSearchParams(String(init?.body))
          expect(params.get("grant_type")).toBe("authorization_code")
          expect(params.get("client_id")).toBe("cli-test-client")
          expect(params.get("redirect_uri")).toBe(savedRedirect)
          expect(params.get("code")).toBe("auth-code-123")
          expect(sha256Url(params.get("code_verifier")!)).toBe(savedChallenge)
          return Response.json({
            access_token: rawToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "mcp:read mcp:write"
          })
        }
        return new Response("not found", { status: 404 })
      }

      const result = await loginMcpRemote({
        origin: "https://smithers.sh",
        repo: "evmts/voltaire",
        storePath,
        stderr,
        fetchImpl,
        openBrowser: (authorizeHref) => {
          const parsed = new URL(authorizeHref)
          savedChallenge = parsed.searchParams.get("code_challenge")!
          const redirect = new URL(parsed.searchParams.get("redirect_uri")!)
          redirect.searchParams.set("code", "auth-code-123")
          redirect.searchParams.set("state", parsed.searchParams.get("state")!)
          void globalThis.fetch(redirect.toString())
        }
      })

      expect(result.status).toBe("authenticated")
      expect(result.repo).toBe("evmts/voltaire")
      expect(JSON.stringify(result)).not.toContain(rawToken)
      expect(stderrChunks.join("")).not.toContain(rawToken)

      const mode = statSync(storePath).mode & 0o777
      expect(mode).toBe(0o600)

      const stored = readStoredToken(storePath, "https://smithers.sh", "evmts/voltaire")
      expect(stored?.token).toBe(rawToken)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("serveMcpStdioBridge forwards JSON-RPC over Streamable HTTP with Bearer token and handles 202 / 401 / parse errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-mcp-bridge-"))
    const storePath = join(dir, "mcp-tokens.json")
    const rawToken = `sma_${"b".repeat(64)}`
    writeStoredToken(storePath, {
      origin: "https://smithers.sh",
      repo: "evmts/voltaire",
      token: rawToken,
      scope: "mcp:read mcp:write",
      expiresAt: null,
      updatedAt: new Date().toISOString()
    })

    const input = new PassThrough()
    const output = new PassThrough()
    const stderr = new PassThrough()
    const outChunks: Array<string> = []
    output.on("data", (c) => outChunks.push(c.toString("utf8")))

    const seen: Array<{ url: string; auth: string | null; method: string }> = []
    const fetchImpl: typeof globalThis.fetch = async (url, init) => {
      const headers = init?.headers as Record<string, string>
      const body = JSON.parse(String(init?.body)) as { id?: unknown; method?: string }
      seen.push({ url: String(url), auth: headers["authorization"] ?? null, method: body.method ?? "" })
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "needs_auth") return Response.json({ code: "authentication" }, { status: 401 })
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } })
    }

    try {
      const running = serveMcpStdioBridge({
        origin: "https://smithers.sh",
        repo: "evmts/voltaire",
        storePath,
        input,
        output,
        stderr,
        fetchImpl
      })

      input.write("{bad json\n")
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n")
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "needs_auth" }) + "\n")
      input.end()
      await running

      const lines = outChunks.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>)
      expect(lines).toHaveLength(3)
      expect(lines[0]!.error.code).toBe(-32700)
      expect(lines[1]!.result).toEqual({ ok: true })
      expect(lines[2]!.error.code).toBe(-32001)
      expect(lines[2]!.error.message).toContain("smthrs mcp login --origin https://smithers.sh --repo evmts/voltaire")
      expect(seen.every((s) => s.url === "https://smithers.sh/evmts/voltaire/mcp")).toBe(true)
      expect(seen.every((s) => s.auth === `Bearer ${rawToken}`)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
