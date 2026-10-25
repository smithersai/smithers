---
title: Code intelligence in the file view (hover, go to definition, diagnostics)
status: blocked
area: app
owner: Codex codeintel
updated: 2026-10-25 14:11 PDT
links: [../design/code-intelligence/DESIGN.md, ../features/code-intelligence.md, old-app-feature-gaps.md, repo-clone-and-view.md, agent-repo-navigation.md, sandboxes.md, ../decisions/0006-repo-clone-and-view.md, ../../../../AGENTS.md]
---

## Production hover regression — 2026-10-25

Owner: Codex codeintel. The production sweep's `engine.worker` parser/transform stacks are decoded `branch/track` refusals and `timeline/SummaryFailed` model failures, not TypeScript parser failures. Its snapshot still has Symbols, so code intelligence opened the file.

The code view used an inline callback ref to disarm the pointer-rest timer on unmount. React also detaches that ref on every render; an unrelated parent render during the rest cancels the hover, while Pierre still considers the stationary pointer inside the same token. Keep the frame ref stable for the shown file; retain cancellation when the file changes or the view unmounts.

Regression: the real Pierre view receives a mouse pointer move onto `add`, its parent renders before the rest expires, and exactly one hover arrives. Replacing the file and unmounting cancel the next token's pending rest. Latitude: the regression failed on the old code; the SDK suite passed 168 tests with 100% lines and functions after the fix.

The downloaded production language-worker bundle independently returned the expected `format` signature for the pinned `vercel/ms` sources. This isolated harness supplies TypeScript declaration files from the installed compiler and browser message-port globals; it is not browser e2e proof. Latitude app typecheck and importRules passed. The full app suite passed on Latitude: 343 files, 4,466 passing tests, 3 expected failures and 17 skipped tests; statements, branches, functions and lines are all 100%. Mini e2e started successfully from a temporary validation copy combining this fix with the mini-e2e builder’s proven startup repair (e52eeeb70965), which is not part of this bookmark. The code-intel spec skipped because the farm lacks CODE_STORAGE_ORG and CODE_STORAGE_KEY. Browser verification therefore remains blocked; run the declared deployment-capable spec after landing and deploying the fix. No e2e pass or GIF is claimed.

Libraries: catalog entries `@smthrs/repo-view` (token gestures) and `@smthrs/platform-browser` (`BrowserLanguageServer`). No dependency or worker-transform change.

## Tracker reconciliation — 2026-10-21 01:54 PDT

**What:** Provide file-view language services and matching agent code actions.

**Why:** Support browsing and working in the VibeLang factory.

**Current state:** Slice 1 landed in c6940ac5 (lead 01:49), after passing e2e and Will’s 01:18 walkthrough approval. Agent actions and repository-package type resolution remain unfinished; deployment is still running.

**Next step:** Smoke-test the deployed file view, then implement agent actions and package types.

**Open questions for Will:** None.

Evidence: script-filtered user-typed messages and lead text replies, session 6253ecf2, 23:53–01:53 PDT; current rulings and queue answers through 01:19 PDT; shared briefs and designs, decisions, proposals, TODOs and rules. Completion and test receipts are reported evidence; this tracker validates only the site build. Execution ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 01:24 PDT

**What:** Provide shared language services for file browsing and agent code tools.

**Why:** The production VibeLang factory needs both.

**Current state:** Slice 1 passed the reported shared-server e2e and Will approved its walkthrough at 01:18:10 PDT. Hover, definitions, references and keyboard operation are accepted. Landing is still pending; agent actions and repository-package types remain unfinished.

**Next step:** Land slice 1 with the combined round; then implement agent code actions and package type resolution.

**Open questions for Will:** None.

Evidence: script-filtered human messages and lead text replies from session 6253ecf2, approximately 23:24–01:24 PDT; current rulings and queue answers through 01:19 PDT; shared briefs/designs, decisions, proposals, TODOs and rules. Product results are reported receipts. Execution owners retained; Codex curates tracker documentation only. Later rulings supersede earlier history.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 00:44 PDT

**What:** Provide keyboard-accessible hover, definitions, references, outline and diagnostics through shared language services.

**Why:** The VibeLang factory needs usable code browsing and agent code tools.

**Current state:** At 00:42 the lead reports slice 1 passing its shared-dev-server e2e: hover, same-file and cross-file definitions, 93 references in Symbols, gutter problems and keyboard controls. TypeScript runs in a tab worker; a GIF exists. This supersedes the failed first recording. Broader language-service work remains unfinished.

**Next step:** Land slice 1 with its receipts, then build agent code actions on the same server and resolve types from repository packages.

**Open questions for Will:** None; subsequent feature work follows the production factory priority.

Evidence: script-filtered user-typed text and lead text replies from session 6253ecf2, approximately 22:44–00:44 PDT; rulings, queue answers through 00:17:42 PDT, current decisions, proposals, TODOs, rules and shared briefs/designs. Automated notifications and teammate messages are excluded as human evidence. Product checks are lead-reported receipts; this tracker validates the site build only. Existing execution owners and all history are retained.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 21:43 PDT

**What:** Provide GitHub-style file hover, definitions, references, outline and diagnostics through shared language services.

**Why:** Will requested full language-server support and approved the first design.

**Current state:** The implementation is described below, but at 21:34 PDT the lead reports its first browser recording failed. It exercises hover, go to definition and references on a TypeScript file from vercel/ms. The curator holds priority 790 until a passing run; slice 1 is not verified working end to end.

**Next step:** Fix the failing real-viewer journey and retain a passing recording before declaring the first slice complete or broadening into agent code/* flows and sandbox language services.

**Open questions for Will:** None.

Evidence: lead text replies and human-typed messages extracted by script from session 6253ecf2 for 19:43–21:43 PDT; synthetic notifications and compaction summaries excluded. Rulings and queue answers through 19:38 PDT take precedence over older briefs, designs, decisions, proposals, TODOs and rules. Product results are reported receipts; this tracker validates the site build. Execution ownership is retained; reconciliation by Codex tracker curator.

## Earlier tracker history (retained)


## Current specification — 2026-10-20

**What:** The code view's language server, as GitHub's code view and github.dev have it: hover, go to definition, references, the outline and problems, keyboard first. Will, about 18:22: "For code it should have full lsp support and stuff and look a lot like github".

**Current state:** Slice 1 built: TypeScript and JavaScript in a browser worker at the commit ([DESIGN.md](../design/code-intelligence/DESIGN.md), [mock](../design/code-intelligence/mock.html), [feature doc](../features/code-intelligence.md)). SDK: `@smthrs/platform-browser`'s `BrowserLanguageServer` (binds `@smthrs/std`'s `LanguageServer`), `@smthrs/repo-view`'s `CodeFileView` marks, hover card and cursor, and `SymbolsPane`. App: `src/features/code-intel/`. Hybrid placement, browser first: the branch box answers only what needs a machine (DESIGN.md).

**Proof (2026-10-21, 00:42):** `e2e/code-intel.spec.ts` passed against the dev server (`BASE_URL=http://localhost:1337`, `vercel/ms` at `4ff48ce`): hover `format`, Enter to its definition at `src/index.ts?L=225`, its 93 references in the Symbols pane, a reference opening its line; `pnpm e2e:gifs` passed the check (`~/Desktop/smithers-mvp/gifs/code-intel-hover-definition-references.gif`, 5 chapters). `src/features/code-intel/code-intel.test.ts` 16/16; `BrowserLanguageServer.test.ts` 25/25, 100% of its files; repo-view 167/167, 100%; `pnpm docs:sync` and `pnpm docs:check` pass; `vite build` passes (entry +6.0 KB gzip; TypeScript only in the worker chunk).

**Next step:** Slice 2, the agent's `code/*` flows on the same server; then package types, the sandbox bridge, search-based navigation, blame.

**Open questions for Will:** None.

## Earlier tracker history (retained)

## Current specification — 2026-10-20, 18:33 PDT

**What:** Provide TypeScript/JavaScript hover, cross-file definitions, references and diagnostics through the repository viewer.

**Why:** Will requested full LSP support and approved the code-intelligence design at 18:30.

**Current state:** Design approval is recorded in queue answer design:auto/code-intelligence@cd86. The lead previously assigned a design-first builder; no implementation or passing browser receipt exists.

**Next step:** Implement the approved first slice with injected language services and SDK components, then verify each operation through the real viewer and review the implementation.

**Open questions for Will:** None.

Evidence: script-filtered last two hours of session 6253ecf2 through 18:32 PDT; queue answers through 18:30 PDT; current rulings, shared feature/host/panel briefs and designs, decisions, proposals, TODOs and rules. Queue answers supersede older open questions. Product receipts are reported evidence; this tracker validates only the site build.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 18:26 PDT

**What:** Add GitHub-style TypeScript and JavaScript hover, cross-file definition, references and gutter diagnostics.

**Why:** Will requested full language-server support in the repository viewer.

**Current state:** At 18:16 the lead assigned a designer/builder to produce a mock and decide browser versus branch-machine language-server placement. No completed implementation receipt.

**Next step:** Design first using catalog-backed SDK services, then implement the first TypeScript/JavaScript slice and prove each navigation operation through the real viewer.

**Open questions for Will:** None; language-server placement is an engineering choice.

Evidence: latest two session hours extracted by script as human text/lead replies; queue answers through 2026-10-21 01:24:15 UTC, current rulings, shared briefs/designs, decisions, proposals, TODOs and rules. Latest rulings override historical proposals. Product results are reported receipts; this pass verifies the maintainer-site build only.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 18:18 PDT

**What:** Provide full language-server support in the repository code viewer, with a GitHub-quality browsing experience.

**Why:** Will explicitly requested full LSP support in the repo-browser queue answer at 18:16.

**Current state:** This is now requested current work; no implementation or completion receipt in this pass.

**Next step:** Choose the catalog-backed code intelligence services, define browser/sandbox placement through injected Effect services, and prove navigation/diagnostics in the actual repository viewer.

**Open questions for Will:** None; the recorded requests settle product intent.

Evidence: script-filtered user text and lead replies from the latest two session hours; queue answers through 2026-10-21 01:16:08 UTC; current rulings, decisions, proposals, TODOs, rules and shared panel briefs/designs. Later rulings override historical proposals. Product receipts are reported evidence; this pass validates the site build only.

## Earlier tracker history (retained)

## What

Language-server help while reading code.

Old app:
- Flows `code.hover` (the type and docs of the symbol at a position), `code.definition` (opens the file at the definition's line) and `code.diagnostics` (a file's errors and warnings), in `apps/app/src/mainview/flows/entries/code.ts`.
- Hover in the file card (`cards/FileCards.tsx`). The language server ran on the branch's machine (`state/CloudLspClient.ts`).
- Journey: `apps/app/e2e/real/file-intelligence.spec.ts`.

The scope keeps it: the root `AGENTS.md` says "Keep browser IDE code intelligence", and mvp.md §8 keeps "code intelligence in file cards".

New app: Shiki highlighting only (`CodeFileView`). No plan names hover, definitions or diagnostics.

## Why

- An explicit keep rule in the root `AGENTS.md`.
- Go to definition is how a person reads unfamiliar code. It also gives [feature 4](agent-repo-navigation.md)'s agent a precise jump instead of a text search.

## How it fits

Two ways:
1. **In the browser:** the TypeScript language service in a Web Worker over Code Storage reads, for TypeScript and JavaScript repositories. It needs no machine and works offline once files are cached.
2. **On a sandbox:** real language servers on the branch's machine ([sandboxes](sandboxes.md)), exposed as sandbox tool flows `code/hover`, `code/definition` and `code/diagnostics`.

Either way, the agent calls the same flows, and results are cached per commit SHA in `ImmutableCache`.

## Size

L.

## Questions for Will

- Start with TypeScript in the browser, or wait for sandboxes and run real language servers? Recommended: TypeScript in the browser first, since it needs no machine.
