# 0006. Hosting

**Status:** accepted, 2026-11-07. **Rulings:** VL-3, VL-4.

**Decision.** One Alchemy stack, `smithers-vibelang` (`infra/Stack.vibe`): the Vite build served by a Cloudflare
Worker with static assets and an explicit home route (`worker/index.ts`). The hostname comes from the deployment's
`VIBELANG_DOMAIN` (vibelang.smithers.sh for ours), so the public stack names no domain, as `apps/mvp` does with
`APP_DOMAIN`. `/api/health` reports which agent the deployment runs (`mock` until roadmap 1b).

**Route boundary.** Only `/`, `/index.html`, `/api/health` and built `/assets/` or `/media/` files are served. Unknown routes, missing assets that reach the asset service’s HTML fallback, and all `/e2e/` paths return 404. The fault host is built only in e2e mode and cannot be served by the production Worker.

**Next.** The Effect-native API Worker and one `Conversation` Durable Object per conversation, hosting the sequencer and
the agent's flows on `@smthrs/platform-cloudflare` (VL-11).
