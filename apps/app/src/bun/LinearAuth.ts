/*
 * The Linear OAuth handoff on the local origin (lane sync, ADR 0005): the
 * settled team-pick flow is handoff → GET setup → pick → create,
 * and the handoff's callback redirects with `?setup=<key>`. The backend's
 * registered redirect URI is fixed at the API host, so the app runs its own
 * receiver, the same shape the CLI browser login already speaks: `start`
 * listens on 127.0.0.1:<random> and answers the OAuth start URL — through
 * the `/api/cloud/*` proxy, so the Bun-held bearer authenticates it — with
 * `callback_port=<port>` attached. Whatever the browser journey, the local
 * origin is where the setup key can land; `session` answers it to the
 * renderer, and the first well-formed callback claims the attempt (a replay
 * or a racing local process answers 409, matching the cloud sign-in).
 * Like the cloud sign-in listener, the callback answers only a GET on the
 * exact loopback Host (no DNS rebinding), from no foreign Origin, carrying
 * the attempt's own `handoff` random (compared in constant time), so an open
 * web page cannot race its own key in across the port range.
 *
 * The setup key is an opaque, one-time, user-bound handle — never a token;
 * nothing here touches the OS keychain. Against a backend that cannot
 * redirect to the local origin the wait simply expires and the card says
 * the handoff did not come back; no route is faked.
 */
import type { Server } from "bun"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { LinearAuthSession } from "@smthrs/rpc/LocalApp"

export interface LinearAuthOptions {
  /** The local origin the `/api/cloud/*` proxy lives on (no trailing slash); read at start time. */
  readonly origin: () => string
  /** The callback wait; production is five minutes, like the cloud sign-in. */
  readonly waitTimeoutMs?: number
  readonly log?: (line: string) => void
}

export interface LinearAuth {
  /** Consume the one-use capability for the browser's OAuth navigation. */
  readonly claimNavigation: (url: URL) => boolean
  /** The renderer-safe session answer: the state, and the key only once authorized. */
  readonly session: () => LinearAuthSession
  /** Begin the handoff: answers the URL the renderer opens in the system browser. */
  readonly start: () => Promise<{ readonly url: string } | { readonly error: string }>
  /** Close a pending callback listener; the server calls this on shutdown. */
  readonly stop: () => Promise<void>
}

export const LINEAR_AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000

/** The one page the callback answers: a browser navigation gets HTML, never JSON plumbing. */
const RETURN_PAGE =
  "<!doctype html><meta charset=\"utf-8\"><title>Linear authorized</title>" +
  "<p>Linear authorized — return to Smithers to pick the team.</p>"

const matchesSecret = (value: string | null, expected: string): boolean =>
  value !== null && Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected))

interface PendingHandoff {
  readonly url: string
  readonly server: Server<undefined>
  readonly timeout: ReturnType<typeof setTimeout>
  navigationClaimed: boolean
}

export const createLinearAuth = (options: LinearAuthOptions): LinearAuth => {
  const waitTimeoutMs = options.waitTimeoutMs ?? LINEAR_AUTH_WAIT_TIMEOUT_MS
  const log = options.log ?? (() => {})

  let setupKey: string | null = null
  let pending: PendingHandoff | null = null

  const clearPending = (): void => {
    if (pending === null) return
    clearTimeout(pending.timeout)
    pending.server.stop(true)
    pending = null
  }

  return {
    claimNavigation: (url) => {
      if (pending === null || pending.navigationClaimed || url.href !== pending.url) return false
      pending.navigationClaimed = true
      return true
    },
    session: (): LinearAuthSession =>
      setupKey !== null
        ? { state: "authorized", setupKey }
        : pending === null
        ? { state: "idle" }
        : { state: "waiting" },
    start: async () => {
      // A new attempt supersedes whatever an earlier one left: the old
      // listener dies and a stale key can never be claimed twice.
      clearPending()
      setupKey = null
      const handoff = randomBytes(32).toString("base64url")
      let server: Server<undefined>
      try {
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => {
            const localOrigin = `http://127.0.0.1:${server.port}`
            if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("invalid host", { status: 403 })
            const url = new URL(request.url)
            if (url.pathname !== "/callback") return new Response("not found", { status: 404 })
            if (request.method !== "GET") return new Response("method not allowed", { status: 405 })
            const origin = request.headers.get("origin")
            if (origin !== null && origin !== localOrigin) return new Response("invalid origin", { status: 403 })
            if (!matchesSecret(url.searchParams.get("handoff"), handoff)) {
              return new Response("this callback does not belong to the current authorization attempt", { status: 403 })
            }
            const key = url.searchParams.get("setup") ?? ""
            if (key.trim() === "") {
              return new Response("expected ?setup=<key>", { status: 400 })
            }
            if (setupKey !== null) {
              return new Response("this authorization attempt already received its callback", { status: 409 })
            }
            setupKey = key
            log("linear-auth: the authorization callback arrived")
            return new Response(RETURN_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })
          }
        })
      } catch (error) {
        return { error: `Could not listen for the Linear callback: ${error instanceof Error ? error.message : String(error)}` }
      }
      const timeout = setTimeout(() => {
        log("linear-auth: the callback never arrived; the attempt expired")
        clearPending()
      }, waitTimeoutMs)
      const url = `${options.origin().replace(/\/+$/, "")}/api/cloud/api/auth/linear?callback_port=${server.port}&handoff=${handoff}`
      pending = { url, server, timeout, navigationClaimed: false }
      return { url }
    },
    stop: async () => {
      clearPending()
    }
  }
}
