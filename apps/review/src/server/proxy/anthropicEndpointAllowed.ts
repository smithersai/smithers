/**
 * The exact upstream endpoints the metered proxy forwards.
 *
 * The proxy attaches the service-wide Anthropic key, so anything a caller can
 * reach through it runs with the shared account's authority. Anthropic's
 * object APIs are workspace-scoped rather than key-scoped: forwarding
 * `/v1/files` would let any repo-scoped caller list, download and irreversibly
 * delete another tenant's uploads, and `/v1/messages/batches` returns results
 * out of band that this proxy never meters. A `/v1/` prefix check is therefore
 * not a boundary — only an allowlist is.
 *
 * A review run dials exactly one endpoint: `@smthrs/model`'s Anthropic route
 * pins `POST /v1/messages` (see `src/workflow/reviewSeatResolver.ts`), which
 * is also the only response shape `parseUsageFromJson` / `teeForMetering`
 * can meter. Anything else is refused before the key is attached. Add an entry
 * here only with a justification for both cross-tenant isolation and metering.
 */
const ALLOWED_ENDPOINTS: ReadonlyArray<readonly [method: string, path: string]> = [["POST", "/v1/messages"]];

/**
 * Whether the proxy forwards this method and path upstream with the real key.
 *
 * Matching is exact. `proxiedPath` comes from `URL.pathname`, which has
 * already collapsed `.` and `..` segments; percent-encoded spellings never
 * decode into a match, and a trailing slash is not the allowed path, so every
 * variant that is not literally an allowed endpoint fails closed.
 */
export function anthropicEndpointAllowed(method: string, proxiedPath: string): boolean {
  const wanted = method.toUpperCase();
  return ALLOWED_ENDPOINTS.some(([allowedMethod, allowedPath]) =>
    allowedMethod === wanted && allowedPath === proxiedPath
  );
}
