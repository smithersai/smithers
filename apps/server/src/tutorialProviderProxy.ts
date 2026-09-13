import { Effect, Redacted } from "effect"
import { TUTORIAL_PROVIDER_PROXY_PATH, TUTORIAL_PROXY_TOKEN_HEADER, tutorialProviderDestinations } from "@smthrs/rpc/TutorialProviderProxy"
import { ServerConfig } from "./Config"
import { discardBody, fetchWithDeadline, readBoundedBytes } from "./Http"

const json = (status: number, message: string) => Response.json({ message }, { status, headers: { "cache-control": "no-store" } })
const sameToken = (left: string, right: string) => {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right)
  let difference = a.length ^ b.length
  for (let i = 0; i < b.length; i++) difference |= (a[i] ?? 0) ^ b[i]!
  return difference === 0
}

export const handleTutorialProviderProxy = (request: Request) => Effect.gen(function*() {
  const config = yield* ServerConfig
  if (!config.tutorialServiceToken) return json(503, "The tutorial provider proxy is not configured.")
  if (!sameToken(request.headers.get(TUTORIAL_PROXY_TOKEN_HEADER) ?? "", Redacted.value(config.tutorialServiceToken))) return json(401, "Service authentication required.")
  const url = new URL(request.url)
  const destination = url.pathname.slice(TUTORIAL_PROVIDER_PROXY_PATH.length + 1)
  if (url.search || !Object.hasOwn(tutorialProviderDestinations, destination)) return json(404, "Unknown provider route.")
  if (request.method !== "POST") return json(405, "Unsupported provider method.")
  const body = yield* readBoundedBytes(request, 1024 * 1024).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!body) return json(413, "Provider request body is too large or unreadable.")
  const headers = new Headers()
  for (const name of ["authorization", "chatgpt-account-id", "content-type", "accept", "openai-beta", "originator", "user-agent", "openai-project", "openai-organization"]) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const upstream = tutorialProviderDestinations[destination as keyof typeof tutorialProviderDestinations]
  const response = yield* fetchWithDeadline("Tutorial provider", upstream, { method: "POST", headers, body, redirect: "manual", signal: request.signal }, 120_000)
    .pipe(Effect.catch(() => Effect.succeed(json(502, "The tutorial provider could not be reached."))))
  // Never follow a redirect with a subscription credential or return a new
  // destination for the coordinator to follow outside this proxy.
  if (response.status >= 300 && response.status < 400) {
    yield* discardBody(response)
    return json(502, "The tutorial provider returned an unexpected redirect.")
  }
  const outgoing = new Headers()
  for (const name of ["content-type", "retry-after", "retry-after-ms", "x-request-id", "request-id"]) {
    const value = response.headers.get(name)
    if (value !== null) outgoing.set(name, value)
  }
  outgoing.set("cache-control", "no-store")
  outgoing.set("x-smithers-provider-proxy", "cloudflare")
  return new Response(response.body, { status: response.status, headers: outgoing })
})
