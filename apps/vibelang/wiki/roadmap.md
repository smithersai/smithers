# Roadmap

Bricks in order. A brick is done when its end-to-end test passes against the deployment (TEST-1).

```
brick                                   state         proof
1a  splash, ⌘K, chat, mock agent        done          e2e/ (dark, light, phone) passes against the deployment; Astra and Fable
                                                      reviews fixed (25 findings), each with a test that failed first
1b  live agent on Cloudflare            done (local)  0010: a Durable Object per conversation runs the sequencer and its reply's
                                                      durable flow (@smthrs/agent ModelStep, engine in the object's SQLite);
                                                      LiveFactory over HTTP + SSE. `pnpm test:workerd` 8 passed (+1 opt-in
                                                      real-model case); `alchemy dev` + e2e/live.spec.ts pass. Deploy is next.
1c  dogfooding surfaces                 done (mock)   CLI, MCP server and skill over Factory; 21 surface tests plus the existing
                                                      25 tests; emitted CLI + stdio McpClient + exact schema parity (0009).
                                                      Live mode uses LiveFactory at VIBELANG_FACTORY_URL (0010).
1d  formal proofs                      done (local)  `pnpm verify`: 28 contracts on conversation.vibe; `pnpm verify:broken`: 48/48
                                                      mutations rejected. Running them in CI comes with the app's PACKAGE.ts.
1f  Learn more: the agent's tour         done (local)  0014: the agent opens the docs in a pane and narrates, glow and Esc;
                                                      mock and live run one tour flow; scene, flow, workerd and browser tests
1g  every suite covers the whole app    started       VL-29: unit, fuzz and benchmark coverage at 100% each; proofs of
                                                      all logic; fuzzing from the Effect fork as @smthrs/fuzz
1e  wiki in the app                     next          /wiki renders these pages as a maximizable pane (VL-17, VL-23)
2   sign-in and roles                   in progress         GitHub sign-in; viewer, new, community, contributor, maintainer (VL-21)
3   issues as a tree, tasks, VIPs       later         VL-20
4   actions and slash commands          later         VL-24
5   mythical history                    later         VL-22
6   sandboxes with minutes              later         VL-25
7   Electrobun desktop app              later         VL-6
```

## Open work outside this app

- **Effect 4.1.1 upgrade landing (2026-11-07).** 57 commits in nyc-01 `~/vl/ws-effect41`; all typecheck/check gates
  pass. Lane `vl-e41land` classifies each remaining red as pre-existing or introduced and fixes introduced ones before
  it lands. Reproductions of upstream defects it found: `~/vl/vibelang-bugs/` and
  `~/vl/effect41-evidence/` on nyc-01.
- **VibeLang bugs to fix upstream** (reproductions on nyc-01 under `~/vl/vibelang-bugs/`): `vibelang-error-subclass-is`
  (after `--fix`, `is` stops matching a subclass of an error), `vibelang-format-npm-reference` (the formatter can't
  resolve its shipped binary on Linux). EK4802 on Effect CLI Commands is fixed and queued (`1794050628-ek4802`).
- **Done: the app is a workspace package (2026-11-07).** With the monorepo on Effect 4.1.1, VibeLang 0.0.12 and
  Alchemy beta.85, `apps/vibelang` installs with the repository (`workspace:*` Smithers packages, no standalone
  lockfile, `setup` script or style-guide alias) and declares its targets in `PACKAGE.ts`.
- **Alchemy's state store.** Alchemy beta.85 keeps state in format v8; apps/mvp's beta.83 keeps the account's default
  store at v7. This stack uses its own store, `smithers-vibelang-state` (infra/Stack.vibe). Moving apps/mvp to beta.85
  migrates the default store, so that deploy and the migration happen together.
- **`@smthrs/ui-css`** holds `@smthrs/ui`'s framework-free CSS so React and Foldkit share one stylesheet.

- Brick 2 policy and shared authentication: decision [0019](decisions/0019-sign-in-and-roles.md); lane vl-roles.
