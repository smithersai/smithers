# 0001. The app and its stack

**Status:** accepted, 2026-11-07. **Rulings:** VL-1, VL-4, VL-5, VL-6.

**Decision.** vibelang.smithers.sh is `apps/vibelang` in the Smithers monorepo. Its runtime dependencies are `effect`
4.1.1, `foldkit` 0.170.0 (and Foldkit's own `parse5`), `vibelang-runtime` 0.0.12 and
Smithers packages (`@smthrs/flow`, `engine` (its in-memory engine, for the mock: 0011), `agent`, `harness` (the agent's workerd sandbox: 0012), `registry`, `model`, `model-host`, `platform-cloudflare`, `crypto`, `plan`, `ui-css`,
`ui-styleguide`; the live agent, 0010). Build and test tools are `vibelang`, `vibelang-vite`, `vite`, `vitest`,
`@effect/vitest`, `happy-dom`, `@playwright/test` and `alchemy`, and for the workerd suites `miniflare`, `esbuild`
and `vibelang-unplugin`, the versions apps/mvp pins.

**Language (VL-4).** Every file is VibeLang (`.vibe`), Effect code or not: Will, 2026-11-07, "We are writing it in
vibelang". This overrides the repository rule that files with no Effect code stay `.ts`. Platform access goes through
Effect's and VibeLang's services (`Stdio`, `Config`, `FileSystem`, `Path`, `ChildProcess`, `HttpClient`,
`SecureRandom`, and `Experimental.Window`, `Document`, `MediaQuery` and `Process`). The browser services add 45 KB
(15 KB gzipped) to the page until vibelang-runtime declares `sideEffects`, which brings that to 5.5 KB
(`upstream-bugs/vibelang-runtime-tree-shaking`). The state machine is VibeLang too; LemmaScript proves an exact `.ts`
copy of its text (0005). A file stays `.ts` only when a tool reads nothing else, and its first
line says which:

| Files | The tool that requires `.ts` |
| --- | --- |
| `vite.config.ts`, `test/mutations/room-isolation.config.ts` | Vite's config loader, for Vite and Vitest, bundles JS/TS only |
| `playwright.config.ts`, `e2e/*.spec.ts` | Playwright loads configs and collects test files by JS/TS extension only |
| `alchemy.run.ts` | the Alchemy CLI's entry; it re-exports `infra/Stack.vibe` |
| `PACKAGE.ts` | `smthrs` discovers targets only in files of that name |
| `verify/bugs/*.ts` | LemmaScript defect reproductions, in the TypeScript LemmaScript reads |
| Desktop `electrobun.config.ts`, `vite.config.ts`, `playwright.config.ts`, `PACKAGE.ts` and `e2e/desktop.spec.ts` | the named build/config loaders and Playwright discovery read JS/TS files only; first-line comments name them |
| Host `Electrobun.d.ts` | TypeScript resolves the foreign native API from declaration files; no implementation lives in this port |
| `test/viewport.test.ts`, `test/support/browser.ts`, `test/support/scrollHost.ts` | they drive happy-dom through DOM globals, EK4402 in VibeLang, which no Effect service provides |

The last row and the specs' page callbacks (`page.evaluate(() => window.scrollY)`, also EK4402) are VibeLang gaps,
reproduced as `upstream-bugs/vibelang-dom-test-globals` and `upstream-bugs/playwright-vibe-specs` on the build host.

**Why the monorepo.** VL-4 requires Smithers' abstractions; `workspace:` packages are how apps reuse them.

**Dependency policy (VL-5).** Anything else is reference code only. A new runtime dependency needs Will's approval in
chat; record it here. The build and test tools above are listed for Will's review: they ship nothing to browsers or
Workers.

**Consequence.** Foldkit needs Effect `~4.1.0`; the app installed on its own until the monorepo moved to Effect
4.1.1. Since 2026-11-07 it is a workspace package: `pnpm install` at the root installs it, its Smithers packages are
`workspace:*`, and `PACKAGE.ts` declares its targets.

**0024 SDK declaration.** The app now declares `@smthrs/sandbox` directly (it was already in the `@smthrs/platform-cloudflare` transitive closure) to use its command fences and bounded tools. No external runtime library is added. `@smthrs/fuzz` is a monorepo development tool; 0008 records its VL-5 review status.

The SDK native test's `test/native/config.ts` remains TypeScript because Vite loads its global setup configuration
before installing the VibeLang plugin. It also holds the foreign synchronous constructor transport and X11 tooling.
The native host and its behavioral tests remain VibeLang.

The desktop designer's reference directory, including its source helpers and rendered examples, is preserved verbatim under `wiki/designs/desktop/`; those archival artifacts are not application modules.
