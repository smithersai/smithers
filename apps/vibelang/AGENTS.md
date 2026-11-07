# apps/vibelang

vibelang.smithers.sh, the VibeLang factory. Read [the wiki](wiki/index.md) first: [Will's rulings](wiki/rulings.md)
(VL-1 to VL-26) are the source of truth for this app, and every decision lands in `wiki/decisions/` in the same change
as its code (VL-23).

## Rules

- **Effect for everything; no other runtime dependencies** (VL-4, VL-5). Effect code is VibeLang (`.vibe`; read
  `node_modules/vibelang/skills/vibelang/SKILL.md` first). Files with no Effect code stay `.ts`. A new dependency needs
  Will's approval, recorded in [0001](wiki/decisions/0001-app-and-stack.md).
- **One state machine** ([0003](wiki/decisions/0003-one-state-machine.md)). Conversation state changes only through
  `src/core/conversation.ts` (`decide`, `apply`, `receive`). Keep it plain TypeScript in LemmaScript's verifiable
  subset ([0005](wiki/decisions/0005-formal-verification.md)); a new transition comes with its contract and property.
- **The core is the `Factory` service** ([0002](wiki/decisions/0002-core-is-an-effect-api.md)). Every surface (web,
  CLI, MCP server, skill) calls it; none reaches the network another way.
- **Mock mode always works** (VL-13, [0004](wiki/decisions/0004-mock-mode.md)). A feature lands with its mock layer
  and a browser test that passes against it.
- **Styles come from Smithers.** Chat parts use `@smthrs/ui-css` classes (`sui-*`), the stylesheet smithers.sh's React
  chat uses; only the frame and splash are this app's (`src/web/styles.css`).
- **Fix upstream** (VL-7). A bug in VibeLang, Foldkit's VibeLang support, Effect or a Smithers package is fixed there
  with a test, or reproduced minimally and recorded; never worked around here.

## Commands

From this directory, after `pnpm install` at the repository root (the app is a workspace package):

```sh
pnpm dev            # http://localhost:5178
pnpm typecheck      # vibelang -p tsconfig.json
pnpm test           # properties, integration, scenes
pnpm e2e            # browser tests against the built app (dark, light, phone)
pnpm run deploy     # Alchemy, with Cloudflare credentials and VIBELANG_DOMAIN set
E2E_BASE_URL=https://vibelang.smithers.sh pnpm e2e   # the same tests against the deployment
```
