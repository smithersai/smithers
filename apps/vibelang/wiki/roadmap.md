# Roadmap

Bricks in order. A brick is done when its end-to-end test passes against the deployment (TEST-1).

```
brick                                   state         proof
1a  splash, ⌘K, chat, mock agent        done          e2e/chat.spec.ts (dark, light, phone); 25 unit/property/scene tests
1b  live agent on Cloudflare            next          a Durable Object per conversation runs the sequencer; the reply is an
                                                      @smthrs/agent flow step (VL-11); LiveFactory replaces MockFactory
1c  dogfooding surfaces                 done (mock)   CLI, MCP server and skill over Factory; 21 surface tests plus the existing
                                                      25 tests; emitted CLI + stdio McpClient + exact schema parity (0009).
                                                      Live dogfooding awaits 1b; local and deployed browser suites pass.
1d  formal proofs in CI                 in progress   local `pnpm verify` proves conversation.ts; `pnpm verify:broken` checks mutations;
                                                      CI wiring remains (0005, VL-9)
1e  wiki in the app                     next          /wiki renders these pages as a maximizable pane (VL-17, VL-23)
2   sign-in and roles                   later         GitHub sign-in; viewer, new, community, contributor, maintainer (VL-21)
3   issues as a tree, tasks, VIPs       later         VL-20
4   actions and slash commands          later         VL-24
5   mythical history                    later         VL-22
6   sandboxes with minutes              later         VL-25
7   Electrobun desktop app              later         VL-6
```

## Open work outside this app

- **The monorepo moves to Effect 4.1.1, VibeLang 0.0.12 and Alchemy beta.85.** Foldkit 0.170 needs Effect `~4.1.0`,
  Alchemy beta.85 needs `^4.1.0` and `vibelang-runtime` 0.0.12 pins 4.1.1, while the monorepo pins 4.0.5. Until that
  lands, this app installs on its own (`pnpm run setup`, excluded in the root `pnpm-workspace.yaml`)
  and links `@smthrs/ui-css` and `@smthrs/ui-styleguide` with `link:`. After it lands: join the workspace, switch to
  `workspace:*`, delete the standalone pnpm-workspace.yaml and `setup` script and the `resolve.alias` and `paths` entries for the style guide.
- **Alchemy's state store.** Alchemy beta.85 keeps state in format v8; apps/mvp's beta.83 keeps the account's default
  store at v7. This stack uses its own store, `smithers-vibelang-state` (infra/Stack.vibe). Moving apps/mvp to beta.85
  migrates the default store, so that deploy and the migration happen together.
- **`@smthrs/ui-css`** holds `@smthrs/ui`'s framework-free CSS so React and Foldkit share one stylesheet.
