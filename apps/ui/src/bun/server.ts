/*
 * The local origin (LOCAL-APP.md, "Runtime topology"): one Bun.serve on
 * 127.0.0.1 that serves the built SPA, the chat boundary, the WebSocket bus,
 * and every lane's HTTP API. It imports nothing from Electrobun, so
 * `serve.ts` can run it without a window and Playwright can drive it in plain
 * Chromium.
 */
import type { Server, ServerWebSocket } from "bun"
import { randomBytes } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, normalize, resolve } from "node:path"
import {
  AUTH_CALLBACK_PATH,
  AUTH_NATIVE_CLAIM_PATH,
  AUTH_ROUTE_PREFIX,
  AUTH_SESSION_PATH,
  AUTH_SIGN_IN_PATH,
  CANCEL_PATH,
  CHAT_CANCEL_PATH,
  CHAT_TURN_PATH,
  HEALTH_PATH,
  IDENTITY_ROUTE_PREFIX,
  TURN_PATH
} from "@smthrs/rpc/AgentApiRoutes"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import { APP_API_VERSION, APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { AgentRuntimeContextSchema } from "@smthrs/rpc/AgentContext"
import { localCapabilities } from "@smthrs/rpc/HostCapabilities"
import {
  CLOUD_AUTH_SESSION_PATH,
  CLOUD_AUTH_SIGN_OUT_PATH,
  CLOUD_AUTH_START_PATH,
  CLOUD_LSP_FRAME_CAP_BYTES,
  CLOUD_ROUTE_PREFIX,
  CLOUD_TERMINAL_FRAME_CAP_BYTES,
  CLOUD_WS_NOT_READY_CLOSE_CODE,
  CLOUD_WS_PENDING_CLOSE_CODE,
  CLOUD_WS_ROUTE_PREFIX,
  LINEAR_AUTH_SESSION_PATH,
  LINEAR_AUTH_START_PATH,
  withRetryAfter
} from "@smthrs/rpc/LocalApp"
import type { CloudWsSessionKind } from "@smthrs/rpc/LocalApp"
import {
  isLocalSessionToken,
  localSessionProtocol,
  LOCAL_SESSION_HEADER,
  LOCAL_SESSION_META
} from "@smthrs/rpc/LocalSession"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { createChatStub } from "./ChatStub"
import { handleBrowserFetch } from "./BrowserFetch"
import { createCloudAgent } from "./CloudAgent"
import type { CloudAgent } from "./CloudAgent"
import { createCloudAuth } from "./CloudAuth"
import type { CloudAuth, CloudKeychain } from "./CloudAuth"
import { createLinearAuth } from "./LinearAuth"
import { detectHarnesses } from "./Harnesses"
import { findNode } from "./Node"
import type { NodeSidecar } from "./Node"
import { binDirOf, createPtyManager } from "./Pty"
import type { PtyManager } from "./Pty"
import { createRepositoryAuthority } from "./RepositoryAuthority"
import type { RepositoryAuthority } from "./RepositoryAuthority"
import { decodePath, invalidPath, json, jsonError, readJson, Router } from "./routes"
import type { RouteHandler } from "./routes"
import { registerAgentRoutes } from "./routes/agents"
import { registerRepoTargetRoutes } from "./routes/repoTargets"
import { registerTargetGraphRoutes } from "./routes/targetGraph"
import { registerHarnessRoutes } from "./routes/harnesses"
import type { HarnessDetector } from "./routes/harnesses"
import { registerLspRoutes } from "./routes/lsp"
import { registerPtyRoutes } from "./routes/pty"
import { createLspHost } from "./lsp/LspHost"
import type { LspHost, LspHostOptions } from "./lsp/LspHost"
import { currentSandboxHost, sandboxEnforced, type SandboxHost } from "./Sandbox"

/** chat.smithers.sh accepts this origin anonymously (verified 2026-08-26). */
export const DEFAULT_CHAT_ORIGIN = "https://canary.smithers.sh"
/** The deployed identity seam the sign-in device flow talks to. */
export const DEFAULT_IDENTITY_UPSTREAM = "https://canary.smithers.sh"
/** The Smithers Cloud API `/api/cloud/*` forwards to (SMITHERS_CLOUD_API overrides). */
export const DEFAULT_CLOUD_API = "https://api.jjhub.tech"
export const APP_VERSION = "0.0.1"
/** Where the SPA posts uncaught errors; the client half is state/ClientErrors.ts. */
export const CLIENT_ERRORS_PATH = "/api/client-errors"
/** Bytes on the wire, the unit the client bounds its report in. */
export const CLIENT_ERROR_MAX_BODY = 16 * 1024

/** Long conversations are replayed on every turn, so the cap is generous, not tight. */
const MAX_BODY_BYTES = 1024 * 1024
const MAX_WS_FRAME_BYTES = 128 * 1024
/*
 * What one renderer frame may carry per branch: `/ws` its own cap, a cloud
 * terminal bridge plue's 64 KiB, a cloud lsp bridge plue's 1 MiB (lane L6). The
 * server's own ceiling sits at twice the largest so every branch refuses an
 * over-cap frame with its own reason (a frame past the ceiling is Bun's to
 * drop, as an abnormal close).
 */
const MAX_CLOUD_WS_FRAME_BYTES: Readonly<Record<CloudWsSessionKind, number>> = {
  terminal: CLOUD_TERMINAL_FRAME_CAP_BYTES,
  lsp: CLOUD_LSP_FRAME_CAP_BYTES
}
const MAX_ANY_WS_FRAME_BYTES = 2 * Math.max(MAX_WS_FRAME_BYTES, ...Object.values(MAX_CLOUD_WS_FRAME_BYTES))
const MAX_WS_SUBSCRIPTIONS = 64
const MAX_WS_TOPIC_CHARS = 256
/** Frames a cloud-terminal tunnel queues before its upstream opens. */
const MAX_CLOUD_WS_PENDING = 256
/** Renderer→upstream bytes the tunnel may hold before it closes the renderer's socket. */
const MAX_CLOUD_WS_UPSTREAM_BUFFER = 1024 * 1024
/** Upstream→renderer bytes Bun may hold per socket; one lsp frame at its cap must fit with room to spare. */
const MAX_WS_BACKPRESSURE_BYTES = 4 * 1024 * 1024

export interface LocalServerOptions {
  /** 0 (the default) picks a free port. */
  readonly port?: number
  /** The built SPA: index.html plus assets/. */
  readonly distDir: string
  /** SMITHERS_CHAT_STUB=1: the deterministic stub instead of chat.smithers.sh. */
  readonly chatStub?: boolean
  /** Offline has no network egress; hybrid explicitly enables Smithers Cloud. */
  readonly cloudMode?: "offline" | "hybrid"
  readonly chat?: { readonly chatUrl?: string; readonly origin?: string }
  /**
   * Where `/api/auth/*` and `/api/identity/*` are forwarded so the sign-in
   * device flow reaches a real identity seam. `null` disables the proxy; the
   * stub mode never proxies.
   */
  readonly identityUpstream?: string | null
  /**
   * Where `/api/cloud/*` forwards (the Smithers Cloud API) and where the
   * `/api/cloud-auth/*` login points. `undefined` reads SMITHERS_CLOUD_API,
   * defaulting to DEFAULT_CLOUD_API; `null` disables the seam. Offline mode
   * disables it either way.
   */
  readonly cloudApi?: string | null
  /** Test/replay override for the Cloud sign-in manager; the default stores in the OS keychain. */
  readonly cloudAuth?: CloudAuth
  /** Test override for the keychain behind the default Cloud sign-in manager. */
  readonly cloudKeychain?: CloudKeychain
  readonly version?: string
  readonly buildSha?: string
  /** Headless/dev-only escape hatch. Native production accepts picker grants only. */
  readonly allowManualRepositoryPaths?: boolean
  /** A pre-resolved Node sidecar; the default probes once at startup. */
  readonly node?: NodeSidecar | null
  /**
   * Where the host remembers state across launches (open repositories). The
   * native launcher passes the platform's application-support directory; a
   * test passes a temp dir or nothing.
   */
  readonly stateDir?: string
  /** The smithers-build build-cli entry for the targets lane; the default resolves it from the checkout (or SMITHERS_BUILD_CLI). */
  readonly buildCli?: string
  /** The home directory used for PTYs without a repoId and reported by `/api/health`. */
  readonly home?: string
  /** The harness table behind `GET /api/harnesses` and harness tabs; default `detectHarnesses`. */
  readonly harnesses?: HarnessDetector
  /** The PTY manager behind `/api/pty*`; the default spawns real sessions. `roles` is the agents store (custom-agents.md). */
  /** The sandbox this host reports and wraps with; defaults to currentSandboxHost(). */
  readonly sandboxHost?: SandboxHost
  readonly pty?: (deps: {
    readonly publish: LocalServer["publish"]
    readonly harnesses: HarnessDetector
    readonly roles: () => Promise<ReadonlyArray<AgentRole>>
    readonly home: string
    readonly pathPrepend: () => Promise<ReadonlyArray<string>>
    readonly log: (line: string) => void
  }) => PtyManager
  /** The language-server host behind `/api/lsp/*`; the default spawns real servers (lsp/LspHost.ts). */
  readonly lsp?: (deps: Pick<LspHostOptions, "publish" | "node" | "home" | "sandbox" | "log">) => LspHost
  readonly log?: (line: string) => void
  /** Test/replay override; production generates 256 fresh random bits. */
  readonly sessionToken?: string
}

export interface WsSocketData {
  readonly topics: Set<string>
  /**
   * Lane citc: a `/api/cloud-ws/` tunnel's bridge to the cloud terminal
   * WebSocket. Undefined on a plain `/ws` socket. Frames the renderer sends
   * before the upstream opens queue in `pending` (bounded) and flush on open.
   */
  readonly cloud?: CloudWsBridge
}

export interface CloudWsBridge {
  /** Which plue socket this bridges: the terminal (binary PTY bytes) or the language-server relay (JSON-RPC text frames, lane L6). */
  readonly kind: CloudWsSessionKind
  readonly target: string
  readonly token: string | undefined
  upstream: WebSocket | undefined
  readonly pending: Array<string | Buffer>
  /** True once the upstream handshake completed; a close before it is a refusal the tunnel classifies. */
  opened: boolean
}

/*
 * plue's pre-upgrade refusals as the close codes the renderer sees (ADR 0002
 * "Terminal attach contract"): the renderer stops redialing on every one of
 * them. For the terminal, 425 is plue's "session still provisioning", the
 * same fact as 409. The lsp branch (lane L6, plue #505) keeps 425
 * `workspace_session_pending` and 503 `guest_not_ready` apart from 409: both
 * carry a `Retry-After`, and the renderer's client retries them on the
 * server's clock while it shows the server's words.
 */
const CLOUD_WS_REFUSAL_CODES: Readonly<Record<CloudWsSessionKind, Readonly<Record<number, number>>>> = {
  terminal: {
    401: 4401,
    403: 4403,
    404: 4404,
    409: 4409,
    425: 4409,
    429: 4429
  },
  lsp: {
    401: 4401,
    403: 4403,
    404: 4404,
    409: 4409,
    425: CLOUD_WS_PENDING_CLOSE_CODE,
    429: 4429,
    503: CLOUD_WS_NOT_READY_CLOSE_CODE
  }
}

const CLOUD_WS_REFUSAL_REASONS: Readonly<Record<number, string>> = {
  4401: "cloud sign-in required",
  4403: "forbidden",
  4404: "session gone",
  4409: "session not running",
  [CLOUD_WS_PENDING_CLOSE_CODE]: "session pending",
  4429: "rate limited",
  [CLOUD_WS_NOT_READY_CLOSE_CODE]: "guest not ready"
}

/** A WebSocket close reason is at most 123 UTF-8 bytes; anything longer is refused by the socket, so it is cut here. */
const closeReasonOf = (text: string): string => {
  const encoder = new TextEncoder()
  let reason = text.replace(/\s+/g, " ").trim()
  while (encoder.encode(reason).byteLength > 123) reason = reason.slice(0, -1)
  return reason
}

/** The headers the tunnel dials the cloud socket with: the bearer, and an Origin only where an environment still enforces one. */
const cloudWsUpstreamHeaders = (token: string | undefined): Record<string, string> => {
  const headers: Record<string, string> = {}
  // plue#475: the terminal upgrade skips the Origin check for Bearer principals, so a desktop app sends none — SMITHERS_CLOUD_WS_ORIGIN is the knob for an environment that still enforces it.
  const origin = Bun.env.SMITHERS_CLOUD_WS_ORIGIN
  if (origin !== undefined && origin !== "") headers["origin"] = origin
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`
  return headers
}

/*
 * Bun's WebSocket client hides the HTTP status of a refused upgrade: every
 * non-101 answer closes 1002 "Expected 101 status code" (verified on Bun
 * 1.4.0), so the refusal is re-read with one plain GET of the same route,
 * same bearer, same Origin policy. plue runs every pre-upgrade check (auth,
 * scope, repo permission, the open-rate limit, the session lookup and its
 * state) before it ever upgrades, so the GET answers the status the
 * handshake got. An answer this table does not know stays 1011, the code
 * the renderer retries once.
 *
 * On the lsp branch the reason carries plue's machine-readable `code` before
 * its message (`language_server_missing: npm i -g …`, the install line
 * verbatim) — three different 409s reach the renderer as one close code, and
 * the code is what tells them apart — and the `Retry-After` a 425 or 503
 * named, in words at the end, so the renderer retries on the server's clock.
 */
const classifyCloudWsRefusal = async (
  bridge: CloudWsBridge,
  fetchImpl: typeof fetch
): Promise<{ readonly code: number; readonly reason: string }> => {
  const url = new URL(bridge.target)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  let response: Response
  try {
    response = await fetchImpl(url, { headers: cloudWsUpstreamHeaders(bridge.token), redirect: "manual" })
  } catch {
    return { code: 1011, reason: `cloud ${bridge.kind} upstream failed` }
  }
  const code = CLOUD_WS_REFUSAL_CODES[bridge.kind][response.status]
  let message: string | undefined
  let plueCode: string | undefined
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown; code?: unknown }
    if (typeof body.message === "string" && body.message !== "") message = body.message
    else if (typeof body.error === "string" && body.error !== "") message = body.error
    else if (typeof body.error === "object" && body.error !== null && typeof (body.error as { message?: unknown }).message === "string") {
      message = (body.error as { message: string }).message
    }
    if (typeof body.code === "string" && body.code !== "") plueCode = body.code
  } catch {
    // A body that is not JSON is plumbing, never copy.
  }
  if (code === undefined) return { code: 1011, reason: closeReasonOf(`cloud ${bridge.kind} upstream answered ${response.status}`) }
  let reason = message ?? CLOUD_WS_REFUSAL_REASONS[code] ?? "refused"
  if (bridge.kind === "lsp") {
    if (plueCode !== undefined && !reason.startsWith(`${plueCode}:`)) reason = `${plueCode}: ${reason}`
    const retryAfter = Number(response.headers.get("retry-after")?.trim())
    if (Number.isInteger(retryAfter) && retryAfter >= 0) reason = withRetryAfter(reason, retryAfter)
  }
  return { code, reason: closeReasonOf(reason) }
}

export type WsSocket = ServerWebSocket<WsSocketData>

/*
 * Close codes a Bun server cannot put on the wire. 1005 and 1006 are
 * unsendable by the protocol, but Bun also rewrites 1001 "going away" to
 * 1000 — verified on Bun 1.3.14 and 1.4.0, Linux and macOS alike. 1000 is
 * exactly the renderer's "session closed, never redial"
 * (mainview/state/CloudTerminalClient.ts), so a bridge that closed 1001
 * silently told every terminal to give up instead of to reconnect.
 */
const UNSENDABLE_CLOSE_CODES: ReadonlySet<number> = new Set([1001, 1005, 1006])

/** Ends a renderer's socket so the code it reads carries the meaning the caller sent. */
const closeRenderer = (socket: WsSocket, code: number, reason: string): void => {
  // An abnormal close is what the renderer reconnects on, so a going-away drop arrives as one.
  if (UNSENDABLE_CLOSE_CODES.has(code)) socket.terminate()
  else socket.close(code, closeReasonOf(reason))
}

/** A client frame other than subscribe/unsubscribe, dispatched by its `type`. */
export type WsMessageHandler = (message: Readonly<Record<string, unknown>>, socket: WsSocket) => void

export interface LocalServer {
  readonly origin: string
  readonly port: number
  readonly sessionToken: string
  readonly websocketProtocol: string
  readonly router: Router
  readonly server: Server<WsSocketData>
  /** Sends one JSON frame to every socket subscribed to the topic. */
  readonly publish: (topic: string, message: unknown) => void
  /** Registers the handler for one client frame type (e.g. "pty.input"). Returns the unregister. */
  readonly onMessage: (type: string, handler: WsMessageHandler) => () => void
  /** Native-only door: inspect a picked path and mint a one-shot HTTP grant. */
  readonly authorizeRepository: RepositoryAuthority["authorize"]
  readonly stop: () => Promise<void>
}

/**
 * The SPA directory for a caller in `fromDir`. SMITHERS_DIST_DIR wins; a
 * packaged app finds the copied views next to its main bundle; a source
 * checkout falls back to apps/ui/dist.
 */
export const defaultDistDir = (fromDir: string, env: Readonly<Record<string, string | undefined>> = Bun.env): string => {
  const explicit = env.SMITHERS_DIST_DIR?.trim()
  if (explicit !== undefined && explicit !== "") return resolve(explicit)
  const candidates = [
    resolve(fromDir, "..", "views", "mainview"),
    resolve(fromDir, "..", "..", "dist")
  ]
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? candidates[candidates.length - 1]!
}

const isStartTurnRequest = (value: unknown): value is StartAgentTurnRequest =>
  typeof value === "object" &&
  value !== null &&
  "runId" in value &&
  typeof value.runId === "string" &&
  value.runId !== "" &&
  "messages" in value &&
  Array.isArray(value.messages) &&
  "instructions" in value &&
  typeof value.instructions === "string" &&
  (!("tools" in value) || value.tools === undefined || Array.isArray(value.tools)) &&
  (!("context" in value) ||
    value.context === undefined ||
    AgentRuntimeContextSchema.safeParse(value.context).success)

/** A live turn's open NDJSON response. `end` is idempotent so a disconnect, a cancel and a `done` can race. */
interface TurnWriter {
  readonly write: (frame: AgentTurnFrame) => void
  readonly end: () => void
}

const encoder = new TextEncoder()

/*
 * The product-API families the local origin forwards to the Worker (the
 * identity upstream), mirroring apps/server's PLATFORM_PROXY_RULES plus the
 * Worker's own billing and admin seams. Local routes match first; `/api/cloud/*`
 * is the bearer proxy straight to plue and never forwards here.
 */
const PRODUCT_PROXY_PREFIXES: ReadonlyArray<string> = [
  /* Flows and runs: provision + RPC live on the Worker (web-mode plan R6); the local origin forwarded neither. */
  "/api/workflow/",
  /* Linear: the integrations list and the per-integration sync/ops routes (lane L5); neither hop forwarded them. */
  "/api/integrations/",
  "/api/linear",
  "/api/repos/",
  "/api/github/",
  "/api/user/",
  "/api/notifications/",
  "/api/billing/",
  "/api/admin/"
]

/** The stub's stand-in for the identity seam: signed out, nothing else configured. */
/*
 * The request trail names paths, never secrets: the Linear setup lookup
 * carries its one-time setup key in the path (`/api/cloud/api/linear/setup/
 * <key>`), so the key is elided before the line is written (sync review
 * finding 8 — the cloud token never reaches a trail line; neither may this).
 */
export const trailPath = (pathname: string): string => pathname.replace(/(\/linear\/setup\/)[^/?#]+/, "$1<setup-key>")

const stubIdentity = (pathname: string): Response =>
  pathname === AUTH_SESSION_PATH
    ? json({ status: "signed-out" })
    : jsonError(501, "not_implemented", "The identity seam is stubbed in this build.")

/*
 * Re-scope an upstream Set-Cookie to this origin. The identity seam serves
 * https, so its session cookie arrives `Domain=<seam>; Secure`. This origin is
 * plain http on loopback: `Domain` would keep the cookie off it, and WebKit
 * (the native renderer) refuses a `Secure` cookie set over http://127.0.0.1
 * or http://localhost, where Chromium accepts one. That difference is why the
 * headless T1 tier signed in while the native app answered "the sign-in
 * cookie never reached it". Both attributes go; the rest travel unchanged.
 */
export const rescopeCookie = (cookie: string): string =>
  cookie.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure(?=\s*(?:;|$))/gi, "")

/** A Set-Cookie for the trail: its name and attributes, never its value. */
export const describeCookie = (cookie: string): string => {
  const [pair = "", ...attributes] = cookie.split(";")
  const name = pair.split("=")[0]?.trim() ?? ""
  return [`${name}=<redacted>`, ...attributes.map((attribute) => attribute.trim())]
    .filter((part) => part !== "")
    .join("; ")
}

/**
 * Forwards an identity request to the deployed seam. The upstream refuses
 * cross-origin writes, so the Origin header follows the upstream (the same
 * rewrite the old Vite dev proxy did), and a session cookie it sets is
 * re-scoped to this origin (rescopeCookie).
 */
const proxyIdentity = async (
  request: Request,
  url: URL,
  upstream: string,
  log?: (line: string) => void
): Promise<Response> => {
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  headers.set("host", target.host)
  headers.set("origin", new URL(upstream).origin)
  headers.delete("content-length")
  // The per-launch local capability authorizes THIS origin; the seam has no use for it.
  headers.delete(LOCAL_SESSION_HEADER)
  let response: Response
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual"
    })
  } catch (error) {
    return jsonError(502, "identity_unreachable", error instanceof Error ? error.message : "identity upstream unreachable")
  }
  const out = new Headers(response.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) {
    out.delete("set-cookie")
    for (const cookie of cookies) out.append("set-cookie", rescopeCookie(cookie))
  }
  /*
   * The native handoff's session travels ONLY as the claim's Set-Cookie. A
   * ready claim without one is the exact failure the app cannot see from
   * JavaScript, so the trail states it here, where the header is visible,
   * with the attributes the WebView was handed (never the value): an
   * attribute the WebView refuses is the same invisible failure.
   */
  if (url.pathname === AUTH_NATIVE_CLAIM_PATH && log !== undefined) {
    const shape = cookies.map((cookie) => describeCookie(rescopeCookie(cookie))).join(" | ")
    log(`${AUTH_NATIVE_CLAIM_PATH} -> ${response.status}, set-cookie ${cookies.length > 0 ? `present: ${shape}` : "absent"}`)
  }
  return new Response(response.body, { status: response.status, headers: out })
}

/**
 * Forwards a Smithers Cloud request (`/api/cloud/*`) to the cloud API, following
 * proxyIdentity: Host and Origin follow the upstream, `content-length` and
 * the local session header are dropped, Set-Cookie is re-scoped, and the
 * request leaves one trail line (the shared `/api/*` trail). The bearer is
 * attached HERE, from the Bun-held credential — a renderer-supplied
 * Authorization header is deleted, because the token never reaches the
 * renderer (ADR 0001).
 */
const proxyCloud = async (
  request: Request,
  url: URL,
  upstream: string,
  token: string | undefined
): Promise<Response> => {
  /*
   * The path after the prefix is joined as a plain path, never as a URL:
   * `/api/cloud//evil.example/x` sliced naively is scheme-relative and the
   * WHATWG parser would send the bearer to evil.example. A leading slash
   * (or an empty rest) is refused, and the constructed origin must be the
   * upstream's, or the request never leaves this process.
   */
  const upstreamOrigin = new URL(upstream).origin
  const rest = url.pathname.slice(CLOUD_ROUTE_PREFIX.length)
  if (rest === "" || rest.startsWith("/") || rest.includes("\\")) {
    return jsonError(400, "invalid_cloud_path", "A cloud path is /api/cloud/<path> with a non-empty, single-slash path.")
  }
  const target = new URL(`/${rest}${url.search}`, upstreamOrigin)
  if (target.origin !== upstreamOrigin) {
    return jsonError(400, "invalid_cloud_path", "The cloud path resolved outside the cloud API origin.")
  }
  const headers = new Headers(request.headers)
  headers.set("host", target.host)
  headers.set("origin", upstreamOrigin)
  headers.delete("content-length")
  headers.delete(LOCAL_SESSION_HEADER)
  headers.delete("authorization")
  // The identity seam's session cookie is re-scoped onto this origin, so the
  // WebView attaches it to every same-origin call; it is not the cloud API's.
  headers.delete("cookie")
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`)
  let response: Response
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual"
    })
  } catch (error) {
    return jsonError(502, "cloud_unreachable", error instanceof Error ? error.message : "cloud upstream unreachable")
  }
  const out = new Headers(response.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) {
    out.delete("set-cookie")
    for (const cookie of cookies) out.append("set-cookie", rescopeCookie(cookie))
  }
  return new Response(response.body, { status: response.status, headers: out })
}

export const startLocalServer = async (options: LocalServerOptions): Promise<LocalServer> => {
  const log = options.log ?? ((line: string) => console.log(line))
  const distDir = resolve(options.distDir)
  const version = options.version ?? APP_VERSION
  const sandboxHost = options.sandboxHost ?? currentSandboxHost()
  const nodeProbe: Promise<NodeSidecar | null> = options.node === undefined ? findNode() : Promise.resolve(options.node)
  const remoteEnabled = options.cloudMode === "hybrid"
  const identityUpstream = options.chatStub === true || !remoteEnabled
    ? null
    : options.identityUpstream === undefined
    ? DEFAULT_IDENTITY_UPSTREAM
    : options.identityUpstream
  /*
   * The Smithers Cloud seam (lane piper): offline performs no egress, so the
   * proxy and the login answer 501 like the identity stub. Hybrid forwards
   * to SMITHERS_CLOUD_API (default DEFAULT_CLOUD_API).
   */
  const cloudUpstream = !remoteEnabled
    ? null
    : options.cloudApi === undefined
    ? Bun.env.SMITHERS_CLOUD_API ?? DEFAULT_CLOUD_API
    : options.cloudApi
  const cloudAuth: CloudAuth | undefined = cloudUpstream === null
    ? undefined
    : options.cloudAuth ?? await createCloudAuth({
      api: cloudUpstream,
      envToken: Bun.env.SMITHERS_CLOUD_TOKEN,
      ...(options.cloudKeychain === undefined ? {} : { keychain: options.cloudKeychain }),
      log
    })
  const home = options.home ?? homedir()
  const harnesses: HarnessDetector = options.harnesses ?? (() => detectHarnesses())
  const sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url")
  if (!isLocalSessionToken(sessionToken)) throw new Error("Local server session token must be 256-bit base64url.")
  const websocketProtocol = localSessionProtocol(sessionToken)
  const repositoryAuthority = createRepositoryAuthority()

  const writers = new Map<string, TurnWriter>()
  const publishFrame = (frame: AgentTurnFrame): void => writers.get(frame.runId)?.write(frame)
  const agent: CloudAgent | undefined = options.chatStub === true
    ? createChatStub(publishFrame)
    : remoteEnabled
    ? createCloudAgent(publishFrame, {
      chatUrl: options.chat?.chatUrl ?? Bun.env.SMITHERS_CHAT_URL,
      origin: options.chat?.origin ?? Bun.env.SMITHERS_CHAT_ORIGIN ?? DEFAULT_CHAT_ORIGIN
    })
    : undefined
  const finish = (runId: string, writer: TurnWriter): void => {
    if (writers.get(runId) === writer) writers.delete(runId)
    writer.end()
  }

  const router = new Router()
  router.add("POST", "/api/tools/browser-fetch", ({ request }) => remoteEnabled
    ? handleBrowserFetch(request)
    : jsonError(501, "not_implemented", "The browser reader is disabled in offline mode."))

  router.add("GET", APP_BOOTSTRAP_PATH, () => {
    const enforced = sandboxEnforced(sandboxHost)
    return json({
      apiVersion: APP_API_VERSION,
      host: "local",
      version,
      buildSha: options.buildSha ?? Bun.env.SMITHERS_BUILD_SHA ?? "unknown",
      // The shared table the Worker and the parity matrix read; both cloud
      // doors (`cloud.terminal`, `cloud.pat`) ride the Smithers Cloud upstream.
      capabilities: localCapabilities({
        agent: agent !== undefined,
        identity: identityUpstream !== null,
        cloud: cloudUpstream !== null,
        browser: remoteEnabled,
        pathEntry: options.allowManualRepositoryPaths === true
      }),
      authFlow: identityUpstream === null ? "none" : "both",
      sandbox: {
        platform: process.platform,
        mode: enforced ? "enforced" : sandboxHost.disabled ? "unavailable" : "trusted-only",
        // The loader profile exists only where seatbelt does; a target run is never wrapped.
        policies: { loader: enforced ? "enforced" : "unenforced", targetRun: "unenforced" }
      }
    })
  })

  router.add("GET", HEALTH_PATH, async () =>
    json({
      ok: true,
      version,
      pid: process.pid,
      home,
      node: await nodeProbe,
      sandbox: { platform: process.platform, enforced: sandboxEnforced(sandboxHost) }
    }))

  const handleChatTurn: RouteHandler = async ({ request }) => {
    if (agent === undefined) return jsonError(503, "agent_unavailable", "No agent provider is configured in local-only mode.")
    // Bounded by bytes received, not by a declared length: a chunked turn
    // carries no Content-Length and would otherwise be read whole.
    const parsed = await readJson(request, MAX_BODY_BYTES)
    if ("error" in parsed) return parsed.error
    if (!isStartTurnRequest(parsed.body)) {
      return jsonError(400, "invalid_request", "Body must be { runId, messages, instructions } with optional tools and context.")
    }
    const body = parsed.body
    const runId = body.runId
    if (writers.has(runId)) return jsonError(409, "turn_running", "That Smithers turn is already running.")
    // The writer exists before the agent starts, so a frame published before
    // the response stream opens is queued, never lost.
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const queue: Array<Uint8Array> = []
    let ended = false
    const writer: TurnWriter = {
      write: (frame) => {
        if (ended) return
        const chunk = encoder.encode(`${JSON.stringify(frame)}\n`)
        if (controller === undefined) queue.push(chunk)
        else controller.enqueue(chunk)
        if (frame.type === "done") finish(runId, writer)
      },
      end: () => {
        if (ended) return
        ended = true
        try {
          controller?.close()
        } catch {
          // Already closed by the client.
        }
      }
    }
    writers.set(runId, writer)
    const started = agent.start(body)
    if (started.status === "error") {
      writers.delete(runId)
      return jsonError(409, "turn_running", started.message)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        for (const chunk of queue) streamController.enqueue(chunk)
        queue.length = 0
        if (ended) {
          try {
            streamController.close()
          } catch {
            // Nothing to close twice.
          }
        }
      },
      cancel() {
        // Only this response's own writer may cancel: a later turn reusing
        // the runId must survive this one's teardown.
        if (writers.get(runId) !== writer) return
        writers.delete(runId)
        ended = true
        agent.cancel(runId)
      }
    })
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
    })
  }
  router.add("POST", TURN_PATH, handleChatTurn)
  router.add("POST", CHAT_TURN_PATH, handleChatTurn)

  const handleChatCancel: RouteHandler = async ({ request }) => {
    if (agent === undefined) return jsonError(503, "agent_unavailable", "No agent provider is configured in local-only mode.")
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const runId = typeof parsed.body === "object" && parsed.body !== null && "runId" in parsed.body ? parsed.body.runId : undefined
    if (typeof runId !== "string" || runId === "") return jsonError(400, "invalid_request", "runId is required.")
    const result = agent.cancel(runId)
    // Cancelling aborts upstream without a frame, so the stream closes here
    // or the SPA would keep reading a response that can never complete.
    const writer = writers.get(runId)
    if (writer !== undefined) finish(runId, writer)
    return json({ ok: true, status: result.status })
  }
  router.add("POST", CANCEL_PATH, handleChatCancel)
  router.add("POST", CHAT_CANCEL_PATH, handleChatCancel)

  /*
   * The Smithers Cloud login (lane piper, ADR 0001): start answers the URL the
   * renderer opens in the system browser; the session answer never carries
   * the token; sign-out forgets it. Offline answers 501 like the identity
   * stub.
   */
  router.add("POST", CLOUD_AUTH_START_PATH, async () => {
    if (cloudAuth === undefined) return jsonError(501, "not_implemented", "The cloud seam is disabled in this build.")
    const started = await cloudAuth.start()
    return "error" in started ? jsonError(409, "cloud_auth_unavailable", started.error) : json(started)
  })
  router.add("GET", CLOUD_AUTH_SESSION_PATH, () =>
    cloudAuth === undefined
      ? json({ state: "signed-out", username: null, expiresAt: null })
      : json(cloudAuth.session()))
  /*
   * Lane citc: every live workspace-terminal bridge, so sign-out (and
   * shutdown) can end them — the bearer was read at upgrade, and a bridge
   * would otherwise outlive the credential it was opened with.
   */
  const cloudBridges = new Set<WsSocket>()
  const closeCloudBridges = (code: number, reason: string): void => {
    for (const socket of [...cloudBridges]) {
      cloudBridges.delete(socket)
      try {
        closeRenderer(socket, code, reason)
      } catch {
        // Already gone; its close handler released the upstream.
      }
    }
  }
  router.add("POST", CLOUD_AUTH_SIGN_OUT_PATH, async () => {
    if (cloudAuth === undefined) return jsonError(501, "not_implemented", "The cloud seam is disabled in this build.")
    await cloudAuth.signOut()
    closeCloudBridges(4401, "signed out of Smithers Cloud")
    return json({ ok: true })
  })

  /*
   * The Linear OAuth handoff (lane sync, ADR 0005): start listens for the
   * setup-key callback and answers the OAuth start URL through the cloud
   * proxy; the session answer carries the key only once authorized. The
   * handoff needs the cloud seam (its URL rides the proxy), so offline
   * answers 501 like the cloud login.
   */
  const linearAuth = cloudUpstream === null
    ? undefined
    : createLinearAuth({ origin: () => `http://127.0.0.1:${server.port}`, log })
  router.add("POST", LINEAR_AUTH_START_PATH, async () => {
    if (linearAuth === undefined) return jsonError(501, "not_implemented", "The cloud seam is disabled in this build.")
    const started = await linearAuth.start()
    return "error" in started ? jsonError(409, "linear_auth_unavailable", started.error) : json(started)
  })
  router.add("GET", LINEAR_AUTH_SESSION_PATH, () =>
    linearAuth === undefined
      ? json({ state: "idle" })
      : json(linearAuth.session()))

  // The runtime error ingest the SPA posts to (state/ClientErrors.ts holds
  // the client half of this contract): logged, never persisted.
  router.add("POST", CLIENT_ERRORS_PATH, async ({ request }) => {
    const body = new Uint8Array(await request.arrayBuffer())
    if (body.byteLength > CLIENT_ERROR_MAX_BODY) {
      return jsonError(413, "body_too_large", `Client error reports are capped at ${CLIENT_ERROR_MAX_BODY} bytes.`)
    }
    log(`client-error: ${new TextDecoder().decode(body)}`)
    return json({ status: "accepted" }, 202)
  })

  const messageHandlers = new Map<string, Set<WsMessageHandler>>()
  const onMessage: LocalServer["onMessage"] = (type, handler) => {
    const set = messageHandlers.get(type) ?? new Set<WsMessageHandler>()
    set.add(handler)
    messageHandlers.set(type, set)
    return () => {
      set.delete(handler)
    }
  }

  const serveStatic = async (pathname: string): Promise<Response> => {
    const index = join(distDir, "index.html")
    const decoded = decodePath(pathname)
    if (decoded === undefined) return invalidPath()
    const relative = normalize(decoded).replace(/^\/+/, "")
    const candidate = resolve(distDir, relative)
    // Only a regular file is a body: `Bun.file(<directory>)` throws EISDIR,
    // and a dotted directory name passes the `relative.includes(".")` test.
    if (relative !== "" && candidate.startsWith(distDir + "/") && statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) {
      const file = Bun.file(candidate)
      if ((await file.exists()) && file.size > 0 || relative.includes(".")) {
        return new Response(file, {
          headers: relative.startsWith("assets/")
            ? { "cache-control": "public, max-age=31536000, immutable" }
            : { "cache-control": "no-store" }
        })
      }
    }
    if (!existsSync(index)) {
      return jsonError(503, "spa_missing", `No built SPA at ${distDir}. Run \`vite build\` first.`)
    }
    // SPA fallback: every route the page owns renders index.html. Only this
    // response receives the per-launch capability; static assets never do.
    const html = await Bun.file(index).text()
    const sessionMeta = `<meta name="${LOCAL_SESSION_META}" content="${sessionToken}">`
    const injected = /<head(?:\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${sessionMeta}`)
      : `${sessionMeta}${html}`
    return new Response(injected, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    })
  }

  /* Filled immediately after Bun chooses the port, before callers can reach it. */
  let origin = ""
  let expectedHost = ""
  const handle = async (request: Request, bunServer: Server<WsSocketData>): Promise<Response | undefined> => {
    const url = new URL(request.url)
    const { pathname } = url
    if (request.headers.get("host") !== expectedHost) {
      return jsonError(421, "invalid_host", "This local server accepts only its loopback origin.")
    }
    if (pathname === "/ws") {
      const requestOrigin = request.headers.get("origin")
      if (requestOrigin !== null && requestOrigin !== origin) {
        return jsonError(403, "invalid_origin", "WebSocket origin does not match the local app.")
      }
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim())
      if (!protocols.includes(websocketProtocol)) {
        return jsonError(401, "local_session_required", "The local session capability is required.")
      }
      const upgraded = bunServer.upgrade(request, {
        data: { topics: new Set<string>() },
        headers: { "sec-websocket-protocol": websocketProtocol }
      })
      return upgraded ? undefined : jsonError(400, "upgrade_failed", "Expected a WebSocket upgrade.")
    }
    if (pathname.startsWith(CLOUD_WS_ROUTE_PREFIX)) {
      /*
       * Lane citc: the workspace-terminal tunnel; lane L6: the workspace
       * language-server tunnel beside it. Same authorization shape as /ws —
       * origin and the local-session subprotocol — because a browser upgrade
       * carries no custom headers. The path mirrors the cloud API's two
       * socket routes exactly (`repos/{o}/{r}/workspace/sessions/{id}/
       * terminal` and `…/lsp`, nothing else), and the bearer attaches HERE
       * from the Bun-held credential, never from the renderer.
       */
      const requestOrigin = request.headers.get("origin")
      if (requestOrigin !== null && requestOrigin !== origin) {
        return jsonError(403, "invalid_origin", "WebSocket origin does not match the local app.")
      }
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim())
      if (!protocols.includes(websocketProtocol)) {
        return jsonError(401, "local_session_required", "The local session capability is required.")
      }
      if (cloudUpstream === null) {
        return jsonError(501, "not_implemented", "The cloud seam is disabled in this build.")
      }
      const rest = pathname.slice(CLOUD_WS_ROUTE_PREFIX.length)
      // `[^/]+` admits `.` and `..`; a segment-wise check keeps the joined target under /api/repos/ (WHATWG normalizes dot segments).
      const segments = rest.split("/")
      const branch = /^repos\/[^/]+\/[^/]+\/workspace\/sessions\/[^/]+\/(terminal|lsp)$/.exec(rest)
      if (
        branch === null ||
        segments.some((segment) => segment === "." || segment === ".." || segment.includes("%2F") || segment.includes("%2f") || segment.includes("\\"))
      ) {
        return jsonError(404, "not_found", "The cloud WebSocket tunnel serves only workspace terminal and lsp sessions.")
      }
      const kind: CloudWsSessionKind = branch[1] === "lsp" ? "lsp" : "terminal"
      const upstreamWs = cloudUpstream.startsWith("https:")
        ? `wss:${cloudUpstream.slice("https:".length)}`
        : `ws:${cloudUpstream.slice("http:".length)}`
      const tunnelTarget = new URL(`/api/${rest}${url.search}`, upstreamWs)
      if (tunnelTarget.origin !== new URL(upstreamWs).origin || !tunnelTarget.pathname.startsWith("/api/repos/")) {
        return jsonError(404, "not_found", "The cloud WebSocket tunnel serves only workspace terminal and lsp sessions.")
      }
      // Signed out, the tunnel never dials plue: an anonymous attach would only be refused there.
      const token = cloudAuth?.token()
      if (token === undefined) {
        return jsonError(401, "cloud_sign_in_required", "Sign in to Smithers Cloud first — /cloud.sign-in.")
      }
      const upgraded = bunServer.upgrade(request, {
        data: {
          topics: new Set<string>(),
          cloud: {
            kind,
            target: tunnelTarget.toString(),
            token,
            upstream: undefined,
            pending: [],
            opened: false
          }
        },
        headers: { "sec-websocket-protocol": websocketProtocol }
      })
      return upgraded ? undefined : jsonError(400, "upgrade_failed", "Expected a WebSocket upgrade.")
    }
    if (pathname.startsWith("/api/")) {
      /*
       * Health remains public for process-supervisor readiness probes. The
       * two OAuth legs are top-level NAVIGATIONS (window.location or the
       * system browser opened by the native handoff) and a navigation can
       * carry no custom header, so gating them on the session header made
       * every GitHub sign-in from this origin answer 401 before the
       * identity seam ever saw it. They carry no local privilege — the
       * proxy forwards them to the identity upstream and back.
       */
      const oauthNavigation = request.method === "GET" &&
        (pathname === AUTH_SIGN_IN_PATH || pathname === AUTH_CALLBACK_PATH)
      const linearNavigation = request.method === "GET" && linearAuth?.claimNavigation(url) === true
      if (linearNavigation) url.searchParams.delete("handoff")
      if (pathname !== HEALTH_PATH && !oauthNavigation && !linearNavigation) {
        if (request.headers.get(LOCAL_SESSION_HEADER) !== sessionToken) {
          return jsonError(401, "local_session_required", "The local session capability is required.")
        }
        const requestOrigin = request.headers.get("origin")
        if (requestOrigin !== null && requestOrigin !== origin) {
          return jsonError(403, "invalid_origin", "Request origin does not match the local app.")
        }
      }
      const matched = router.match(request.method, pathname)
      if (matched !== undefined) {
        try {
          return await matched.handler({ request, url, params: matched.params })
        } catch (error) {
          log(`${request.method} ${pathname} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
          return jsonError(500, "internal", error instanceof Error ? error.message : "Request failed.")
        }
      }
      if (router.knows(pathname)) return jsonError(405, "method_not_allowed", `${request.method} is not allowed on ${pathname}.`)
      if (pathname.startsWith(CLOUD_ROUTE_PREFIX)) {
        return cloudUpstream === null
          ? jsonError(501, "not_implemented", "The cloud seam is disabled in this build.")
          : proxyCloud(request, url, cloudUpstream, cloudAuth?.token())
      }
      if (pathname.startsWith(AUTH_ROUTE_PREFIX) || pathname.startsWith(IDENTITY_ROUTE_PREFIX)) {
        return identityUpstream === null ? stubIdentity(pathname) : proxyIdentity(request, url, identityUpstream, log)
      }
      /*
       * The product API. The cloud client is served BY the Worker, so every
       * repo, issue, landing, file, notification, and billing seam calls
       * `/api/…` on its own origin and the Worker bridges the GitHub session
       * to a Smithers Cloud token per login (apps/server PLATFORM_PROXY_RULES).
       * This local origin is that client's stand-in: the same families
       * forward to the same Worker with the same re-scoped session cookie,
       * or every one of those seams answers a local 404 in 0 ms — which is
       * exactly what "Listing issues for smithersai/smithers failed (404)"
       * was on 2026-09-02. An allowlist, mirroring the Worker's, never a
       * wildcard.
       */
      if (PRODUCT_PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        return identityUpstream === null
          ? jsonError(501, "not_implemented", "Smithers Cloud is not reachable from this build (offline mode).")
          : proxyIdentity(request, url, identityUpstream, log)
      }
      return jsonError(404, "not_found", `No route for ${request.method} ${pathname}.`)
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError(405, "method_not_allowed", `${request.method} is not allowed on ${pathname}.`)
    }
    return serveStatic(pathname)
  }
  const server = Bun.serve<WsSocketData>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 255,
    /*
     * Every "/" and "/api/*" request leaves one trail line with its status
     * and duration, written after the handler answers. A sign-in that fails
     * silently inside the WebView is visible here as the sequence of answers
     * the page got; a WebSocket upgrade answers nothing and leaves no line.
     */
    fetch: async (request, bunServer) => {
      const started = performance.now()
      const { pathname } = new URL(request.url)
      /*
       * The line is written in `finally`, and a throw past `handle` answers
       * the error envelope routes.ts promises: a request that fails outside
       * a matched handler still leaves its trail line instead of Bun's
       * default HTML 500 and silence.
       */
      let answered: Response | undefined
      try {
        answered = await handle(request, bunServer)
        return answered
      } catch (error) {
        log(`${request.method} ${trailPath(pathname)} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        answered = jsonError(500, "internal", error instanceof Error ? error.message : "Request failed.")
        return answered
      } finally {
        if (answered !== undefined && (pathname === "/" || pathname.startsWith("/api/"))) {
          log(`${request.method} ${trailPath(pathname)} -> ${answered.status} in ${Math.round(performance.now() - started)}ms`)
        }
      }
    },
    websocket: {
      maxPayloadLength: MAX_ANY_WS_FRAME_BYTES,
      backpressureLimit: MAX_WS_BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: true,
      open: (socket) => {
        const bridge = socket.data.cloud
        if (bridge === undefined) return
        /*
         * Lane citc: connect the cloud socket. plue requires its own
         * subprotocol at upgrade — `terminal` for the PTY, `lsp` for the
         * language-server relay (lane L6) — and the branch IS the kind; Bun's
         * client carries it (and the bearer) as headers. Frames that arrived
         * first flush on open.
         */
        cloudBridges.add(socket)
        const headers: Record<string, string> = { "sec-websocket-protocol": bridge.kind, ...cloudWsUpstreamHeaders(bridge.token) }
        const upstream = new WebSocket(bridge.target, { headers } as never)
        bridge.upstream = upstream
        upstream.binaryType = "arraybuffer"
        const end = (code: number, reason: string): void => {
          cloudBridges.delete(socket)
          try {
            // 1001/1005/1006 cannot be relayed as a code; the renderer learns of an abnormal drop by getting one.
            closeRenderer(socket, code, reason)
          } catch {
            // The renderer's socket already left; the bridge is done either way.
          }
        }
        let refusing = false
        /*
         * A close before the handshake completed is a refusal: classified
         * from the upstream's own HTTP answer into a distinct code the
         * renderer never redials on (4401 … 4429), 1011 only when unknown.
         */
        const refuse = (): void => {
          if (refusing) return
          refusing = true
          void classifyCloudWsRefusal(bridge, fetch).then(({ code, reason }) => end(code, reason))
        }
        upstream.addEventListener("open", () => {
          bridge.opened = true
          for (const frame of bridge.pending) upstream.send(frame)
          bridge.pending.length = 0
        })
        upstream.addEventListener("message", (event) => {
          socket.send(event.data as string | ArrayBuffer)
        })
        upstream.addEventListener("close", (event) => {
          if (!bridge.opened) {
            refuse()
            return
          }
          end(event.code, event.reason)
        })
        upstream.addEventListener("error", () => {
          if (!bridge.opened) {
            refuse()
            return
          }
          end(1011, `cloud ${bridge.kind} upstream failed`)
        })
      },
      message: (socket, raw) => {
        const bridge = socket.data.cloud
        const frameBytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
        if (bridge !== undefined) {
          // Each branch refuses its own over-cap frame with its own reason: plue's 64 KiB for the terminal, 1 MiB for the lsp relay.
          const cap = MAX_CLOUD_WS_FRAME_BYTES[bridge.kind]
          if (frameBytes > cap) {
            socket.close(1009, `A ${bridge.kind} frame is larger than the upstream accepts (${cap / 1024} KiB).`)
            return
          }
          const upstream = bridge.upstream
          if (upstream !== undefined && upstream.readyState === WebSocket.OPEN) {
            // A flooding renderer must not grow the upstream client's buffer without bound (the other direction is capped by backpressureLimit).
            if (upstream.bufferedAmount > MAX_CLOUD_WS_UPSTREAM_BUFFER) {
              socket.close(1009, `The ${bridge.kind} input outran the upstream.`)
              return
            }
            upstream.send(raw)
          } else if (bridge.pending.length < MAX_CLOUD_WS_PENDING) {
            bridge.pending.push(raw)
          } else {
            socket.close(1011, `cloud ${bridge.kind} upstream never opened`)
          }
          return
        }
        if (frameBytes > MAX_WS_FRAME_BYTES) {
          socket.close(1009, `A /ws frame is larger than the bus accepts (${MAX_WS_FRAME_BYTES / 1024} KiB).`)
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Frames must be JSON." }))
          return
        }
        if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
          socket.send(JSON.stringify({ type: "error", message: "Frames must carry a string `type`." }))
          return
        }
        const message = parsed as Record<string, unknown> & { readonly type: string }
        if (message.type === "subscribe" || message.type === "unsubscribe") {
          const topic = message.topic
          if (typeof topic !== "string" || topic === "" || topic.length > MAX_WS_TOPIC_CHARS) {
            socket.send(JSON.stringify({ type: "error", message: "subscribe needs a topic." }))
            return
          }
          if (message.type === "subscribe") {
            if (!socket.data.topics.has(topic) && socket.data.topics.size >= MAX_WS_SUBSCRIPTIONS) {
              socket.send(JSON.stringify({ type: "error", message: `At most ${MAX_WS_SUBSCRIPTIONS} topics may be subscribed.` }))
              return
            }
            socket.subscribe(topic)
            socket.data.topics.add(topic)
          } else {
            socket.unsubscribe(topic)
            socket.data.topics.delete(topic)
          }
          socket.send(JSON.stringify({ type: `${message.type}d`, topic }))
          return
        }
        const handlers = messageHandlers.get(message.type)
        if (handlers === undefined || handlers.size === 0) {
          socket.send(JSON.stringify({ type: "error", message: `No handler for ${message.type}.` }))
          return
        }
        for (const handler of handlers) {
          try {
            handler(message, socket)
          } catch (error) {
            log(`WebSocket ${message.type} handler failed: ${error instanceof Error ? error.message : String(error)}`)
            socket.send(JSON.stringify({ type: "error", message: "The WebSocket request failed." }))
          }
        }
      },
      close: (socket) => {
        for (const topic of socket.data.topics) socket.unsubscribe(topic)
        socket.data.topics.clear()
        const bridge = socket.data.cloud
        if (bridge !== undefined) cloudBridges.delete(socket)
        if (bridge?.upstream !== undefined) {
          try {
            bridge.upstream.close()
          } catch {
            // A dead upstream needs no close; the session is the cloud's to reap.
          }
          bridge.upstream = undefined
        }
      }
    }
  })

  const port = server.port ?? 0
  origin = `http://127.0.0.1:${port}`
  expectedHost = `127.0.0.1:${port}`
  log(`SMITHERS_LOCAL_ORIGIN=${origin}`)

  const publish: LocalServer["publish"] = (topic, message) => {
    server.publish(topic, JSON.stringify(message))
  }

  // Code intel (code-intel PLAN.md §3): one language server per (repository,
  // language), started on first use, ended with the repository and with the server.
  const lspDeps = { publish, node: nodeProbe, home, sandbox: sandboxHost, log }
  const lsp = options.lsp === undefined ? createLspHost(lspDeps) : options.lsp(lspDeps)

  // L3: one repository authority feeds targets and every child-process cwd.
  const routeHost = { router, publish, onMessage }
  const repoTargets = registerRepoTargetRoutes(routeHost, {
    node: nodeProbe,
    authority: repositoryAuthority,
    allowManualRepositoryPaths: options.allowManualRepositoryPaths,
    onRepoClosed: (repoId) => lsp.closeRepo(repoId),
    onRepoAccessRevoked: (repoId) => ptyRoutes.revokeRepo(repoId),
    log,
    ...(options.buildCli === undefined ? {} : { cli: options.buildCli }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir })
  })
  await repoTargets.restored

  // L4: the harness table and PTY sessions. Browser input carries a repo id,
  // never a filesystem path; the server resolves the authorized cwd here.
  registerHarnessRoutes(router, harnesses)
  // Agents as data (custom-agents.md): the store under stateDir seeds from the built-ins; a role launch resolves against it.
  const agents = registerAgentRoutes(router, {
    harnesses,
    log,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir })
  })
  const ptyDeps = {
    publish,
    harnesses,
    roles: () => agents.store.list(),
    home,
    pathPrepend: async () => binDirOf((await nodeProbe)?.path),
    log
  }
  const pty = options.pty === undefined ? createPtyManager(ptyDeps) : options.pty(ptyDeps)
  const ptyRoutes = registerPtyRoutes(routeHost, pty, {
    resolveRepo: (repoId) => repoTargets.resolveRepo(repoId, "read-write")
  })
  // A language server reads: read access suffices.
  registerLspRoutes(routeHost, lsp, {
    resolveRepo: (repoId) => repoTargets.resolveRepo(repoId, "read")
  })

  const local: LocalServer = {
    origin,
    port,
    sessionToken,
    websocketProtocol,
    router,
    server,
    publish,
    onMessage,
    authorizeRepository: repositoryAuthority.authorize,
    stop: async () => {
      // Close PTY admission synchronously, before any asynchronous host cleanup.
      let ptyStopped: Promise<void>
      try { ptyStopped = pty.dispose() } catch (error) { ptyStopped = Promise.reject(error) }
      const writerCleanup = [...writers].flatMap(([runId, writer]) => [() => agent?.cancel(runId), () => writer.end()])
      writers.clear()
      // Stop accepting traffic before waiting on independent resources. A
      // failed finalizer must not strand the listener or another child owner.
      const results = await Promise.allSettled([
        ...writerCleanup,
        () => closeCloudBridges(1001, "the local app is shutting down"),
        () => server.stop(true),
        () => cloudAuth?.stop(),
        () => linearAuth?.stop(),
        () => ptyStopped,
        () => lsp.killAll(),
        // Target children are reaped before the journal flushes, so their
        // exit frames land on disk instead of in a queue nobody awaits.
        () => repoTargets.stop(),
        () => repositoryAuthority.clear()
      ].map(async (cleanup) => cleanup()))
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "Local server shutdown failed.")
    }
  }
  registerTargetGraphRoutes(local, { repos: repoTargets.repos, history: repoTargets.history, node: nodeProbe, ...(options.buildCli === undefined ? {} : { cli: options.buildCli }) })
  let stopPromise: Promise<void> | undefined
  return {
    ...local,
    stop: () => stopPromise ??= (async () => {
      // Close run admission synchronously; local.stop awaits the reaping.
      void repoTargets.stop()
      await local.stop()
    })()
  }
}
