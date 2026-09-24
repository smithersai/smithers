/** Hosts a published repository may link to. */
const appHosts = ["smithers.sh", "app.smithers.sh", "canary.smithers.sh"];

/**
 * A published app URL: HTTPS on a Smithers app host, without credentials or a
 * port. Completion validates with it before publishing, and the delivery sweep
 * re-validates stored readiness before mailing the link. Null when it fails.
 */
export function parseAppUrl(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || !appHosts.includes(url.hostname) || url.username || url.password || url.port) return null;
  return url;
}
