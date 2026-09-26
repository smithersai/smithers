/*
 * The one `smithers://` URL the app answers (#1964): `smithers://open/<owner>/<repo>`,
 * which `smthrs open` hands to the installed app. It maps to the renderer's
 * repository page `/<owner>/<repo>` (RepoLink.pathRepo), whose first message is
 * the repository homepage. Anything else — another host, a query, a fragment,
 * credentials, a port, a third segment, an encoded slash — is refused, so a
 * link on a web page can do no more than open a repository page. `api` is
 * never an owner: the renderer origin relays `/api/*` (NativeRendererServer),
 * so `smithers://open/api/user` would load an API response, not a page.
 */

const SEGMENT = /^[\w.-]+$/

/** The renderer path a deep link opens, or null when the URL is not exactly `smithers://open/<owner>/<repo>`. */
export const deepLinkPath = (url: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "smithers:" || parsed.hostname !== "open") return null
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null
  if (parsed.search !== "" || parsed.hash !== "" || url.includes("?") || url.includes("#")) return null
  const segments = parsed.pathname.split("/")
  if (segments.length !== 3 || segments[0] !== "") return null
  const [, owner, repo] = segments
  if (owner!.toLowerCase() === "api") return null
  for (const segment of [owner!, repo!]) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") return null
  }
  return `/${owner}/${repo}`
}
