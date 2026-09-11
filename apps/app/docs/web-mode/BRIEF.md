# Planning brief — native mode (default) + web mode (funnel) for the Smithers app

Asked by will, 2026-09-02: "We need our app to run both native mode (default)
but also web mode (good funnel). The web mode will not have the same features
as the native mode. ... This web mode will be deployed to cloudflare. ... the
web mode will have a button on it to link to the download page."

Two independent plans (a Fable agent and Codex Sol) are written from this brief,
then a Fable agent reads both and writes the better combined plan. Write a PLAN
AND ARCHITECTURE, not code. Ground every claim in the tree; cite files.

## Facts in the tree (verify them, then build on them)

- `apps/app` is one Vite SPA (`src/mainview`) with two shells today:
  - Native: Electrobun. Bun main process (`src/bun/`) serves the SPA over a
    random loopback origin with a per-launch local-session capability
    (`x-smithers-local-session` header from a `<meta>`), owns the keychain,
    local repositories (`Repos.ts`, `RepoFiles.ts`, `routes/repoTargets.ts`),
    the PTY terminal, the cloud auth browser-login callback (`CloudAuth.ts`),
    the cloud terminal WebSocket tunnel (`/api/cloud-ws/*` in `server.ts`),
    the agent turn relay (`CloudAgent.ts`), and forwards identity + product API
    families to the cloud Worker (`PRODUCT_PROXY_PREFIXES` in `server.ts`).
    `pnpm run start` = ensure-devkit + `vite build` + `electrobun dev`;
    `build:native` = `scripts/build-native.ts`.
  - Web: the Cloudflare Worker `smithers-mvp-web` (`apps/server`,
    `wrangler.jsonc`) serves `../ui/dist` as static assets
    (`not_found_handling: single-page-application`, `run_worker_first` for
    `/api/*`, `/v1/*`, `/workflows/*`) on `canary.smithers.sh`. It owns GitHub
    OAuth / WorkOS sign-in cookies, the chat turn seam (`/v1`, Durable Objects
    `TURN_CANCELS`, `TURN_LIMITS`, `GATEWAY_SESSIONS`, `CLIENT_ERRORS`), and a
    per-route allowlist to Smithers Cloud (`PLATFORM_PROXY_RULES`). Its identity is
    frozen (`apps/server/DEPLOY.md`); `scripts/deploy.ts` builds the SPA and
    deploys with a receipt.
- The SPA already abstracts the shell: `src/mainview/runtime/Runtime.ts`
  (`AppRuntime { bootstrap, http, backend { agent?, identity?, Smithers Cloud?, local? },
  shell: browser | native }`), bootstrap capabilities
  (`@smthrs/rpc/AppBootstrap`, `hasCapability`), `native/WebAgent.ts` (the
  agent over HTTP when no native bridge), `native/NativeBridge.ts`
  (`window.__electrobun`). Every flow in `src/mainview/flows/Flows.ts`
  declares `runtime: [...]` requirements: counts today — Smithers Cloud 80,
  local.targets 20, identity 14, local.repositories 9, local.harnesses 3,
  keys.byok 2, billing.checkout 2, agent 2, local.terminal 1. A flow whose
  runtime is absent is refused honestly (see `flows/Commands.ts`).
- Laws (`apps/app/AGENTS.md`, `apps/DESIGN.md`): EMBED LAW (everything is a card
  in one chat), NO INVENTION (never render a guessed value), no React
  `useEffect`, all state in TanStack DB collections via the dispatcher, every
  act is a flow (slash + agent + button), consequential acts confirm, 300 ms
  toast law, honesty lines generated from the live catalog
  (`state/Instructions.ts`).
- Backend: Smithers Cloud (`~/plue`) — repos mirroring GitHub under users/orgs,
  workspaces (cloud Linux machines with a terminal over WebSocket, Bearer +
  `terminal` subprotocol, 64 KiB frames, close-code contract), changes and
  landing requests, GitHub-synced issues, Linear sync. The Worker bridges the
  cookie session to a Smithers Cloud token for `/api/repos/`, `/api/user/…`,
  `/api/github/import`, `/api/notifications/`; a separate Smithers Cloud PAT flow
  (`/api/auth/github/cli`) exists for the native app (keychain).
- Today's sidebar/surface work in flight (docs/workbench-lanes/sidebar-tree.md):
  repository file tree in the sidebar, sessions (not tabs), Flows surface,
  file panels, maximize beside the sidebar.

## What the plan must decide (each with a recommendation, not a menu)

1. Mode model: how the SPA knows it is web vs native (bootstrap vs bridge
   presence), how features are gated (the existing `runtime` tags vs a new
   capability set), and how the honesty lines say "not in the web app —
   download the native app" instead of a generic refusal.
2. The web feature set (a table: feature → web / native / both, with the
   reason): cloud repos, issues, changes and review, workspaces and their
   terminal (the Bun WebSocket tunnel does not exist in a Worker: Worker
   WebSocket proxy, Durable Object, or direct-to-cloud with a short-lived
   token — pick one and say why, including the token-exposure argument),
   agent chat (chat seam), flows/runs, local repositories (native only),
   local terminal (native only), BYOK keys (where the secret lives), billing.
3. The funnel: what a first-time visitor sees, sign-in, first value in under
   a minute, and the download button (placement under the EMBED LAW and the
   sidebar design; where the download page lives and who builds it; what the
   native app opens to after install so the web session continues — deep
   link / same cookie domain / sign-in handoff).
4. Build and deploy: one SPA build or two (Vite modes, env, tree-shaking the
   native-only code), the Cloudflare topology (the existing frozen Worker vs
   a new production Worker + domain, assets, DOs, secrets), CI targets in
   `BUILD.ts` terms, preview deployments, rollback, the deploy receipt.
5. State and persistence: what web stores where (TanStack DB persistence
   backend in the browser vs the native app's disk), what must never touch
   the browser (tokens), cookie/CSP/isolation headers already present.
6. Testing: how T1 specs run against the web shell (Playwright against
   `wrangler dev` or the Vite preview) without duplicating the native e2e,
   what a "parity matrix" test looks like so a native-only flow can never
   appear enabled on web.
7. Migration path: ordered lanes with file-level scope, what lands first to
   prove the walking skeleton (a visitor signs in on the web, opens a cloud
   repo, reads a file, sees the download button), risks, and open questions
   for will (max five, each with your default).

## Output

One Markdown file, at most ~400 lines, sections in the order above, ASCII
mockups where a screen is described, a final "Lanes" table (lane, files,
tests, depends on). No code beyond signatures. Write it to the path you are
given; do not edit any other file.
