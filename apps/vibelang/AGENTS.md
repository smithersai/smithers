# apps/vibelang

vibelang.smithers.sh, the VibeLang factory. Read [the wiki](wiki/index.md) first: [Will's rulings](wiki/rulings.md)
(VL-1 to VL-39) are the source of truth for this app, and every decision lands in `wiki/decisions/` in the same change
as its code (VL-23).

## Rules

- **Effect for everything, written in VibeLang; no other runtime dependencies** (VL-4, VL-5). Every file is VibeLang
  (`.vibe`; read `node_modules/vibelang/skills/vibelang/SKILL.md` first), Effect code or not. A file stays `.ts` only
  when a tool reads nothing else, and its first line says which ([0001](wiki/decisions/0001-app-and-stack.md)). A new
  dependency needs Will's approval, recorded in 0001.
- **One state machine** ([0003](wiki/decisions/0003-one-state-machine.md)). Conversation state changes only through
  `src/core/conversation.vibe` (`decide`, `apply`, `receive`). Keep it in LemmaScript's verifiable subset, plain
  TypeScript syntax with no Effect code ([0005](wiki/decisions/0005-formal-verification.md)); a new transition comes with its contract and property.
- **The core is the `Factory` service** ([0002](wiki/decisions/0002-core-is-an-effect-api.md)). Every surface (web,
  CLI, MCP server, skill) calls it; none reaches the network another way.
- **Mock mode always works** (VL-13, [0004](wiki/decisions/0004-mock-mode.md)). A feature lands with its mock layer
  and a browser test that passes against it. The live agent ([0010](wiki/decisions/0010-live-agent.md)) is chosen only
  when the origin's `/api/health` says `live`; `?agent=mock` forces the mock anywhere.
- **Everything is a flow** (VL-11). Agent work runs as `@smthrs/flow` steps; a model call is `@smthrs/agent`'s
  `ModelStep`, never a raw provider call.
- **Styles come from Smithers.** Chat parts use `@smthrs/ui-css` classes (`sui-*`), the stylesheet smithers.sh's React
  chat uses; only the frame and splash are this app's (`src/web/styles.css`).
- **Fix upstream** (VL-7). A bug in VibeLang, Foldkit's VibeLang support, Effect or a Smithers package is fixed there
  with a test, or reproduced minimally and recorded; never worked around here.

## Commands

From this directory, after this install at the repository root (the app is a workspace package; the second filter
is the fuzz flow in `.smithers/flows`, which `pnpm fuzz` checks for first):

```sh
pnpm install --frozen-lockfile --filter "@smthrs/vibelang-site..." --filter "@smithers/release-workflows..."
bash verify/install.sh   # from this directory: Dafny and LemmaScript for pnpm verify
```

The VL-29 gates (unit, fuzz, benchmark and browser coverage, proofs, mutations) each have one command that runs on a
host or a Cloudflare box through `run-heavy`: [0016, "Measuring every gate"](wiki/decisions/0016-coverage.md#measuring-every-gate-lane-vl-gatefix-2026-11-10).

```sh
pnpm dev            # http://localhost:5178
pnpm typecheck      # vibelang -p tsconfig.json
pnpm test           # properties, integration, scenes, surfaces (mock backend)
pnpm test:workerd   # the API Worker's Durable Objects in local workerd, through LiveFactory, the protocol and the CLI
pnpm test:sandboxes-live   # real Cloudflare Containers in the vl-test stage, on demand (0024: deploy:sandboxes-test first)
pnpm agent-context  # regenerate worker/agentContext.vibe after a VibeLang upgrade
pnpm e2e            # browser tests against the built app (dark, light, phone), on the mock
pnpm fuzz:affected  # before land-main: the fuzz targets that reach each changed src/ or worker/ source, at their floor; writes the receipt the landing check needs (0015)
FUZZ_AFFECTED_BOX="$HOME/lanes/bin/run-heavy --name vl-<lane>:{name} --cores 4 --where cfbox --image {image} --writes $PWD --" pnpm fuzz:affected --boxes 4   # the same, split across boxes (0015, session 22)
pnpm wiki:build && pnpm exec alchemy dev --stage dev   # site + API Worker locally at http://localhost:1337 (NODE_OPTIONS=--import=vibelang/register)
E2E_LIVE_URL=http://localhost:1337 pnpm exec playwright test e2e/live.spec.ts   # the live agent in a browser
pnpm run deploy     # Alchemy, with Cloudflare credentials, VIBELANG_DOMAIN and the model's key set (0010)
E2E_BASE_URL=https://vibelang.smithers.sh pnpm e2e   # the same tests against the deployment
```
