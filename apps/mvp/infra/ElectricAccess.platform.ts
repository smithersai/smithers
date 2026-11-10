// The platform side of infra/ElectricAccess.vibe: the Worker's `Request` constructor.
import type { Headers } from "effect/http"

/**
 * A new `GET` request to `url` with `headers`.
 *
 * @throws {never} A parsed URL, the `GET` method and a headers record are always a valid request.
 */
export const getRequest = (url: URL, headers: Headers.Headers): Request => new Request(url, { method: "GET", headers })
