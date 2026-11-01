---
title: Remote flows and their features in production
status: in-progress
area: platform
owner: prodflows-store (Codex)
updated: 2026-10-21 23:30 PDT
links: [../features/remote-flows.md, ../features/todos.md, ../features/spend-alerts.md, ../features/repo.md, ../features/branch-workspace.md, ../infrastructure.md, prod-e2e.md, land-and-deploy-mvp.md]
---

**What:** In production, webhook issue sync, clone, TODO runs, spend alerts, role checks, answer expiry and sign-out's token revocation each run, proven by an e2e test. The flow engine's `MigrationError` on every alarm is the `prod-remote-flows` builder's; this note covers what breaks each feature once migrations apply.

**Found, 2026-10-21 (four-model panel, checked against the code):**
- TODO runs: a TODO's machine cloned its branch through the deployment's forge, the Code Storage mirror, which never has the branch `todo/Begin` makes on GitHub. Every production run would fail at checkout; `alchemy dev` has no Code Storage, so the live loop passed there. ChatApi also ran at the default 30 s of CPU per alarm, and an alarm gets 15 minutes of wall time against `todo/Implement`'s 40.
- Spend alerts: a server flow's model calls (the TODO agent, triage's judge) never started their window's alert.
- Clone and About: GitHub REST reads went out anonymously, 60 an hour per IP shared with every Worker on Cloudflare's addresses; 3 of 5 About reads answered 503.
- Electric's container held Postgres' direct URL, password included, as plain container configuration that the Cloudflare API returns.
- Webhook sync, role checks, answer expiry and revocation need nothing beyond the migration fix and a Member session.

**Built, 2026-10-21 10:00 to 10:31 PDT:**
- A TODO's machine reads its branch from GitHub (`SandboxBranch.forge`, `Forge.forgeOf`); ChatApi has five minutes of CPU; a test kills the engine mid-implement and shows the resume re-asks only the unanswered frame.
- Server seats start their window's spend alert (`Executions.starter`).
- GitHub reads go out as the App's installation token for `GITHUB_REPOSITORY`, `metadata: read` (`worker/github/ReadToken.ts`). Checked live: such a token reads other public repositories at 9,400 calls an hour.
- Electric's `DATABASE_URL` is the gateway Worker's secret binding, passed at container start. `alchemy plan --stage prod` from the workspace: 6 updates, 2 binding changes, no errors.
- `e2e/remote-flows.spec.ts` and a Cloudflare tail for `LogTail` in a deployment. `e2e/logs.test.ts` opened a live tail on production and saw the record of its own signed-out read.

**Not built, by decision (merged plan):** durable spend-alert admission after a failed start, keeping sign-out's tokens past five failed revocations, an authority re-check before a TODO's Publish, and a staging stage.

**Production, 2026-10-21:**
- 11:47 PDT: deployed 931fed704f46 (the migration fix, the factory stack, these fixes and the sandboxes fixes); the first attempt failed "Script startup exceeded CPU time limit", the retry passed. Electric's container environment names: `ELECTRIC_INSECURE`, `ALCHEMY_CLOUDFLARE_ACCOUNT_ID` (no `DATABASE_URL`); the repositories and messages shapes answer 200; About answers 200.
- Engine records (`smithers_flows.flows_runs`): `auth/RevokeGitHubToken` 2 completed, `auth/RecheckRole` 1 completed, `chat/Expire` 13 completed and 22 waiting, `github/Apply` 8 and `github/Reconcile` 28 completed, `repo/Clone` 6 completed, `ops/SpendAlert` 5 completed.
- ChatApi's startup was 416 to 735 ms (Cloudflare's `startup_time_ms` on a scratch upload); its program now loads when the Worker first builds it. 12:35 PDT: deployed b1bab88a7393; the deployed bundle starts in 64 to 76 ms, and `terminal/Open` and `sandbox/Call` completed after the deploy.
- `e2e/remote-flows.spec.ts` against production: the issues sync passed (a walk of its own, 10 min, 12:48); the signed webhook's `github/Apply` passed at 12:20 and then missed its record once to a tail that had not started streaming (fixed: a new tail waits until it streams).

**Review findings fixed (2026-10-21):** a model call larger than the whole daily budget is refused; only a Member's About read spends the deployment's GitHub token; a clone request is persisted and answered at once, its launch a durable second step of `repo/clone`; a transient About 503 is retried by the `repo/about` flow; a branch made without a head change shows in the refs (migration `refs_changed_at`); a failed alert-channel save clears once another device saves.

**Waiting on:** the long production run (`E2E_LONG=1`: spend alert, answer expiry, role check, the TODO run on `roninjin10/smithers-github-tests`), after the sandboxes builder's production e2e.

**Device store correction:** Repository cache v4 resyncs through `Migrations.synced` (`@smthrs/effect-tanstack-db`, library catalog: carry device stores across deploys), per decision 0021. The deployed v3 schema and fixture remain immutable and validated against their recorded fingerprint. No local row migration applies to this server-backed cache.
