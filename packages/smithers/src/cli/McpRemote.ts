/**
 * Remote BYOA MCP OAuth 2.1 + PKCE login and stdio-to-Streamable-HTTP bridge.
 * Connects stdio-only MCP clients to `https://smithers.sh/<owner>/<repo>/mcp` or `/api/mcp`
 * without storing model API keys on the server.
 * @since 1.0.0
 */

import * as Environment from "@smthrs/integrations/Environment"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Readable, Writable } from "node:stream"
import * as CliError from "../CliError.ts"

const DEFAULT_ORIGIN = "https://smithers.sh"
const DEFAULT_SCOPE = "mcp:read mcp:write"
const DEFAULT_CLIENT_NAME = "smithers-cli"
const MAX_FRAME_BYTES = 10 * 1024 * 1024
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/
const TOKEN_PATTERN = /^sma_[0-9a-f]{64}$/

/**
 * One stored MCP bearer token entry on disk (`0600`).
 *
 * @category mcp
 * @since 1.0.0
 */
export interface StoredMcpToken {
  readonly origin: string
  readonly repo: string | null
  readonly token: string
  readonly scope: string
  readonly expiresAt: string | null
  readonly updatedAt: string
}

interface TokenStoreFile {
  readonly version: 1
  readonly tokens: Record<string, StoredMcpToken>
}

/**
 * Validates and normalizes an MCP origin (`https:` or loopback `http:`).
 *
 * @category mcp
 * @since 1.0.0
 */
export const normalizeOrigin = (raw: string | undefined): string => {
  const input = (raw ?? DEFAULT_ORIGIN).trim()
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new CliError.UsageError({ message: `Invalid MCP origin URL: ${input}` })
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new CliError.UsageError({
      message: "MCP origin must use https:// (or http://localhost for local development)"
    })
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CliError.UsageError({ message: "MCP origin must not include credentials" })
  }
  return parsed.origin
}

/**
 * Validates an optional `owner/repo` string.
 *
 * @category mcp
 * @since 1.0.0
 */
export const normalizeRepo = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "")
  if (!REPO_PATTERN.test(trimmed)) {
    throw new CliError.UsageError({ message: `Invalid --repo "${raw}". Expected owner/name (e.g. evmts/voltaire).` })
  }
  return trimmed
}

/**
 * Resolves the Streamable HTTP endpoint for `origin` and optional `owner/name`.
 *
 * @category mcp
 * @since 1.0.0
 */
export const mcpEndpointUrl = (origin: string, repo?: string): string => {
  const cleanOrigin = normalizeOrigin(origin)
  const cleanRepo = normalizeRepo(repo)
  if (cleanRepo === undefined) return `${cleanOrigin}/api/mcp`
  const [owner, name] = cleanRepo.split("/") as [string, string]
  return `${cleanOrigin}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/mcp`
}

/**
 * Default path for stored MCP bearer tokens (`$XDG_CONFIG_HOME/smithers/mcp-tokens.json`).
 *
 * @category mcp
 * @since 1.0.0
 */
export const tokenStorePath = (
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): string => {
  const xdg = env["XDG_CONFIG_HOME"]?.trim()
  const base = xdg && xdg.length > 0 ? xdg : join(env["HOME"] ?? homedir(), ".config")
  return join(base, "smithers", "mcp-tokens.json")
}

const storeKey = (origin: string, repo: string | null): string =>
  `${origin.toLowerCase()}|${repo === null ? "*" : repo.toLowerCase()}`

const readStoreFile = (filePath: string): TokenStoreFile => {
  if (!existsSync(filePath)) return { version: 1, tokens: {} }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<TokenStoreFile>
    if (parsed && typeof parsed === "object" && parsed.tokens && typeof parsed.tokens === "object") {
      return { version: 1, tokens: { ...parsed.tokens } }
    }
  } catch {
    // Corrupted store resets cleanly on next write.
  }
  return { version: 1, tokens: {} }
}

/**
 * Writes one MCP token atomically with `0700` dir and `0600` file permissions.
 *
 * @category mcp
 * @since 1.0.0
 */
export const writeStoredToken = (filePath: string, entry: StoredMcpToken): void => {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best-effort on filesystems without POSIX chmod.
  }
  const store = readStoreFile(filePath)
  store.tokens[storeKey(entry.origin, entry.repo)] = entry
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tempPath, 0o600)
  renameSync(tempPath, filePath)
}

/**
 * Reads the most specific non-expired token for `(origin, repo)` (repo-pinned first, then global `*`).
 *
 * @category mcp
 * @since 1.0.0
 */
export const readStoredToken = (
  filePath: string,
  origin: string,
  repo?: string,
  nowMs = Date.now()
): StoredMcpToken | undefined => {
  const store = readStoreFile(filePath)
  const cleanOrigin = normalizeOrigin(origin)
  const cleanRepo = normalizeRepo(repo) ?? null
  const candidates = cleanRepo === null
    ? [store.tokens[storeKey(cleanOrigin, null)]]
    : [store.tokens[storeKey(cleanOrigin, cleanRepo)], store.tokens[storeKey(cleanOrigin, null)]]
  for (const entry of candidates) {
    if (!entry || typeof entry.token !== "string" || !TOKEN_PATTERN.test(entry.token)) continue
    if (entry.expiresAt !== null) {
      const expiresAtMs = Date.parse(entry.expiresAt)
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) continue
    }
    return entry
  }
  return undefined
}

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

const pkceS256 = (verifier: string): string => base64Url(createHash("sha256").update(verifier).digest())

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const openInBrowser = (url: string): void => {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    child.unref()
  } catch {
    // Caller prints the authorize URL as fallback.
  }
}

/**
 * Options for remote MCP OAuth 2.1 + PKCE login.
 *
 * @category mcp
 * @since 1.0.0
 */
export interface McpLoginOptions {
  readonly origin?: string | undefined
  readonly repo?: string | undefined
  readonly scope?: string | undefined
  readonly clientName?: string | undefined
  readonly noOpen?: boolean | undefined
  readonly timeoutMs?: number | undefined
  readonly storePath?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  readonly stderr?: { readonly write: (chunk: string) => unknown } | undefined
  readonly fetchImpl?: typeof globalThis.fetch | undefined
  readonly openBrowser?: ((url: string) => void) | undefined
  readonly onAuthorizeUrl?: ((url: string) => void) | undefined
}

/**
 * Result of a completed remote MCP OAuth login.
 *
 * @category mcp
 * @since 1.0.0
 */
export interface McpLoginResult {
  readonly status: "authenticated"
  readonly origin: string
  readonly repo: string | null
  readonly scope: string
  readonly expiresAt: string | null
  readonly tokenStorePath: string
}

interface AuthServerMetadata {
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly registration_endpoint: string
}

const discoverAuthServer = async (
  origin: string,
  fetchImpl: typeof globalThis.fetch
): Promise<AuthServerMetadata> => {
  const fallback: AuthServerMetadata = {
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`
  }
  const res = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`, {
    headers: { accept: "application/json", "user-agent": "smithers-cli/1.0" }
  })
  if (!res.ok) return fallback
  const body = (await res.json()) as Partial<AuthServerMetadata>
  return {
    authorization_endpoint: typeof body.authorization_endpoint === "string"
      ? body.authorization_endpoint
      : fallback.authorization_endpoint,
    token_endpoint: typeof body.token_endpoint === "string" ? body.token_endpoint : fallback.token_endpoint,
    registration_endpoint: typeof body.registration_endpoint === "string"
      ? body.registration_endpoint
      : fallback.registration_endpoint
  }
}

/**
 * Runs OAuth 2.1 + PKCE S256 login against a Smithers MCP server using an ephemeral loopback callback
 * and stores the resulting `sma_` bearer token (`0600`) on disk without ever printing the secret.
 *
 * @category mcp
 * @since 1.0.0
 */
export const loginMcpRemote = async (options: McpLoginOptions = {}): Promise<McpLoginResult> => {
  const origin = normalizeOrigin(options.origin)
  const repo = normalizeRepo(options.repo) ?? null
  const scope = (options.scope ?? DEFAULT_SCOPE).trim() || DEFAULT_SCOPE
  const clientName = (options.clientName ?? DEFAULT_CLIENT_NAME).trim().slice(0, 120) || DEFAULT_CLIENT_NAME
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const stderr = options.stderr ?? process.stderr
  const filePath = options.storePath ?? tokenStorePath(options.env)
  const timeoutMs = options.timeoutMs ?? 300_000

  const metadata = await discoverAuthServer(origin, fetchImpl)

  // Start ephemeral loopback callback server on 127.0.0.1:0
  let resolveCallback!: (params: { readonly code: string; readonly state: string | null }) => void
  let rejectCallback!: (err: Error) => void
  const callbackPromise = new Promise<{ readonly code: string; readonly state: string | null }>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  let settled = false
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1")
    if (parsed.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("Not found")
      return
    }
    if (settled) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      res.end("Authorization already handled.")
      return
    }
    settled = true
    const oauthError = parsed.searchParams.get("error")
    const code = parsed.searchParams.get("code")
    const state = parsed.searchParams.get("state")
    if (oauthError) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
      res.end("<!doctype html><html><body><h2>Authorization denied</h2><p>You can close this tab.</p></body></html>")
      rejectCallback(
        new CliError.Refused({
          fault: "user",
          code: "mcp_oauth_denied",
          message: `Authorization failed (${oauthError})`
        })
      )
      return
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      res.end("Missing authorization code.")
      rejectCallback(
        new CliError.Refused({
          fault: "user",
          code: "mcp_oauth_invalid",
          message: "Callback did not include an authorization code"
        })
      )
      return
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(
      "<!doctype html><html><body><h2>Connected to Smithers</h2><p>You can close this tab and return to your terminal.</p></body></html>"
    )
    resolveCallback({ code, state })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      rejectCallback(
        new CliError.Refused({
          fault: "user",
          code: "mcp_oauth_timeout",
          message: "Timed out waiting for browser authorization"
        })
      )
    }
  }, timeoutMs)

  try {
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new CliError.UnsupportedError({ message: "Failed to bind loopback callback server" })
    }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`

    // Dynamic Client Registration (RFC 7591)
    const regRes = await fetchImpl(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "smithers-cli/1.0" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none"
      })
    })
    if (!regRes.ok) {
      throw new CliError.Refused({
        fault: "dependency",
        code: "mcp_dcr_failed",
        message: `Dynamic client registration failed with HTTP ${regRes.status}`
      })
    }
    const regBody = (await regRes.json()) as { readonly client_id?: unknown }
    if (typeof regBody.client_id !== "string" || regBody.client_id.length === 0) {
      throw new CliError.Refused({
        fault: "dependency",
        code: "mcp_dcr_invalid",
        message: "Registration response did not include client_id"
      })
    }

    const codeVerifier = base64Url(randomBytes(32))
    const codeChallenge = pkceS256(codeVerifier)
    const expectedState = base64Url(randomBytes(24))

    const authorizeUrl = new URL(metadata.authorization_endpoint)
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("client_id", regBody.client_id)
    authorizeUrl.searchParams.set("redirect_uri", redirectUri)
    authorizeUrl.searchParams.set("code_challenge", codeChallenge)
    authorizeUrl.searchParams.set("code_challenge_method", "S256")
    authorizeUrl.searchParams.set("scope", scope)
    authorizeUrl.searchParams.set("state", expectedState)
    if (repo !== null) {
      authorizeUrl.searchParams.set("repo", repo)
      authorizeUrl.searchParams.set("resource", mcpEndpointUrl(origin, repo))
    }

    const authorizeHref = authorizeUrl.toString()
    options.onAuthorizeUrl?.(authorizeHref)
    stderr.write(`Authorize Smithers MCP in your browser:\n  ${authorizeHref}\n`)
    if (!options.noOpen) {
      ;(options.openBrowser ?? openInBrowser)(authorizeHref)
    }

    const callback = await callbackPromise
    if (callback.state === null || !safeEqual(callback.state, expectedState)) {
      throw new CliError.Refused({
        fault: "user",
        code: "mcp_oauth_state_mismatch",
        message: "OAuth callback state did not match; aborting login"
      })
    }

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: regBody.client_id,
      redirect_uri: redirectUri,
      code: callback.code,
      code_verifier: codeVerifier
    })
    const tokenRes = await fetchImpl(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": "smithers-cli/1.0"
      },
      body: form.toString()
    })
    if (!tokenRes.ok) {
      throw new CliError.Refused({
        fault: "dependency",
        code: "mcp_token_exchange_failed",
        message: `Token exchange failed with HTTP ${tokenRes.status}`
      })
    }
    const tokenBody = (await tokenRes.json()) as {
      readonly access_token?: unknown
      readonly expires_in?: unknown
      readonly scope?: unknown
    }
    if (typeof tokenBody.access_token !== "string" || !TOKEN_PATTERN.test(tokenBody.access_token)) {
      throw new CliError.Refused({
        fault: "dependency",
        code: "mcp_token_invalid",
        message: "Token endpoint returned an unexpected access_token format"
      })
    }
    const expiresAt = typeof tokenBody.expires_in === "number" && Number.isFinite(tokenBody.expires_in)
      ? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString()
      : null
    const grantedScope = typeof tokenBody.scope === "string" && tokenBody.scope.trim() !== "" ? tokenBody.scope : scope

    writeStoredToken(filePath, {
      origin,
      repo,
      token: tokenBody.access_token,
      scope: grantedScope,
      expiresAt,
      updatedAt: new Date().toISOString()
    })

    return {
      status: "authenticated",
      origin,
      repo,
      scope: grantedScope,
      expiresAt,
      tokenStorePath: filePath
    }
  } finally {
    clearTimeout(timer)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/**
 * Options for the stdio-to-Streamable-HTTP MCP bridge.
 *
 * @category mcp
 * @since 1.0.0
 */
export interface McpServeOptions {
  readonly origin?: string | undefined
  readonly repo?: string | undefined
  readonly token?: string | undefined
  readonly storePath?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  readonly input?: Readable | undefined
  readonly output?: Writable | undefined
  readonly stderr?: { readonly write: (chunk: string) => unknown } | undefined
  readonly fetchImpl?: typeof globalThis.fetch | undefined
  readonly signal?: AbortSignal | undefined
}

const writeLine = (output: Writable, line: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (output.write(`${line}\n`, (err) => (err ? reject(err) : resolve()))) return
    output.once("drain", resolve)
  })

/**
 * Bridges newline-delimited JSON-RPC 2.0 on `stdin`/`stdout` to a remote Smithers Streamable HTTP MCP endpoint.
 *
 * @category mcp
 * @since 1.0.0
 */
export const serveMcpStdioBridge = async (options: McpServeOptions = {}): Promise<void> => {
  const origin = normalizeOrigin(options.origin)
  const repo = normalizeRepo(options.repo)
  const endpoint = mcpEndpointUrl(origin, repo)
  const env = options.env ?? process.env
  const filePath = options.storePath ?? tokenStorePath(env)
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  const resolveToken = (): string | undefined => {
    const direct = options.token?.trim() || env["SMITHERS_MCP_TOKEN"]?.trim()
    if (direct && TOKEN_PATTERN.test(direct)) return direct
    return readStoredToken(filePath, origin, repo)?.token
  }

  let pending = Buffer.alloc(0)
  const handleFrame = async (raw: string): Promise<void> => {
    const trimmed = raw.trim()
    if (trimmed === "") return
    let parsed: { readonly id?: unknown }
    try {
      parsed = JSON.parse(trimmed) as { readonly id?: unknown }
    } catch {
      await writeLine(
        output,
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      )
      return
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "smithers-cli/1.0"
    }
    const token = resolveToken()
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`

    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: trimmed,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    } catch {
      if (parsed.id !== undefined) {
        await writeLine(
          output,
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            error: { code: -32000, message: `Could not reach Smithers MCP endpoint at ${endpoint}` }
          })
        )
      }
      return
    }

    if (response.status === 202) return
    if (response.status === 401) {
      const hint = repo === undefined
        ? `smthrs mcp login --origin ${origin}`
        : `smthrs mcp login --origin ${origin} --repo ${repo}`
      stderr.write(`Smithers MCP authentication required. Run: ${hint}\n`)
      if (parsed.id !== undefined) {
        await writeLine(
          output,
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            error: {
              code: -32001,
              message: `Authentication required. Run "${hint}" to sign in.`,
              data: { code: "authentication" }
            }
          })
        )
      }
      return
    }
    const text = (await response.text()).trim()
    if (text !== "") await writeLine(output, text)
  }

  await new Promise<void>((resolve, reject) => {
    let queue = Promise.resolve()
    const onAbort = () => {
      input.off("data", onData)
      input.off("end", onEnd)
      input.off("error", onError)
      resolve()
    }
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      if (pending.length + buf.length > MAX_FRAME_BYTES) {
        reject(
          new CliError.Refused({
            fault: "user",
            code: "mcp_input_too_large",
            message: "MCP stdio input exceeds 10 MiB buffer limit"
          })
        )
        return
      }
      const combined = Buffer.concat([pending, buf])
      let start = 0
      const frames: Array<string> = []
      for (;;) {
        const nl = combined.indexOf(10, start)
        if (nl < 0) break
        frames.push(combined.subarray(start, nl).toString("utf8"))
        start = nl + 1
      }
      pending = combined.subarray(start)
      for (const frame of frames) {
        queue = queue.then(() => handleFrame(frame))
      }
    }
    const onEnd = () => {
      const tail = pending.toString("utf8")
      pending = Buffer.alloc(0)
      queue = queue.then(() => handleFrame(tail)).then(() => resolve(), reject)
    }
    const onError = (err: Error) => reject(err)

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    input.on("data", onData)
    input.on("end", onEnd)
    input.on("error", onError)
  })
}
