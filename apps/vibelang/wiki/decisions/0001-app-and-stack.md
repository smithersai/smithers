# 0001. The app and its stack

**Status:** accepted, 2026-11-07. **Rulings:** VL-1, VL-4, VL-5, VL-6.

**Decision.** vibelang.smithers.sh is `apps/vibelang` in the Smithers monorepo. Its runtime dependencies are `effect`
4.1.1, `foldkit` 0.170.0 (and Foldkit's own `parse5`), `vibelang-runtime` 0.0.12 and
Smithers packages (`@smthrs/flow`, `agent`, `model`, `model-host`, `platform-cloudflare`, `crypto`, `plan`, `ui-css`,
`ui-styleguide`; the live agent, 0010). Build and test tools are `vibelang`, `vibelang-vite`, `vite`, `vitest`,
`@effect/vitest`, `happy-dom`, `@playwright/test` and `alchemy`, and for the workerd suites `miniflare`, `esbuild`
and `vibelang-unplugin`, the versions apps/mvp pins. Effect code is VibeLang (`.vibe`); files with no Effect code stay `.ts`
(the repository rule), which keeps the state machine provable by LemmaScript (0005).

**Why the monorepo.** VL-4 requires Smithers' abstractions; `workspace:` packages are how apps reuse them.

**Dependency policy (VL-5).** Anything else is reference code only. A new runtime dependency needs Will's approval in
chat; record it here. The build and test tools above are listed for Will's review: they ship nothing to browsers or
Workers.

**Consequence.** Foldkit needs Effect `~4.1.0`; the app installed on its own until the monorepo moved to Effect
4.1.1. Since 2026-11-07 it is a workspace package: `pnpm install` at the root installs it, its Smithers packages are
`workspace:*`, and `PACKAGE.ts` declares its targets.
