# 0006. Hosting

**Status:** accepted, 2026-11-07. **Rulings:** VL-3, VL-4.

**Decision.** One Alchemy stack, `smithers-vibelang` (`infra/Stack.vibe`): the Vite build served by a Cloudflare
Worker with static assets and an explicit home route (`worker/index.ts`). The hostname comes from the deployment's
`VIBELANG_DOMAIN` (vibelang.smithers.sh for ours), so the public stack names no domain, as `apps/mvp` does with
`APP_DOMAIN`. `/api/health` reports which agent the deployment runs: `live` when the API Worker is bound and answers
it, `mock` from the site Worker without one.

**Route boundary.** Only `/`, `/index.html`, `/api/health` and built `/assets/` or `/media/` files are served. Unknown routes, missing assets that reach the asset service’s HTML fallback, and all `/e2e/` paths return 404. The fault host is built only in e2e mode and cannot be served by the production Worker.

**The API Worker (2026-11-07).** `VibelangApi` (`worker/Api.vibe`), an Effect-native Alchemy Worker the site reaches
by service binding for every `/api/*` path, hosts the `Conversation` and `Budget` Durable Objects (0010).
