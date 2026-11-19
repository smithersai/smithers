---
"@smthrs/build-infra": patch
---

`node scripts/deploy.ts --cache-only` deploys a stage without the sandbox service: no sandbox Worker, no container applications, no image build, and no `SMITHERS_SANDBOX_TOKEN`, so the stage needs only Cloudflare credentials and the two cache tokens. `pnpm run deploy:dev` passes it; `pnpm run deploy` (production) does not, and production's stack is unchanged. The wrapper sets `SMITHERS_BUILD_INFRA_CACHE_ONLY` for every run, so a value exported in the shell has no effect; it refuses Alchemy's `--env-file`, which Alchemy reads before the process environment and could use to override that variable or `SMITHERS_BUILD_INFRA_STATE_SYNCED`; and it refuses a cache-only run of a stage whose state records a sandbox Worker, which Alchemy would otherwise delete. A cache-only deployment's outputs have no `sandboxUrl`.
