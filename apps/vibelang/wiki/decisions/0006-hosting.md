# 0006. Hosting

**Status:** accepted, 2026-11-07. **Rulings:** VL-3, VL-4.

**Decision.** One Alchemy stack, `smithers-vibelang` (`infra/Stack.vibe`): the Vite build served by a Cloudflare
Worker with static assets and single-page-app fallback (`worker/index.ts`). The hostname comes from the deployment's
`VIBELANG_DOMAIN` (vibelang.smithers.sh for ours), so the public stack names no domain, as `apps/mvp` does with
`APP_DOMAIN`. `/api/health` reports which agent the deployment runs (`mock` until roadmap 1b).

**Next.** The Effect-native API Worker and one `Conversation` Durable Object per conversation, hosting the sequencer and
the agent's flows on `@smthrs/platform-cloudflare` (VL-11).
