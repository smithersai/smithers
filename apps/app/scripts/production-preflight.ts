type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * The deployed build a production run certifies. When matrix readiness already pinned a build,
 * the deployment must still serve it, so a redeploy between readiness and the run fails here.
 */
export const productionBuild = async (origin: string, pinned?: string, fetcher: Fetcher = fetch): Promise<string> => {
  const response = await fetcher(new URL("/api/bootstrap", origin))
  if (!response.ok) throw new Error(`Production bootstrap failed: HTTP ${response.status}`)
  const body = await response.json() as { readonly host?: unknown; readonly buildSha?: unknown }
  if (body.host !== "cloud" || typeof body.buildSha !== "string" || !/^[0-9a-f]{40,64}$/.test(body.buildSha)) {
    throw new Error("Production preflight requires a cloud host with an exact deployed revision.")
  }
  if (pinned !== undefined && pinned !== body.buildSha) throw new Error(`Production deployment changed since readiness: ${pinned} is now ${body.buildSha}.`)
  return body.buildSha
}
