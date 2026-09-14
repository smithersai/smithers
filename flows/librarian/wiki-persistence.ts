import { Schema } from "effect"
import { PublishedWikiPage, type WikiReceipt } from "./wiki/flow.ts"
/** The gateway credential is repository scoped; no user-wide PAT enters the guest. */
export const persistWiki = (options: { repo: string; apiUrl: string; token: string; gatewayId: string }) => {
  const url = new URL(options.apiUrl)
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) || url.username || url.password) {
    throw new Error("Product publication requires an authenticated API origin")
  }
  if (!options.token || !options.gatewayId) throw new Error("Missing product publication authority")
  const endpoint = `${options.apiUrl.replace(/\/$/, "")}/api/gateways/${encodeURIComponent(options.gatewayId)}/wiki-pages`
  return async (receipt: WikiReceipt): Promise<NonNullable<WikiReceipt["publishedPages"]>> => {
    if (receipt.repo !== options.repo) throw new Error("Wiki receipt does not belong to this workspace")
    if (receipt.pages.length > 200 || Buffer.byteLength(JSON.stringify(receipt)) > 8 * 1024 * 1024 ||
      receipt.pages.some(page => Buffer.byteLength(page.body) > 1024 * 1024)) {
      throw new Error("The Wiki source index exceeds the publication limit; choose a smaller repository.")
    }
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" }, body: JSON.stringify(receipt) })
    if (!response.ok) throw new Error(`Wiki publication failed (HTTP ${response.status}); retry the run to publish its source index.`)
    const result = Schema.decodeUnknownSync(Schema.Struct({ pages: Schema.Array(PublishedWikiPage) }))(await response.json())
    if (result.pages.length !== receipt.pages.length || new Set(result.pages.map(page => page.id)).size !== receipt.pages.length ||
      result.pages.some(page => !receipt.pages.some(source => source.id === page.id) || !/^[a-z0-9-]+$/.test(page.slug))) {
      throw new Error("Wiki publication did not acknowledge every source page")
    }
    return result.pages
  }
}
