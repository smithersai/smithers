/**
 * The bindings the Worker is deployed with. `ASSETS` is the static site in
 * `site/` (wrangler.jsonc: assets.binding), served with
 * `not_found_handling: single-page-application`, so it answers an unknown path
 * with index.html and a 200 rather than a 404.
 */
export interface StatusSiteEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

const NOSNIFF = { "x-content-type-options": "nosniff" } as const;

/**
 * SHA-256 of the one inline `<script>` in site/index.html. The policy allows
 * exactly that block, so a stray `javascript:` href in the feed or a later
 * third-party tag cannot run. worker.test.ts recomputes the hash from the file
 * on every run: editing the script without updating this constant fails the
 * build instead of shipping a page whose script the browser refuses.
 */
const INLINE_SCRIPT_SHA256 = "sha256-SKwTCdmxN7XzWk252l0bIhwomosnZDw1a8afCNDcCzo=";

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src '${INLINE_SCRIPT_SHA256}'`,
  // The page carries one <style> block and one style attribute.
  "style-src 'self' 'unsafe-inline'",
  // fetch("/status.json")
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const HTML_HEADERS = {
  "cache-control": "public, max-age=300",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  ...NOSNIFF,
} as const;

const ASSET_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
  ...NOSNIFF,
} as const;

/** Errors and health probes must not outlive the deploy that changes them. */
const UNCACHED_HEADERS = {
  "cache-control": "no-store",
  ...NOSNIFF,
} as const;

/**
 * The page uses cache: "no-cache" to revalidate on every load. Other clients
 * may reuse the feed for 60 seconds before revalidating with its validators.
 */
const FEED_HEADERS = {
  "cache-control": "public, max-age=60, must-revalidate",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
} as const;

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const next = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) next.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  });
}

/**
 * The binding answers any unknown path with index.html and a 200 (see
 * wrangler.jsonc: not_found_handling is single-page-application), so the path
 * alone cannot tell an asset from the page. Only a 200 that is not HTML earns
 * the year-long immutable policy; the fallback page keeps the page policy, and
 * nothing outside 200/304 is cached at all, so a broken deploy is gone the
 * moment the next one lands.
 */
function headersFor(pathname: string, response: Response): Record<string, string> {
  if (response.status !== 200 && response.status !== 304) return { ...UNCACHED_HEADERS };
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 200 && pathname.startsWith("/assets/") && !contentType.includes("text/html")) {
    return { ...ASSET_HEADERS };
  }
  return { ...HTML_HEADERS };
}

async function fetchAsset(request: Request, env: StatusSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  return withHeaders(response, headersFor(new URL(request.url).pathname, response));
}

/**
 * The assets binding runs with `not_found_handling: single-page-application`,
 * so a missing status.json comes back as the index page with a 200 rather than
 * a 404. Handing that to a caller would be HTML claiming to be the feed, so
 * anything that is not JSON is reported as a missing feed instead.
 */
async function fetchFeed(request: Request, env: StatusSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 304) return withHeaders(response, FEED_HEADERS);
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !contentType.includes("json")) {
    const reason = response.status === 404 ? "missing" : response.status === 200 ? "not-json" : "unexpected-status";
    console.warn("status feed refused", {
      status: response.status,
      contentType,
      pathname: new URL(request.url).pathname,
    });
    return withHeaders(
      Response.json({ error: "status feed unavailable", reason }, { status: 404 }),
      { ...FEED_HEADERS, "cache-control": "no-store" },
    );
  }
  return withHeaders(response, FEED_HEADERS);
}

async function fetchIndex(request: Request, env: StatusSiteEnv): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  const response = await env.ASSETS.fetch(new Request(url, request));
  return withHeaders(response, headersFor(url.pathname, response));
}

/**
 * The status site handler. Routes:
 *
 * - anything but GET or HEAD: 405 with `allow: GET, HEAD`, and the feed's CORS
 *   headers when the path is /status.json so a browser reads the refusal.
 * - /healthz: `{ ok: true, service: "status-site" }`, never cached.
 * - /status.json: the feed, guarded against the SPA fallback so a missing file
 *   reads as a JSON 404 instead of an HTML page (`fetchFeed`).
 * - everything else: the asset, falling back to index.html.
 *
 * Every response carries `x-content-type-options: nosniff`; `headersFor`
 * decides the cache and page policy from the response, not the path.
 */
const worker: { fetch(request: Request, env: StatusSiteEnv): Promise<Response> } = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: {
          allow: "GET, HEAD",
          "content-type": "text/plain; charset=utf-8",
          ...NOSNIFF,
          ...(url.pathname === "/status.json" ? { ...FEED_HEADERS, "cache-control": "no-store" } : {}),
        },
      });
    }

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "status-site" }, { headers: UNCACHED_HEADERS });
    }

    // A missing status feed must read as missing, not as an HTML page.
    if (url.pathname === "/status.json") return fetchFeed(request, env);

    const direct = await fetchAsset(request, env);
    if (direct.status !== 404) return direct;

    return fetchIndex(request, env);
  },
};

export default worker;
