# Repository tutorial v3 — inventory, design, skeleton, lane handoff

Scope: /Users/williamcory/smithers, product in apps/app. No commit or push. This is the inventory/skeleton lane, not the implementation of the eight feature lanes. Paths below are repository-relative unless they start with `src/`, in which case they are relative to apps/app.

## Hygiene

The requested initial diff covered 17 already-modified files (1,748 additions / 478 deletions), including a Library move to stage 1, guide version 3, rewritten navigation, CSS, and tests. `bun test src/mainview/onboarding` was green: 26 pass / 0 fail / 217 assertions. No rollback was necessary. Existing palette/header/nav/fill-height CSS was left untouched. The interrupted v3 migration was real, not merely a TODO.

## Inventory

| Lesson | Kind | Completion signal | Existing pieces | Gaps to build | Risk |
|---|---|---|---|---|---|
| 1. Introduction | say | read pause | `src/mainview/onboarding/{GuideShell,GuideSteps}.tsx`, `advance.ts`, `lessons.ts`; session collection in `state/AppState.ts` | Replace old sequence; preserve one-second entrance and keyboard shell | Low: timer cancellation/replay |
| 2. Log in | do | `identity.signed-in` | `src/mainview/ControllerBoot.client.ts`; `state/controller/auth-billing.ts` load/adopt/finishSignedInSession/signIn; `flows/entries/auth.ts`; `state/seams/CloudSeam.ts`; `src/bun/CloudAuth.ts`, `src/bun/server.ts`; current cloud route implementation is `apps/server/src/index.ts`, not a Worker file in apps/site | Tutorial signal, already-signed-in handling, usable local-origin login and honest offline recovery | High: app identity, cloud PAT and local CSRF session are distinct; redirect/reload |
| 3. Choose repo or skip | do | `repository.ready` | `src/mainview/Composer.tsx` still exports SidebarRepositoryPicker, although the old header placement is removed; `flows/entries/{repo,repos}.ts`; `state/seams/{RepositoriesSeam,RepoImportSeam}.ts`; `state/controller/{tabs,adoptLocalRepository}.ts`; `src/bun/routes/repoTargets.ts` POST /api/repo/open, GET /api/repos; `src/bun/Repos.ts` | Ranking by authored contributions; `/repo.choose`; local initialize-and-adopt path; choice form. Existing `/repo.open` opens a directory, not a demonstrated create-new-repo endpoint | High: pagination/rate limits, account/repo scope, filesystem collisions and cloud/local capability |
| 4. Issues or PRs | do | `issues.opened` OR `prs.opened` (normalized) | `flows/entries/{issues,prs}.ts`: issues.list/view/create and prs.list/view; `state/seams/{IssuesSeam,LandingsSeam}.ts`; `cards/{IssueCards,LandingCards}.tsx`; GitHub-source issues through /api/user/github-repos/{owner}/{repo}/issues, platform PRs through /api/repos/{owner}/{repo}/landings | Exact bare `/issues` and `/prs` doors, selected-repo defaults, completion after rendered successful read; honest local-only path | Medium: GitHub pull requests and platform landings are not interchangeable; auth errors must not look empty |
| 5. Open file | do | `file.opened` | `flows/entries/{files,code}.ts`; `flows/{SlashPayload,FileArgs}.ts`; `state/seams/{FilesSeam,RepoTreeSeam,CodeIntelSeam}.ts`; `cards/FileCards.tsx`; `packages/smithers/ui/src/adapters/code-view/CodeFileView.tsx` | Missing-path form with useful file choices and real-read completion; no need for new /open or /file alias | Low/medium: directory vs file, selected repo and read failure |
| 6. Install Librarian | do | `librarian` | `onboarding/pluginLesson.ts`: LESSON_PLUGIN = librarian; `plugins/{catalog,AppPlugin,appSurface}.ts`, `PluginGallery.tsx`, `PluginsSurface.tsx`, `PluginRail.tsx`; `flows/entries/plugins.ts`; `state/controller/plugins.ts` persists installed shelf | Only required tutorial package is Librarian; current Library advertises five packages and other recommendations. Existing catalog package contributes Wiki/history reads, not the two generation implementations | Medium: Library opening is not install; already-installed replay; agent browse currently has user-only surface switch with plugins.list alternative |
| 7. Two background flows | do | `librarian.runs.monitored` | `flows/entries/wiki.ts` supports reading/editing/creating individual notes, not codebase generation; `wiki/`, `state/controller/cloud-wiki.ts`, world documents collection; `flows/entries/history.ts` has history.show/bootstrap/amend/fold; `state/seams/HistorySeam.ts` reads refs/notes/mythical and explicitly refuses retell writes; `cards/HistoryCard.tsx`; `flows/entries/{flow,runs}.ts`; `state/controller/{workflows,workflow-pump,runs}.ts`; `cards/{RunsCards,RunHistoryCard,RunTraceCard}.tsx` | `/wiki.create` generation, real history.bootstrap, two durable async launch receipts and aggregate monitoring completion | High: generation is not implemented by showing notes; main/tree invariants; restart and idempotency |
| 8. Agent change | do | `change.committed` | `flows/entries/{agent,feature,change}.ts` role/delegate, feature.prototype, change.view/diff/land; `state/controller/{agents,workflows,targetGraph}.ts`; `cards/{CodingPlanCard,CodingPlan,ChangeCards,GraphCard,TargetCards}.tsx` (CodingPlan is .ts); root `flows/coding/{schema,workflow,registration,implementation/flow}.ts`; `packages/smithers/agent/src/{Agent,AgentAction,ChildFlows,EngineChildren,StandardFlows}.ts`; `packages/smithers/flows/{flow,plan,engine,journal}` | Feature suggestion and `/agent.change` glue; pre-execution commit plan -> real execution -> one resulting commit receipt with captured HEAD; commit strip. Target graph is a dependency/run graph, not a Git DAG | High: plan-before-write proof, recursive scripts, concurrent HEAD movement and one-commit invariant |
| 9. Explanation and trace | do | `trace.opened` | `cards/RunTraceCard.tsx` already has Turn explanations buttons, scoped call tree and recorded source block; `cards/{RunTrace,EngineTrace}.ts` folds real events; `flows/entries/runs.ts` runs.steps/trace.select/view/filter/live; `state/controller/runs.ts`; `DevtoolsPanel.tsx`; journal in `packages/smithers/flows/journal/src/{Journal,SqlJournal}.ts`; shared components in `packages/smithers/ui/src` | Guarantee one useful sentence per real turn; current fallback says Calls: or Turn opened; tie tutorial to selecting this change run's actual source trace | Medium: redacted/missing source; observable explanation must not invent events |

`flows/registry.ts` owns catalog/runtime/actor policy; `flows/Flows.ts` composes per-namespace entries; `flows/SlashPayload.ts` owns typed slash grammar. A namespace label is not proof a bare slash executes. `flows/FlowForms.ts`, `flows/entries/form.ts`, and `state/controller/forms.ts` implement schema-derived missing-field cards with durable drafts and submit-as-original-actor behavior. `packages/rpc/src/Cards.ts` FORM_OPTION_PROVIDERS currently includes harnesses, agent-harnesses, harness-models, open-repos, cloud-repos, bookmarks, workspaces, agents, plugins; there is no files or ranked-contributions provider yet. Add only the provider genuinely needed; ordinary repo choice can reuse existing options.

Other reused surfaces: Wiki keeps `world` storage IDs and Markdown/provenance/revision semantics; connectors attach local/cloud context; sessions and tabs (`tabs/ChromeBar.tsx`, `state/controller/tabs.ts`) already represent local terminals/harnesses. They must not become a second implementation of an embedded output. `DevtoolsPanel` is app diagnostics, while RunTraceCard is the better run-specific debugger. The requested “flows-ui stdlib” is not a product dependency found here; reuse repository-owned `@smthrs/ui` and the run journal, not a retired runtime package. Shared UI exports Commit and related parts in `packages/smithers/ui/src/index.ts`.

## Identity: local versus cloud

Cloud: boot awaits `loadSession`; validated signed-out is an auth gate. `/auth.sign-in` goes to `/api/auth/github/start` with a safe same-origin return path. The OAuth browser gesture is userOnly; `/auth.prompt` is the agent's embedded door. Emit after the validated signed-in response is persisted, including an existing signed-in account on entering the lesson. Preserve /owner/name and guide state across redirect. Do not equate allowlisting or a pending probe with successful login.

Local hybrid: boot paints first and loads identity asynchronously. `src/bun/server.ts` proxies /api/auth and /api/identity, re-scopes cookies, and separately supports host-held cloud credentials (`CloudAuth.ts`, GitHub CLI callback/browser flow). A local session token is not a GitHub login; cloud PAT state is not automatically the app's identity row. Complete only once the intended authenticated identity is resolved and available to repository reads. Native shell uses system-browser/device handoff; local browser must use the proxied return path or existing cloud handoff without losing state.

Offline/chat-stub: identity may be unavailable and auth returns 501. Keep the lesson incomplete with honest recovery, or hand off to a configured origin; do not emit signed-in to keep the tour moving. The browser skeleton test uses an explicit named event to test plumbing only. Cloud-only browser Skip cannot create a directory on the user's computer: use the existing local-app/download handoff and finish on the local host. Do not call a cloud repo “local.” `apps/site` contains docs/site content; current identity proxy routes were found in apps/server, so assigning OAuth fixes to a nonexistent apps/site/src/worker.ts would be wrong.

## Stage design and copy

Nine requested lessons map to zero-based stages 0–8, followed by workspace destination 9. Every do-stage is required. Repository Skip is a successful creation act, never a navigation bypass. The authoritative Smithers message and numbered instruction copy is in `src/mainview/onboarding/lessons.ts`; reproduced below for handoff.

### Stage 0 — say

Smithers: I'm Smithers, I help your team manage your repository.

### Stage 1 — do

Smithers: First thing you should do is log in.

1. Press Cmd K (or Ctrl K), type /auth.sign-in, press Enter, and finish signing in with GitHub.

### Stage 2 — do

Smithers: Let's choose the repository you've contributed to most in the last 90 days. You can skip GitHub and create a new local repository instead.

1. Press Cmd K (or Ctrl K), type /repo.choose, press Enter. Choose a repository, or choose Skip to create smithers-playground locally.

### Stage 3 — do

Smithers: Let's check the issues or pull requests in your repository.

1. Press Cmd K (or Ctrl K), type /issues or /prs, and press Enter.

### Stage 4 — do

Smithers: You can open files in this repository, too.

1. Press Cmd K (or Ctrl K), type /files.read, press Enter. Choose a file in the form and submit.

### Stage 5 — do

Smithers: The Librarian is the only plugin package we need. Open /plugins and install it from the Library.

1. Press Cmd K (or Ctrl K), type /plugins, and press Enter.
2. Type /plugins.install librarian in the composer and press Enter, or Tab to Install the Librarian and press Enter.

### Stage 6 — do

Smithers: Let's run Create Wiki and Create Mythical history. Both flows run in the background, and we can monitor them while we keep working.

1. Press Cmd K (or Ctrl K), type /wiki.create, press Enter, and submit the repository form.
2. Type /history.bootstrap and press Enter, then open /runs.list to monitor both flows.

### Stage 7 — do

Smithers: I'll find a useful feature for this codebase and plan the commits before making changes. Watch the agent orchestrate through scripts, then see one resulting commit on top of HEAD.

1. Press Cmd K (or Ctrl K), type /agent.change, press Enter. Review the suggested feature and planned commits, then start the change.

### Stage 8 — do

Smithers: Each turn explains what the agent did. Open a turn to walk through the real code and its debug trace.

1. Tab to a turn's explanation and press Enter to open its trace, or use /runs.steps and choose the change run.

### Stage 9 — say

Smithers: Your repository is ready. Call me with Cmd K whenever you need me.

## Slash and form contract

| Stage | Door | Missing input / successful outcome |
|---|---|---|
| 1 | /auth.sign-in; agent /auth.prompt | No arguments. Actual signed-in identity persisted. |
| 2 | proposed /repo.choose and /repo.create; existing /repo.open, /repos.import | Choice card from repo inventory/ranking; create form needs name/location only when absent. Button includes args; selected repo or created local repo is adopted before completion. |
| 3 | proposed bare /issues and /prs -> existing issues.list/prs.list | Selected repo defaults; if absent, repo form. /issues defaults open. Successful empty read counts; error does not. Either signal completes this single lesson. |
| 4 | /files.read | Missing path form, selected repo prefilled; options from real files.list/tree seam. Read the actual file before signaling. |
| 5 | /plugins; /plugins.install librarian | Missing plugin gets existing plugins option provider; installed shelf is the existing completion producer. Agent install confirms. |
| 6 | proposed /wiki.create, existing /history.bootstrap, /runs.list, /runs.open | Repo required from active context or form; real background receipt per flow. Completion requires both run IDs persisted and inspected, not both finishing. |
| 7 | proposed /agent.change | Suggested feature based on repo inspection; repo/feature missing fields only; persist base and planned commit list, then human launch/agent confirm. Real one-commit result completes. |
| 8 | /runs.steps; /runs.trace.select <runId> <spanId> | Missing run form; context should prefill the tutorial change run. Click/Enter and slash use same durable selection. Recorded source/calls visible before signaling. |

All UI says “flow”. Preserve native Enter/Space activation and text editing; ArrowRight = Next only, ArrowLeft = Back, C theme, N notify, R starts Create Wiki in the background-flow lesson, S sound, Cmd/Ctrl+K composer. R depends on the generation lane; it is not fake completion. No shortcut silently fills a missing required form field.

## Repository ranking and local skip

Capture a single cutoff `now - 90 days` per ranking refresh. Enumerate the user's accessible contributed repositories through the existing GitHub inventory proxy (including organizations). For each repo, count distinct commit SHAs authored by the authenticated GitHub user with authored timestamp at/after cutoff; do not substitute pushed_at, updated_at, stars, committer, or repo ownership. Use GitHub commit API author+since filtering through the existing same-origin proxy, follow pagination, and deduplicate SHAs across branches if enumerated. A default-branch-only response is a partial coverage result, not an all-branch total. Descending count, then latest qualifying authored timestamp, then full_name lexical is deterministic. Confirm exact commit proxy support in the lane: local code proves a GitHub repo GET proxy, not that the deployed upstream implements arbitrary commit queries. Rate-limit/permission failures are unknown counts, never zero; a partial ranking stays explicitly partial and leaves manual choice/Skip available.

Preselect the first fully ranked eligible repo and let the user accept or choose another. Never create/import or launch paid work merely because a repo ranks first. Selection/adoption persists into the same repository context the existing file/issues/run flows resolve.

Skip creates `smithers-playground` at `~/Smithers/repositories/smithers-playground` on the local host, expanded from the host home directory. This is a proposed default, not a claim that directory currently exists. Use an unused numeric suffix on collision; create/initialize once, then invoke existing repo adoption/open, and persist active repo. Show the actual returned name and absolute path in the resulting card (“Created <name> at <path>”). Do not create a GitHub remote. Host capability controls the cloud-to-local handoff; no browser filesystem illusion.

## Minimum change/trace UI

Use the existing `run-trace` card identity and `CodingPlanBody` for a “change” run, with persisted input plan from root `flows/coding/schema.ts`. Show the suggested feature, captured base HEAD, and ordered planned commits before executing a script. Existing predicted Changes/atoms and required checks are sufficient; no new dashboard. The feature suggester inspects this repo and supplies a small justified feature, not a hardcoded heading demo. Run `ImplementPlan` / recursive child flows through repository-owned scripts and journal each child call.

A successful tutorial result is one actual commit above captured HEAD. Prefer a small `@smthrs/ui` Commit strip embedded under the same plan: `[result SHA — subject] -> [captured HEAD]`. Read SHA, parent and files from the real backend receipt; the plan is not evidence of a commit. The target graph/GraphCard is useful for execution dependencies but should not be relabeled a Git graph. If HEAD moved, show the real changed base or stop and replan; never draw the desired parent relation without verifying it. Do not push by default.

Reuse `RunTraceCard` turns view. Each turn button holds one observable human sentence; selecting it uses `runs.trace.select` and displays the actual turn subtree, recorded script source, inputs/outputs and errors, with timeline/scrub for deeper inspection. `RunTrace.ts` / `EngineTrace.ts` fold journal events; cursor, selection and view persist in card payload. Use recorded explanations, not hidden model reasoning. No source means an honest missing-source state. Reuse DevtoolsPanel only for app diagnostics or common renderer pieces, not as the default run output.

## Skeleton contract and migration

`onboarding.act signal <name>` is the clearly named stub integration door. It accepts only the current stage's completion name; `prs.opened` normalizes to `issues.opened`. It records completion through the shared guide.changed dispatcher. No timer, Next button, or message send produces a success signal. Production lanes should emit after their persisted outcome, scoped to selected repo, run, account and playthrough; stale asynchronous work must re-read current scope before signaling. They can use `completeGuide` inside their existing successful transition, or the guide controller's signal door. The skeleton's generic signal door is not proof a feature exists and is not offered as the lesson instruction.

GuideSteps shows the green check (200 ms animation + 700 ms hold; reduced motion drops animation); complete lessons advance automatically. Say lessons auto-advance after the existing read pause, interrupted by input. Back pauses. Replay clears guide completion and increments playthrough. Terminal is durable step 9; `data-stage` is the new test/automation index. `data-step=14` is retained ONLY at the terminal DOM to reuse untouched existing workspace CSS; nonterminal data-step equals data-stage. No palette or layout CSS edits were made.

`migrateGuideV3` in `state/controller/guide.ts` runs at store hydration (`state/AppStore.ts`). `GuideSchema`/initialGuide carry `sequence: repository-v3` because the killed reorder already wrote version 3 with a different meaning. Versions 1/2 and unmarked old v3: untouched intro remains intro, unfinished old lessons restart at login (new repository prerequisites cannot be inferred), finished old guides remain finished at destination 9. Clear obsolete completion names, preserve profile drafts, plugin flags and surrounding session data. Marked repository-v3 guides are idempotent across reload. Theme command events keep the existing user/system projection actor contract; the flow journal retains the invoking actor.

Obsolete profile/practice/theme lessons and their e2e expectations were replaced by the new brief. Their old draft fields remain parseable for migration. Existing tutorial styles were not rewritten. The shell, stage table and navigation remain owned by this inventory lane.

## Parallel ownership / integration

See TUTORIAL2_LANES.json: eight lanes with disjoint exact file lists, signals and browser acceptance. No lane edits lessons.ts or GuideShell.tsx. Root integration owns shared composition contracts: AppController.ts, controller/context.ts, AppState.ts, AppStore.ts, flows/Flows.ts, flows/registry.ts, flows/SlashPayload.ts, state/controller/forms.ts, packages/rpc/src/Cards.ts and shared server registration. Each feature lane exports its entries/controller/route and provides a small integration handoff; root wires those exports after the lane work. Do not concurrently patch shared types/registries. Login owns local server.ts, so it mounts repository's exported route registrar. Agent-change exports the commit strip and trace lane owns RunTraceCard; root does their final composition after both are ready. New per-lane e2e specs may be added under their assigned prefix. No lane should create a second store authority or use useEffect.

## Verification report

- Requested hygiene onboarding run: 26 passed, 0 failed before edits. The interrupted Library-first v3 reorder was present but green.
- New standalone onboarding run: 17 passed, 0 failed (89 assertions).
- Focused onboarding + guide controller + migration + agent-context run: 37 passed, 0 failed (196 assertions). Explicit mounted GuideShell and PluginLessons checks: 4 passed, 0 failed (42 assertions).
- Required broad `bun test src/mainview/onboarding src/mainview/state`: 1,417 passed, 19 failed across 121 files. Compared failure names against the baseline run (1,432 passed / 19 failed): **zero new failure names**. Removed obsolete lesson cases account for the changed count.
- Required `bunx playwright test onboarding.spec.ts --reporter=line`: **5 passed**. Covers auto-advance/login gate, keyboard-only named-signal end-to-end walk plus real Librarian install, Back/Next/composer, opening Library not completing install, and narrow/reduced-motion layout. Helpers now use durable `data-stage`, not historical lesson mappings. Replay Escape intentionally pauses the say stage; Next resumes it. Composer helpers read open state rather than transition visibility.
- TypeScript after fixes: the app changes produced no remaining diagnostic; only `apps/server/src/index.ts:2754` TS6133 (`anonymousCatalogTurn` unused) remains. The previously known theme actor mismatch was corrected using the existing system projection contract for a Smithers-originated theme event. The reported server duplicate-identifier errors were not present in this run.
- No commit. Main checkout remains on main. `git diff --check` passed for edited implementation/docs/test files. Eight lane file lists have zero duplicate ownership. Port 47311 was free when checked with lsof; Playwright started its own server, and no unrelated process was killed.

Pre-existing broad-suite failures, separated from this work:

| File | Count | Failure family |
|---|---:|---|
| src/mainview/state/ChatShell.test.tsx | 1 | Removed composer surfaces menu |
| src/mainview/state/ComposerHotPath.test.tsx | 4 | Removed surface/connect trigger and menu interactions |
| src/mainview/state/ComposerLayout.test.tsx | 10 | Old header/sidebar selector, origin chips and plus/surface menus |
| src/mainview/state/controller/targetGraph.test.ts | 3 | Target label/filter/scrubber fixture expectations |
| src/mainview/state/seams/RepoTreeSeam.test.ts | 1 | Expected apps/ui path while current tree emits apps/app |

The old “Let's begin”/profile/practice/sidebar onboarding e2e sequence is superseded by the new brief and replaced, not counted as a product regression. GuideMigration tests now explicitly cover old versions 1, 2 and the interrupted unmarked v3, plus reload/idempotency. Feature-specific OAuth/GitHub/local-create/generation/commit/trace browser assertions belong to the eight lanes; the named-signal skeleton is deliberately not evidence those features have been delivered.
