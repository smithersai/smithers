---
title: Serve truthful non-immutable misses for retired static assets
status: done
area: pwa
owner: antigravity-pwa-static-assets
updated: 2026-11-27
links: []
---

Across two live releases, authenticated navigation intermittently fell back to
the error boundary because production served obsolete `/assets/*` JavaScript
chunks with `200 text/html` and `Cache-Control: public, max-age=31536000, immutable`
(due to `notFoundHandling: "single-page-application"` combined with
`runWorkerFirst: ["/*", "!/assets/*", ...]` and `public/_headers`).

Fixed by extracting `apps/mvp/infra/SiteAssets.ts` (`notFoundHandling: "none"`,
`runWorkerFirst: ["/", "/index.html", "/api/*"]`) and handling `ASSETS` 404s in
`apps/mvp/worker/index.ts` so valid hashed files remain on Cloudflare's CDN edge
with immutable caching, missing `/assets/*` and static JS/CSS/WASM/map files
receive empty `404` responses with `Cache-Control: no-store`, app deep links
serve origin-aware `200 text/html`, and unknown page routes retain `404 text/html`
with `x-robots-tag: noindex` and the in-app recovery view. Restored relayed
telemetry for `pwa.preload` and added `RouteModuleUnavailable`, `clientBuild`,
and `stage` (`controlled` / `uncontrolled`) to `render error`.

Verified on the Mac mini farm with real Miniflare workerd tests
(`worker/SocialPreview.workerd.test.ts`), unit and coverage tests (13 files,
200 tests, 100% coverage on `infra/SiteAssets.ts`, `worker/index.ts`,
`src/telemetry.ts`), `pnpm lint`, `pnpm typecheck`, a two-release Miniflare +
Chromium proof (including negative control reproducing the old `200 text/html`
+ `immutable` response), and Playwright `e2e/pwa-update.spec.ts` (3/3 passed).
