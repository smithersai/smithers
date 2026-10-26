// What the Electric gateway (infra/ElectricGateway.ts) lets through to Electric's container: `GET /v1/shape`, and
// nothing else.
//
// The gateway has no public URL: ChatApi reaches it only through its service binding (infra/Electric.ts), after it has
// authorized the person and fixed the shape. Electric runs without a secret of its own: its container has no way in but
// this gateway (docs/infrastructure.md).
import { HttpServerRequest } from "effect/http"

/** The gateway's answer to one request: refused with a status before the container starts, or let through. */
export type Admission =
  | { readonly _tag: "Refused"; readonly status: 404 }
  | { readonly _tag: "Admitted"; readonly request: HttpServerRequest.HttpServerRequest }

/**
 * Admits `request` when it is `GET /v1/shape`; anything else is 404. The admitted request is a new `GET` to the same
 * URL with the same headers.
 */
export const admit = (request: HttpServerRequest.HttpServerRequest): Admission => {
  const url = new URL(request.originalUrl, "http://electric")
  if (request.method !== "GET" || url.pathname !== "/v1/shape") return { _tag: "Refused", status: 404 }
  return { _tag: "Admitted", request: HttpServerRequest.fromWeb(new Request(url, { method: "GET", headers: request.headers })) }
}
