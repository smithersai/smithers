---
title: Development filesystem serving and rule scope checks
status: done
area: mvp
owner: codex-fix-apps-mvp-023236
updated: 2026-10-21
links: []
---

Reproduce the Vite filesystem restriction, Jev scope matcher, and production Electric fallback findings. Use the real Vite middleware and rule scopes; no new runtime actions or library choices.

Confirmed regressions:
- An actual Vite server returned HTTP 200 for a temporary file outside its workspace. Enabling `server.fs.strict` returns 403 while workspace package metadata remains available.
- Jev scopes skipped `worker/.private/Source.ts` under `worker/**/*.ts`. Scope checks now use minimatch 10.2.6 with `dot: true`, matching the existing build checker; import scopes retain `node:path.matchesGlob`.

Latitude receipts: baseline PACKAGE.test.ts and dev/https.test.ts: 182 passed. Added regressions: 2 failed for the stated reasons, 182 passed. After fixes: PACKAGE.test.ts, dev/vite-fs.test.ts and dev/https.test.ts: 184 passed (`pnpm exec vitest run ... --coverage.enabled=false`). Coverage is disabled for these focused configuration tests, rather than measuring all app features. The reused farm install needed the newly declared minimatch dependency linked from its existing build-target installation.

The production Electric fallback is unreachable by construction: `electric` returns undefined only under `ALCHEMY_DEV`; production supplies the gateway endpoint or fails provisioning. No failing behavioral test was reproduced, so alchemy.run.ts is unchanged.

Mac mini: `pnpm e2e start-app.spec.ts` was requested with the original Vite config for an A/B baseline. It remained queued behind the shared browser lock for over two minutes and was cancelled before execution. Browser smoke checks remain unverified; no browser pass is claimed.
