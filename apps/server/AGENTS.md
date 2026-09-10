# Worker implementation

- Use Effect for service implementation, I/O, resource lifetimes, concurrency,
  cancellation, and failures. Services expose Effects and receive dependencies
  through typed Effect services and Layers. Effect v4 is authoritative; read
  `node_modules/effect/src` before guessing an API. `docs/EFFECT.md` is the
  map of the program.
- Promise interop lives only at the platform boundaries `docs/EFFECT.md`
  lists (`src/Http.ts`, `src/DurableStorage.ts`, `src/Boundary.ts`,
  `src/Worker.ts`, and a native Durable Object class's `fetch` line marked
  `// effect-policy: boundary`). `pnpm run check:effect` enforces it; run
  `pnpm run check` (typecheck + policy) before landing.
- Use Alchemy's Effect-native Cloudflare Worker and binding APIs for deployment
  and runtime dependency injection (`src/Worker.ts`, `alchemy.run.ts`). The
  installed `node_modules/alchemy/src` is the reference; cite `file:line` when
  a deploy behaviour matters.
- Preserve HTTP contracts and the deployed Worker name, domains, Durable Object
  class identities AND binding names, and persisted storage keys during
  implementation refactors. `src/workerIdentity.ts` is the one place those
  facts live; `src/workerIdentity.test.ts` pins it and holds `wrangler.jsonc`
  (the adoption bridge, never edited for a deploy) to it. A change there is a
  DEPLOY.md cutover-log entry in the same commit.
- Secrets are declared by name in `WORKER_IDENTITY.secrets` and read through
  `Config` in `src/Worker.ts`; an Alchemy deploy drops any secret the deploying
  shell does not supply. The same is true of `WORKER_IDENTITY.optionalVars`:
  Alchemy records every init-phase `Config` as a Redacted output, so a knob
  read with `Config.string` deploys as `secret_text` too. Never print a secret
  value, in code or in a report.
- Deploys go through `scripts/deploy.ts` (preflight, then `alchemy deploy
  --stage prod --adopt --yes`). Never deploy, `--apply`, or mutate Cloudflare
  or Alchemy state from an agent session; plan and preflight are read-only and
  are the most an agent may run.
- Run the Alchemy CLI under bun, on its own TypeScript entry
  (`bun node_modules/alchemy/bin/alchemy.ts <command>`). `node_modules/.bin/alchemy`
  re-execs under node unless the environment names bun (`alchemy bin/cli.js:98-116`),
  and node cannot resolve this package's extensionless imports. `alchemy plan`
  evaluates the program, needs no credential, and reads no live script, so it
  is never the adoption verdict — `bun scripts/adopt-durable-objects.ts` is.
- A Durable Object's in-memory state is made once by the object (the native
  class's field, and the `layers` callback `src/Worker.ts` runs in the
  per-object Effect), never a Layer built per request: the client-error
  throttle `Ref` and the gateway registry's resolution join map.
- A Durable Object that talks to an upstream needs the deployment's config.
  `src/Worker.ts` builds the resolved env bag BEFORE it registers the exports
  and passes it to `durableObjectClasses(deployment)`; the gateway registry
  provisions inside the object, so an empty bag is a silent `/api/workflow/*`
  outage. `src/Worker.test.ts` pins it.
- This package is the UI gateway. Changes to sandbox execution or frontend
  framework code belong to their owning packages.
