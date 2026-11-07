import type { HttpServerRequest } from "effect/http"

// What every socket route of the branch workspace checks before anything else (the terminals', worker/branch/Terminals.ts,
// and the room's, worker/branch/Presence.ts): that the request asks for a WebSocket, and that it came from a page of
// this app. A cookie rides along on a cross-site WebSocket, so the `Origin` is what keeps another site's page out.

/** Whether the request asks to upgrade to a WebSocket. */
export const isUpgrade = (request: HttpServerRequest.HttpServerRequest): boolean =>
  (request.headers.upgrade ?? "").toLowerCase() === "websocket"

/** Whether the request came from a page of this app: its `Origin` is the request's own. */
export const sameOrigin = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const origin = request.headers.origin
  return origin !== undefined && origin === new URL(request.originalUrl).origin
}
