// Stays .ts: a `fetch` is the host's Request and Response, which VibeLang code may not read (EK4402). HostModel's
// provider transport takes one (`HostModelOptions.fetch`); this one sends every call through an Effect HttpClient,
// such as @smthrs/testing's HttpRecording.
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

/** A `fetch` over `client`: the request's method, URL, headers and text body; the answer's status, headers and text. */
export const fetchOver = (client: HttpClient.HttpClient): typeof globalThis.fetch => async (input, init) => {
  const asked = new Request(input, init)
  const text = await asked.text()
  const headers: Record<string, string> = {}
  asked.headers.forEach((value, name) => {
    headers[name] = value
  })
  const base = HttpClientRequest.make(asked.method as "POST")(asked.url).pipe(HttpClientRequest.setHeaders(headers))
  const request = text === "" ? base : HttpClientRequest.bodyText(base, text, headers["content-type"] ?? "application/json")
  return Effect.runPromise(Effect.gen(function*() {
    const response = yield* client.execute(request)
    const body = yield* response.text
    const empty = response.status === 204 || response.status === 205 || response.status === 304
    return new Response(empty ? null : body, { status: response.status, headers: response.headers })
  }))
}
