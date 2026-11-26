import { HttpServerRequest } from "effect/http"

// The web `Request` a buffered write needs, beside worker/WriteAdmission.vibe: VibeLang shadows the global.

/**
 * Whether a request's web source carries no body.
 * @throws {never}
 */
export const bodyless = (source: object): boolean => source instanceof Request && source.body === null

/** `request` again, its body now `body`: every body accessor, the stream included, reads the buffered bytes. */
export const replay = (request: HttpServerRequest.HttpServerRequest, body: Uint8Array<ArrayBuffer>) =>
  HttpServerRequest.fromWeb(new Request(new URL(request.originalUrl, "http://localhost"), {
    method: request.method, headers: request.headers, body,
  })).modify({ url: request.url })
