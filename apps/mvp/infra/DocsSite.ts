// The docs site (apps/site, an Astro build) on the app's hostname. It claims only its own paths there, by zone routes,
// and Cloudflare runs a route before the app's custom domain, so every other path stays the app's
// (docs/infrastructure.md#domain).
import * as Cloudflare from "@alchemy.run/cloudflare"
import { docsRoutes } from "./Domain.ts"

/**
 * The docs site at `domain`: `pnpm build` in apps/site, which Alchemy runs again only when that folder's files change,
 * served as static assets with no Worker code. Its `_redirects` and `_headers` apply, and a missing page is its 404.
 */
export const DocsSite = (domain: string) =>
  Cloudflare.Website.StaticSite("SmithersDocs", {
    command: "pnpm build",
    cwd: "../site",
    outdir: "dist",
    routes: docsRoutes(domain),
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" }
  })
