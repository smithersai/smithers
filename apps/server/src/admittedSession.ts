/*
 * Test fixture: send a Worker request as one admitted login. Every
 * model-spending route fails closed on a deployment without an identity seam
 * (requireTurnSession), so a test of what happens after the gate runs through
 * this session. The identity answer wraps whatever fetch the test installed
 * for the length of the call: the test's own upstream mock still receives
 * every other subrequest and never sees the validate. Nothing in the Worker
 * imports this.
 */

const ADMITTED_IDENTITY_URL = "https://identity.admitted.test"
const ADMITTED_LOGIN = "admitted"
const ADMITTED_COOKIE = "smithers_session=admitted"

type WorkerFetch<Env, Ctx> = (request: Request, env: Env, ctx?: Ctx) => Promise<Response>

/** The env with the admitted identity seam configured. */
const admittedEnv = <Env extends object>(env: Env): Env & { readonly IDENTITY_UPSTREAM_URL: string } => ({
  ...env,
  IDENTITY_UPSTREAM_URL: ADMITTED_IDENTITY_URL
})

/** The request with the admitted session cookie. */
const admittedRequest = (request: Request): Request => {
  const headers = new Headers(request.headers)
  headers.set("cookie", ADMITTED_COOKIE)
  // Hand the body stream over unread: a test of the body cap watches it.
  return new Request(request.url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit)
}

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

/** Run `fetchWorker` on the request as the admitted login under the admitted identity seam. */
export const asAdmitted = <Env extends object, Ctx>(fetchWorker: WorkerFetch<Env, Ctx>) =>
  (request: Request, env: Env, ctx?: Ctx): Promise<Response> => {
    const sent = admittedRequest(request)
    const configured = admittedEnv(env)
    const inner = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input) === `${ADMITTED_IDENTITY_URL}/api/identity/validate`
        ? Promise.resolve(Response.json({ login: ADMITTED_LOGIN, allowlisted: true, admin: false, scopes: [] }))
        : inner(input, init)) as typeof fetch
    return fetchWorker(sent, configured, ctx).finally(() => {
      globalThis.fetch = inner
    })
  }
