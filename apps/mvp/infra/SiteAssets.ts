/**
 * Cloudflare Workers static-asset routing for the site Worker (`alchemy.run.ts`, `worker/SocialPreview.workerd.test.ts`).
 *
 * Existing built files (content-hashed `/assets/*`, icons, manifest, `sw.js`, `workbox-*.js`, `version.json`) serve
 * directly from Cloudflare's CDN edge with `public/_headers` intact. `/` and `/index.html` always run the site Worker
 * first for aliases, custom domains, origin-aware social meta tags and edge first-paint, and `/api/*` goes straight to
 * the Worker without an asset lookup. With `notFoundHandling: "none"`, missing files and app routes reach
 * `worker/index.ts`, preventing retired `/assets/*` files from receiving a `200 text/html` SPA fallback with
 * `_headers`'s immutable cache header.
 */
export const siteAssets = {
  notFoundHandling: "none" as const,
  runWorkerFirst: ["/", "/index.html", "/api/*"],
}
