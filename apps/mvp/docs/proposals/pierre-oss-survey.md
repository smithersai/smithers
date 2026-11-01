# Pierre's open source: what Smithers adopts or upgrades

Status: surveyed 2026-10-21 for Will's request of about 13:10 ("go through this and all of the great oss code pierre has released and see what we can add to our current component library or upgrade", on [On highlighting code](https://pierre.computer/writing/on-highlighting-code)). One upgrade is built; everything else is a recommendation.

**Summary.** Of Pierre's 26 published packages and 7 repositories, only `@pierre/diffs` earns a change now: we pin 1.5.2 today and move to 1.6.1 once it is a day old, while the new `@pierre/highlights` renders our review diffs 30 times faster than our Shiki but recolors code and can't color VibeLang, so switching to it is Will's call.

**In one paragraph.** `@smthrs/repo-view` and the review flow use `@pierre/diffs` 1.3.6; nothing else of Pierre's is a direct dependency (`@pierre/theme` and `@pierre/theming` arrive through it, and `@pierre/storage` is banned by ruling ARCH-13 in favor of `@smthrs/effect-code-storage`). Diffs 1.5.2 (2026-10-05) is the newest version that is both at least a day old (SDK-15) and works: 1.6.0 (2026-10-20 20:30 UTC) can't resolve its default themes, so the review flow's server rendering throws, and 1.6.1, which fixes it, was published at 18:05 UTC today. The 1.5.2 upgrade is built, with the code view's worker pool rewritten on pierre's new initialization timeout and error hook (192 lines to 156). 1.6.1 cuts the code views' first JavaScript by 24% (136.8 to 104.0 KB brotli) and makes Highlights one option away. Highlights is the headline: on a 98-file, 410 KB patch from this repository, the review flow's server rendering drops from 1,980 ms to 67 ms in Node, and a 24 KiB TypeScript file's first highlight drops from 901 ms to 13 ms. It changes how code looks (about 3 in 10 TypeScript characters change color under our Night Owl themes, JSON most of all) and renders `.vibe` files as plain text, because it runs hand-written lexers and can't load our TextMate grammar. `@pierre/trees` adds search, git status and virtualization to a file tree, but costs 60 KB brotli with a Preact runtime inside our React app; we keep our `FileTree`.

## What we used before this change

| Pierre package | Version | Where | How |
|---|---|---|---|
| `@pierre/diffs` | 1.3.6 (`^1.3.6`) | `packages/smithers/ui/repo-view` | `CodeFileView` renders a file through `File` in a one-worker pool (`src/workerPool.ts`); `PierreDiffView` renders patches through `CodeView`; `.vibe` files get our TextMate grammar through `registerCustomLanguage` (`src/vibe.ts`) |
| `@pierre/diffs` | 1.3.6 (`^1.3.6`) | `.smithers/flows` | the review flow prerenders each file's patch to static HTML with `preloadPatchDiff` (`review/src/diffs/renderPierreFileDiff.ts`) |
| `@pierre/theme` 2.0.0, `@pierre/theming` 1.0.1 | transitive | through `@pierre/diffs` | default themes and theme resolution |
| `@pierre/storage` | none | banned in `apps/mvp/PACKAGE.ts` | Code Storage goes through `@smthrs/effect-code-storage` (ARCH-13) |

`@smthrs/ui` itself uses nothing of Pierre's. It has its own `FileTree` (282 lines, not virtualized), `DiffHunks`, a `CodeBlock` with a synchronous highlighter seam, and a 94-line regex highlighter for TypeScript, JavaScript and VibeLang on a repository home (`src/repository-home/highlight.ts`). The only palette, Paper, highlights with Shiki's `night-owl` and `night-owl-light`.

## Every package and repository, with a verdict

Sizes are npm's unpacked size. Runtime is what the package states; "DOM" means a browser page. Confidence is that the verdict is right.

| Package or repository | What it does | Maturity, license, size | Runtime | Verdict | Confidence |
|---|---|---|---|---|---|
| `@pierre/diffs` | File, diff and review renderer: shadow DOM, virtualized `CodeView`, worker pool, SSR, editing | 1.6.1 (2026-10-21), 109 versions; Apache-2.0; 11.0 MB | DOM; SSR in Node and Bun | **Upgrade** to 1.5.2 now (built); to 1.6.1 after 2026-10-22 18:05 UTC | 90% |
| `@pierre/highlights` | Syntax highlighter in hand-written WebAssembly Text lexers; HTML, tokens, streams, incremental edits | 0.2.0 (2026-10-21), "experimental"; Apache-2.0; 1.5 MB, 80 languages | Node, browsers, Workers (`workerd` export); ran in Bun 1.4.2 | **Recommendation for Will:** the backend for code views and the review flow once VibeLang is covered | 60% |
| `@pierre/trees` | Path-first file tree: virtualized, search, git status, drag and drop, context menu, SSR | 1.0.0-beta.6 (2026-07-25); Apache-2.0; 1.5 MB; bundles Preact 11 beta | DOM; SSR | **Skip**; borrow its prepared-input and virtualization ideas if a 50,000-path tree proves slow | 70% |
| `@pierre/theming` | Theme catalog, resolver and controller; derives UI colors from a Shiki theme | 1.0.2 (2026-10-21); Apache-2.0; 0.2 MB | All | **Skip** (comes with diffs); borrow "derive surface colors from the syntax theme" if we add palettes | 80% |
| `@pierre/theme` | Pierre's light and dark color themes, with color-blind variants, for VS Code, Zed and Shiki | 2.0.0 (2026-07-24); Apache-2.0 on npm, MIT repository; 0.8 MB | All | **Skip**; switching Paper to `pierre-light`/`pierre-dark` is a look change for Will | 85% |
| `@pierre/icons` | Pierre's icon library as React components | 0.9.0 (2026-09-17); Apache-2.0; 1.4 MB, 1,881 files | DOM | **Skip**: we draw a few inline SVGs | 85% |
| `@pierre/vscode-icons` | File-type icon theme for VS Code and Cursor | 0.0.9 (2026-05-08); MIT; 0.1 MB | VS Code | **Skip**; file-type icons in our tree are a look change for Will | 75% |
| `@pierre/path-store` | Path-keyed tree store under `@pierre/trees` | 1.0.0-beta.1 (2026-04-20), private in the repository; Apache-2.0 | All | **Skip** (internal to trees) | 90% |
| `@pierre/truncate` | React text truncation | 0.0.2 (2026-03-21); Apache-2.0 | DOM | **Skip** (two releases in two minutes, none since) | 85% |
| `@pierre/storage` | Code Storage SDK | 1.17.1, 1.18.0-beta.1; MIT; zod 3, jose | Node, browsers | **Skip** (ARCH-13); read it when `@smthrs/effect-code-storage` needs a new endpoint | 95% |
| `@pierre/just-code-storage` | A `git` command for `just-bash`, backed by Code Storage | 0.1.1 (2026-06-04); Apache-2.0 | Node | **Skip**: our sandboxes run real git | 95% |
| `@pierre/vercel-code-storage` | Deploys a Code Storage repository to Vercel | 0.1.0 (2026-06-09); MIT | Node | **Skip**: we host on Cloudflare (SCOPE-8) | 99% |
| `@pierre/storage-elements-next` | Next.js elements for storage | 0.0.7 (2025-10-14); no license | Next.js | **Skip** | 99% |
| `@pierre/precision-diffs`, `@pierre/file-tree` | The earlier names of diffs and trees | 0.6.1 (2025-12), 0.0.1-beta.1 (2026-01) | DOM | **Skip** (superseded) | 99% |
| `@pierre/eslint`, `prettier`, `typescript`, `vercel`, `recipes`, `preview` | Pierre's 2023 to 2025 config recipes | 2.0.0 and older | Node | **Skip** | 95% |
| `@pierre/sdk`, `sandbox`, `cli`, `sessions`, `mergeset` | Name reservations, 0.0.0, about 100 bytes each | 2026-09 and 10 | none | **Skip**; watch `sandbox` and `mergeset` | 99% |
| `@pierre/pipes` (monorepo only) | The Windows 3D Pipes screensaver in WebGL2 | 1.0.0, unpublished | DOM | **Skip** | 99% |
| `pierrecomputer/pierre` | The monorepo of all the above, plus diffs.com, diffshub.com, trees.software and agent skills for diffs, highlights, theme, theming and trees | Apache-2.0, 6,298 stars, pushed today | | Source of the verdicts above | |
| `pierrecomputer/theme`, `vscode-icons`, `icons`, `sdk`, `just-code-storage` | Standalone repositories of the packages above (`sdk` adds a Python Code Storage SDK) | MIT or Apache-2.0 | | As their packages | |
| `pierrecomputer/checkout` | A GitHub Action that checks out a Code Storage repository | MIT | GitHub Actions | **Skip**: Smithers has no GitHub Actions (GH-1) | 99% |

## The evidence

Everything was measured on 2026-10-21 on a Linux x64 server with Node 26.5.0 and Bun 1.4.2, on inputs from this repository: `CodeFileView.tsx` (24 KiB TSX), 517 KiB of `apps/mvp/src` TypeScript, `catalog.mvp.json` (363 KiB), `rulings.md` (81 KiB), and the 98-file, 410 KB patch of `apps/mvp/src` and `apps/mvp/worker` from `08d98613b5-` to `821e4c78c3`. Each number is one fresh process; "warm" is the median of later runs in it. The scripts are in [the appendix](#appendix-the-benchmark-scripts).

### Diffs: the review flow's server rendering

`preloadPatchDiff` per file, unified, `themeType: "system"`, as `renderPierreFileDiff` calls it.

| Diffs | Highlighter | Node cold | Node warm | Node RSS | Bun cold | Bun warm | Bun RSS |
|---|---|---|---|---|---|---|---|
| 1.3.6 (today) | Shiki | 3,331 ms | 2,158 ms | 323 MB | 5,688 ms | 2,488 ms | 204 MB |
| 1.5.2 | Shiki | 3,407 ms | 2,208 ms | 317 MB | 5,691 ms | 2,498 ms | 199 MB |
| 1.6.0 | Shiki | throws `UnregisteredThemeError: No loader registered for theme "pierre-dark"` | | | same | | |
| 1.6.1 | Shiki | 3,250 ms | 1,980 ms | 316 MB | 5,412 ms | 2,199 ms | 187 MB |
| 1.6.1 | Highlights 0.2.0 | 137 ms | 67 ms | 149 MB | 135 ms | 75 ms | 101 MB |

1.6.0 pins `@pierre/theming` 1.0.1, under which its default theme `pierre-dark` has no loader. 1.6.1's release note is "Fix broken theming dep"; it pins theming 1.0.2 and renders.

### Diffs: what a page with a code view loads

esbuild 0.25.10, minified, split, React external, bundling exactly the imports `@smthrs/repo-view` makes. "First load" is the entry and the chunks it imports statically; the rest load on demand.

| Diffs | Page first load (raw / gzip / brotli) | Page, every chunk (brotli) | Worker |
|---|---|---|---|
| 1.3.6 | 599.7 / 166.7 / 136.8 KB | 1,618 KB | one 607.7 KB file (146 KB brotli) |
| 1.5.2 | 630.6 / 175.9 / 143.8 KB | 1,625 KB | the same |
| 1.6.0 and 1.6.1 | 477.5 / 128.5 / 104.0 KB | 1,801 KB | a 13.7 KB brotli entry; grammars and Highlights load on demand |

1.5.2 costs 7 KB brotli more on first load; 1.6.1 saves 32.8 KB (24%) against today. The larger total in 1.6 is Highlights' lazily loaded chunks, which a Shiki page never fetches.

### Highlights against Shiki, on our files

Shiki 4.4.3 with the JavaScript regex engine, which is what diffs runs (`preferredHighlighter: "shiki-js"`), against Highlights, both rendering HTML with `night-owl`.

| File | Shiki cold / warm (Node) | Highlights 0.2.0 cold / warm (Node) | Shiki cold / warm (Bun) | Highlights 0.2.0 cold / warm (Bun) |
|---|---|---|---|---|
| 24 KiB TSX | 900.8 / 132.0 ms | 13.3 / 0.5 ms | 1,952.7 / 102.3 ms | 24.0 / 0.7 ms |
| 517 KiB TypeScript | 3,478.7 / 2,491.3 ms | 23.3 / 3.9 ms | 4,208.0 / 3,084.6 ms | 33.5 / 7.0 ms |
| 363 KiB JSON | 413.0 / 297.4 ms | 18.8 / 1.0 ms | 624.0 / 459.1 ms | 24.0 / 2.1 ms |
| 81 KiB Markdown | 131.6 / 17.5 ms | 15.6 / 0.2 ms | 226.3 / 94.3 ms | 16.1 / 0.2 ms |

Peak RSS on the 517 KiB file: Shiki 303 MB, Highlights 66 MB. Highlights 0.1.3, the version diffs 1.6.0 pins, measures within 15% of 0.2.0.

**It recolors code.** Share of non-whitespace characters drawn in the same color, same theme:

| File | `night-owl` | `night-owl-light` |
|---|---|---|
| 24 KiB TSX | 76.7% (Shiki uses 17 colors, Highlights 11) | 72.2% |
| 517 KiB TypeScript | 70.7% | |
| 363 KiB JSON | 12.3%: Shiki colors keys teal and strings purple; Highlights leaves keys plain, colors strings tan and brackets yellow | |
| 81 KiB Markdown | 92.0% | |

**Languages.** Highlights colors 54 of the 60 file types we checked. It lacks `fish`, `ini`, `csv`, `prisma` and VibeLang (`.vibe`, `.effeck`). Diffs' Highlights backend renders an unsupported or custom language as plain text (`highlighter/backends/highlights.js`: "Unsupported and custom languages render as text"), so with Highlights on, VibeLang, the north star's language (SCOPE-13), loses its colors.

**Not measured here:** Highlights in a browser or a Worker. Pierre's article reports Chromium 153 highlighting ten copies of `three.min.js` in 81.6 ms against Shiki's 28.28 s, and diffs' DOM paths 4 to 39 times faster, against Shiki's WebAssembly engine rather than the JavaScript engine we run.

### Trees

`FileTree` and `useFileTree` from `@pierre/trees/react` bundle to 237.7 KB raw, 59.9 KB brotli, Preact included. Preparing 50,000 paths (`REPO_TREE_MAX_PATHS`) takes 57.6 ms in Node. It renders in its own shadow root with its own look, theming through CSS variables or `themeToTreeStyles`.

## Upgrade: `@pierre/diffs` 1.5.2 (built)

**Why now.** It is the newest working version at least a day old (SDK-15). Its fixes since 1.3.6 that reach us: both grammars load when a diff renames a file across languages (1.4.2); patch file names parse safely and blank-line changes keep their positions (1.5.0); `CodeView` anchors annotations at the viewport's bottom and measures collapsed items correctly (1.5.0, 1.5.2); `Dockerfile` and similar names resolve inside a path (1.5.2); worker errors go to an `onWorkerError` hook instead of the console (1.5.2).

**Where it plugs in.** `packages/smithers/ui/repo-view` and `.smithers/flows` (the review flow), each pinned exactly at `1.5.2` in its own commit. The review flow gains the patch-parsing fixes; its server rendering measured the same on both versions.

**What changed in our code.**

- `CodeFileView` names the caret metadata type that 1.4 made required: `FileOptions<AnnotationMeta, undefined>`.
- `src/workerPool.ts` lets pierre settle the pool's startup. The 15-second `CODE_VIEW_POOL_DEADLINE_MS` becomes pierre's `workerInitializationTimeout`; the pool waits on `manager.initialize()` instead of polling it every 50 ms, and it fails on pierre's `onWorkerError` instead of its own listener on each worker. The probe timers, the deadline timer and the generation counter are deleted (192 lines to 156). The fallback warning now names the reason, such as pierre's timeout.
- `patchToCodeViewItems` returns `CodeViewItem<undefined>[]`, the annotation type argument 1.5 made required.
- `.smithers/flows`' walkthrough test finds pierre's `color-scheme` rule with or without the space after the colon, which 1.5's minified sheet drops.
- Docs: `docs/reference/contracts.md`, `docs/guides/use-the-repository-views.md` and `docs/api.md`. Changeset: `.changeset/repo-view-pierre-diffs-1-5-2.md`.

**Tests.** `pnpm check` and `bun test --isolate test` in `packages/smithers/ui/repo-view`: 167 pass, 100% of lines and functions. They run real pierre: a 16 KiB file tokenized in a real Bun Worker, the main-thread path, the diff view, the bundle split (`test/bundle.test.ts`), and the pool's fallbacks, rewritten to fire pierre's own deadline and worker errors. In `.smithers/flows`, `bun test review/tests`: 289 pass. Its `pnpm check` fails only in `test/coding-builtin-routes.test.ts`, which imports `packages/smithers/agent/fs/src/*.ts` files that are `.vibe` on `main`, a red unrelated to this change. `apps/mvp`'s `tsc -p tsconfig.json` passes. No Effect wrapper is needed: `@smthrs/repo-view` is a React view package, which SDK-4 exempts like `@smthrs/ui`.

**End to end.** `e2e/code-intel.spec.ts` and `e2e/repo-browse.spec.ts` render this code view in the app, but they need a Code Storage clone, so they run where the dev server holds Code Storage credentials (the MacBook or production), not on the Mac mini.

## Upgrade: `@pierre/diffs` 1.6.1 (after 2026-10-22 18:05 UTC)

1.6.1 and its `@pierre/theming` 1.0.2 and `@pierre/highlights` 0.2.0 turn a day old at 2026-10-22 18:05 UTC, 17:59 UTC and 08:43 UTC; after that, SDK-15 needs no question.

- **Where:** both `packages/smithers/ui/repo-view` and `.smithers/flows`, pinned at `1.6.1`, one commit each.
- **Migration** (1.6.0 release notes): `CodeView` and `File` annotation callbacks take the displayed file or diff as their second argument (`renderAnnotation` in `CodeFileView` reads only the annotation, so nothing changes); `createCSSVariablesTheme` and `getSharedHighlighter` changed, and we call neither; `FileDiffMetadata` gains character counts.
- **What we gain:** 24% less first-load JavaScript on every page with a code view; the worker loads grammars itself, on demand; `mainThreadMaxCharacters` can keep small files off the worker; Highlights becomes one option away.
- **Tests:** the repo-view suite and `bundle.test.ts` (first load still under its guard, every grammar and VibeLang still in later chunks); the review flow's `review/tests/renderPierreFileDiff.test.ts` and `extractDiffAssets.test.ts` with the default themes, which is what 1.6.0 broke; then the two e2e specs above.

## Recommendations for Will

1. **Switch syntax highlighting to Highlights?** It makes the review flow's rendering about 30 times faster and a TypeScript file's first highlight about 70 times faster, at a quarter to a half of the memory. Two costs: code looks different (about 3 in 10 TypeScript characters and most JSON change color under Night Owl), and `.vibe` files show plain until a VibeLang lexer exists. My recommendation: we write a VibeLang lexer for Highlights and contribute it to `pierrecomputer/pierre` (Apache-2.0; it takes outside contributions), then switch both the code view and the review flow in one change with before and after screenshots for your review. The same lexer would let Highlights replace the 94-line regex highlighter on repository homes. Until then, Shiki stays.
2. **Keep our file tree.** `@pierre/trees` gives search, git status, drag and drop and virtualization, for 60 KB brotli, a second UI runtime (Preact) and its own look; it is still a beta. We revisit if a 50,000-path repository is slow in our tree.
3. **No other Pierre package fits.** Theme, icons and file-type icons are look changes nobody asked for (FE-15); the storage packages are ruled out by ARCH-13.

## Appendix: the benchmark scripts

Each runs from a directory whose `node_modules` holds the packages it names: `@pierre/diffs` at the version under test with `react@19.2.8`, or `shiki@4.4.3`, `esbuild@0.25.10`, `@pierre/trees@1.0.0-beta.6` and `@pierre/highlights` 0.1.3 and 0.2.0 installed under the aliases `hl013` and `hl020`.

<details>
<summary><code>ssr.mjs &lt;dir&gt; &lt;patch&gt; [highlighter]</code>: the review flow's rendering</summary>

```js
import { readFileSync } from "node:fs";
const [dir, patchFile, highlighter] = process.argv.slice(2);
const ssr = await import("@pierre/diffs/ssr");
const patch = readFileSync(patchFile, "utf8");
const files = patch.split(/(?=^diff --git )/m).filter((p) => p.startsWith("diff --git"));
const render = async () => {
  let bytes = 0;
  for (const f of files) {
    const r = await ssr.preloadPatchDiff({ patch: f.endsWith("\n") ? f : f + "\n", options: { diffStyle: "unified", themeType: "system", disableFileHeader: true, ...(highlighter ? { preferredHighlighter: highlighter } : {}) } });
    bytes += r.prerenderedHTML.length;
  }
  return bytes;
};
const t0 = performance.now();
const bytes = await render();
const cold = performance.now() - t0;
const warm = [];
for (let i = 0; i < 3; i++) { const t = performance.now(); await render(); warm.push(performance.now() - t); }
warm.sort((a, b) => a - b);
console.log(JSON.stringify({ dir, highlighter: highlighter ?? "default", files: files.length, html_kb: (bytes / 1024).toFixed(0), cold_ms: cold.toFixed(0), warm_median_ms: warm[1].toFixed(0), rss_mb: (process.memoryUsage().rss / 1048576).toFixed(0) }));
process.exit(0);
```

</details>

<details>
<summary><code>highlight.mjs &lt;x&gt; &lt;shiki-js|hl013|hl020&gt; &lt;file&gt; &lt;lang&gt;</code>: one highlighter on one file</summary>

```js
import { readFileSync } from "node:fs";
const [, engine, file, lang] = process.argv.slice(2);
const imp = (s) => import(s);
const code = readFileSync(file, "utf8");
const t0 = performance.now();
let run;
if (engine === "shiki-js") {
  const { createHighlighterCore } = await imp("shiki/core");
  const { createJavaScriptRegexEngine } = await imp("shiki/engine/javascript");
  const langMod = { tsx: "@shikijs/langs/tsx", typescript: "@shikijs/langs/typescript", json: "@shikijs/langs/json", markdown: "@shikijs/langs/markdown" }[lang];
  const h = await createHighlighterCore({ themes: [imp("@shikijs/themes/night-owl")], langs: [imp(langMod)], engine: createJavaScriptRegexEngine() });
  run = () => h.codeToHtml(code, { lang, theme: "night-owl" }).length;
} else {
  const hl = await imp(engine);
  const { default: theme } = await imp(engine + "/themes/night-owl");
  const l = { tsx: "tsx", typescript: "ts", json: "json", markdown: "md" }[lang];
  run = () => hl.codeToHtml(code, { lang: l, theme }).length;
}
run();
const cold = performance.now() - t0;
const warm = [];
for (let i = 0; i < 5; i++) { const t = performance.now(); run(); warm.push(performance.now() - t); }
warm.sort((a, b) => a - b);
console.log(JSON.stringify({ engine, file, cold_ms: cold.toFixed(1), warm_ms: warm[2].toFixed(1), rss_mb: (process.memoryUsage().rss / 1048576).toFixed(0) }));
```

</details>

<details>
<summary><code>parity.mjs &lt;file&gt; &lt;shikiLang&gt; &lt;hlLang&gt; &lt;theme&gt;</code>: same-color share</summary>

```js
import { readFileSync } from "node:fs";
const [file, shLang, hlLang, themeName] = process.argv.slice(2);
const code = readFileSync(file, "utf8");
const { createHighlighterCore } = await import("shiki/core");
const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
const sh = await createHighlighterCore({ themes: [import(`@shikijs/themes/${themeName}`)], langs: [import(`@shikijs/langs/${shLang}`)], engine: createJavaScriptRegexEngine() });
const st = sh.codeToTokens(code, { lang: shLang, theme: themeName });
const hl = await import("hl020");
const { default: theme } = await import(`hl020/themes/${themeName}`);
const ht = hl.codeToTokens(code, { lang: hlLang, theme });
const norm = (c) => (c ?? "").toLowerCase().slice(0, 7);
const fill = (lines, arr) => { let off = 0; const starts = []; for (const l of code.split("\n")) { starts.push(off); off += l.length + 1; } lines.forEach((line, i) => { let o = starts[i] ?? 0; for (const t of line) { const s = t.offset ?? o; for (let k = 0; k < t.content.length; k++) arr[s + k] = norm(t.color); o = s + t.content.length; } }); };
const a = new Array(code.length).fill(""), b = new Array(code.length).fill("");
fill(st.tokens, a);
fill(ht.tokens, b);
let same = 0, total = 0;
for (let i = 0; i < code.length; i++) { if (/\s/.test(code[i])) continue; total++; if (a[i] === b[i]) same++; }
console.log(JSON.stringify({ file, theme: themeName, same_color_pct: ((100 * same) / total).toFixed(1) }));
```

</details>

<details>
<summary><code>bundle.mjs &lt;dir&gt;</code>: what a page with a code view loads</summary>

```js
// Entry: the imports @smthrs/repo-view makes.
//   import { getFiletypeFromFileName, registerCustomLanguage, processPatch } from "@pierre/diffs";
//   import { File, WorkerPoolContext, useStableCallback, CodeView } from "@pierre/diffs/react";
//   import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
// Built with esbuild: bundle, splitting, format "esm", minify, platform "browser", target "es2022",
// external react, react-dom and react/jsx-runtime, metafile. "First load" walks the metafile from the entry
// through `import-statement` edges only; every other output is a dynamic import. Sizes are raw, gzip -9 and
// brotli (Node's zlib defaults).
```

</details>
