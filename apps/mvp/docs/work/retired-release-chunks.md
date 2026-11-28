---
title: Serve truthful non-immutable misses for retired static assets
status: done
area: pwa
owner: antigravity-pwa-controllerchange-diag
updated: 2026-11-27
links: []
---

Across two live releases, authenticated navigation intermittently fell back to
the error boundary because production served obsolete `/assets/*` JavaScript
chunks with `200 text/html` and `Cache-Control: public, max-age=31536000, immutable`
(due to `notFoundHandling: "single-page-application"` combined with
`runWorkerFirst: ["/*", "!/assets/*", ...]` and `public/_headers`).

Fixed in `fa186f89c566` by extracting `apps/mvp/infra/SiteAssets.ts`
(`notFoundHandling: "none"`, `runWorkerFirst: ["/", "/index.html", "/api/*"]`)
and handling `ASSETS` 404s in `apps/mvp/worker/index.ts` so valid hashed files
stay on Cloudflare's CDN edge with immutable caching, missing static assets
return empty `404` responses with `Cache-Control: no-store`, app deep links
serve origin-aware `200 text/html`, and unknown page routes retain `404 text/html`
with `x-robots-tag: noindex`.

Follow-up diagnosis against `765d5250d287` isolated two distinct causes behind
(1) the NYC01 two-release test hanging in `page.evaluate` waiting for
`controllerchange` after `activate()` and (2) returning-user rollovers where
another route required manual reload:
1. **Listener registration race (`apps/mvp/e2e/pwa-update.spec.ts`):** Un-awaited
   `const controlling = page.evaluate(...)` followed synchronously by `activate()`
   let Node release `/sw.js` before Chromium attached `addEventListener("controllerchange")`
   (observed in 4/4 clean runs; reproduced `HUNG_5S` with 60ms CDP/main-thread lag).
   Fixed via `watchControllerChange(page)` awaiting `page.evaluateHandle(...)`
   listener attachment strictly before `activate()` (Test #2) and `click()` (Test #1),
   preserving surrounding assertions for operator bell-count coordination.
2. **Product activation tracking gap (`apps/mvp/src/pwa.ts`, `src/main.tsx`,
   `src/hostRecords.ts`, `src/boot.ts`):** Returning-user reload across a deploy
   left `workbox-window`'s `Workbox.register()` resolving with `waiting: "installed"`
   (which Workbox does not attach `statechange` to; Workbox also detaches
   `updatefound` after one external update). `controllerchange` fired silently 4ms
   later without invoking `onNeedReload`, leaving retired routes stuck on the error
   boundary. Fixed by attaching `watchControllerUpdates` at module evaluation to
   call `releaseActivated("controllerchange")` on any non-null controller
   replacement, plus `hasNewerLiveBuild` (`/version.json`) if an online preload
   error's `registration.update()` finds no installing/waiting worker on a non-`dev`
   build (`via: "version_mismatch"`). HTTP/2 `304`, `_headers`, and `beforeNewWorker`
   holds were verified clean and ruled out as root causes.

Verified on the Mac mini farm: Vitest 8 files / 122 tests (100% v8 coverage on
`src/pwa.ts`, `src/telemetry.ts`, `worker/index.ts`, `infra/SiteAssets.ts`),
`src/pwa.build.test.ts` (1/1), `pnpm lint` (0 warnings), `pnpm typecheck`
(5 projects), Playwright `e2e/pwa-update.spec.ts` (4/4 passed including new
returning-user rollover test), and a 5x loaded-host stress proof (6x CPU throttle
+ 200ms main-thread block, 5/5 passed with `browser.listener_confirmed` strictly
before `node.activate`).
