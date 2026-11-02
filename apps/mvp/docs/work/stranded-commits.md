# Stranded commits

Owner: Claude Opus, lane `stranded-audit`. Requested by the lead on 2026-11-01
after Will's ruling PROC-26: "Land them fuck you are never allowed to leave
stranded commits that's how we lose the work!!!" Live status:
`~/smithers-builders/stranded-audit-STATUS.md`.

## Scope

- `~/smithers-builders/w12-hold`: every non-empty commit outside `::main@origin`
  that no `origin` branch holds (746 commits; the lead counted 566 with
  `mutable()`, which leaves out 149 commits held only by the local `bb2-*`,
  `bb3-*`, `electric-s7` and `mig2` remotes). This covers all heads, every
  `builder/*` bookmark, and the working copies of `cfg-build` (51b45986) and
  `ci-agent` (60fb9113). Lane `land-effect` owns
  `main@origin..builder/effect-upgrade` and the copies it made of it today;
  they are excluded.
- `~/smithers`, read-only (`--ignore-working-copy`): the same revset, committed
  since 2026-10-02 (30 days), minus what `w12-hold`'s bookmarks hold: 3,417
  commits in 1,196 heads. Its table is in
  [stranded-commits-smithers.md](stranded-commits-smithers.md).
- Workspaces with a live process or an edit in the last 6 hours, and commits
  made in the last 6 hours, are other agents' live work: listed, not judged.

## Method

`.smithers/flows/land/stranded.mjs` judges content, not subjects. For each hunk
of a commit's own diff it asks whether the added significant lines (6+
characters, not lone punctuation or jj conflict markers) are in main's current
tree at that path, or for long lines anywhere in main; a deletion hunk asks
whether the removed lines are gone. A hunk is on main at 90% or more, missing
at 30% or less, and partial between. Generated files (`pnpm-lock.yaml`,
`bun.lock`, `.smithers/target-index.json`, `schemas.lock.json`) are skipped;
landers regenerate them.

A missing hunk is superseded, with the evidence recorded, when main deleted the
file after the fork, when a main commit after the fork added or removed at
least half of the missing lines (main carried the content, then changed it),
when every later head of the commit's own stack removed them (the stack
itself moved on; the head's net diff then carries the work), when the file is
new in a package main removed (`apps/app`, `packages/backend`, the 2026-10-21
SCOPE-3 removal), or when the commit is an older version of a change that
landed: same author and author time (jj keeps both through rebase, squash and
duplicate), main's version committed later and touching the same file.

| Class | Meaning |
|---|---|
| ON-MAIN | Every hunk's content is on main. |
| SUPERSEDED | Every hunk is on main or superseded, with the main commit or stack head that did it. |
| PARTIAL | Some hunks on main or superseded, some missing. |
| STRANDED | Every hunk missing. |
| SCAFFOLD | Missing, and a temporary proof or staging commit by its subject ("temporary retirement crash red proof", "stage W8 qualification", checkpoints). Not landed; listed. |
| EMPTY-ISH | No significant lines (whitespace, generated files only). |

Commit classes describe history; the **Heads** tables decide landing. A head's
net diff (head against its fork point with main) collapses edits inside its
stack, so its missing hunks are exactly what landing that stack must add.
Many heads are older versions of one lane (rewritten, rebased or duplicated);
landing takes the newest version of each lane and records the older ones as
superseded by it.

## Result (2026-11-01, final run)

The classifier's classes are conservative: a hunk main rewrote in other
words still reads PARTIAL. Every head with missing content was then judged
by hand, family by family, by the sub-lanes in the ledger below.

| | w12-hold | ~/smithers |
|---|---|---|
| Commits judged | 644 | 3,417 |
| ON-MAIN | 291 | 727 |
| SUPERSEDED | 212 | 1,647 |
| PARTIAL | 132 | 949 |
| STRANDED | 3 | 71 |
| SCAFFOLD | 2 | 12 |
| EMPTY-ISH | 4 | 11 |

Ledger decisions (rows; a family row covers every copy of that lane): 46
LANDED, 12 PARTLY LANDED, 240 SUPERSEDED with the main commit, 7 SCAFFOLD,
4 HELD by a decision, 2 BLOCKED (one needs Will; one needs a GitHub App dev
stack). home-2-ci's BLOCKED row was landed afterwards by home-2
(`e1fdb6f0f2`). 147 commits landed on main: 140 by the sub-lanes, 7 by this
lane.

Rerun, read-only for both repositories, against an empty workspace at
main@origin:

```sh
.smithers/flows/land/stranded-audit.sh <workspace at main@origin> <out dir>
```

## Landing ledger

Every head with missing net content, by sub-lane. Each sub-lane judged its
families hunk by hunk against current main; LANDED rows name the pushed main
commits, SUPERSEDED rows the main commit that replaced the content, HELD rows
the decision that holds it. Nothing leaves this list without a pushed commit
or a recorded reason.

### Held by decision

| Heads | Decision | Reason |
|---|---|---|
| `lander/w8mig-held` 2bf9537d, mig2 `w8-top` 9d424aa5, and the `migrate(vibelang):` heads in ~/smithers | HELD | The W8 VibeLang migration. Lane smithers-f2 owns it (newer tips on nyc-01), and Will's rule of 2026-10-29 00:41 merges a VibeLang migration only when every tool, script and linter works on `.vibe` (`~/smithers-builders/smithers-tool-risk.md`). Kept under its bookmarks. |
| `held/sandbox-accounting` 7ec478c2 and its content in 321ccd7c, 62d8a6f3, 650117a1 | HELD | The lead narrowed AUTH-8 on 2026-10-28 01:57 after P1 defects survived nine Astra rounds; decision 0122's amendment, AUTH-8, `sandbox-budgets.md`, `todos.md` and `who-caps.md` still record the hold. Its decision `0124-todo-startup-ownership` needs a new number if revived. |
| `main@origin..builder/effect-upgrade` and its copies | OWNED | Lane `land-effect`. |
| ~/smithers a340a0cbb4, 0182dd8d5b (run credential stored on the device) | BLOCKED: Will | Main keeps a credential in the issue outbox and renews it at delivery (the landed design of `10ec5f4da5`, which later work builds on). Landing this reverses a landed auth design and needs an outbox redesign and a device-schema bump, so it needs Will's call. Sub-lane home-1. |
| ~/smithers 2bb993d7cb browser test for issue eviction | BLOCKED | Its fix landed re-implemented as `e6e1f71db8` (sub-lane evict). The test removes access with a shape `403`, which decision 0110 no longer treats as losing access; a replacement needs a dev stack syncing through the GitHub App and a fault switch for the role answer, which the mini lacks. |
| ~/smithers e98419b928 auto-POC code | HELD | Unwired and older than per-repository roles; decision 0018 lists auto-POC as follow-up work. A pointer is in `docs/work/issue-lifecycle.md`. Sub-lane home-1. |
| ~/smithers 40d9433e74 issue POC, Repro and Prototype drafts (migration `0034_prototypes`) | HELD | `apps/mvp/docs/features/issues.md` says the draft files "are outside this landing". Readable at that commit. Sub-lane home-3. |

### Parent lane checks

| Head | Name | Decision | Evidence |
|---|---|---|---|
| `da5b4eda61` | builder/first-run | SUPERSEDED | Its commits were changed later in the who-may-ask lineage (head 650117a1), landed as `8800f22acb` "guide first run and narrow AUTH-8…"; `tests/FirstRun.test.ts` on main was then rewritten by `199eafbb24` (model setup moved into the shared toast stack). |
| `b6b6552142` | builder/bb4-writes | SUPERSEDED | Rechecked on current main: 5 of 5 commits superseded, net 0 missing (migration `0071_branch_write_notices` and `write-admission.spec.ts` on main; carriers `1d5f008b71`, `959ed5fca8`, `39b7705c9e`, `e14f3bc21c`, `627194e142`). |
| `6b985b4f92` | builder/app-timeouts | LANDED | By sub-lane ci-a3 (`fe6a735a56`..`8465130939`); the 50 lines left are `worker/test/reset*` and one `RepoApi.test.ts` hunk, superseded by `1dc140ad06` and `a35b513380`. |
| 8 TUI fixes from home-6 (#3676–#3702) | ~/smithers | LANDED | Their issues were closed "not planned" on 10-16 because mvp.md defers the TUI from launch: a schedule, not a rejection, so they landed under PROC-26. |
| `d7f78f322e` | home-2-ui helper | LANDED | The helper stalled before testing; home-2 duplicated its commit, finished it and landed it as `e1fdb6f0f2`. Its original stays in w12-hold. |

### Sub-lane app-a (DONE)




Judged against main@origin `dad7863710` ("📝 docs(mvp): inventory every stranded commit by content"), 2026-11-01.
Nothing in this family needed landing: every missing hunk is on main, superseded by a named main commit, held by
the lead, or scaffold. No commits pushed. Workspace `sa-app-a` removed.

Method: for each `net.gaps` line in hold.json, check main@origin, then the W17 landing `8800f22acb`, then walk
`8800f22a::main@origin` for the first commit that removed it (script: /tmp/sa-app-a/trace.py). Lines never on main
were checked against `held/sandbox-accounting` (7ec478c2), `builder/auth` and its narrowing commit `376d024e`.

#### Lineages

```
who-may-ask 650117a1 (oldest) --rewritten--> d60764..edea3c --> c19955 --> 7ec478c2 (held/sandbox-accounting)
                                                                             |--> 321ccd7c (scaffold crash proof)
                                                                             '--> 376d024e narrow AUTH-8 ... a33f7fca builder/auth (newest) = W17 8800f22a
bb6-cli older copy: 16357a..62d8a6f3 (stacked on edea3c) --rewritten--> builder/bb6-cli 4ed2c811 (newest) = W26
```

#### Heads

| Head | Name | Decision | Pushed main ids / evidence |
|---|---|---|---|
| `a33f7fcaea` | builder/auth | LANDED | Tree identical to main `8800f22acb` "🔒 feat(mvp): guide first run and narrow AUTH-8 to repository conversations and clone caps" (W17, `jj diff --from 8800f22a --to builder/auth` empty). The 8 missing / 10 partial lines were rewritten on main later; see table below. |
| `4ed2c81157` | builder/bb6-cli | LANDED | Landed in W26 (`892bbbf763` "🐛 fix(build-cli): type gate refusals and retain execution receipts", `239bac7e42`, `5bcd94cba3`, `9ade31348a`, `417af8c017`, ...). Remaining gaps SUPERSEDED: PackagePlanner `installations` set replaced by `e0f8f12c18` "🔒 fix(build-cli): grant only rechecked installed dependency trees" (W26 bb6xW25 grant-path fix, security hardening); RawErrorSites `["src/Cli.ts", 15]` repinned to 14 by `31365ca555` "🧪 fix(build-cli): pin merged raw error count and format the owners table"; Cli.ts `config.environment ?? process.env` is on main (line moved). |
| `650117a1db` | builder/who-may-ask | SUPERSEDED | Older copy of the auth lineage. Rewritten into d60764..edea3c, landed as `8800f22acb`. Its unique commit ca05763bcf "resync's conflict case..." is on main as `3eb23a38b8`. Its sandbox-hours / TODO-cap code is HELD (see held row). Its unique SessionStore.ts/Budget.ts variants were rewritten in the newer lineage, then removed by the narrowing. |
| `62d8a6f3ce` | (none) | SUPERSEDED | Auth part = the same d60764..edea3c commits (landed `8800f22acb`; sandbox parts HELD). bb6 part = older copy of builder/bb6-cli: McpLifetime.test.ts, fixtures/mcp-lifetime.ts, McpParseError.test.ts, McpStdio.test.ts, both changesets are on main (`5bcd94cba3` "🐛 fix(cli): answer malformed MCP JSON without losing later requests" et al.). Owners.ts `const relative = absolute ? ...` superseded by `417af8c017` "🐛 fix(build-cli): map owners paths spelled through a symlinked workspace alias"; McpTransport.test.ts `environment: { HOME: root, ... }` is on main reformatted (lines 74-75). |
| `321ccd7c31` | (none) | SCAFFOLD | Head commit "🧪 test: temporary retirement crash red proof" is a one-line crash injection in Startup.ts on the held stack. Every other missing line is in `7ec478c2` = held/sandbox-accounting. |
| `7ec478c2f6` | held/sandbox-accounting | HELD (not landed) | Lead decision [01:57] 2026-10-28 (lead-todo.md line 98): narrow AUTH-8 to ask+read+clone; machines Members-only; hold sandbox accounting after P1 defects through nine Astra rounds (payer overwrite BranchSandboxes.ts:254, blocked tool prevents daily shutdown :402). Main still records the hold: decision 0122 "Amendment: narrow this landing", rulings AUTH-8, features/sandbox-budgets.md:77, features/todos.md:383, work/who-caps.md:25. No later main commit or doc asks for it. Bookmark left untouched. |

#### builder/auth gaps (on W17, rewritten later by main)

| File / line | Main commit that changed it |
|---|---|
| db/Database.ts `0072_role_observations` import + entry | `1d5f008b71` 🔧 fix(devx): rebuild migration registration and merge device schema history (now in MigrationManifest.ts) |
| docs/features/first-run.md "Until a person has had a conversation..." | `d8851a1de3` 🧹 fix(mvp): finish model setup toast validation |
| src/boot.ts `FirstRun.layer`; ComposerGate.tsx comment | `199eafbb24` 🐛 fix(mvp): move model setup into shared toast stack |
| first-run/FirstRunSteps.tsx `@smthrs/ui` import | `cbb40294a0` 🎨 style(mvp): the app bar, conversations, landing and bug report in the mock look |
| repo/RepoHeader.tsx clone comment | `4fdaaa36a7` 🐛 fix(mvp): gate cloning and complete live Issues layout audits |
| worker/RepoAbout.ts `appSlug` import | `aedf57aea9` 🐛 fix(mvp): say Not found for an absent repository when GitHub's anonymous quota is spent |
| worker/SignIn.ts `install = ...installUrl` | `699808ed52` 🐛 fix(mvp): bind APP_DOMAIN and APP_ALIASES to ChatApi... (0130) |
| worker/personal/Api.ts AUTH-8 comment | `d2942b1ea7` ✨ feat(mvp): model connections like Amp's... (decision 0132, AUTH-10) |
| model-endpoint.md, personal-model.md, repo.md, commands.test.ts, first-run.css, Answers.ts, ChatApiProgram.ts, RepoApi.ts | on main (classifier partial/whitespace) |

#### Hunks not landed, with reason

- HELD, `7ec478c2` content (also every NEVER-on-main line of 321ccd7c, 62d8a6f3, 650117a1): migrations
  `0072_sandbox_daily_limit`, `0074_sandbox_generation_history` (and its renumbered `0073_role_observations`; main
  keeps `0072_role_observations`); decision `0124-todo-startup-ownership.md` (number now taken on main by
  `0124-background-progress.md`; renumber if ever revived); worker/branch/Budget.ts, Startup.ts, Machine.ts,
  Machines.ts, Sandboxes.ts, BranchSandboxes.ts daily-limit/generation ledger; flows SandboxCall, SandboxKeep,
  TerminalOpen, Todo, TodoAgent, TodoMachine machine admission; terminal `daily_limit` UI (actions, schema, view,
  tests); ExecutionHost/Executions `dailyHours`; docs sandbox-budgets/todos/observability/who-caps/repo
  `CLONES_PER_PERSON` row; platform-cloudflare `SandboxObject.wakeRunning` + `.changeset/confirmed-machine-ownership.md`.
  Reason: lead narrowing, recorded in decision 0122 amendment; P1 defects.
- SCAFFOLD: `321ccd7c31` crash red proof (Startup.ts one line). `14ed9812cb` is classed SCAFFOLD by the
  classifier but builder/auth's tree equals main's `8800f22a`, so nothing is lost.
- SUPERSEDED: everything in the two tables above.

### Sub-lane ci-a (DONE)

stranded-audit/ci-a, 2026-11-01. Families: cfg-build (51b4598687) and ci-agent (60fb9113b5). Workspaces sa-ci-a, sa-ci-a2, sa-ci-a-main (baseline) forgotten and deleted; fork sa-ci-a3 likewise.

| Head | Name | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| 51b4598687 | cfg-build@ (11 commits; cfg-build-net@ 667a4d41, cfg-build-graph@, cfg-build-mach@ are inside it or empty) | LANDED | e7c8133635..6c9e4781c2 (12: 11 copies + the decision-reference renumber). Mini: apps/mvp `pnpm typecheck` 4/4, 47 files / 680 tests, `pnpm docs:check` green; eslint clean; sandbox CiJob tests pass. Pre-existing reds proven on plain main by source swap: SandboxSpend.test.ts (2), TodoHost.test.ts (1), sandbox RealExistingContainer + SandboxCommand. |
| 9dae978249 | cfg-reds@- / builder/app-timeouts (14) | LANDED (2 hunks SUPERSEDED) | fe6a735a56..8465130939 (16 commits: 14 copies + 3bbf684318, 8465130939); details ~/smithers-builders/stranded-audit-ci-a3.md |
| 60fb9113b5 | ci-agent@ (65 commits incl. builder/ci-agent bc51864e) | PARTLY LANDED | 5e849c437f..f94ad3048c (64: 62 copies + f441e866e3 lint fix + f94ad3048c target index). Not landed: ca184cecec (SUPERSEDED by b274d80b0f), 16df066772 (on main as fe9f7be475), 11354f162d (no longer fits; see below), .probe-ci-agent/ (SCAFFOLD). |

#### Not landed (with reason)

- ci-agent ca184cecec "🧪 test(agent): cover policy fallback and unreadable state boundaries": SUPERSEDED by main b274d80b0f "🧪 test(agent): exercise policy defaults and reader race failures", which closes the same agent coverage gaps (construction policies, cooling routes, corrupt child state, threshold file races) in the same three test files.
- ci-agent 16df066772 "🧪 test(model-host): exclude the hidden agents command from grants": ON MAIN as fe9f7be475 (identical; copy empty).
- ci-agent e7480a398e and bbf0173373: code on main as ee55a19021 and b121939f11; only their changesets (and control docs/api.md lines of bbf01733) land.
- 63942d2a02 reset, 10cd4df2eb RepoApi.test.ts hunk: SUPERSEDED (see ci-a3 report: 1dc140ad06, a35b513380).
- ci-agent 7100b96a11 "🐛 fix(observability): classify retry and flow-realm refusals": code ON MAIN as 070cd83172 (same subject); only its changeset lands.
- ci-agent 11354f162d "🧪 test(cli): measure human-wait budgets with a controlled clock": NOT LANDED, no longer fits main. Its frozen wall clock never passes the resume grace on current main: the pending resume's requestedAtMs is re-stamped at the frozen time, so the run never resumes and the case times out (2 of 2 on the mini, also with a poll added for the pending entry). Main's real-wait version of ModuleHumanWaitBudget.test.ts passes on the stack (1/1). Intent (keep loaded hosts from charging real model latency to the 12 s allowance) needs a resume-aware clock; left for the CLI owner.
- `.probe-ci-agent/*` in 60fb9113b5: SCAFFOLD (probe scripts and before/after copies of import edits).

#### Decisions so far

- cfg-build: decision renumbered 0128 -> 0145 (main's 0128 is repository feeds, 0144 is Cloudflare overflow), inside e062be9ad0's copy e7c8133635 with FLOW-14 and its Sources line (parent's exception), link at 0145. Conflicts resolved: alchemy.run.ts/infrastructure.md/Executions.ts/ChatApiProgram.ts (both sides kept), BranchSandboxes.ts (machine spec instance + main's overflow-box instance).
- cfg-build working copy 51b45986: landed as "✨ feat(mvp): run the apps/mvp gate as 16 shards and a coverage job on the gate machine".
- ci-agent working copy 60fb9113: real part landed as "⚡ perf(cli): import Node services by subpath, not the platform barrel" plus ws-ci-agent's unsnapshotted Bootstrap.ts doc edit; .probe-ci-agent/ left out.
- Older copies of 4 ci-agent subjects (37eb9dbf, dad6289a, 27da0c9c, 6154adae, b4a05c37, 5c55ae04, b9e2970a, 0624bd65, fcfcd4e2, f81eea91, 35bdb578) sit in the effect-upgrade lineage (land-effect@, d76f1b43, builder/effect-upgrade): lane land-effect owns them.

#### ci-agent evidence (Mac mini)

- Conflicts resolved: external-peer-scenario.ts (stack's earlier stolen-lease takeover + main a5f5321cd0's one-writer CAS), SqlControlRuntime.test.ts import (both), CodeDriftLiveHost.test.ts (stack's stage observer + main a2249e4f7f's log tracing), RealmFlowBundle.ts (main's bundle).
- 64 targets (`:test :check :lint` of smithers, agent, harness, model-host, build-cli, control, engine-store, flow, journal, run-store, gateway, migrate, effect-electric; harbor:offline; repo-targets:test), stack vs plain main source swap: stack 7 red, main 9 red. The stack's 7 (agent:test cargo ENOENT, harness:test, engine-store:test coverage 99.9%, flow:test coverage, build-cli:test rustc ENOENT, repo-targets:test, harbor:offline) are red on main with the same failures; control:test and gateway:test are red on main and green on the stack. Lints green after f441e866e3.
- `//packages/smithers:test` is linux-only, so it can't run on the mini. Its 45 changed test files ran directly with vitest (VITEST_MAX_WORKERS unset): 563 passed, 7 failed. All 7 also fail on main: Bin/BinLaunch "names the refusal" (~/.smithers 0.x state on the mini), NativeCancellationCli x3, QuickstartGuides x3. CliTestLanes fails only under the farm's forced VITEST_MAX_WORKERS=2 and passes without it.
- `pnpm docs:check` green. `.smithers/target-index.json` regenerated on the mini.
- Not run: the linux-only `//packages/smithers:test` gate as a target, and its 100% coverage.

#### cfg-build related workspaces

- cfg-build-net@ 667a4d41 = e062be9ad0's child 667a4d4157, landed as 5828caff30.
- cfg-build-graph@ 80bd0b5e and cfg-build-mach@ a5fa6337 are empty, on 0a8e3a686b and 64a277abbb, both landed.
- cfg-reds@ 02028b90 is empty, on 9dae978249 (landed by ci-a3).

### Sub-lane ci-a3 (DONE)

stranded-audit/ci-a3 (fork of ci-a), 2026-11-01. Head 9dae978249: builder/app-timeouts (63942d2a02..6b985b4f92, 13 commits) plus cfg-reds' 9dae978249.

| Head | Name | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| 9dae978249 | cfg-reds@- / builder/app-timeouts (14) | LANDED (2 hunks SUPERSEDED) | main fe6a735a56..8465130939 (16 commits: the 14 plus 3bbf684318 doc note and 8465130939 farm-slot fix). Evidence below. |

Pushed, oldest first: fe6a735a56 (63942d2a02), 62a80da6c2 (caef8cac17), 2033393e00 (f47a2df62d), 4ba45f94c7 (be2c8cbb71), 4061b3147b (10cd4df2eb), 732c15efe1 (a26c42db5a), aeb6a24009 (b05f717c18), 83e2659e60 (2c0b5d1788), 0305a4a909 (3144df937b), 83419508ff (d2723c2ed5), b12f8f39de (2796cd1f6e), e825e36ce4 (deb0d0035b), d9a1a4c21e (6b985b4f92), 70039f6151 (9dae978249), 3bbf684318 📝 docs(mvp): record that the worker test reset landed separately, 8465130939 🐛 fix(mvp): let the owned test stack replace a farm slot's endpoints.

Evidence (Mac mini):
- `pnpm typecheck` (four projects) passed on the stack at dad78637 and again rebased on 0810336815.
- `pnpm test:stack` passed (with a fake farm slot after the fix); `db/TestEndpoints.test.ts` passes under `db/test-stack.sh`.
- Full suite `bash db/test-stack.sh -- pnpm vitest run --maxWorkers=4`: 6646 passed, 31 failed in 22 files. One (TestEndpoints) was this stack's fault: test-stack.sh kept the farm's FARM_ELECTRIC_PORT; fixed in 8465130939 with a regression. The other 30 failures in 21 files (ChatChrome/MobileLayout browser, PersonalModelSettings, PACKAGE.test, BugDoor, ConversationList, conversations, memory, SandboxSpend, TodoHost, github/Api and others) fail identically on plain main@origin dad78637 in the same farm (source swap: same 30 test names, none only on the tip). Coverage under 100% only in files outside this stack (fleet, views/steps, plugins), tied to those pre-existing reds; the stack's production files (conversations/store.ts, flows/RepoClone.ts) are at 100%.
- After rebasing on 0810336815: typecheck plus runners Overflow/Fleet/TodoRunner, chatApi, store, RepoClone tests pass; ConversationList's one pre-existing red remains.

#### Not landed (with reason)

- 63942d2a02 `apps/mvp/worker/test/reset.ts`, `reset.test.ts` and its infrastructure.md reset bullet: SUPERSEDED by main 1dc140ad06 "🐛 fix(mvp): avoid global catalog scans in worker test resets", which deliberately re-implemented the same TRUNCATE-free reset (adds timeline_phase_claims, transactional `ALTER SEQUENCE ... RESTART`) with its own regression. The harness keeps main's `reset`; 63942d2a02's slow-await trace is landed, and its infrastructure.md sentence about it is appended to main's bullet.
- 10cd4df2eb `apps/mvp/worker/RepoApi.test.ts` hunk (refusal expired by 1 s): SUPERSEDED by main a35b513380 "🐛 fix(mvp): share repository refs cache keys", which made the identical change.
- be2c8cbb71 `src/test/chatApi.ts` `engineStore`: main had renamed the Postgres schema to `TestSchemas.schemaName("flows")` in lines this commit replaces with local SQLite files; the SQLite version is landed (the commit's intent), so main's rename there is moot.

Notes for the parent: decision 0144 is now taken on main (runners, 3f2e5e2db2..0810336815), so cfg-build's gates decision needs the next free number. Main also gained ci-agent subjects from another lane: ee55a19021 (engine memo map), b121939f11 (observed waits), fe9f7be475 (hidden agents command).

### Sub-lane ci-b (DONE)

stranded-audit/ci-b, 2026-11-01. Families: CI-shard, CI lanes W25, ci-release, ci-flows, 1423db6ecc, bf9dcdee57.

| Head | Name | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| `d2b355bf5e` | W25 (ci lanes) | SUPERSEDED | Content on main as 454bbb1c89, cefe037322, 333e31a579, b8cbbd20e4, ffb8703b0a, 684f616436, 8fc31b5507, 557d6bbf88, 7989646cbf; projections regenerated by 522c2d02e6 "reconcile browser setup and regenerate W25 outputs" and 55801588bb "regenerate W26 API baseline". Gaps: `id: setup`, `workflowDispatch: false`, `steps.push({` are removed lines of deletion hunks that recur elsewhere in the file (classifier false positive; the deletions are on main). |
| `c1d2717c45` | builder/ci-ui | SUPERSEDED | On main as 67cee6b848, ffb8703b0a. Playwright `browsers: ["chromium"]` widened to chromium+webkit by 522c2d02e6 (deliberate merge with ci-flows). Privileged-after-checkout check and its test belong to the trusted root setup that 684f616436 "delete the dormant root setup" removed. Changeset wording replaced by b4cec29b5e. SCOPE-3 comment reworded by 25b61f5296. |
| `d16b924d3c` | builder/ci-drift | SUPERSEDED | Identical to main 684f616436 (empty interdiff). Gaps are deletion-hunk false positives; baseline hash regenerated by 55801588bb. |
| `0b4ecc8849` | builder/ci-build | SUPERSEDED | On main as 8fc31b5507, 72482f1306. PackagePlanner `realpathSync` line rewritten by e0f8f12c18 "grant only rechecked installed dependency trees"; README ` *` sentence reworded by 454bbb1c89. |
| `adb4c688e3` | builder/ci-repo | SUPERSEDED | On main as 557d6bbf88, 7989646cbf, eaef01631c. `bun test --isolate test` parametrized by 333e31a579 "pin the terminal unit directory selector"; every export it added is in main's list (21404c7f79 later added Transcript); platform-browser dependency reorder only. |
| `3cdca413c0` | builder/ci-release | SUPERSEDED | On main as 44f8fd1d5d, de26ba420a, ad31a575b6 (sql-pg peer), eaef01631c. 3c166a0df0's shared `resolveWorkspaceDependencies` was deliberately dropped by 8a5693102c ("Publication manifests already resolve workspace links on main, so that half is dropped"); check-npm-dedupe keeps the equivalent `rewriteWorkspaceProtocol`. |
| `6447f92bba` | builder/ci-flows | SUPERSEDED | On main as e9f2e76a59, b4cec29b5e, 25b61f5296. `CiToolchain.Needs({ playwright: [...] })` replaced by 522c2d02e6 with `CiToolchain.Playwright({ cwd, browsers: ["chromium","webkit"] })`, keeping both browsers. |
| `1423db6ecc` | build-lint docs budget | SUPERSEDED | Squashed onto main as 3b734cb691 "enforce import scopes and clear workspace gates" (PACKAGE.ts docsDrift 20m and the W22 build-lint notes are verbatim on main). Baseline hash regenerated later; CycleDetectionSql import is a moved line, present. |
| `bf9dcdee57` | create-app skills | SUPERSEDED | On main as 67f85a3588, e40da83be9; main's public-export-surface.json has no create-app entries (deletion landed). |
| `801ae69887` | CI-shard newest (23 commits) | LANDED | Split by lane. ci-flows2 4: 596cbc5e03, e53c7c4897, 43f6bc6fb7, e21378f127. ci-shard + W27: 70ecf51f02, 9a82813033, 701a17d1a6, 855ed62251, f270be5bf3, 20766ac863. app-timeouts 13: landed by another lane as fe6a735a56..d9a1a4c21e (see 9dae row). Mini evidence for the ci-shard batch (ci-b-logs/b4.log, b5.log): `smthrs target //:ci --write` and `//:targetIndex --write` leave both unchanged; `smthrs lint //:ci //:driftCi //:targetIndex` pass; repo-targets vitest 197/197; ci-inventory 21/21; targets GithubCiGen+GithubWorkflow 182/182; build-cli 7 files 133/133; cloud.test.ts 42/42; targets, build-cli, repo-targets `check` pass; release/evidence 190/191, the 1 red (jj workspace without .git) is the same red on plain main (swap-pack.log). One landing fix: CiSelection.test.ts expects the TestSchemas source 72ece084eb added (red on main before this push too). |
| `9dae978249` | app-timeouts + toast tip | SUPERSEDED (landed by another lane) | All 14 commits landed on main while I tested, by another stranded-audit lander: fe6a735a56..70039f6151 (same subjects), plus 8465130939 "let the owned test stack replace a farm slot's endpoints" and 3bbf684318 "record that the worker test reset landed separately", which records why the lane's own reset and its two regressions were not landed (main's 1dc140ad06 reset). I abandoned my own copies. My mini evidence: same 24-file selection on main and on my copy fails the identical 35 tests (pre-existing; ci-b-logs/swap-main.log, swap-b3.log); typecheck, test:stack pass (b3.log). |
| `79b7a879cd` | builder/ci-shard | LANDED | cec6cb6841 and 79b7a879cd are identical to 801ae's a805868e85 and e8dc2d90e7 (stack A). ac7f4d45c1 "follow removal of the global docs banner" SUPERSEDED by main 804dafe28d "check installation copy after banner removal" (same assertion change; only a comment differs). |
| `9445aa0c85` | builder/ci-flows2 | LANDED | Identical to 801ae's first four commits. Pushed 596cbc5e03, e53c7c4897, 43f6bc6fb7, e21378f127. Mini: DispatchErrorContract 1/1, SharedText 24/24, SandboxJob 21/21, DriveWrites 2/2; engine, sync, sandbox, platform-cloudflare `check` pass (focused runs miss package coverage thresholds by design). Log ~/smithers-builders/ci-b-logs/b1.log |

#### Conflict decisions, stack B (app-timeouts)
- 2bed55e9dd reset.ts/reset.test.ts: main reimplemented the same transactional DELETE reset in 1dc140ad06 "avoid global catalog scans in worker test resets" (adds timeline_phase_claims, ALTER SEQUENCE RESTART). Kept main's reset; ported app-timeouts' two distinct tests (reader holds the tables open; table files preserved) and the harness slow-await diagnostics onto main's `reset`.
- 4306a2b055 infrastructure.md: kept main's slot-Electric and schema-reaper paragraphs (9eeb9e1237, 72ece084eb) and added the opt-in db/test-stack.sh paragraph.
- 653286dc42 chatApi.ts engineStore: app-timeouts' SQLite engine store replaces the Postgres schema whose name 72ece084eb switched to TestSchemas.schemaName; the remote/domain schemas keep main's TestSchemas names.
- 3bdf374783 RepoApi.test.ts: both sides made the same `now() - interval '1 second'` change; kept the app-timeouts comment.

#### Hunks not landed, with reasons
- ac7f4d45c1 (builder/ci-shard): SUPERSEDED by 804dafe28d, the same assertion change with a different comment.
- Stack B copies of app-timeouts: I abandoned my own duplicates because another lane landed the originals first (fe6a735a56..70039f6151). Not landed from my resolution: two reset regressions (reader keeps tables open; relfilenode kept) and a reworded infrastructure.md sentence. 3bbf684318 records on main that the lane's reset and its regressions were deliberately not landed in favour of 1dc140ad06. The RepoApi comment wording: main keeps its own comment on the same `now() - interval '1 second'` line.
- W25 / ci-ui / ci-drift / ci-build / ci-repo / ci-release / ci-flows / 1423db6ecc / bf9dcdee57: nothing to land. Each gap is a deletion-hunk false positive, a regenerated hash, or a line main rewrote; the rows above name the main commit.

#### Findings for the parent lane
- Main has docs and API-baseline drift that my stack did not cause. A regeneration on main's tip changes public-api-baseline.json (runner/*, Acp, AgentRunner, ExternalAgent, Transcript, TestSchemas, CiJob and others) and the agent, cli, database, engine-store, patterns and platform-node API pages plus llms-full.txt. So `//:docsDrift` and `//.smithers/flows:apiBaseline` are red on main. I did not commit that regeneration, because recording reviewed declarations belongs to those features' owners.
- The jj-workspace release test in pack-release.test.mjs ("reads a jj workspace without .git") fails on plain main on the mini.
- On the mini, 35 apps/mvp tests in 24 files fail identically on plain main and on the app-timeouts copy (swap-main.log, swap-b3.log), so they are pre-existing.
- The mini-run client counts any command containing "e2e" as E2E mode. A path such as e2e/offlineTransport.test.ts in an eslint list is enough to trigger it.
Workspace sa-ci-b removed after landing.

### Sub-lane app-b (DONE)




Families: toasts/progress (toasts2, f02a185170, w13-toasts 618f8d2383, 86f688d42c), bb4-app2, bb5-app, progress cc87e618b5.
Workspace: ~/smithers-builders/ws-sa-app-b (w12-hold, sa-app-b). Originals untouched.

#### Lineage (from lead-todo, toasts2-REPORT.md, w13-toasts-REPORT.md, bb4-app2-REPORT.md, bb5-app-REPORT.md)

```
bb4-app2 717f550e (W11)  --W13 9662836059fe lands non-toast fixes, HOLDS 7db7a18f/1306d2d3/717f550e (Astra)
  -> w13-toasts 618f8d23 (toasts redo on W14 writes; Astra P2 "permanent Requested") -- left out of W15
  -> toasts2 1ba8d1ef (+ f02a185170 older copy) -- STOPPED at review limit: "no single admission authority"
  -> progress redesign cc87e618 (decision 0124) -- LANDED W18 as e14f3bc21c71, refined f33bc3757938
bb5-app a80b82ce (bb4-writes + bb5 fixes) -- LANDED W13 9662836059fe (bb4-writes part) + W14 959ed5fca835
w14-writes 111179544c.. (inside 618f8d23) -- LANDED W16 627194e142ec..a75d29abd74c (decision 0122 -> 0123)
86f688d42c -- conflicted root-parented copy of 111179544c (lander rebase artifact)
```

Decision 0124 (main, e14f3bc21c71) states: "Nothing is stored for presentation: no progress row, owner, lock or generation" and "The three earlier builders' twelve review rounds stored a progress row beside the receipts ... Each class is impossible here or has a regression test". That is the deliberate replacement of decision 0121-operation-progress and every FlowNotices/FlowProgress/operationNotice/snapshotProgress/todoProgress/issueProgress file in the toast heads.

#### Heads

| Head | Name | Decision | Pushed main ids / evidence |
|---|---|---|---|
| `1ba8d1efde` | builder/toasts2 (23) | PARTLY LANDED | 83eb2a5099 landed as **1f42c292ff2a** "🧪 test(platform-browser): assert mode bits without privileged access checks". Rest SUPERSEDED by e14f3bc21c71 "✨ feat(mvp): show background progress as a projection of receipts" (decision 0124, W18) + f33bc3757938. Builder itself stopped (`docs/work/toasts2.md`: "no single atomic admission/result authority"); lead replaced it with the progress redesign (lead-todo 00:57). |
| `f02a185170` | - (4, older copy of toasts2 base) | SUPERSEDED | e14f3bc21c71 (0124). Its top commit "reconcile progress across interrupted write admission" is the same stored-progress reconciliation 0124 rules out. |
| `618f8d2383` | w13-toasts (22; builder/w13-toasts divergent) | SUPERSEDED | 19 w14-writes commits on main by subject in W16: 627194e142ec, 2d4e899b08ad, d890c4b0322b, 3820a388bea6, 39b7705c9e5d, efb71af72a29, 3877247b9e80, 9a62b3f26457, bb772e7b575a, 821c6fbead7d, 296604b0f68b, 442c645993e2, 402fd35b344c, e83354acdabf, fcdcafa459ee, a607f642cbb5, a37329a06c1a, a29c886b0c5c, a75d29abd74c (their "missing" lines are intermediate states fixed later in the same stack; decision 0122 renumbered to 0123). d422bb58fa is empty. 3 toast commits (6c5d84c8cb, 9c9b33924b, 618f8d2383) SUPERSEDED by e14f3bc21c71 (0124). |
| `86f688d42c` | - (1) | SUPERSEDED | Conflicted (`conflict=true`), root-parented lander rebase artifact of 111179544c (contains conflict markers; 7862 insertions from root). Landed as 627194e142ec "🐛 fix(mvp): retain write inputs before asynchronous admission"; decision is 0123-write-input-receipts on main. |
| `717f550e01` | builder/bb4-app2 (11) | SUPERSEDED | 8 non-toast fixes landed in W13 9662836059fe "🐛 fix: land W13 browser, writes, views, CLI, privacy and docs" (main has PluginScreen Connection status, blank-report docs, run-panel/flow-draft `requires(...)` specs, bug-report-privacy spec, commands refusal; later evolved). W13 explicitly held 7db7a18f/1306d2d3/717f550e (toasts); those SUPERSEDED by e14f3bc21c71 (0124: no FlowNotices/stored progress). |
| `a80b82ce4b` | builder/bb5-app (13) | SUPERSEDED | bb4-writes part (65d92738ce, d9d3378f53, 5b86d9d1d2, 6a00d1869c, b6b6552142) in W13 9662836059fe (migration 0071, WriteFeed). bb5 part in W14 959ed5fca835 "🐛 fix: land W14 production followups and CLI references" (bugbash4-bb5-app.md, admission.ts, appRoute, not-found, filter-sitemap, telemetryExport, IssuesScreen failure line, visitor counts). Remaining missing lines (sameFields recovery matching, e2e titles) rewritten by w14-writes 627194e142ec (input receipts, 0123); main's write-admission/todo-write-admission specs keep the same tests. |
| `cc87e618b5` | builder/progress (3) | LANDED (earlier) | e14f3bc21c71 + 60137de34d/f13f678099 equivalents in W18 (999a30cbc877); its 12 "missing" lines are later refinements on main: f33bc3757938 "🐛 fix(mvp): project committed TODO results after recovery cleanup" (0124 item 7 inserted, renumbering 7-10). |

#### Hunks not landed, with reason

- toasts2/f02a185170/w13-toasts/bb4-app2 toast code: 0121-operation-progress, flows/progress*, flows/notices*, noticeSchema, attention/operationNotice, snapshotProgress, todoProgress, issueProgress, receiptNotices, FlowNoticesStore/flow-progress device stores, generations/owner tokens, test/faults progress faults, playwright.progress.config.ts, background/issue/todo-progress specs (main has its own), docs/work/toasts2.md and w13-toasts.md: SUPERSEDED by e14f3bc21c71 (0124 §"The findings this rules out").
- toasts2 1be995b47a `BrowserEngine.leaders` + README/libraries.md row: SUPERSEDED by 0124 §6 `BrowserEngine.runs` snapshot-and-follow stream (f13f678099 -> main).
- toasts2 30d2274d39 TODO outbox v3 migration assertion: depends on toasts2's todo-sending v3; main is at v2 (migrations.test.ts:383). SUPERSEDED with the toast schema.
- 86f688d42c whole commit: conflict artifact; SUPERSEDED by 627194e142ec.
- bb4-app2/bb5-app docs/work notes lines (status, "No push"): main holds its own current versions of those work files.

#### Tests (Mac mini)

- 1f42c292 on 73c00d52: `vitest run test/BrowserFileSystem.test.ts` 63/63 pass; `pnpm run check` pass; eslint pass. `dprint check` reports 2 unformatted files, test/BrowserRuntime.test.ts and src/internal/Protocol.ts, identically on plain main (source swap, /tmp/sa-app-b/pb-test2.log vs pb-test3.log): pre-existing, not touched by this change.
- The landed change: browser FS `access` checks mode bits itself (`permitted`, src/BrowserFileSystem/make.ts:128), so main's old assertion `toBe(backendReadable)` failed when the Node test process can bypass mode bits (root).

### Sub-lane app-c (DONE)




| Head | Name | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| `0be3bde878` | bb2-notify | SUPERSEDED | run/TODO rail entries and their `displayTime` removed by main `b65aa03472` ✨ feat(timeline): rebuild the rail to the mock (railEntries ignores drafts/todos, no `run:` entries); message `displayTime` and its test are on main |
| `a91b10af06` | bb2-chat | SUPERSEDED | length limit, first-Enter format, navigation refusal and late-refusal tests are on main; `onPendingInput` on main in a reworked form. Only the old `/new` dispatch test and its `conversation/new`-only restore guard are missing: main `e14f3bc21c` ✨ feat(mvp): show background progress as a projection of receipts redefined `/new` admission (decision 0124) and replaced the test with "new conversation outcomes: the engine's refusal is Not sent..." |
| `881ce02e3d` | bb2-runs | SUPERSEDED | stack landed as main `3edbe7e211` 🐛 fix(runs): show pending repository history while sync loads; the "missing" lines are main's later rewrites: `959ed5fca8` 🐛 fix: land W14 production followups and CLI references pinned `run-records.spec.ts` to `E2E_FAILED_RUN`/`E2E_REPOSITORY_RUN`; `/actions` renamed `/runs`; RepoRunsView skeleton, `?from=runs`, `Started by`, `stepDuration`, `selected={shown?.row.id}` all on main |
| `1570cd8ccd` | bb2-code | SUPERSEDED | landed as main `a445f8f34b` and `a7f56e02ad`; later rewritten by `959ed5fca8` 🐛 fix: land W14 production followups (tree-file spec mirrors README.md first) and `0b0fbc91c4` 🎨 style(mvp): the repository header on the shared PageHeader; IssueScreen OfflineFallback on main |
| `64738e065c` | bb2-lists | SUPERSEDED | all intent on main in rewritten form: issues.md `?q=`/No commitment paragraphs, `visibleRows`, search/sort tools (native select later replaced by `IssueSort`), `installed !== true` sync status, `Syncing TODO…`; missing lines are only the pre-rewrite spellings |
| `24bbdd43fd` | bb2-notfound | SUPERSEDED | all intent on main: canonical/tree redirects, `RouteNotFound`, settings/secrets/actions alias routes (now via `ROUTE_PATHS`), `NotFound` item pages, sign-in actions on settings, `fileAtTree`/`canonicalName` (with timeout). Specs landed as `e33764dc87`, `fb8d7fcf94`, `cb087aa066`, then parameterised by `959ed5fca8` 🐛 fix: land W14 production followups and CLI references (`repositoryAbout` prerequisites) and `f897520234` 🧪 fix(mvp): preserve strict errors across WebKit navigation |
| `3ce9d3ae4b` | bb2-settings | SUPERSEDED | all five commits landed: `805018246b` (decision renumbered 0119-test-saved-model-after-validation), `ae30d7e5b6`, `f3275f8a0b`, `afc9ac8efa`, `264b976436`; the missing lines are the pre-redesign form, replaced by main `d2942b1ea7` ✨ feat(mvp): model connections like Amp's (decision 0132, AUTH-10) (`testDraftProblem` now over `connections`, tier purposes via `TIER_PURPOSE`) and `e113d968d5` 🎨 style(mvp): Settings' model section has one solid action at a time |
| `2fb3fbb2f9` | bb2-a11y | SUPERSEDED | on main: `pluralPull` route (via `ROUTE_PATHS`), Chat `h1` and composer-before-conversation order, `.root-skip` (now clip-path), ui `accessibility.md`, docs spec (with timeout). Landing grid replaced by main `cbb40294a0` 🎨 style(mvp): the app bar, conversations, landing and bug report in the mock look; protocol field names replaced by `d2942b1ea7` (decision 0132) |
| `9bd3469684` | bb2-webkit | SUPERSEDED | landed in main `9662836059` 🐛 fix: land W13 browser, writes, views, CLI, privacy and docs; specs then reworked by `d97e8f6ec5`, `f897520234`, `d890c4b032` (WebKit persistent devices keep context options) and `b450a52fc2` (private browser limits, `StorageDiagnostics.observe` around `load`). Session editors, `SESSION_STORAGE`, `EffectBuild` all on main |
| `30798c67e1` | bb4-views | SUPERSEDED | landed in main `9662836059` 🐛 fix: land W13 browser, writes, views, CLI, privacy and docs: undispatched-as-skipped graph steps, FlowGraph `skipped` (now via `STEP_WORDS`), `pullPageOf`/`pullAbsent`, raw download tests, minimum-font specs. Settings spec rewritten by `d2942b1ea7` (decision 0132); landing title rule replaced by `cbb40294a0` (landing in the mock look) |
| `d1d3cc9af8` | w12-followups | SUPERSEDED | landed as main `959ed5fca8` 🐛 fix: land W14 production followups and CLI references (quota section in repo.md, `/bug` exact-command tests, `choose(..., keyboard)`, retained prerequisites in target.test.ts, CSP expectations, bell flow). Later deliberate rewrites: repo-browse clone test now drives `/clone` (`959ed5fca8`+), signed-out plugin sign-in moved to `PluginView.tsx` by `613822c9e7`/`cbb40294a0`, Account span and repo-header CSS rewritten by `cbb40294a0` and `0b0fbc91c4` (PageHeader), mobile control audit rewritten by `b450a52fc2`/`4fdaaa36a7` |
| `64c69c1597` | bb4-docs | SUPERSEDED | 36 of 39 commits on main; the missing lines are generated CLI references (`cli-commands.json`, `help/tui.txt`, `help/generate/ci.txt`, `cli.md`, `llms-full.txt`, `CatalogCli.fixture.json`) that `gen-cli-data --check` regenerates from main's CLI, plus `--budget-tokens` wording, all rewritten by main `959ed5fca8` 🐛 fix: land W14 production followups and CLI references ("Token cap per turn and worker (default 200M...)") and `e40da83be9` 🐛 fix(cli): select executable CI renderers. `regressions/*.test.mjs` in check:docs and the `/app/flows`,`/app/settings` built-site test are on main |
| `45a19eaed2` | bb2-docs | SUPERSEDED | the one real gap: `05ae782867` fixed the Install Smithers link in generated `.smithers/home.json` only; `3b734cb691` regenerated it from `.smithers/FACTORY.ts` and reverted it, so `apps/site/scripts/repository-install-link.test.mjs` went red. I fixed FACTORY.ts plus home.json, ran it green on the mini (site test, pack.test homepage suite, `//:factoryProjection` ok), then after a fetch found main `c410c1346f` 🐛 fix(home): send installation to its instructions had landed the same diff, so my copy rebased to empty and was not pushed. Rest: flows.md `/flow.edit` wording deliberately removed by `9662836059` (flow-terms test now forbids `/flow.edit`); quickstart, Schedule nav (`1088f9d05b`), tier names (`959ed5fca8`, `d2942b1ea7`) on main |

#### Hunks not landed

Every missing hunk above is SUPERSEDED by the named main commit. None is SCAFFOLD. Nothing is BLOCKED. Nothing was pushed: the one live gap (Install Smithers link) landed independently as `c410c1346f`.

Rechecked against main `73c00d52fe` after fetch; all cited commits are ancestors of main and the key markers are still present. Workspace `sa-app-c` forgotten and its directory removed.

### Sub-lane app-d (DONE)




Method: per head, every added line of `fork..head` checked against `main@origin` (dad78637) after whitespace and table-padding normalization (`/tmp/appd/netcheck2.py`), then each residual read against main's current code.

| Head | Name | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| `c499102e10` (newest of W17/W19) | - | SUPERSEDED | Landed rewritten as `b450a52fc20c` 🐛 fix(mvp): repair mobile layout and explain private browser limits (same author time 10-28 13:56; engineAvailability, FlowCodeCard, BranchScreen, StorageDiagnostics, mobile.spec all present). Residuals below. |
| `e4b12661` | builder/w17-private | SUPERSEDED | Older copy of `aab3082678` in `c499102e10`; nothing it has is absent from the newest head; covered by `b450a52fc20c`. |
| `aa86bdc1` | builder/w17-ui | SUPERSEDED | Older copy of `b44724fbcf`; its `docs-screen.css` lines are on main in a later layout (`.docs-page-links a { display: block; ... }`, nav `scrollbar-gutter: stable; padding-inline-end: 1rem`), reshaped by `ab6e3e2bc86a` 🎨 style(mvp): repository home, files, docs and branches in the shared frame. |
| `55d2437b03` | - | SUPERSEDED | Stack landed as `23e08690d0fd` (shape request phase), `115a0e95d631` (report focus / live pull comparisons), `f8975202347a` (strict errors across WebKit navigation); later evolved by `83f457a48c` (WebKit profiles, departing-document diagnostics). Residuals below. |
| `dab3fbbb2c` | - | SUPERSEDED | Landed as `e1a134f19854` and `d97e8f6ec5fe`; the clone test was then deliberately rewritten by `20b4264a4930` 🧪 test: retain W15 integration and SDK regression coverage (fixed absent-repository fixture, `/clone` command, W12 rule that Clone is hidden once absence is known). |
| `39d8ecdc5b` | - (contains builder/bb5-cli-docs) | SUPERSEDED | Top 5 landed as `1c1d58de238d`, `56a1a9f8e4c2`, `e5de421c64e1`, `050175b0dd34`, `163bd8d4ab2b`; lower 11 (bb5-cli-docs) landed folded into `959ed5fca835` 🐛 fix: land W14 production followups and CLI references. The 41 "missing" are api.md tables main re-padded (`3b734cb691ea` 🧹 fix(lint)); normalized, 14 lines differ, all evolved (below). `llms-full.txt` is generated and on main. |
| `4bbb57c3` | builder/w15-webkit | SUPERSEDED (on main) | Net diff vs main: 0 of 12 files have a missing line. |
| `a999d8d1` | builder/importrules-vibe | SUPERSEDED (on main) | Net diff vs main: 0 of 7 files missing. |
| `3033b230` | builder/drift-helper | SUPERSEDED (on main) | Net diff vs main: 0 of 7 files missing. |
| `36145de1` | builder/bb3-cli | SUPERSEDED (on main) | Net: 1 line, `PackageRunner.ts` `did not produce declared outputs` error, present on main at line 733 reformatted to a multi-line object. |
| `5b587903` | builder/build-lint | SUPERSEDED (on main) | Net: 2 lines, `docs/work/build-lint.md` `status: blocked`; main has the same doc at `status: in-progress`, a later state. |
| `4805577f` | builder/bb5-cli-docs | SUPERSEDED (on main) | Member of `39d8ecdc5b` above; landed in `959ed5fca835`. Net residual: 6 lines, the API index sentence and site `package.json` test lists, both rewritten later on main. |
| `da5b4eda` | builder/first-run | NOT MINE: owned by app-a | The classifier is wrong here: 130 normalized lines are missing (FirstRunSteps, contract, DevChatApi newcomers, quickstart). The tip belongs to the `builder/who-may-ask` lineage. app-a records it as rewritten and landed as `8800f22acb` plus `d8851a1de3` and `cbb40294a0` (stranded-audit-app-a.md). |
| `b6b65521` | builder/bb4-writes | NOT ON MAIN: belongs to `builder/bb5-app` (a80b82ce4b) | The classifier is wrong here: 81 lines are missing, including migration `0071_branch_write_notices`, `WriteFeed.ts` branch write receipts, the notices v4 registry and `write-admission.spec.ts`. bb5-app is listed in heads.tsv and is outside my families. Flagged to the parent. |
| `6b985b4f` | builder/app-timeouts | NOT ON MAIN: belongs to head `9dae978249` | The classifier is wrong here: 807 lines are missing, including `db/test-stack.sh`, `test-stack.test.sh`, `docker-compose.test.yml`, `worker/test/reset.ts`, `src/test/chatApi.ts` and `docs/work/app-timeouts.md`. 9dae978249 is listed in heads.tsv and is outside my families. Flagged to the parent. |
| `e72b2cbf` | builder/mobile-w8 | SUPERSEDED by `940e573216` | Sub-lane home-1 landed it from ~/smithers copies (119ffa9a91, dca331d06f) as `940e57321606` 🐛 fix(mvp): keep screenshot captures out of edited mobile recordings. That landing applies the same adaptation I reached on my own: tile clips go through `fullPageScreenshot(page, path, { clip, timeout })`. Against main 77fa731e my independent resolution (`6b4b5f0bb38c`) differs only in import order and how the option type is spelled. Not re-landed. The one missing file is `tests/FullPageScreenshot.browser.test.ts` (below). My own duplicate is not pushed. |

#### Hunks not landed, with reasons

W17/W19 (`c499102e10`, `e4b12661`, `aa86bdc1`):
- `apps/mvp/e2e/mobile.spec.ts` and `BranchScreen.tsx`: a stray `>>>>>>> conflict 1 of 1 ends` line was committed in the head. It is a broken conflict resolution artifact, so I did not land it.
- `docs/work/w17-private.md`: the `NEEDS-DECISION` Option A/B paragraph. Superseded by `b450a52fc20c`, which replaced it with "Decision settled for W19: retain decisions 0011/0120", a deliberate resolution of the open question.
- `engineAvailability.test.ts`, `BranchScreen.tsx` `unavailable = stopped && signed_in`: superseded by `b450a52fc20c` `branchUnavailable(stopped, session, confirmed)`, which keeps recovery guidance for confirmed offline sessions (its message says so). The test is on main with more cases.
- `FlowCodeCard.tsx` Save button: on main with `variant="solid"`, added by a later restyle.
- `StorageDiagnostics.ts` `record("opening")` / `Effect.exit(effect)`: on main as `Effect.exit(restore(effect))`. `b450a52fc20c` added this to record externally cancelled initialization.
- `docs-screen.css`: on main in the shared-frame layout, `ab6e3e2bc86a`.

`55d2437b03`:
- `flow-editor-storage.spec.ts` inline `storageLog` / capabilities receipt: main moved it into a helper that filters `browserLog`, at lines 18-19.
- `repo-browse.spec.ts` WebKit CSP `Refused to load` lines: main declares them per browser in a loop, at lines 198-204.
- `watch.ts` `accessControlURL` import: renamed on main to `nativeAccessControlURL` by `83f457a48c`.
- `pulls.ts` import and `pulls.md` row: on main with the later `review` action added.

`dab3fbbb2c`:
- `repo-browse.spec.ts` clone test (`bugbash4-w13f-no-such-repo-*`, `/navigate`, `goBack`): `20b4264a4930` deliberately rewrote it to a fixed absent-repository fixture.

`39d8ecdc5b`:
- `packages/smithers/ui/docs/api.md` ChatTimeline props and `timelineLevels`/`timelineLevelCount` helpers: superseded by `b65aa03472a1` ✨ feat(timeline): rebuild the rail to the mock, with logical phases. That commit replaced the zoom-level API with phases and blocks; main documents the new API at lines 339-351.
- `apps/site/package.json` test lists: main's lists are supersets. They add `scripts/regressions/*.test.mjs` and more tests.
- `e2e/api-reference.spec.ts` row matcher and `crypto/scripts/reference-docs.test.mjs` import: evolved on main. The guard now imports `vitest` or `node:test` dynamically.
- `apps/site/docs/reference/api/index.mdx` sentence: main reworded its last clause.
- `apps/site/public/llms-full.txt`: generated, and main's copy is current.

`e72b2cbf` (mobile-w8), against main `940e573216`:
- `tests/FullPageScreenshot.browser.test.ts` is not landed because it flakes on the Mac mini, with two different failures. Evidence from main 77fa731e plus the file alone, slot 1:
  - Run 1: pass.
  - 3 sequential runs: pass, then fail with `expected 2 to be greater than 3` at line 41, `shown.length`. The recording is too short outside the capture intervals.
  - I added a hold of 10 recorded sample slots before and after the captures (patch: `~/smithers-builders/stranded-audit-app-d-fullpage-probe.diff`). Then 8 sequential runs: 6 pass, then fail with `expected 128 to be greater than 158`. That assertion checks the edited video's right edge, so the gray resize margin of Chromium's full-page surface reached the edited MP4. My hypothesis, untested: the screencast sends no new frame after the viewport is restored until something repaints, so the stale resized frame is held past `capture.end`. `painted()` (rAF) does not force a new screencast frame.
  - This is a defect in the landed media editing (`withoutCaptures` with `fullPageScreenshot`), not only a test flake. Follow-up: make the recorder receive a fresh frame after each capture, then land the test with the hold patch. Repro: `mini-run apps/mvp -- sh -c 'for i in 1 2 3 4 5 6 7 8; do pnpm vitest run --coverage.enabled=false FullPageScreenshot.browser.test || exit 1; done'`.
- `docs/work/mobile-w8.md`, `README.md`, `frames.ts`/`frames.test.ts`, `gifs.mjs`, `mobile.spec.ts`, `MobileLayout.browser.test.ts`, `mobile-layout.tsx`, `Recording.browser.test.ts`, `RecordingPaints.test.ts`: on main via `940e573216`.

#### Proof runs (Mac mini)
- An earlier run on my duplicate: `pnpm typecheck` passed (all four projects). The eslint step failed only with "File ignored" warnings, because eslint.config.js does not cover tests/ and e2e/. There were no findings.
- Main 77fa731e with FullPageScreenshot, Recording and RecordingPaints: 4/4 passed once. The repeated runs are listed above.

#### Pushed
Nothing. Every head in my families was already on main or superseded. My copies (dup `6b4b5f0bb38c`, probe, empty WC) were abandoned. These were my own copies, never originals; all originals in w12-hold are intact.

#### Flagged to the parent: content not on main and outside my families
- `builder/app-timeouts` 6b985b4f, in stack `9dae978249`: 807 lines, test-stack.sh, worker/test/reset.ts, src/test/chatApi.ts and others.
- `builder/bb4-writes` b6b65521, in stack `builder/bb5-app` a80b82ce4b: migration 0071 branch_write_notices, WriteFeed receipts, notices v4.

### Sub-lane home-1 (DONE)


| Family | Newest head | Decision | Pushed main ids / evidence |
|---|---|---|---|
| F1.1 | `fea394ac50` | SUPERSEDED | Undescribed snapshot of a conflicted rebase (conflict markers only). Main resolved it: `dailyCap(unset)` and the `resumed` outcome are in apps/mvp/worker/TimelineSummaries.ts from 7ee5a29a55 "🔒️ fix(mvp): make the timeline's summary and phase ledger safe". |
| F1.2 | `bde074effb` | SUPERSEDED | Conflict-marker snapshot of the same rebase. Decision text (durable claim owner, point 9) is main's decision 0138-timeline-phases.md; store.test timeout 20_000 is on main; migrations list is main's Database.ts. 7ee5a29a55. |
| F1.3 | `523f7daeb1` (+9ccdbed588, 9f4603355d, 5c06bc2a31, 27e3332cdd, e7b5a39485, b665026cf8) | SUPERSEDED | Lane landed as d9240f088e "🐛 fix(timeline): notify every summary-preventing failure, keep semantic phases open with rolling summaries, show each message's own summary" and b65aa03472 "✨ feat(timeline): rebuild the rail to the mock, with logical phases". Every gap test is on main (timeline-entry-labels "pending messages keep their distinct host labels", view.test "phase markers preserve boundaries", notice.test "a conversation that can't be read", phases.test prompt test); migration is main's 0079_timeline_phases, decisions 0138/0140. ChatTimeline label `??` lost deliberately: main uses `\|\|` and tests "empty overrides retain state labels". dc8e519e65 "wip: review fixes" is SCAFFOLD. |
| F1.4 | `4e42c3bae8` [builder/stack-flake] (+53f3e4f254 s1-runner@) | SUPERSEDED | Every commit landed with renumbered decisions/migrations: af9676cf5d "🐛 fix(mvp): a stack starts its ready TODOs oldest first, whatever order Postgres reads them in"; 4e6fd708aa independent lanes (decision 0135, migration 0077); 805077900e external agents on a runner (decision 0136, migration 0078); merge flow decision 0134, migration 0076. Gaps are only the old numbers (0132/0133/0134) in comments; DUR-9, "Admission after a failed base", `TodoSession.Agent.call` are on main. |
| F1.5 | `86021e62c1` (+ab6868b4a9) | SUPERSEDED | Undescribed snapshots of apps/mvp/e2e/toast-layout-shift.spec.ts. Main has the spec, later reworked (FE-21, decision 0137, tracked-branch fixture, `.sui-msg-scroller`): 024272d7f8 "💄 fix(mvp,ui): toasts overlay the page under its header and take no layout space (0137)", then af88f72aeb, b37fb5e925. |
| F1.6 | `c5bd6f21fd` [builder/s3-steer] (+2554588b75, bceaf869a0, 940f8a206a, c32430ee25, 2115d4a452, f77f503af8) | SUPERSEDED | Every commit is on main under its subject: 719148d634 (site API pages), 6855753cba "stop and steer a TODO's external agent from its run's page" (decision 0142, migration 0083_agent_stops), 7c9416aa24 "steer and stop an external agent on a runner", 65d9bf03c4, 485373e18a, 3ae57ca7b1, b1c12df191, 805077900e, aade7f1458, 229e117e9e, 4e6fd708aa, d81b1cea64. The four undescribed snapshots (940f8a206a etc.) hold an earlier alternative: the runner waits for background tool processes (`QUIET.toolsMaxMs`, `Tree.living/others`, a `background` fixture step, SIGKILL after 15 s). The final 87d70da83d replaced it with the profile's `steering: "prompt"` and a 5 s `STOP_GRACE_MS`, which is what 7c9416aa24 landed ("a profile that steers by prompt" test). Not landed: deliberate replacement. |
| F1.7 | `fafb7b4b72` [builder/byok] (+d4b99ce31b) | SUPERSEDED | All four subjects on main: 86ef52c4b2, a3631b4ad4, 5e5a6a503d, c730cbb9ed. The 3 missing lines (`removeLeftModel` in the BYOK specs) were rewritten to `removeConnections` by d2942b1ea7 "✨ feat(mvp): model connections like Amp's ... (decision 0132, AUTH-10)". |
| F1.8 | `c32827324b` | SUPERSEDED | Undescribed snapshot of the timeline-phases lane (migration 0075, decision 0131). Landed as b65aa03472 "✨ feat(timeline): rebuild the rail to the mock, with logical phases" (migration 0079_timeline_phases, decision 0138), refined by d9240f088e and 7ee5a29a55. |
| F1.9 | `1e8eb7c87f` | SUPERSEDED | Undescribed snapshot of the toasts-overlay lane (decision 0132, `anchored` placement). Landed as 024272d7f8 "💄 fix(mvp,ui): toasts overlay the page under its header and take no layout space (0137)"; .changeset/toast-stack-anchored.md is on main. |
| F1.10 | `b43032836f` (+5c3d63613b) | SUPERSEDED | Undescribed snapshots of the fleet lane (S5: migration 0080_fleet, decision 0136, plugins/fleet, worker/runners/Fleet.ts). Landed as 02461910a2 "✨ feat(mvp): the fleet: every agent run and runner machine of a repository, live, and five durable alerts (decision 0143)" (migration 0084_fleet) and adab8bbabc. apps/mvp/.s5-check.sh is SCAFFOLD. |
| F1.11 | `0bd16f0c21` | SUPERSEDED | Undescribed snapshot of the transcripts lane (decision 0134). Landed as da1302263b "✨ feat(mvp): watch an external agent's run live: RunContent, the runner events route and the Transcript panel (decision 0141)" and 1bd20badf9 (migration 0082). |
| F1.12 | `0fe9b8d615` [builder/merge-flow] | SUPERSEDED | Landed as d81b1cea64 "✨ feat(mvp): a repository's merge flow chooses GitHub's merge or its own merge queue" (decision 0134, migration 0076_merge_flow). Gaps are the old numbers 0075/0131 and device epoch 101 only. |
| F1.13 | `dca331d06f` (+119ffa9a91) | LANDED | 940e573216 "🐛 fix(mvp): keep screenshot captures out of edited mobile recordings": `fullPageScreenshot` records capture intervals, gifs.mjs drops them (`withoutCaptures`), recording paints, the web-page figure test, the W8 work note; adapted to main's tiled desktop-baseline clips. Not landed: tests/FullPageScreenshot.browser.test.ts (red on the mini: 0 recorded frames shown, `0 > 3`); the snapshot's conflict-marked MobileLayout test copy (the clean test from 119ffa9a91 landed). Mini: typecheck green; frames, RecordingPaints, Recording.browser green; MobileLayout "issues targets" 390/768 red on plain main too (pre-existing, source swap). |
| F1.14 | `982d7006d2` | SUPERSEDED | Ten CLI/memory commits are on main under their subjects (3b6b30a14d, 4c04a96cfb, 5bcd94cba3, 9ade31348a, f0396ab248, 29cd493f01, 431fab476f, 4c444314f6, 0bc7725ac0, abde1fee14). The three W13 progress commits (515363c380 branch launch progress, ee03ac2bc5 issue progress, 982d7006d2 TODO progress, decision 0121-operation-progress) were rebuilt as e14f3bc21c "✨ feat(mvp): show background progress as a projection of receipts" (decision 0124-background-progress; e2e background-progress, issue-progress and todo-progress specs on main). |
| F1.15 | `bd36978696` (+bf0476b452) | SUPERSEDED | The W14 CLI/reference and W12/W14 production followups landed in bulk as 959ed5fca8 "🐛 fix: land W14 production followups and CLI references" and 9662836059. The 3 classifier gaps: worker/index.ts 404 rule is on main in a wider form (`/index.html \|\| isAppRoute`), commands.test.ts import list was changed later. |
| F1.16 | `b499a383cc` | SUPERSEDED | Landed as 806045b527 "⚡️ perf(mvp): defer repository text shapes until detail demand" with the decision renumbered to 0116-shape-payloads.md (the 2 gaps are the old number 0115). |
| F1.17 | `77972d9a1e` [builder/electric-s5b] | SUPERSEDED | S5b Electric cache trials. 93a8535b90 is on main as c673eb228b. The cache/collapse work landed as 86c73b0883 "⚡ feat(mvp): cache private Electric reads and collapse live polls" (decisions 0114-electric-cache-trial, 0115-electric-workers-cache; infra/ElectricCache.ts). docs/work/electric-gateway-cache.md on main keeps the S5b numbers as historical evidence. |
| F1.18 | `380d7b2e82` | SUPERSEDED | Same Electric cache trial line (standard-1 capacity, gateway cache, live collapse trial). Main's 86c73b0883 and docs/infrastructure.md "Electric S5 cache trials (2026-10-26)" record the outcome: "no cache or instance-size activation is retained". The bench `--abort-live` option was trial instrumentation for that dropped activation. |
| F1.19 | `0712915ee7` | SUPERSEDED | Same subject on main as ccd2d74df6 (08:35, later than this 07:48 version). Main's docs/work/mobile-taps-2.md states the dropped hunks (bell routes, issues GitHub link, announcement height, signed-out Sign in) deliberately keep e2e-baseline's touch-width fixes instead; repositoryHomeCss.ts has `min-height:${t.controlHeight}` at touch width. |
| F1.20 | `4b37b4b97f` | SUPERSEDED | Undescribed snapshot: workerd shapes test provides `BranchRoles.layer(roles)`, device epoch 93. Main's apps/mvp/worker/test/workerd/shapes.ts provides `BranchRoles.layer(roles)` (same comment); the epoch is generated. |
| F1.21 | `7f67d7edde` (+84810da5d9, 7d062cf108, 3285d5e1f9, baac407a47) | SUPERSEDED | All described commits on main: 7976545b25, 7dda079f97, 22725ce3d6, 484ff27221, 29ae6de911, 51e98d98f3, ab7cd141f4, 18eb9b5ca2, 6e2a7c27ec, 2d24cfc182, 6509ca42cc. Gaps are pre-renumbering ids (migrations now 0064_bug_reports, 0065_model_tiers, 0066_timeline_summaries, 0067_bug_report_errors; decision 0107-model-tiers). The undescribed 7f67d7edde (issues/pulls stores per repository, `forRepo`) is on main in later form: apps/mvp/src/features/issues/store.ts `forRepo(id, number?)`, decision 0079 slice 1b, docs/features/pulls.md row. |
| F1.22 | `20acd0d7f6` | SUPERSEDED | All eight commits on main: a00cb4f967, 124fdc7e00, 6843293914, b530794314, 930ef7d8eb, cce9c661b2, 5ea88fc32c, 718a04bd6e. Decision renumbered to 0109-frontend-failures-recorded-once.md; remaining gaps are lines rewritten later. |
| F1.23 | `709a9b4085` | SUPERSEDED | On main as 24baaeb1c1; decision renumbered 0111-embed-full-screen-revision.md. |
| F1.24 | `dd7765b429` | SUPERSEDED | On main as 3253f42230 and 1dfcf9927e; decision renumbered 0108-first-load.md. |
| F1.25 | `a3d42af1a1` (+136945052a, e3d2449249, 6e719f421a) | SUPERSEDED | feb24d7c41 "retain repository navigation and fence deployment-only pages" and 9437bad66e are on main; decision 0102-repository-page-boundaries.md. The unmatched "provide spend alerts in repository page regression" (SpendProvider in tests/fixtures/repository-pages.tsx, `services.spend.queries.open`) is on main in apps/mvp/tests/fixtures/repository-pages.tsx:52. |
| F1.26 | `0b52629593` | SUPERSEDED | On main as e3a4a95b63 and cca07b3470; migration 0062_sandbox_budgets, decision 0103-sandbox-budgets.md, 0005's "deferred until we ship" line points to 0103. |
| F1.27 | `3994db664f` | SUPERSEDED | On main as 7e55daf25f; decision 0106-production-log-capture.md. |
| F1.28 | `7027d6f38f` | SUPERSEDED | On main as 45e326dc6b; migration 0060_repo_about. |
| F1.29 | `11a35a00fb` | SUPERSEDED | On main as c129f7b85a; migration 0059_model_quota_failure, decision 0100-terminal-model-refusals.md. |
| F1.30 | `0cbf100ade` | SUPERSEDED | On main as ab8b7edba8; decision 0101-notification-backlog.md. |
| F1.31 | `dcd6da80eb` (+68315c158f) | SUPERSEDED | All subjects on main: 6469de9704, d02050fcf0, b2550ad31a, cf36c7f0e2. The gaps are '-' lines inside docs tables (credentials.test row, timeline.summary row, agent-status POST row) that main rewrote later; apps/mvp/docs/features/sign-in.md:337 has the credentials.test row. |
| F1.32 | `e98419b928` | PARTLY LANDED | 77fa731ed8 "📝 docs(mvp): keep the tracker curator's 2026-10-25 notes and the VibeLang README drafts" (70 never-landed curator notes to docs/work/evidence/curator-2026-10-25/, off the board; 4 README drafts to docs/design/vibelang-readme/; pointer to the unfinished auto-POC code in docs/work/issue-lifecycle.md). Undescribed stale working-copy snapshot (parent 10-21, content 10-25). Not landed: evals/swebench logs and fixtures (51,811 lines; evals moved into packages by 595b6abcbc); apps/playground and old-app files (removed, SCOPE-3); work notes that exist on main (main carries later versions); decisions/0028-review-queue.md (landed as 0031-review-queue.md); vibelang-readme docgen/token-compare (SCAFFOLD prototypes with own manifests and lockfile); auto-POC code Prototype.ts, PrototypeStore.ts, Repro.ts, poc.ts, migration 0034_prototypes (BLOCKED: unwired, predates per-repository roles, decision 0018 lists auto-POC as follow-up; kept in e98419b928 and pointed to from issue-lifecycle.md). |
| F1.33 | `f4776e99c3` | SUPERSEDED | Five commits on main (e7e023368e, 52ac3169d3, 16aad3ccfc, c832cfe8e4, c8dffce533). 779b93904c "preserve fetch capabilities in new branch fixtures" (a `fetchTransport` adapter to dodge 4 TS2741 `preconnect` errors) is unneeded: f54dacc1e6 "🐛 fix(mvp): bundle and type-check Workers whose sources reach .vibe modules" removed the cause (Bun's fetch type leaking via vibelang-unplugin declarations). |
| F1.34 | `7e69a6ee2b` | SUPERSEDED | Three commits on main (37472935d5, 5a6bf89dfd, 52c936f67b). The 3 missing lines are a `status: blocked` frontmatter of docs/work/main-reds-0024e.md; main's note is later (`in-progress`, 2026-10-24). |
| F1.35 | `d3928d2f04` | PARTLY LANDED | 8f0228a3ca "🧪 test(mvp): calibrate TODO inspection against the wrong TODO, repository or a follow-up write" (b0a5326d3d's calibration test; mini green). cfcdf6fa07 and acdfc7de8e already on main; b0a5326d3d's `todo-inspect` case and telemetry name are on main in later form (evals/flowCases.ts:73). |
| F1.36 | `39f8cad1c3` (+5041c806d8) | SUPERSEDED | 39f8cad1c3 was reworked onto main as 97174ab133 "🧪 test(mvp): retain missing fixture isolation and synchronization" ("Rework 39f8cad1 on origin main ..."). 9823226b3f is 52a5e776f9 "✨ feat(mvp): create branches through repository flows"; fdf5f28852, 8ea5310fe4, 09f1b5b9f3/991982f24e on main (89f5937dba, 248507ec10, a60cc8ad0c). 5041c806d8 "retain blocked ephemeral branch integration draft" is superseded by the landed design: decision 0095-new-conversation-ephemeral-refs.md, migration 0055_branch_ref_namespace, GH-11 in rulings. |
| F1.37 | `40022a75e6` (+039dfc6ed8, 9a588759db) | SUPERSEDED | On main as e700a96856 "✨ feat(mvp): keep personal messages pinned above conversations"; decision renumbered 0090-pin-message.md. |
| F1.38 | `ecf78a276d` | LANDED | 61a52c5904 "📝 docs(mvp): retain agent UI eval repair evidence and blocked proof" (work note evidence, results, proof JSON, agent-evals and infrastructure facts; private paths redacted; case count corrected to twenty-eight). 22 of its 24 commits were already on main (ea5c8b8bbf ... 33e706cc72). Not landed: six raw result JSONs over the 1 MiB file limit (listed in the note); 3518848272 "drive default retry exhaustion with a real-host test clock" (superseded by 97174ab133, which kept main's injected RetryPolicy timings and TestClock alarm delivery for the same tests). |
| F1.39 | `f7689eb189` | SUPERSEDED | A blocked-run note (no model credential on the mini, no trial scored). The work it was blocked on landed: decision 0091-forms-and-views-eval-evidence.md and docs/work/prod-forms-views.md on main. |
| F1.40 | `e4138ff4d0` | SCAFFOLD | Undescribed snapshot that only deletes two cases (FileTabsStore, ConversationPendingStore) from src/device/migrations.test.ts: a probe. Main keeps both cases (lines 316-317). |
| F1.41 | `339099a805` | SUPERSEDED | The coverage gate landed: docs/work/coverage-main.md on main carries this head's text (baseline f33937fbbcdb, 3,766 tests, all 100%). The 10 Api.test.ts lines ("default HTTP metadata reads use the configured bot token...") are on main as "the production metadata transport uses the configured read token and refuses a newly private repository" (apps/mvp/worker/github/Api.test.ts:1214). |
| F1.42 | `a4b7a02775` | SUPERSEDED | Five CI commits on main (20e4d480fc, 9f6bbd1e9c, ccc71a0b2c, c0b1b3651d, 70bb21fef6); the head landed as 120aa96554 "✨ feat(mvp): watch repository CI runs with Stop and restrict rollout" (migration 0053_repo_runs). |
| F1.43 | `397ac16d47` (+91d70e9d68, 5d05890579, e2d711da18) | SUPERSEDED | Landed as f8040d47ff "🐛 fix(mvp): preserve merged views and prove form submission recovery" (migration 0052_agent_views). Gaps are older migration numbers 0043/0044 and registry import lists. |
| F1.44 | `96303ec936` | SUPERSEDED | 25 of 27 subjects on main. b50fd9924e is classed SUPERSEDED (0 gaps). 9cb95cbd2b (both devices wait for `needs_you`) is on main: status.test.ts:227-230 waits on b, then a. The warm.test "still cloning" hold is on main as `h.scripted.hold("listCommits")` (warm.test.ts:255). |
| F1.45 | `2ee2c108ec` | SUPERSEDED | Decision renumbered 0080-new-conversation-refusal.md on main; gap is the old title "# 0077". |
| F1.46 (docs truth pass) | `3a4c9409b0` (+b582dd6f9e, 9282a98a77, df5ede0070, 8aa8312ce6, 3cb9124e12, 531bfc5f56, f10019f8ed, f9da52c50b, 467e1e0ece) | LANDED | 564bb40d42 "📝 docs: the 2026-10-21 docs truth pass, and remote flows in production" (the six truth-pass commits and the two land-and-deploy remote-flows entries). Not landed: apps/UPSTREAMS.md banner (file removed by 82b5490dbe), infrastructure.md intro and Deployed section and branch-workspace "live half" line (rewritten later on main), the rules.md github.no-actions hunk (GH-10 on main), conflict-label-only hunks in sandbox-tools.md and integrations docs. |
| F1.46 (docs in panes) | `8d07068639` and the same 9 heads' 21fc0a8f36, cae7772992, e32daf153b | SUPERSEDED | Rewritten as e80ced7fea "✨ feat(mvp): a repository's docs in the app: the Docs tab, app/docs/search and the docs view (AGENT-6)" (migration 0043_docs_views) and d4383dd9c7 "✨ feat(views): Docs reads a docs site's llms.txt index, and a home names its docs". The old docs/search flow and worker/DocsSearch.ts were replaced by that design. |
| F1.46 (SSR temp cache) | `d39f412ec2` (+1b038435cd copies) | SUPERSEDED | 4d3b0221b7 "fix(test): reclaim Vitest root SSR transforms through the run lifecycle" fixes the same leak with `registerRootCleanup` instead of `fsModuleCache: true` in 70 configs. |
| F1.46 (generated, engine) | `e7c2dfa26f`, `a3b4795f09`, `5f627a1f24`, `2eebe05718`, `5cb08384b1` | SUPERSEDED | Public API baseline and target index are regenerated on main; the PlanScheduler stack is on main (82a2afc74c ...). 5cb08384b1's versioned action-key encodings landed later as 631bbbe2f2 (`keyEncodings = [3, 2, 1]`). |
| F1.46 (notifications access) | `797b55f409` lineage: `06889e5501`, `9ff7f5bc65`, `93a0a2e454`, `c870231485`, `040001c3ef` | LANDED | 46c3fdc6a9 "🔒 fix(mvp): repository notifications reach only watchers who may read it now, and a re-published release refreshes", re-implemented on main's roles (`SessionStore.latestRole`, `role_generation`), no migration. Source migration 0038 `role_verified_at` and its two dependent test cases not carried (main's role generations replace it). |
| F1.46 (run credential in outbox) | `a340a0cbb4`, `0182dd8d5b` (copies bf3f74375d/a2ea16b98e, 2e39651439/9e85137372; WIP 32bf658e5f) | BLOCKED | "an agent's issue write goes with its run's credential alone" and "no run credential in device storage". Main still stores `credential` in the issue outbox (issues/schema.ts `Sending`) and renews it at delivery (writes.ts, Runs.ts `renew`), the design of 10ec5f4da5 that later main work builds on (c40976dcbe, 7c71068265). The 3,195-line source diff rejects on most hunks; landing needs a redesign of the issue outbox plus an `issue-sending` device-schema bump. Not attempted in this audit; needs its own lane and Will's call, since it reverses a landed auth design. |
| F1.46 (refused issues on device) | `e8a39377e9` (copies 67f7b7c8d3, a641394e8f, aac28cf1ed, e32851a7a8), `2bb993d7cb`, `7ed39694df` | PARTLY SUPERSEDED / BLOCKED | View half on main: issues/view.ts `pageOf` puts `refusedOf` first (7c481b16c7, c4954e045c). Device half (evict stored rows of a refused repository) is not on main and needs an `ElectricCollection` evict API keyed on role-based access (main deliberately decides access from roles, not 401/403). The e2e/issue-refusal.spec.ts browser test depends on it. Not attempted. |
| F1.46 (b008dcea7c rest) | `b008dcea7c` | SUPERSEDED | Its other 21 commits are on main (dcde3214c5, 80c0a384aa, d83507cf90, eb229cc9be, a72fdddcf6, ad64f9e107, 9f203eadfe, ceafe70c9b, 03a0cfbfc8, cb3e557601, 1e8e60737e, 5cfacfa483, 6afec65a61, ddc8a395a7, a9c9f7a157, bee4fb90e2, bf4c9724e8, 94807a56d6, cca84c0105). |
| F1.46 (alert channel, prod-flows) | `cdb1160df9` | LANDED | 3328e54f2f "🐛 fix(mvp): a failed alert-channel save clears once another device saves the channel" (31b27639d3); 1b13ad95e3 (prod-flows production evidence). Its other 15 commits are on main. |
| F1.46 (deployment e2e) | `b752bc330e`, `25dff651a6` | SCAFFOLD | Snapshots whose files hold pasted diff text; the real files are on main; test-results-deployment/* is run output. |
| F1.46 (merge rechecks base) | `7ed8110efb`, `a0628cfe62`, `83b9d49672`, `4ab24343c4`, `1f61aefdd2`, `2f5b9204b2`, `aba350c47e`, `fcb0f1f644` | SUPERSEDED | Landed as e0367e6fb5 with 36ebd46a94, 6eb9f73bf5, ac88ac3757, d9b86c2f66, 6a49b0aa8f; migrations 0048-0050, decision 0077. 59e962ef0a, f3b22f1327 are merge scaffolds. |
| F1.46 (small ChatApi, roles) | `7fd6439ba8`, `bcc82d0297`, `b8a380c99d`, `e141cdd55c`, `2b50710416`, `de3650a43e` | SUPERSEDED | bee4fb90e2, b54e0cdae1, 7ddb6b9961, bf4c9724e8, 94807a56d6, cca84c0105, cfb31c3981; 2-line ChatApi gaps are comments rewritten later. |
| F1.46 (worker-953411) | `0ea193cb82`, `e2e332627a` | LANDED | Fix on main as df0456e999; the work note landed in 1b13ad95e3. |
| F1.46 (patterns cleanup) | `eca4f0f7f4`, `8adf84bd4d`, `ff41e80e78`, `fa8c951f97` and 25 undescribed snapshots (b98e2fc309 ... 0700de245e) | SUPERSEDED | All 13 commits on main (3f9b64e07b, a1644998f1, 615a42e800, 3c3ee5c040, a8d61ab541, c121a342e4, 7ff5707074, 7830576d96, ce1415762f, 72fca0eb0c, 6a1bc75005, 8d4e1825eb, 37ccb84f89); snapshot patterns files match main apart from whitespace; "regenerate llms-full.txt" is generated. |
| F1.46 (time-travel, plan, flow) | `cfb32e285e`, `01e3888243`, `2bab452b78`, `997ce2d97f`, `23f5cee51b`, `c659b0153c`, `dd60c8c5bf`, `ecea1e22e6`, `4b4584af3b` | SUPERSEDED | 010eda3fbe, 0d26fe49b6, 220e7aa2cc, 600aa05cf6 (time-travel stack); b87a5b87e1 (renew fork reservation; its done-note evidence is in that commit's message); 03aa079b28 (plan, note renamed plan-rework-c659b015.md); 99b4faed0f (sibling suspensions); 4b4584af3b's 20 subjects on main. |
| F1.46 (stacked PRs, dogfood) | `0cabd611c1`, `edc2e4c7a1`, `063cd73166`, `29e6aa7cbb`, `3a369a27d1`, `6faf10f20f`, `ac07bc9451`, `04acef4549`, `d464438d7f`, `3bfa24b71f`, `b81df565e1`, `8c47f86713`, `2a8e92a560`, `cd216513f0`, `7bc4b5408b`, `f30888f5ce`, `4fbbbe9cd2`, `df704c1faa`, `fed0124841`, `abe7287882`, `2cac886f0a`, `44950d7853` | SUPERSEDED | fc50b8a1c3 "✨ feat(integrations,mvp): the stack's TODOs become stacked pull requests" (migration 0039_stacked_todos) and 1e8e60737e "✅ test(mvp): the dogfood loop's e2e ..." (refined by 0c544cbd51, ec2364e689, 7236973a0d); site/llms pages are generated. |
| F1.46 (conflict snapshot) | `6a15b126a1` | SCAFFOLD | Conflict-marker snapshot of Todo.ts mid-rebase; resolved in fc50b8a1c3. |
| F1.46 (rest of slice D) | `efb69411db`, `65e5c1587b`, `1c3b1ed942`, `7ff8144985`, `354a880329`, `e16546f509`, `c558742b0f`, `dcd3dc5fb7`, `5adf377d7d`, `0b93fc6d9a`, `9a5507edcc`, `8c9a5d26e3`, `a2cc4468ea`, `4a47b426e6`, `5d3efd101f`, `f1257d53d3`, `c77b0a5f1b`, `21c0144bb6`, `c0a47af784`, `1ece3c2d19` | SUPERSEDED | Subjects on main (8c57cefc53, 8dae3ba02c, 0e93f17a49, d598a9baf1, b57631c5c2, 06af41d91f, 29bfed57f5, 65c92c4271, f6c9575f3a, 5e95a09557, f3ed32fbaa, 9b1435a866, 3493c5f786, aa5cbf5dd8, ...); each gap line found on main (Todo.test.ts:413, runs/actions.ts:46, agent.md:110, navigation.md:24, AlertChannels.test.ts:66, target.ts:486, evals/session.ts:31); EVAL_MAX_TOKENS was raised later on purpose. |

#### Pushed to main

| Commit | Subject |
|---|---|
| 564bb40d42 | 📝 docs: the 2026-10-21 docs truth pass, and remote flows in production |
| 1b13ad95e3 | 📝 docs(mvp): production evidence for remote flows, and the worker-953411 note |
| 61a52c5904 | 📝 docs(mvp): retain agent UI eval repair evidence and blocked proof |
| 46c3fdc6a9 | 🔒 fix(mvp): repository notifications reach only watchers who may read it now, and a re-published release refreshes |
| 3328e54f2f | 🐛 fix(mvp): a failed alert-channel save clears once another device saves the channel |
| 8f0228a3ca | 🧪 test(mvp): calibrate TODO inspection against the wrong TODO, repository or a follow-up write |
| 940e573216 | 🐛 fix(mvp): keep screenshot captures out of edited mobile recordings |
| 77fa731ed8 | 📝 docs(mvp): keep the tracker curator's 2026-10-25 notes and the VibeLang README drafts |

Tests (Mac mini): `pnpm docs:check` green. apps/mvp `pnpm typecheck` green. Focused vitest run: frames, RecordingPaints, Recording.browser, MobileLayout, flowCases, spend, AlertSettings and worker/Notifications passed, apart from three failures. MobileLayout "issues targets" 390/768 also fails on plain main (pre-existing, shown by source swap). The spend "Member's save is refused" test flaked under load and passed 22/22 twice when rerun alone. FullPageScreenshot.browser was dropped (see F1.13).

#### Open (BLOCKED, needs its own lane)

- Run credential out of the issue outbox (a340a0cbb4, 0182dd8d5b): reverses main's renew-at-delivery design (10ec5f4da5). It needs an issue-outbox redesign and an `issue-sending` device-schema bump.
- Device eviction of a refused repository's issues (e8a39377e9) and its browser test (2bb993d7cb): needs an `ElectricCollection` evict API keyed on role-based access.
- Auto-POC code (e98419b928): unfinished slice 3 of decision 0018.

### Sub-lane home-2 (DONE)




Source: ~/smithers heads in `briefs/stranded/home-2.md`. Workspace `sa-home-2`.

| Family | Newest head | Decision | Pushed main ids / evidence |
|---|---|---|---|
| F2.1 platform-node Linux reds | `0e8d7cc83b` (copies b03633a3c1, 373aa72a50) | PARTLY LANDED | 11f4da16bbaa. Lands ProcSnapshot ESRCH-as-gone fix + real-/proc ESRCH regression, linked-workspace declared-read assertion, troubleshooting section (receipt renamed to main's `STATUS=running`), work note. On main in another form: restart comment variants (`commented-*`), `STATUS=`/`SPAWNED=` receipts, write-widening guard removal, seatbelt read-denial test. |
| F2.2 (undescribed) | `0f5e96700e`, `775dd2d7c7` | SUPERSEDED | Journal recall/recorded: 784d75196eeb ✨ feat(journal): recall and recorded answer a run's re-emissions without a write. Stack: b8a9ee0cec9f (run past deployment limit), 706f1373c78d (sandbox command 0.1 s). 775dd2d7c7 is the older version of the same stack. |
| F2.3 (undescribed) | `24337be84e` (older 7e0ae698e6) | PARTLY LANDED | 2c59c85599ab. Lands `flow.run.claimed` owner/stolenFrom/evidence fields + ClaimLogOwners test + changeset + lifecycle doc. Not landed: Engine.crash test-harness refactor in worker/test/flowHost.ts, agent.ts, Todo.test.ts; main built its own crash harness (009de4d458c8 fix(mvp): let crashed test engines refuse shutdown writes; Todo.test's todo-crash engine). Stack below is on main (sandbox command jobs). |
| F2.4 retain live session authority | `97b04fc0f6` (+ae3d1d4e90, 81490bf80b, e84c047471) | SUPERSEDED | b820dda6ae2d, b590c19559f3, 2cb405b306ce, 61e46051e70d. Missing lines are the registrations doc comment, rewritten on main. |
| F2.5 CI manual run, CiJob step log | `67917e16d7` | LANDED (re-implemented) | 7bf773f965c2 (engine slice of d8e24d5fbe94, helper home-2-ci) and e1fdb6f0f2da (routes, repo/run, Run form, Retry/Retry failed, e2e/actions.spec.ts, docs; ported by helper home-2-ui, which stalled before landing, finished and landed by home-2). CI spine: c0b1b3651d05, ccc71a0b2c24, 9f6bbd1e9c44. Actions list: 120aa96554cb. 645410aad889 log tail: SUPERSEDED by 88e0dbb1f2d3. Source CiJobMachine step log SUPERSEDED by 88e0dbb1f2d3; durable repo/Settle SUPERSEDED by 120aa96554cb. 10814a5fe4f1 SCAFFOLD ("not for landing"). Docs regen commits 31e8e9eacc16, 67917e16d7 SUPERSEDED (docs:check passes on landed tree). Detail: stranded-audit-home-2-ci.md |
| F2.6 issues/TODOs on any installed repo | `e5760e837c` | SUPERSEDED | 1426cef9c5bb (same subject; decision renumbered 0065 to 0079, migration to 0051) |
| F2.7 your conversations | `47f1d1ffea` | SUPERSEDED | cb7025c266dc (migration renumbered 0047_conversation_people) |
| F2.8 box command uses a secret e2e | `7db2d33fbd` (+adec00bc79, 3458516e6a) | SUPERSEDED | 535211a0b878 and its stack; missing lines are app-context wiring rewritten on main |
| F2.9 time construction phases | `be9b41b545` | SUPERSEDED | 240f2209365d fix(runtime): preserve host tracing context while timing construction phases (main deliberately drops the construction span); work note updated on main 11-01 |
| F2.10 custom domains | `ff1eb39a91` (+c6db4254b1, 8e74b2cf91) | SUPERSEDED | a68d249bb845, a5761cac6e3a (decision 0039, migration 0046) |
| F2.11 CLI red-suite receipts | `db2e3e783b` | SUPERSEDED | df26713a43b4 and stack (ef6bdef547a3 ...); EvaluationCli comment rewritten on main |
| F2.12 electric replay caches | `3436383373` | SUPERSEDED | 61e46051e70d; README namespace text on main |
| F2.13 visitor data in place (30 heads) | `2fa3be8d79` | SUPERSEDED | Iterations of lanes landed as 048fd027cc3f, 470748d3467f, b590c19559f3, 2cb405b306ce, c0509f694413, e3c8b6ea5a04 + 571b858be8d3 (change feed), cedbdbd8e138 (header metadata). ef3d9b5979's "Harness reconciliation" note: SCAFFOLD (lander coordination). |
| F2.14 wake TODO merge waits | `11af05aba7` | SUPERSEDED | 890a410e190b, 656539c3ae0b |
| F2.15 drive node records (13 heads) | `d716562442` | SUPERSEDED | 4bbbcb2eb3d9, f37a6ffe0e79, 7f519c3102da, 719b30408c02, 01545660e0b6, 3c0e0593a049, 5ded0f4b84e5 (writer lock), drive budget 9ed661b2002c/38558f6db1e2, 9774f649839e, a1eb8b8c3d97. WIP heads (46d017becd75 "do not land", 6219c2037250) SCAFFOLD. |
| F2.16 browser leader resume | `6243124341` | SUPERSEDED | b22677e1e3e6 🐛 fix(platform-browser): a run a tab starts after a reload goes ahead of the runs the reload resumed (Runtime `resumeConcurrency = 2`, a different design) |
| F2.17 harness safe recovery | `232ed3b05c` | SUPERSEDED | aaa88c2b0f91 (reworked landing) |
| F2.18 model secure endpoints | `69b56b184f` | SUPERSEDED | b309617f6d8a; rework note model-evaluator-rework-349375.md keeps loopback HTTP deliberately |
| F2.19 harness mutation evidence | `3f81cf738f` | SUPERSEDED | df649523c76e |
| F2.20 model-host fence callbacks | `829c3ee0c3` | SUPERSEDED | b2ebc9fba284 |
| F2.21 github write outcomes | `06799a9d9d` | SUPERSEDED | a7052c78fe27; github-write-rework-06799a9d.md drops the blanket HTTPS credential rule on purpose |
| F2.22 harness ledger evidence | `467ba8d3c1` | SUPERSEDED | 467ebf907671 (rework note mini-fix-rework-467ba8d3-602078.md) |
| F2.23 backend edits | `0ae96a044a` | SUPERSEDED | 99846c61cd8a (rework note mini-backend-rework-521409.md) |
| F2.24 theme system changes | `7791be2481` | SUPERSEDED | 9bba4661b257 |
| F2.25 attempt identity | `d847d43bdb` (+be74787aa6) | SUPERSEDED | 65a5864b2a77 (rework-be74787a.md: explicit parent scope wins over includeAttempt, deliberately) |
| F2.26 (undescribed) terminal opening | `02a3d5d58a` | SUPERSEDED / SCAFFOLD | 9b6a246ef1b8 fix(mvp): a terminal whose open never finished offers Open terminal again; `.smithers/flows/**/node_modules` symlinks SCAFFOLD |
| F2.27 flow retries durable | `d5ebb2c9ec` | SUPERSEDED | 1d12521b2561 (mini-flow-rework-d5ebb2c9.md) |
| F2.28 terminal session stage/deadline | `ad1d4ef682` | SUPERSEDED | 1115ed3e88e3 (moved to worker/branch/Session.ts; facts in sandbox-tools.md and infrastructure.md). Decision 0028-terminal-session-deadline and its work note were not carried; their content is in the feature docs and the main commit body. |
| F2.29 effect-electric batch validation | `77c9d62aff` | SUPERSEDED | 403de9ecd88f |
| F2.30 model proxy lines | `09e2b52cd0` (+cff156d794) | PARTLY LANDED | 25a8d19bbfbf. Fix on main as c13e6bf9e999; lands its dropped regression "preserves split UTF-8 and keep-alives between bounded lines". Work note status on main is done. |
| F2.31 (undescribed) | `bedd7ff582` | SUPERSEDED | flow-sibling-suspension-codec.md on main carries its own rework text |
| F2.32 (undescribed) | `d349d20f42` (+02def9611e) | PARTLY LANDED | 25a8d19bbfbf; earlier snapshots of F2.30; same test |
| F2.33 (undescribed) | `7e6e777b16` | SUPERSEDED | only `status: in-progress` line; main's note is later |
| F2.34 (undescribed) | `a27a438a21` | SUPERSEDED | only `status: in-progress` line; main's note is later |
| F2.35 external agent runners (16 heads) | `2f0bd0d362` | SUPERSEDED | Coding model role: 472b6b0baef0's work landed renumbered (migration 0042_coding_model_role, decision 0033). External-agent / McpServer / HarnessCli stack (62778583ba "dropped by Will's 940 ruling ... kept only as history"): rewritten vendor-neutral as 229e117e9eea, aade7f14584a, f1684204b38d, 21404c7f79da, 805077900ee6 (decision 0136); a second MCP server was deleted on purpose in 6e1ac64fd75d. |
| F2.36 (undescribed) | `cf246cf515` (+8720bcef3e) | SUPERSEDED | F2.13 identity iteration; 048fd027cc3f, 470748d3467f, b590c19559f3 |
| F2.37 (undescribed) | `6cfff5d4ce` | SUPERSEDED | as F2.36 |
| F2.38 (undescribed) | `27308dff1b` | SUPERSEDED | as F2.36 |

#### Tests (Mac mini)

- engine-store: `vitest run test/ClaimLogOwners.test.ts` 2 passed; `pnpm check` exit 0.
- platform-node: `vitest run test/ProcSnapshot.test.ts test/ProcessSandbox.test.ts` 141 passed, 3 skipped (the ESRCH case is Linux-only; the source's Latitude Linux run recorded it green); `pnpm check` exit 0.
- model: `vitest run test/ModelProxy.test.ts` 96 passed; `pnpm check` exit 0.
- apps/mvp (e1fdb6f0f2da before rebase): `pnpm typecheck` exit 0; `vitest run src/features/runs src/features/actions worker/ci/RunsApi.test.ts worker/RepoRuns.test.ts src/flows evals/flowCases.test.ts` 34 files, 457 passed; `src/device/schemas.test.ts` 8 passed; root `pnpm docs:check` exit 0. The e2e spec `e2e/actions.spec.ts` was not run (needs the e2e lock and GitHub App prerequisites).

Rebased onto main cb2ff93fc445 before push; no shared files with the two new main commits. Workspaces sa-home-2, sa-home-2-ci, sa-home-2-ui forgotten and deleted. The helper's original commit d7f78f322eb0 stays in w12-hold, unabandoned.

### Sub-lane home-2-ci (DONE (PARTLY LANDED; rest BLOCKED))


Family F2.5, newest head ~/smithers 67917e16d7 (fork 3e1eb154a6).

| Hunk/commit | Decision | Pushed main ids / evidence |
|---|---|---|
| 1389c84f2832..70805a5f7524 CI spine | SUPERSEDED | c0b1b3651d05, ccc71a0b2c24, 9f6bbd1e9c44 (parent's finding) |
| a3c129e82f66 actions list with Stop | SUPERSEDED | 120aa96554cb watch repository CI runs with Stop and restrict rollout |
| 10814a5fe4f1 "base: not for landing" | SCAFFOLD | its own subject says not for landing |
| 645410aad889 CiJob StepResult.log tail | SUPERSEDED | 88e0dbb1f2d3 retain command output for run step records: StepResult.output {stdout,stderr,truncated}, bounded, earlier steps stripped |
| d8e24d5fbe94 engine part: Realm.describe, RunRequest manual/input/only, Triggers manual+manualFlows, e2e hand flow, failed-jobs run settles failed | LANDED (re-implemented) | 7bf773f965c2 |
| d8e24d5fbe94 Dispatch records run before start | SUPERSEDED | 120aa96554cb (Dispatch.ts RepoRuns.record) |
| d8e24d5fbe94 CiJobMachine step log | SUPERSEDED | 88e0dbb1f2d3 |
| d8e24d5fbe94 durable repo/Settle flow (worker/ci/Settle.ts) | SUPERSEDED | main settles in the run's object (RepoRuns.settle from Executions settled hook, 120aa96554cb); the failure-reading intent landed in 7bf773f965c2 |
| d8e24d5fbe94 RunsApi routes, repo/run client flow, Run form, Retry/Retry failed buttons, e2e/actions.spec.ts, feature docs | BLOCKED | 33 of 57 files reject on main; RunsApi assumes one GITHUB_REPOSITORY, main has REPO_FLOWS_REPOSITORIES allowlist + per-repo RepoRoles (decision 0079) and the runs-as-cards UI (cf9b8a0d72a3). Needs a fresh port (~1500 lines + e2e). Recorded in apps/mvp/docs/work/ci-parity-manual-run.md "Engine slice landed, 2026-11-01" |
| 31e8e9eacc16, 67917e16d7 docs regen | SUPERSEDED | regen of superseded/blocked content; docs:check on landed tree passed |

Tests (mini): vitest worker/ci/{Realm,Realm.workerd,RepoFlow,Triggers}.test.ts worker/{RepoRuns,ExecutionHost}.test.ts: 6 files, 74 tests passed; RepoFlow.test.ts after a needs case: 14 passed, Realm/RepoFlow/Triggers/RepoRuns 100% on all metrics (exit 1 only from the global threshold on a partial run). pnpm typecheck (apps/mvp, 4 projects): exit 0. pnpm docs:check: exit 0.

### Sub-lane home-3 (DONE)




| Family | Newest head | Decision | Pushed main ids / evidence |
|---|---|---|---|
| F3.1 | `b111fae417` | SUPERSEDED | Terminal commit ef68a20877 landed rewritten as `7c5cd5f1b5` (budget terminal input by bytes). The content-free diagnostics commit was deliberately cut to B1 only by `dc5dc7c9bb` "guard a SQL reason beyond the diagnostic chain limit" ("Keep only B1 ... Preserve main's migration message, database primary message ... failed statement"); `5ded0f4b84` then documents `db.error.message` in troubleshooting. |
| F3.2 | `31778ff498` (older `ad5cff7222`, `d048301dfc`) | SUPERSEDED | The stack landed rewritten on 10-24: `2ad78157a4` (fs VibeLang 0.0.3), `6f9f46e0e4` (errors in VibeLang), `710006bbc0` (OTHER-1a ruling), `5f15e7dc1a` (migration starts from the tooling stack). Remaining missing lines: astro.config's old-app island and dev proxy (removed with apps/app by SCOPE-3), generated API baseline (regenerated on main), work-note revision text replaced by `5f15e7dc1a`. |
| F3.3 | `88e17533b3` | SUPERSEDED | Reworked and landed as `367a9d918a` "🐛 fix(control): preserve watch tails and rejected outcomes" (work note owner `codex-rework-88e17533`); main's ControlLive has the catch-up and rejection outcomes; the missing lines are the original's note text and pre-rework hunks. |
| F3.4 | `8a067eb479` | SUPERSEDED | Landed as `e941c9d9e8` "🐛 fix(backend): preserve mutation bodies and cache upload bytes"; main's Client.ts sends `Uint8Array` as octet-stream and ProductApi.ts carries the mutation bodies and the corrected header. |
| F3.5 | `07c9441bae` | SUPERSEDED | Reworked and landed as `7a091fe244` "🐛 fix(notifications): validate delivery evidence and notice access" (safe provider reasons, `provider_rejected`, fractional/unsafe version tests on main). |
| F3.6 | `092f8d2167` (same change `b2273ae344`) | SUPERSEDED | Main's `7c4f77086c` "✨ feat(mvp): serve the app at its domain, with the docs site beside it" is the later form: it adds `DOCS_SITE_FOLDERS`, query-tolerant file routes and the workers.dev `domain: null`; the head's missing lines are the earlier shapes main replaced. |
| F3.7 | `2f18041e12` (older `0b9034bb1b`) | SUPERSEDED | `e09825901d` (persist settlements before publication) is on main; the payload-source fix was reapplied as `ede7c1e0b6` (work note `flow-source-rework-0b9034bb.md`: "Obsolete completion/maxAttempts tests are omitted", raw-defect logging removed in the completion action) plus `569fb6aba3` and `fd506c3b7c`. |
| F3.8 | `2c53e7d3fb` (older `a2f7e9ecfd`, `e8c922fe28`) | SUPERSEDED | Landed as `c40976dcbe` "🐛 fix(issues): validate queued writes and retain failed persistence" (the e8c922fe rework); main validates the credential in `api.ts` (400) and keeps `bearer.renewed` at the shared 403. The head's 400-in-bearer variant and doc line placement are the alternative main did not take. |
| F3.9 | `41d3a29143` | SUPERSEDED | Formatting landed as `89b4eef1d7` "🎨 style: format the files repository dprint reports, in every dprint config"; the remaining missing lines (apps/site catalog repo pages, the app island, its threat-model entries) belong to the old app removed by `82b5490dbe` "🔥 chore(repo): remove the legacy app, its Worker and the Go backend". |
| F3.10 | `1de8c0a2fa` (same content `dd9fb460f8`) | SUPERSEDED | Landed as `a5d878e9c8` "🐛 fix(mvp): network keys and turn and steer admission stay consistent" with the decision renumbered to `0030-worker-admission-consistency.md`; main's work note is `status: done` and RemoteRuns.test.ts has the `remote_runs_no_engine` case. |
| F3.11 | `71c9f6ae2f` (same content `c4a38e7a0c`) | SUPERSEDED | Landed as `106c594862` "🐛 fix(home): keep repository selection when branch actions finish"; main uses a per-action token (`store.actions`) instead of the head's `sameRepository` check, a stricter form of the same intent. |
| F3.12 | `15f0dbca51` (same content `32562de10e`) | LANDED | `d11bfc87ba` "🐛 fix(mvp): restrict dev file serving and match Jev scopes faithfully". Not on main before: main's `apps/mvp/vite.config.ts` still has `fs: { strict: false }` (from `24573bf1a5`, 10-20, never revisited), so the dev server serves any file through `/@fs/`. Ported strict fs, `dev/vite-fs.test.ts` (adapted to main's function-form config) and the minimatch-with-`dot` Jev scope test; minimatch 10.2.6 added to apps/mvp devDependencies (frozen install passes). Mini: PACKAGE.test.ts and dev/vite-fs.test.ts pass, `pnpm typecheck` passes. |
| F3.13 | `b8a154457f` | LANDED | `9f810f44fd` "🐛 fix(platform-browser): validate stats and retain filesystem operations". Not on main before: platform-browser's `fileInfo.ts`/`make.ts` unchanged since `ee177d591c` (10-14); main accepts a non-integer `mode` and an out-of-range `mtimeMs`. Mini: check passes, BrowserFileSystem + Snapshot tests 68 passed, eslint passes, dprint clean on the changed files (dprint flags BrowserRuntime.test.ts and internal/Protocol.ts, untouched, pre-existing). |
| F3.14 | `f129e8e7ef` | PARTLY LANDED | `b330220d42` "🐛 fix(issues): leave out comments of a deleted or retyped issue". Draft and submission ownership SUPERSEDED by the 10-27 rewrite: `3820a388be` "preserve newer drafts when admission completes", `627194e142`, `3877247b9e`, `e83354acda` (per-submission `submissionKey`). Still missing on main: the conversation query keeps comments of a deleted issue or of an item turned `pull`; ported that guard and its test (red on main: 2 failed; green with the fix; `pnpm typecheck` passes). Not landing: detail `commitment` coalesce to `""` (main's `CommitmentControl` takes the nullable value). |
| F3.16 | `40d9433e74` (same change `vokunrsx`: `133177b7ce`, F3.38 `df9aecf75d`, F3.39 `702ffac454`, F3.42 `f50eeed6be`) | SUPERSEDED / SCAFFOLD | Shared-checkout snapshot. SCAFFOLD: `evals/swebench/logs/**` and fixtures (run outputs at paths `595b6abcbc` moved on 10-16). Generated: public-api baseline, maintainer-site `queue/coverage.json`/`queue.json`, pnpm-workspace (main has its own vibelang exemptions). VibeLang README/CONTRIBUTING/MAINTAINERS drafts and token-compare shipped in the VibeLang repo (`~/effectscript/README.md` token headline). Review queue: main has `0031-review-queue.md` and `docs/design/review-queue`. Issue POC/Repro/Prototype drafts (`worker/github/Prototype*.ts`, `Repro*.ts`, `poc.ts`, migration `0034_prototypes`): main deliberately left them out ("Their draft files remain in the shared checkout but are outside this landing", apps/mvp/docs/features/issues.md; auto-POC "proposed in 0018 and not implemented"); source stays readable at ~/smithers `40d9433e74`. `rulings.md` hunk not ours to edit. |
| F3.17 | `b541e7346c` (older `43205e918b`) | SUPERSEDED | The stack's removal commit landed as `82b5490dbe` "🔥 chore(repo): remove the legacy app, its Worker and the Go backend", which removed only the reference-host workflow and kept the hooks (`legacy-removal.md`: "The reference-host runner hooks now admit no workflow"; root PACKAGE.ts `referenceHostHooks` and reliability.yml's reference matrix remain). `7eaa33a84d`'s caller audit is recorded on main in `legacy-removal.md` (smithers-machined and smithers-server callers). |
| F3.18 | `c9b1279c8b` | SUPERSEDED + SCAFFOLD | Landed as `b2550ad31a` "🐛 fix(mvp): recover attention launches and refresh branch notices" (unreachable/timeout causes, malformed 200 warnings, watch reservation, branch render test). `.sol-review-baseline.json`, `.sol-review-red.mjs`, `.sol-review-validate.mjs` are SCAFFOLD (red-proof harness). |
| F3.23 | `f31eb50189` | SUPERSEDED + SCAFFOLD | Earlier snapshot of the same attention review as F3.18; landed as `b2550ad31a`. `.sol-review-*` files are SCAFFOLD. |
| F3.19 | `f987f4d487` | SUPERSEDED | Landed as `220e7aa2cc` "🐛 fix(time-travel): retry abandoned fork lanes until forgotten and refuse a fork whose reservation was reclaimed" (migration `0006_fork_intent_forgotten`, `forgetForkIntent`, `reclaimedAtMs`), then `b87a5b87e1` renewal. |
| F3.28 | `3d8110d1c5` | PARTLY LANDED | `3882b42327` "🐛 fix(time-travel): refuse an untyped audit patch and mint distinct owners under a repeated clock". Fork cleanup retry SUPERSEDED by `220e7aa2cc`/`b87a5b87e1` (main forgets lanes by a recorded forgotten stamp instead of the head's `cleanup` callback); carried-child history SUPERSEDED by `0d26fe49b6` "cut a fork's carried child by its own sequence, never by a clock". Still missing on main and ported: `validateAuditPatch` refuses a non-object patch through the typed channel (main throws a TypeError from `Object.keys(null)`), and `mintOwner` adds a realm ordinal so a repeated TestClock/seeded Random cannot mint the same owner twice; both with the head's tests (red on main: 7 failed; green: 34 passed; check and lint pass). |
| F3.30 | `a3b0e6cbce` | SUPERSEDED | Earlier snapshot of F3.28 (same `time-travel-storage-regressions.md` note); judged with F3.28. |
| F3.34 | `aafdad4fc2` | SUPERSEDED | Duplicate terminal-receipt guard: `3b02838605` "preserve consistent boundary and frame evidence" records "landed without the Duplicate terminal-receipt guard hunk ... which time-travel's 8d383d4f replaces"; main's EffectBoundary then got `010eda3fbe`. |
| F3.21 | `cbe8fe86e7` | SUPERSEDED + SCAFFOLD | Write-transaction tally landed as `7f519c3102` "✨ feat(flows): each alarm logs its duration, journal entries, write transactions and writer-lock wait" (main has `internal/WriteTally.ts`, `DatabaseMetrics.tally`, ExecutionObject wraps the drive in it, fixture `NotFoundClone.ts`). `test/Probe.test.ts` ("Disposable probe") is SCAFFOLD. |
| F3.22 | `1cabd1f1c2` (same content `2700fb6351`) | SUPERSEDED | Landed as `6a49b0aa8f` "🐛 fix(github): fence projections and preserve merge outcomes" with the migration renumbered to `0048_github_projection_fences` and the decision to `0077-github-projection-ordering.md`; work note `github-ordering-fixes.md` is `status: done`. |
| F3.31 | `4949a83285` | SUPERSEDED | Earlier snapshot of the F3.22 lane; landed as `6a49b0aa8f`. |
| F3.41 | `28873e59cd` (same content `3b17fe4b72`) | SUPERSEDED | Earliest snapshot of the F3.22 lane (receipt-before-admission, nonblocking reconciliation, merge settlement); landed as `6a49b0aa8f`. |
| F3.25 | `a18ce6bbb6` | SUPERSEDED | Landed as `f0dda22908` "🐛 fix(mvp-bench): require complete observations and release acquired resources"; main's `bench/follower-regressions.test.ts` has the follower request-deadline test and `bench-correctness.md` is `status: done`. |
| F3.27 | `fd43214bf2` | SUPERSEDED | Landed as `b61cf65bd3` "🐛 fix(platform-browser): preserve transaction outcomes and resumable code queries" (work note `status: completed`). |
| F3.36 | `c3be9c0f71` | SUPERSEDED | Landed as `870122c885` "🐛 fix(platform-browser): preserve failure delivery and cancellation recovery" (work note `status: done`). |
| F3.40 | `bfcb08d420` | SUPERSEDED | Earliest snapshot of the F3.7 flow-source lane; reapplied as `ede7c1e0b6` (`flow-source-rework-0b9034bb.md`). |
| F3.26 | `e1095b962f` (older `d88d0cf0df`, `197cebb305`) | SUPERSEDED | The stack landed on 10-21: `eb56b104a3`, `08d98613b5`, `2ae1b8c5d6`, `c440790fe9`, `fb9b691356`, `d12b9cc772`. `fb23abf0de` (read a Cloudflare run again only when its change feed moves) is on main in the later form: RunsStore follows `REMOTE_RUN_SHAPE_ROUTE` and engine events skip cloud roots (`if (!onCloud(rootId)) return`), with `c8dffce533`/`e3c8b6ea5a`; decision renumbered `0026-watching-a-todo-run.md`. The missing harness hooks (`remote.hold`/`deliveries`) belong to that replaced test. |
| F3.29 | `48208181b8` (same `14cd4d44e8`) | SUPERSEDED | Generated only (public-api baseline entry for `github/Statuses.d.ts`, target index); main has `Statuses.ts` and its baseline entry, regenerated since. |
| F3.35 | `8d6d9f946c` | SUPERSEDED | Generated only, with an unresolved conflict in the baseline; same Statuses entry as F3.29, on main. |
| F3.15 | `514c5839a7` | LANDED | `cb2ff93fc4` "🐛 fix(mvp): chat retries and withdrawals keep drafts in their own conversation": findings 1-6 re-implemented on current chat code (retry keeps the draft/shared prompt, retry without a local question is a no-op, takeBack after navigation keeps its own conversation's draft, every open shape counts toward the pill, first-text timing in the answer's conversation, branch-open failure during confirmation is `Outbox.Retry`). Finding 7 (200 receipt validation) SUPERSEDED: on main as the `Existing` schema in chat/api.ts. Mini: 9 new regressions fail on main source and pass; 148 chat tests and `pnpm typecheck` pass. Not landed: the head's work note `chat-regressions-212049.md` (in-progress tracker; facts are in the commit and chat.md). |
| F3.20 | `30c93e58e5` | LANDED (with F3.15) | Same seven findings; landed in `cb2ff93fc4`. Its decision `0028-chat-draft-and-delivery-isolation.md` not landed: the behavior is documented in apps/mvp/docs/features/chat.md, and 0028 is taken on main. |
| F3.24 | `88f0d76616` | LANDED (with F3.15) | Same change as F3.20, 47 s older; landed in `cb2ff93fc4`. |
| F3.32 | `c9ccd9c40f` | LANDED | `d6a5df2821` "🐛 fix(mvp): serialize draft writes and fence admission" (saved_revision migration renumbered 0087, decision 0146, RepoAdmissionLost) plus `d0ec8e7db9` (two extra regressions, sub-builder home-3-drafts). Save locking was already on main (`4656e2586b`, `858ebca3fb`). Not landed: work note `worker-concurrency-261971.md` (findings in decision 0146). Out of scope: three RepoReads findings the original never reproduced. Details: ~/smithers-builders/stranded-audit-home-3-drafts.md. |
| F3.33 | `7440233936` (older `9ff3087d68`) | LANDED (with F3.32) | Undescribed snapshots of F3.32; landed via `d6a5df2821`, `d0ec8e7db9`. |
| F3.37 | `6b11187a07` (older `ea9f72d317`, `b6d3a4ffb2`, `b763b2c97b`) | LANDED | `96cd0fd31f`, `2101a501a2`, `6d7863a034` (original three subjects). Not on main: repo-view and .smithers/flows still on `@pierre/diffs ^1.3.6`, workerPool.ts unchanged since `04f89c41cf`, and `docs/proposals/pierre-oss-survey.md` absent (main's tracker: "record the survey in its proposal (not present in this checkout)"). Mini: repo-view check passes, bun 186 pass 0 fail (100% coverage), review flow renderWalkthroughHtml 14 pass, frozen lockfile install passes, `pnpm docs:check` passes, target index unchanged. |
| F3.38 | `df9aecf75d` | SUPERSEDED / SCAFFOLD | Same change `vokunrsx` as F3.16 (14:19 snapshot; decision then named `0025-review-queue.md`); judged with F3.16. |
| F3.39 | `702ffac454` | SUPERSEDED / SCAFFOLD | Same change `vokunrsx` as F3.16 (14:14 snapshot); judged with F3.16. |
| F3.42 | `f50eeed6be` | SUPERSEDED / SCAFFOLD | Same change `vokunrsx` as F3.16 (14:07 snapshot); judged with F3.16. |

### Sub-lane home-3-drafts (DONE)




Baseline: ported tests on plain main 55915a67a7 (mini) gave 11 failed / 61 passed of 72 across PersonalFlows, Repos and RepoClone. The regression describe alone gave 8 failed / 4 passed.
While this lane was porting, another builder landed the same port as d6a5df2821 (migration 0087, decision 0146). This lane's full port was dropped before push and only two extra tests were landed: d0ec8e7db9.

| Finding | Decision | Evidence |
|---|---|---|
| Concurrent saves create a duplicate revision | SUPERSEDED | 4656e2586b, 858ebca3fb; passes on plain main |
| Concurrent new-flow saves collide on the name | SUPERSEDED | 4656e2586b; passes on plain main |
| Save validates a stale source | SUPERSEDED | 858ebca3fb; passes on plain main |
| Repeated save reports a later revision (receipt) | LANDED | d6a5df2821 (0087 saved_revision); d0ec8e7db9 adds rename-name case |
| Late same-round write loses answers | LANDED | d6a5df2821 |
| Late same-round drafting regresses status | LANDED | d6a5df2821; d0ec8e7db9 adds newer-round-still-replaces case |
| Concurrent answers lose one | LANDED | d6a5df2821 |
| Answers succeed after concurrent settle/advance | LANDED | d6a5df2821 |
| Obsolete clone attempt gets admission | LANDED | d6a5df2821 (RepoAdmissionLost -> CloneRefused in Inspect schema) |

Not landed: original work note docs/work/worker-concurrency-261971.md (its findings are in decision 0146); original 0038 numbers (renumbered 0087/0146 on main).
Out of scope: three RepoReads findings the original left unreproduced.

### Sub-lane home-4 (DONE)




| Family | Newest head | Decision | Pushed main ids / evidence |
|---|---|---|---|
| F4.1 | `aaf17365b7` (change `quxxrywq`; described newest `0b9034bb1b`, home-3) | SUPERSEDED | Same code on main: `ede7c1e0b6` "🐛 fix(flow): preserve payload sources and safe durable replay" (`replayExit`, `wrapActionResult(engine.deferredResult…)`, `GraphRegression.test.ts`, `PlannedInput input:`, `<non-plain>`); ede7c1e0b6 itself chose `() => false` over the snapshot's `Option.isNone`; `fd506c3b7c` "escape token diagnostics and propagate queue take failures" later replaced the queue's take-failure log on purpose. Not landed: `docs/work/flow-source-regressions-751129.md` (in-progress tracker note of the lane, SCAFFOLD). |
| F4.2 | `c3ab4ad244` (change `nvxpztpx`; described newest `c9ccd9c40f`, home-3 F3.32) | LANDED | `d6a5df2821` "🐛 fix(mvp): serialize draft writes and fence admission": migration 0087 `flow_drafts.saved_revision` (the draft's 0038), decision 0146 (the draft's 0038), answers under the draft lock, completed-round fence in `writeDraft`, `RepoAdmissionLost` → `CloneRefused` in Inspect, the original regressions (PersonalFlows, Repos.test.ts, RepoClone stale cases, Database 0087). Main already had Save-under-lock (`4656e2586b`, `858ebca3fb`). Mini: 4 files / 121 tests passed; `pnpm typecheck` passed; `tsc -p worker/tsconfig.json` shows the same 41 IntegrationError errors on plain main (pre-existing). Code equals the described newest `c9ccd9c40f` (home-3 F3.32, sub-builder home-3-drafts): **home-3 should mark F3.32/F3.33 SUPERSEDED by d6a5df2821.** Not landed: `docs/work/worker-concurrency-261971.md` (tracker receipts) and `verify-261971.sh` (lander script, deleted by the lane itself): SCAFFOLD. |
| F4.7 | `537de2daf8` | LANDED (with F4.2) | `d6a5df2821`; older snapshot of `nvxpztpx`, a subset of `c3ab4ad244`. |
| F4.10 | `6afbc5206d` | LANDED (with F4.2) | `d6a5df2821`; older snapshot of `nvxpztpx`, a subset of `c3ab4ad244`. |
| F4.4 | `a5e2df4749` (change `ppypnrmu`) | SUPERSEDED | Its one line (`@pierre/diffs` 1.5.2 pin in repo-view) is in the described newer copy `6d227a6d45` "⬆️ chore(repo-view): pin @pierre/diffs 1.5.2 and let pierre settle the code view's worker pool", stack `6b11187a07`, judged by home-3. |
| F4.8 | `faa02d0a79` (+ `12c1e23387`; change `orpqwlmp`, described newest `e8c922fe28`) | SUPERSEDED | `c40976dcbe` "🐛 fix(issues): validate queued writes and retain failed persistence": `writes.test.ts`, `kept.persisted` → `Outbox.Retry`, `issues.write.invalid`, the issues.md bullet, 400 for an undecodable credential (renewal parsing moved to `src/flows/bearer.ts`). Not landed: `docs/work/issues-credential-regressions.md` (tracker note, SCAFFOLD). |
| F4.14 | `ad3afb35e8` (change `svzrnspo`; described newest `0ea193cb82`, home-1) | SUPERSEDED | Its code (Actor `boundTo`, `refusesPersonOnly` tests) is on main via `df0456e999` "🐛 fix(mvp): bind opaque runs exactly and use configured alert links". Only missing: `docs/work/worker-953411.md` (in-progress tracker note, SCAFFOLD). |
| F4.16 | `4d35803d1f` (change `myvvvqrs`; described `4b9748bdaf` is on main) | SUPERSEDED | `apps/mvp/e2e/sandbox-lifecycle.spec.ts` landed by `4e87378f9f` (10-22) and was deliberately reworked by `930e66f9c9` (terminal reads the forge's branch, agent step after wake, checkout left clean), `d2823b531d` (`messageIn` locators), `e3a4a95b63` (registries, Go, Python). The 13 lines are the pre-rework ordering and `broken("remoteFlows")`, removed on purpose. |
| F4.3 | `7759ae184b` (change `vokunrsx`, shared ~/smithers checkout; newest copy `e98419b928` 10-25 is home-1's, others home-3 F3.16) | SUPERSEDED / SCAFFOLD | File-by-file against main and `e98419b928`: 242 files equal main, 327 equal the newer snapshot (home-1 judges those: apps/playground, worker/github/Prototype*, migration 0034_prototypes, vibelang-readme drafts, swebench fixtures, cerebras-load journals). Only-here content, all older versions of files that later states replaced: maintainer-site `queue.json`/`coverage.json`/`answers.jsonl`/`dispatch.md` (superseded by `0c455cbe8e` and `0c6f850dca`, the curator's newest queue state "recovered from the parked shared checkout"); 45 `docs/work/*.md` trackers whose only unique lines are earlier `updated:`/`status:`/`owner:` frontmatter and reconciliation paragraphs (tracker rewrites); `CURATOR-PROMPT.md`, `rulings.md` PLUGIN-6 and `wiki.md`/`will-decision-queue.md` lines citing review-queue decision 0025 (main renumbered it to `0031-review-queue.md`; rulings.md PLUGIN-6 and PROC-18 are on main with 0031). |
| F4.5 | `8f2dc27a08` (`vokunrsx`) | SUPERSEDED | Same check: only-here files are the same tracker/queue/curator/rulings intermediate states as F4.3. |
| F4.6 | `d74d3c69ef` (`vokunrsx`) | SUPERSEDED | As F4.5. |
| F4.9 | `9aa491a333` (`vokunrsx`) | SUPERSEDED | As F4.5. |
| F4.11 | `d00a00804b` (`vokunrsx`) | SUPERSEDED | As F4.5. |
| F4.12 | `8902f02f40` (`vokunrsx`) | SUPERSEDED | As F4.5. |
| F4.13 | `aa5882d7a8` (`vokunrsx`) | SUPERSEDED | As F4.5. |
| F4.15 | `869eaba965` (`vokunrsx`) | SUPERSEDED | As F4.5. |
| F4.17 | `871bacc02d` (+ `c349c7bdf4`, `vokunrsx`) | SUPERSEDED | As F4.5 (29 only-here files, all trackers/queue/curator/rulings). |
| F4.18 | `c3f3d6782a` (change `omumuqys`, shared checkout at 04:00, stale working copy) | SUPERSEDED | Added lines checked against main and `e98419b928`. The code that differs is the pre-review version that the 10-20 evening review PRs replaced on purpose: `LocalRuns.ts` + `Destination.ts` (run ids follow the local store) replaced by `173bfdf59c` "fix(cli): keep run IDs scoped to the selected host (#4425)"; AgentSession `waitForRunning` polling replaced by `844ba8d1e1` "fix(agent): await committed admission instead of polling (#4422)"; IssueSync reaction 409 retry loop replaced by `395fc44513` "fix(integrations): leave issue intake retries to durable callers (#4416)"; `retryGitIndexLock` + `NodeJjLock` test removed by `1b44b2b049` "fix(sandbox): delegate Git contention retries to durable actions (#4415)"; `flows-as-code-api.md` two-panelist draft replaced by `e7ff5621de` (four-panel proposal, FLOW-10); decisions `0022-review-queue`, `0021`, `0023` landed renumbered (review queue is `0031`). Rest: tracker docs, queue state, generated `target-index.json`/`llms-full.txt`/api.mdx tables, `bun.lock`/`pnpm-lock.yaml` (generated). |
| F4.19 | `0432886e45` (change `tqqzylmk`, shared checkout at 02:58) | SUPERSEDED | Against main and the later snapshot `c3f3d6782a`, 59 files keep unique lines; all are older states main rewrote: outbox rows at `v: 2` (main `v: 3`), `schemas.lock.json` epoch 47 (generated), `local-first-conflicts.spec.ts` "five tests marked broken" (fixed since), an earlier `worker/flows/Todo.ts` import list, maintainer-site `queue.js`/`outline.mjs` comments (main has the outline/folds/symbols feature), tracker docs. |

#### Not landed, with reasons

- Tracker/work notes only in snapshots (`flow-source-regressions-751129.md`, `worker-concurrency-261971.md`, `issues-credential-regressions.md`, `worker-953411.md`, intermediate `docs/work/*` frontmatter): SCAFFOLD, lane receipts; main's trackers carry later states.
- `apps/mvp/verify-261971.sh`: SCAFFOLD (lander script; the lane deleted it in `c9ccd9c40f`).
- Shared-checkout code differing from main: SUPERSEDED by the commits named in F4.18/F4.19.

#### Notes for other sub-lanes

- home-3 F3.32/F3.33 (`c9ccd9c40f`, `7440233936`, `9ff3087d68`): the same code landed as `d6a5df2821`; its sub-builder `home-3-drafts` should not land it again.
- home-1 owns the newest `vokunrsx` snapshot `e98419b928`; everything my older copies share with it is left to that judgment.

### Sub-lane home-5 (DONE)




| Family | Newest head | Decision | Pushed main ids / evidence |
|---|---|---|---|
| F5.1 docs(mvp): round 4 deploy record | `39a13b08de` | SUPERSEDED | `5ca2098804` 📝 docs(mvp): feature docs and decisions say what is true on main, per Will's words: removed the deploy log from infrastructure.md; it belongs in private `smithers-infra` (Will, 2026-10-20 18:08). The MigrationError finding is on main in `work/cloudflare-flow-host.md`, `work/prod-flows.md`. |
| F5.2 land4d: combined (to split) | `62b9ef30ca` | SUPERSEDED | Round 4d landed as `840806f212` ✨ feat(mvp): device data across a deploy...; the remaining 34 lines are tests main rewrote later. `.land4-sdk.sh` SCAFFOLD (lander helper, "never landed"); `apps/maintainer-site/queue/queue.json` curator data. |
| F5.3 undescribed 10-20 snapshot | `1ef9292cf0` | SUPERSEDED + SCAFFOLD | `runs show` local-store routing: `173bfdf59c` fix(cli): keep run IDs scoped to the selected host (#4425) (main never redirects run ops). AgentSession admission polls: `844ba8d1e1` fix(agent): await committed admission instead of polling (#4422); readTransaction on main. SqlConnection rollback-on-failed-opener: main chose the opposite, tracking and abandoning it, `b688e6d1c7` (#4413). agent/fs .vibe: `1e94e0ec07` ✨ feat(fs): @smthrs/fs is written in VibeLang. agent-evals.md, maintainer-site queue (`a14ec8770e`, `772b434be6`): main newer. SCAFFOLD: `evals/swebench/logs/run_evaluation/**` run outputs, `apps/mvp/evals/results/*` dev-run artifacts, ui `bundle.generated.ts`. |
| F5.4 undescribed 10-18 design mocks | `9335d5fa7d` | SUPERSEDED | `7fcc338483` 📐 feat(design): land the stage 1-4 UI mocks as the Monday launch spec (10-19, curated: source only, no dists, shots or eval runs). |
| F5.5 fix(chat): capacity shortages | `e99ce3e179` | SUPERSEDED | `82b5490dbe` 🔥 chore(repo): remove the legacy app, its Worker and the Go backend (work was apps/app + packages/backend); only gap is generated `.smithers/factory.json`. |
| F5.6 fix(cli): name what a flow body threw (#4253) | `c1ec763351` | SUPERSEDED | `e0fb0fcd87` 🐛 fix(flows): lead "Cannot load flow" with the underlying cause (#4253); `causeLine` in Executable.ts and NativeControl.ts. |
| F5.7 feat(sites): owner controls, prebuilt publishing (+publish sites, OAuth cookies) | `5036067ccb` | SUPERSEDED | `82b5490dbe` (Go backend, apps/app, apps/server removed; CLI `Sites.ts` called the removed API). |
| F5.8 feat(app): public repository home (+bug drafts, static landing) | `28a10398f8` | SUPERSEDED | Home links: `6fec3b6039` ✨ feat(home): link installation, docs and bug reports with verified fixes, `c410c1346f`; landing redesigned around the install command (`9662836059`); apps/app parts removed by `82b5490dbe`; `docs/fixed-by-agents.md` has the #3905 row. |
| F5.9 undescribed draft of #4253 | `62148f367d` | SUPERSEDED | `e0fb0fcd87` (same fix as F5.6). |
| F5.10 undescribed 10-16 swebench | `147ca67f07`, `1af7df96d6` | SUPERSEDED + SCAFFOLD | `evals/swebench/fixtures/**` are leftovers at the pre-move path; `595b6abcbc` ♻️ refactor(evals): move eval suites into the packages they evaluate (now `packages/smithers/agent/harness/benchmarks/swebench`). `logs/run_evaluation/**` SCAFFOLD (SWE-bench run outputs). `Consensus.ts` is a jj conflict snapshot; its resolved side (`ConsensusError` fence_lost with cause) is on main. Base #4120 on main as `0fd9d0693d`. |
| F5.11 undescribed 10-16 swebench | `257ede9a75` | SUPERSEDED + SCAFFOLD | As F5.10; `packages/rpc/src/RepositoryHome.ts` is a conflict-marker snapshot (main has the resolved consts); CellFlows/CachePermit = #4120 `0fd9d0693d`, #4119 `256e3d4a1c`. |
| F5.12 docs(review): lane 78 receipts (#4026) | `943bb4002e` | SCAFFOLD | Commit says "LOCAL RECEIPTS ONLY, drop this commit before publishing"; only the ROOT-NOTE handoff is missing. The #4026 fix it reviewed (`e02c005dfe`, apps/app) went with `82b5490dbe`. |
| F5.13 undescribed flow dist | `21d0afd93a` | SCAFFOLD | Only `packages/smithers/flows/flow/dist/esm/**` build output (gitignored `dist/`). |
| F5.14 undescribed 10-14 (7 heads) | `501e378253` (+`a3d8c239a9`, `ff428962db`, `cb24c3c390`, `259eda1f88`, `cef5d69b56`, `4f0aed1fb7`) | SUPERSEDED + SCAFFOLD | Every fix is on main in rewritten form: build-library lazy `import()` (build-library.mjs:195; `0a62d4534a`, `564f67c42d`), AgentAction claimCap test, deploy.ts `removeHandlers`, Owners `unsafePattern`, Jj `[unrenderable failure]`, JournalGrantStore `emptyPage`, BunHost NUL root, SandboxMerge `fullCommitId`, memory/kernel `@next` install docs and EntryPoints test. SCAFFOLD: `packages/testing/test/zz-probe-tmp.test.ts`. |
| F5.15 undescribed @next docs | `2255b9c7dc` | SUPERSEDED | `@next` install lines on main in integrations quickstart and migrate embed-the-scanners. |
| F5.16 undescribed 10-14 | `3bc718311f` (+`106e324965`) | SUPERSEDED + SCAFFOLD | As F5.14; `agent/scorers/test/zz-probe.test.ts` SCAFFOLD. |
| F5.17 undescribed 10-14 | `be0eae202f` | SUPERSEDED + SCAFFOLD | As F5.16; canonical PACKAGE.ts `bunTest` on main. |
| F5.18 undescribed 10-14 | `edcd2f4cb5` (+`45b7874a46`) | SUPERSEDED + SCAFFOLD | On main: evals `__proto__` (Runner/Trials tests), registry `invalid_model` docs, EnvelopePrecheck substitutions, Webhook header casing, PackageManager docs, ingest-a-webhook, ArtifactSweep, capability `withinMatchBudget`, database eslint examples, RedactionLeakForms, keys PACKAGE, JournalLogger getter test, StepKey tests, run-store PACKAGE reviews, Semver upper bound, PlanAssertions. SCAFFOLD: `zz-probe-tmp.test.ts`, `zz-probe-depth.test.ts`, `StepKey.ts.fixed`, `vitest.tmp-effect404.config.ts`, the `if (false && ...)` red-proof mutation in PackageManager.ts. |
| F5.19 undescribed 10-14 | `1ee38f3447` | SUPERSEDED + SCAFFOLD | As F5.18; triggers quickstart example and examples test, BoundedJson docs on main. SCAFFOLD `zz-probe-registry-lane.test.ts`. |
| F5.20 undescribed 10-14 | `865abb05d4` | SUPERSEDED + SCAFFOLD | As F5.18; Jj.test `[unrenderable failure]` on main. SCAFFOLD `zz-probe.config.ts`. |
| F5.21 undescribed 10-14 | `1a00aac5c5` | SUPERSEDED + SCAFFOLD | As F5.20; RecordingModel raw-string scan on main (RecordingModel.ts:83-88). SCAFFOLD `rt-probe.tmp.ts`. |
| F5.22 undescribed 10-14 | `a16459a919` | SUPERSEDED + SCAFFOLD | As F5.20; RemoteArtifacts trailing `?`/`#` on main. SCAFFOLD `DigestMemoProbe.test.ts`, `vitest.tmp-effect404.config.ts` (says "TEMPORARY, never landed"), `false &&` red-proof in NotificationQueue.ts. |
| F5.23 fix(testing): Faults waits ignore skewClock | `801f514d36` | SUPERSEDED | `284ce12b6b` 🐛 fix(testing): time Faults waits on the real clock and reject non-finite skews. |
| F5.24 undescribed 10-14 | `6e7e29a2aa` | SUPERSEDED + SCAFFOLD | fs `hidden-runtime` fixture on main; `vitest.tmp-effect404.config.ts` and `.api-example-*` SCAFFOLD. |
| F5.25 fix(tui): worker durations consistent, clock units whole (#3672) | `cc7646203d` | PARTLY LANDED | `a600e38f7e` 🐛 fix(tui): keep clock units whole where a surface clips (#3672): footer fits key hints first and shows a status item whole or not at all (F09: `⠏ 5.1` at 80x24); focused chip, run card, Summary row, graph box and worker header keep the clock whole. New `test/clocks.test.tsx` 32 pass on the mini; 17 of them fail with main's `src` (source swap). Not landed: the `41.0s`/`1m00s` format switch to `Transcript.duration` in inbox.ts, run-card.ts, toasts.ts, tree.ts, the tab title, README examples and 7 test files' expectations, and the boundary/8ms/freeze/clock-seam tests: SUPERSEDED by `c7fc5614aa` 🐛 fix(tui): one worker clock on the chip, card, Summary row, tree and toast (#3672), which settled the values on `Tabs.clock`. |
| F5.26 fix(tui): stop the denied-edit replay after the denial (#3673) | `417e34ccc1` | SUPERSEDED | `bea04053ce` (#3993) made the judge opt-in, so a worker that reports a denied edit settles `✓ Fix math.js · 1s`, not `failed`. Reproduced on the mini: `e2e/denied-edit.test.ts` times out on "naturally failed worker" with the screen showing `✓ Fix math.js · 1s`. #3673 was closed not planned for this reason (2026-10-16). Copy abandoned, not pushed. |
| F5.27 fix(tui): project workspace fixture delegation outcomes (#3677) | `1b0c595a39` | LANDED | `693f40c643` fix(tui): project workspace fixture delegation outcomes (#3677). Mini: `e2e/workspace-outcome.test.ts` 2 pass; `e2e/tui.test.ts` (shares the fixture) 124 pass, 1 fail `extensions > a metadata.tui key on a markdown flow starts a real durable run that settles`, which fails the same way on plain main (source swap). |

Checks on the mini for the landed pair: `bun test ./test/clocks.test.tsx` 32 pass; tabs, subagent-view, run-card-view tests pass; `pnpm typecheck` (vibelang) 0; `eslint src --max-warnings=0` 0; `dprint check` clean after formatting.

### Sub-lane home-6 (DONE)




Source: `~/smithers` (read-only). Families: `briefs/stranded/home-6.md`, 28 families, 39 heads.
Landed 9 commits on main, `d0ec8e7db9..c69effb46e`, 2026-11-01. Tests on the Mac mini:
apps/tui typecheck, lint, `bun test ./test` (2681 pass, 0 fail, after the final rebase);
new e2e files (input-ownership, steering-delivery, asks, answer-frames, cells-scroll, diff-focus)
25/25 pass; packages/smithers `pnpm check` plus 15 NativeControl/ControlDatabase files (79 tests) pass;
build/targets ToolBuild 60/60, typecheck and lint pass; root `pnpm docs:check` passes; target index unchanged.

| Family | Newest head | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| F6.1 retain card focus closing worker diffs (#3675) | `a8a2e05e6d` | SUPERSEDED | `976bdefe4a` 🐛 fix(tui): Esc from a worker card's diff keeps the card focused (#3675). Main has the same review-key move, test and e2e. The 5 "missing" lines are one comment's wording. |
| F6.2 pipeline checks and multiline commands (#3676) | `b39ca4665b` | LANDED | `d7aae3fa8c` |
| F6.3 model replacements on worker cards (#3678) | `62f5ff7635` | LANDED | `059d6483d1` (README hunk merged by hand) |
| F6.4 steering delivery in tabs fixture (#3683) | `0429a5434c` | LANDED | `070199bf41` |
| F6.5 explicit Summary row focus (#3682) | `b1266b07a7` | LANDED | `86e63b36b3`. app-agent-controls and app-target-approvals, which were written after this fix, now press Tab before row keys. |
| F6.6 recognized budgets through malformed causes (#3797) | `d9eacae175` | SUPERSEDED | `8688f2bc86` 🐛 fix(model): FailureCopy reads only own table entries and safe fields, and keeps a found budget (#3795)(#3796)(#3797). Main merged the three fixes into one commit and kept their tests in FailureCopy.test.ts. The separate FailureCopyBudget.test.ts was left out on purpose. |
| F6.7 /grep vs non-program cell display (#3794) | `617ca48896` | SUPERSEDED | `9d5f83e3c9` 🐛 fix(tui): /grep matches what a cell's row draws (#3794): cell-display.ts plus a 425-line app test |
| F6.8 safely inspect failure descriptions (#3796) | `7c360bd2cd` | SUPERSEDED | `8688f2bc86` (guarded field snapshot, 16-cause bound); FailureCopyInspection.test.ts was consolidated |
| F6.9 chat row cache reuses projection (#3793) | `3c156cc6f0` | SUPERSEDED | `a90be37a64` ⚡ fix(tui): the chat row cache hits on an unchanged render (#3793), with a smaller test |
| F6.10 ignore inherited failure copy entries (#3795) | `d3b36ac7a7` | SUPERSEDED | `8688f2bc86` (`own()` uses Object.hasOwn); FailureCopyLookup.test.ts was consolidated |
| F6.11 skip hidden programs in /grep (#3698) | `73a7a8697e` | SUPERSEDED | `06fc58f459` 🐛 fix(tui): /grep skips a cell's code while Cells is off (#3698), then `9d5f83e3c9` (app-grep-display test). The head's e2e and fixture were replaced by main's tests. |
| F6.12 send Chat's a on Enter (#3666) | `7bcf9a2535` | LANDED | `5bae4fdb09` |
| F6.13 draw answers before syntax highlighting (#3699) | `d81ce9b981` | LANDED | `6b622539d9`. The test presses Tab after Ctrl+S because Summary now opens in its composer. |
| F6.14 preserve Chat position toggling Cells (#3697) | `526ea677dd` | LANDED | `b57faa6536` |
| F6.15 leave stdin ownership to the renderer (#3702) | `28c5a59925` | LANDED | `b72f8c830c`. NativeControl and NodeControlHost hunks re-applied by hand; test fixtures moved to `.smithers/flows` (M-49 `7f0e0cd5aa`). |
| F6.16 bound wiki install pages (#3787) | `344a9adabd` | SUPERSEDED | Its Go `flow_config` changes left with `82b5490dbe` 🔥 chore(repo): remove the legacy app, its Worker and the Go backend. #3787 landed as `66b82c50cd`. The 3 missing lines remove an excerpt that main deliberately keeps, at `.smithers/wiki/README.md` (M-49 `7df5f685fc`). |
| F6.17 (undescribed) site CLI data `--operation` | `b10b061de9`, `855eddfa2c`, `ac47472556` | SUPERSEDED | Generated help/cli-commands data for a CLI main no longer has (main `smthrs diff` has no `--operation`). The data was regenerated in `2469f87993` 📝 docs(site): regenerate the reference, CLI data and llms bundles. The rest of the snapshot was old-app e2e, removed in `82b5490dbe`. |
| F6.18 machinedWire CI target (#3626) | `3db7927ac4`, `4847fe3e63`, `5015cf2b98` | SUPERSEDED | Landed as `9beb3b0efe` and `7edb373931`; packages/smithers-machined was later deleted by `82b5490dbe` |
| F6.19 setup claims and owner upgrade (T-ACC-01, #3443) | `dcbf160de9` | SUPERSEDED | Wire contracts and failure codes for the Go backend's setup-session path, which `82b5490dbe` removed. No setup_token_invalid/SETUP_SESSION code exists on main. #3443 was closed not planned on 10-16. |
| F6.20 TODO object, state machine, projection (#3433) | `924ebf2104` | SUPERSEDED | Main's TUI files TODOs through `mythical/todos` (`daafe52404`, `b77f8a22bf`). The head's TODO_ROUTES backend contract was removed with the backend (`82b5490dbe`). #3433 was closed as on main (`46dd08774c`). |
| F6.21 (undescribed) relocatable server bundle (#3432) | `6abe4af91b` (+ older `4c1418c1dc`, `254db52da3`, `1317075d06`, `c8e5326089`) | PARTLY LANDED | Landed ToolBuild `timeout` (code, docs, tests) as `c69effb46e`. Not landed: (1) the bundle itself, release.yml and .gitignore. #3432 landed as `bdd9ec5672`..`984c91ab10` and was removed by `82b5490dbe`. (2) The ProcessSupervisor TMPDIR and relative-socket change. Main's #3432 landing left it out on purpose, and later ProcessSupervisor work (`451ee47a70`, `5698a8fd8e`, `ce622ad4c3`) keeps `/tmp/sm-p-`. Its only consumer, the bundle's private TMPDIR, is gone. (3) The SupervisorProgram error detail, already on main via `5698a8fd8e`. |
| F6.22 (undescribed) rpc Cards.ts cut cards | `03a3694b3b` | SUPERSEDED | `f3b124de41` ✂️ refactor(app): finish cut surface cleanup and scope rules (#3435), `8172812db2`. Main has none of the removed card kinds. The missing line is an import with a double space. |
| F6.23 audited repeat-safe dispatch identity (#3413) | `cd09439a2c` | SUPERSEDED | Decision: `41e0fdaf88` (mvp.md Appendix B: "issue-sweep is cut from the product"). Issue #3413 was closed not planned on 10-16: "repeat-safe Burndown qualification serves the cut issue-sweep path; arbitrary callbacks must remain unkeyed". |
| F6.24 (undescribed) site docs installation links | `9af5010598` | SUPERSEDED | #3458 landed as `96b1a46b68`, `d9625bd3da`, `3fff9eb8e6`, `cddfb2620b`. The snapshot also contains a broken global replace (`~/docs/installation/-skills/*`) that must not land. |
| F6.25 (undescribed) site docs links | `c185ee200a` | SUPERSEDED | Same as F6.24 (an earlier step of the same broken replace) |
| F6.26 scope remote recovery ownership (#3413) | `2a97a69e93`, `ddf8ab9ba9` | SUPERSEDED | Same decision as F6.23 (`41e0fdaf88`, #3413 not planned) |
| F6.27 card view-model contracts (#3474) | `1662612525`, `b5d487148e`, `9e8d01e519` | SUPERSEDED | `a292b73283` ✨ feat(rpc): add card view-model contracts and action seam (#3474), then `e3a521ad60` (ui-components v0.4) and `5d4485ba07`. CatalogTagPlaceholder was replaced by CatalogTags (T-CAT-01). Card tests live in packages/rpc/test. |
| F6.28 (undescribed) host capacity / install_owner_required | `80438d385b` | SUPERSEDED | Built on `10ebdb683951` ✨ feat(backend): derive machine limits from detected host capacity (#3470), which is all Go backend and microsandbox. Its openapi `host.yaml` and failure codes served that backend, which `82b5490dbe` removed. |

Hunks not landed, with reasons: see the F6.16, F6.21, F6.23 and F6.26 rows. SCAFFOLD: none.
Each landed commit keeps its original subject and adds `Source: ~/smithers <id>` and Co-Authored-By.

### Sub-lane home-7 (DONE)




All 14 families are SUPERSEDED. Nothing landed: main carries each intent in another form, or main deleted the code on purpose. No pushes. Source repo: ~/smithers (read-only). Workspace sa-home-7 removed.

| Family | Newest head | Decision | Pushed main ids / evidence |
|---|---|---|---|
| F7.1 fix(cli): initialize required MCP without unrelated host services (#3473) | `9d34c2542b` (older `8e2d288e32` is a subset) | SUPERSEDED | The trigger was a Codex subscription seat that required `smthrs --mcp`. `70f632e205` (⏪ fix(codex): subscription seats call the model directly again, #3808) deleted that path and `CodexCode.ts`. #3473 closed 2026-10-16. Mini probe on main@origin `f94ad3048c`: `smthrs --mcp` answers initialize and tools/list in 3.06 s cold and 1.01 s warm (bound: 30 s). Not landed: the lazy-import refactor (CliConfig.ts, lazy NodeControl/Migrate/History imports, McpStartup and LazyControlAcquisition tests). It fixes a symptom main no longer shows, and Cli.ts, NodeControl.ts and ControlBridge.ts have been rewritten since. |
| F7.2 (undescribed) .specs/engineering/overview.md v0.4 | `6ef8a02b74` | SUPERSEDED | Main has v0.5 from `631d6632a9`, `ec280744fb` and `84d3255ee9` (10-03 spec rounds). `b97d3104b7` then marked it "Superseded on 2026-10-20 by apps/mvp/docs/rulings.md". |
| F7.3 (undescribed) ProductApi GitHub App setup types | `23830b2acb` (`6a3cd7ac07`, `5a39eeb80a`, `e648b58958` have the same hunk) | SUPERSEDED | Main's ProductApi.ts has `GitHubAppManifestStart`, `GitHubAppManifest`, `InstallSetupStatus` and `postApiInstallSetupApp`: the same endpoint under main's names. The spec and generator were removed in `82b5490dbe` (🔥 remove the legacy app, its Worker and the Go backend). The rest of the head is apps/app work, deleted by `82b5490dbe`. |
| F7.4 (undescribed) host status, install capacity, install_owner_required | `3ba6237ede` | SUPERSEDED | The Go install capacity, microsandbox host profile and `GET /host` were deleted in `82b5490dbe`. `354ce345f2` (🚀 feat(host): restore per-user launchd bundle commands, #3523) gave main's `smthrs host status` a new meaning: launchd, bundle and process health, through HostService.status. The `permission` fault is on main in CliError.ts. Not landed: `install_owner_required`, because no server produces it now. The mch-01 spike scripts are SCAFFOLD. |
| F7.5 (undescribed) TODO service: rpc Todo.ts, `/api/todos`, history todo | `9ad4699473` | SUPERSEDED | The Go `todo_service`, `/api/todos` and `todo_transition_refused` were deleted in `82b5490dbe`. Main's TODO contract is `0169619e59` (♻️ refactor(rpc): share the TODO commands' copy, grammar, routes and cards, #3446). That covers Mythical todos, TodoCommands.ts, `todo answer` and the Needs-you grouping in backend/History.ts. |
| F7.6 (undescribed) rpc card view models | `6851f25350` | SUPERSEDED | Landed as `a292b73283` (✨ feat(rpc): add card view-model contracts and action seam, #3474). `5d4485ba07` and `e3a521ad60` (#3601) refined it. Main keeps the tests in packages/rpc/test/cards/ instead of colocated, and docs/card-view-models.md is on main. CatalogTagPlaceholder.ts was temporary by design: CatalogTags.ts replaced it in `263c41d3d8`. |
| F7.7 (undescribed) TODO service, earlier copy | `f2231907b8` (older `6e3cbc98d2`) | SUPERSEDED | Older version of F7.5, same files minus CloudSession. Same evidence: `0169619e59` and `82b5490dbe`. |
| F7.8 (undescribed) `host status` → `GET /host` + BackendHostStatus.test | `879b69e3c3` | SUPERSEDED | Same as F7.4: `354ce345f2` and `82b5490dbe`. |
| F7.9 (undescribed) rpc MVP command catalog (catalog/Command.ts, commands/*, catalog.mvp.json, Appendix A/B/C tests) | `d69f001440` (older `ea329ccaed`, `665a7bba77`) | SUPERSEDED | The catalog landed in another form in `263c41d3d8` (🔀 land the frontrun integration on main as one commit). That form is rpc/CatalogTags.ts plus internal/backend/catalog.mvp.json, with `5d7463d8ef` (match the catalog to Appendix A), `5310e3b390` and `47dfd7e2a4` (#3434). `e3375f5f19` moved the Appendix B generator into apps/app, and `82b5490dbe` removed it with the legacy app. The head's descriptors target legacy app commands. |
| F7.10 (undescribed) on fix(agent): bind intrinsic read-only checkpoints (#3416) | `9c5e89b94c` (2 commits, with `2016162c38`) | SUPERSEDED | #3416 closed through main's own design: `513062ec45` (pin run checkpoints with host git on Linux), `7790e318f4` (pin in a sealed host's container) and `bdaff86a61` (🔒 fix(checkpoints): pin only into the repository the host opened, #3416). The CheckpointIndexTimestamp case (#3431) landed as `6ce0009cbd` and `4cf3879b2b`. Not landed: NativeSnapshotSpawner and NativeCheckpoints, an alternative design main did not take. |
| F7.11 fix(registry): preserve snapshot admission diagnostics (#3414, #3429) | `ff0f4bb5e9` | SUPERSEDED | Landed as `95d44390cd` (same subject). `8aa81f78d5` refined it: `indexMissing` is on main, and the scoped temporary became acquireRelease with reclaim. |
| F7.12 (undescribed) rpc MVP command catalog | `c71ff4ff02` | SUPERSEDED | Earlier copy of F7.9: `263c41d3d8`, `e3375f5f19`, `82b5490dbe`. |
| F7.13 (undescribed) rpc MVP command catalog | `230b43a5cc` (older `d09a8e1dcb`) | SUPERSEDED | Earlier copy of F7.9: same evidence. |
| F7.14 (undescribed) cuts: Cards.ts removals, cuts.json, Cuts.test.ts | `3d82b68e64` | SUPERSEDED | Main took the cuts as cuts.json plus retired tombstones: `263c41d3d8`, then `8172812db2` (🧹 reconcile cut qualification with retired card history, #3435), and kept the admin cards on purpose. Cuts.test.ts imports apps/app FlowName, which `82b5490dbe` deleted. The rest of the head (29k lines of apps/app deletions) went with `82b5490dbe`. |

#### Hunks not landed, with reasons

- F7.1: CliConfig.ts extraction, lazy imports in Cli.ts, ControlBridge.ts, HistoryCommands.ts and others, and the `@effect/platform-node` subpath imports. MCP cold start on main is 3 s against a 30 s bound, and the required-MCP Codex seat is gone (`70f632e205`).
- F7.4: `install_owner_required` failure code, `smthrs host` help text, and scripts/spikes/mch-01-memory (SCAFFOLD).
- F7.10: NativeSnapshotSpawner.ts and NativeCheckpoints.ts with their tests, and the ProcessSandbox tweak. Main settled #3416 with `bdaff86a61` and `513062ec45`.
- Every apps/app, apps/backend and packages/backend hunk: deleted by `82b5490dbe`.

### Sub-lane leftovers (DONE)




stranded-audit/leftovers, 2026-11-01. Two items that did not fit main, re-implemented and landed. Workspace sa-leftovers forgotten and deleted.

| Head | Name | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| `e72b2cbf` | builder/mobile-w8: `apps/mvp/tests/FullPageScreenshot.browser.test.ts` | LANDED (with a capture fix) | `79716581f0` 🐛 fix(mvp): end full-page captures on a recorded frame of the restored viewport. Mini: 12/12 loops of FullPageScreenshot + Recording + RecordingPaints + frames tests (35 tests each); `pnpm typecheck` 4/4 projects green; eslint has no findings (only "File ignored" warnings, e2e/ and tests/ are outside eslint.config.js). |
| `11354f162d` | ci-agent: 🧪 test(cli): measure human-wait budgets with a controlled clock | LANDED (re-implemented) | `73c00d52fe` (original subject). Mini: 22/22 passes (10 + 12), about 2 s each; main's real-wait version took 45978 ms. `vibelang -p tsconfig.test.json --noEmit` green, dprint clean. Mutation check: removing `- run.suspendedMillis` in Budget.ts fails it with `flows/agent/BudgetExceeded: The run has been running for 44000 ms of its 12000 ms budget`. |

#### 1. FullPageScreenshot: the real cause

Chromium's screencast, which Playwright records, sends a frame only when the compositor draws. A rAF acknowledgment (`painted()`) with nothing changed draws nothing. Probes on the mini (frames observed with `page.screencast.start({ onFrame })`):

- A full-page capture at 2330-2630 ms sent one frame inside the interval (2426 ms, the tall surface), then no frame until the next draw: the viewport screenshot at 3088 ms. Same in 3/3 runs. So the recording keeps the gray-margin picture past `capture.end` until the page next changes.
- A static page can send no frame before the first capture. In 4 of 8 runs the recording's first frame was a frame inside a capture, or the final screenshot (a 1 s video). Playwright starts the video at its first frame, so the gray frames moved to the start of the video, outside the excluded intervals. That produced both reported failures: `expected 2 to be greater than 3` and `expected 128 to be greater than 158`.
- A viewport `page.screenshot()` always drew a frame (11/11).

Fix: `fullPageScreenshot` ends each interval with `recordCurrentPicture(page)`, a viewport screenshot (`caret: "initial"`), before the final `painted()`. The recording then holds the restored page from inside the interval. The landed test pins the recording's first frame with `recordCurrentPicture` after `setContent` and keeps app-d's hold of ten sample slots. A second, deterministic test checks that each capture's last recorded frame shows the restored page at the right edge.

Red/green on the mini:

| Variant | Result |
| --- | --- |
| Neither fix, original test with hold | 9/10 pass; 1 fail `expected 128 to be greater than 158` |
| Deterministic test, capture fix removed | 0/6 pass |
| Deterministic test, with the fix | 6/6 pass |
| Full file plus recording tests, with the fix | 12/12 pass |

Not changed: the e2e fixtures (`fixtures.ts`, `mobile.spec.ts`, `devices.ts`) still assume the recording's first frame is `startedAt`. Real flows navigate right away, so their first frame is early. A static page that never draws before its first capture would still shift. This is recorded here; it is not in scope.

#### 2. Human-wait budget with a controlled clock

Why the stranded version timed out: it aged the pending delegation once, right after the answer. On current main the new host records a newer delegation (sequence 2) before it adopts the run. That delegation is stamped at the frozen time, so `now - requestedAtMs` never reaches `Ownership.heartbeatStaleAfter` (30 s) and `hostsPark` never adopts the run. Probe: seq 1 at +14001, seq 2 at +15001, then parked with no change for 5 s; after a jump of 31 s the run completed within 1 s.

Re-implementation: a scoped fiber, started after the answer commits, polls `runtime.pendingResumes` every 50 ms (real sleep). It moves the controlled clock to `requestedAtMs + heartbeatStaleAfter` for every pending delegation until none is left. That is parked time. The rest keeps the stranded intent: one second per provider response, a 13 s parked advance, both durable compositions, replay assertions and the 12 s ceiling. The diagnostic `failureFacts` returned `[]` on main's event payload, so I replaced it with `budgetRefusals`, which extracts `flows/agent/BudgetExceeded: …` lines from the failure. The mutation run above shows it working.

Not run: the linux-only `//packages/smithers:test` gate. The change is to one test file only; no src or coverage change.

#### Hunks not landed

- None from either item. Probe files (`tests/FullPageProbe.browser.test.ts`, `.probe-leftovers.sh`, `test/MainHumanWaitProbe.test.ts`) were mine, temporary, and deleted before commit: SCAFFOLD.

### Sub-lane evict (DONE)




| Head | Name | Decision | Pushed main ids / evidence |
| --- | --- | --- | --- |
| `e8a39377e9` | 🔒 fix(mvp): a refused person never sees issues the device still holds, and the device forgets them | LANDED (re-implemented) | `e6e1f71db8` on main, same subject, `Source: ~/smithers e8a39377e9`. The original patch failed 21 of 26 hunks; re-implemented on main's role-based access (decisions 0079, 0110). |
| `2bb993d7cb` | ✅ test(mvp): in a real browser, a refusal hides the issue the device still holds | BLOCKED | Its mechanism no longer applies on main: it revokes access with a shape `403` (`faults.shapes.refuse`), and decision 0110 makes transport refusals change availability only, never authority. A real-browser proof on main needs (1) a dev stack that syncs a public repository's issues through the GitHub App (`E2E_SYNCED_REPOSITORY`), which the Mac mini lacks (no App, no GitHub token: the original ran only on a workspace's own alchemy dev stage), and (2) a way to make ChatApi's role answer refuse that visitor mid-test (a repository going private), which no e2e fault switch provides. Unrun specs were not landed. The same behavior is proved on Node devices with real SQLite, ChatApi, Postgres and Electric (`issues.test.ts`, below). |

#### What landed in `e6e1f71db8`

- SDK `@smthrs/effect-electric` `ElectricCollection.evict` (`src/ElectricCollection.ts`, `src/internal/fence.ts`):
  ends Electric's sync session (requests aborted), truncates every row in one sync transaction (on the device with
  `persist`) that stores Electric's `reset` resume state, and starts a new session that syncs from `offset=-1` once its
  `ShapeSource` answers. Each session writes through a fence that closes when the next starts. A persisted collection
  nobody read yet evicts its stored rows. Docs (`docs/api.md`, `docs/sync-policy.md`), changeset, catalog
  (`docs/libraries.md`), regenerated `.smithers/target-index.json`.
- apps/mvp `IssuesStore` (`src/features/issues/store.ts`): each time authority comes to refuse the person
  (`sign_in`/`forbidden`), evict the repository's summaries, details, comments, sync and triage rows, and an opened
  issue's details and comments. Shapes wait at the authority gate and resync from the start on a re-grant. Log
  `issues.access.refused`, span `issues.access.evict`, counter `smithers_issue_access_evictions{status}`. Docs:
  `docs/features/issues.md`, `docs/observability.md`.
- Tests: `issues.test.ts` new "a refusal evicts what the device holds" (visitor's cached public issue; repository goes
  private; reload asks to sign in; stored rows 0); "loading" test now expects the cached issue evicted once session
  authority refuses. SDK: 4 evict tests and `fence.test.ts`.

#### Hunks not carried, with reasons

- `view.ts` `listProps` returning no issues on refusal, and `pageOf` refusal-first: main already has the page half
  (`pageOf`, decision 0094, 7c481b16c7/c4954e045c), and its screens return early on `list.refused`.
- "Shapes stay ended in that tab; `reconnect` does nothing": conflicts with main, where a re-granted reader must sync
  again (`src/features/issues/source.test.ts` "a public receipt releases them" failed with it). Replaced by a session
  restart. A first attempt answering a synthetic `409` made Electric mark the live handle expired and log stale-cache
  warnings; dropped.
- The subset-snapshot body read in `ElectricCollection.ts`: unrelated to eviction.
- A watcher program (`Persistence` lock) evicts only its own session; the stored rows go when the writer program evicts
  (documented).
- No decision record: the change follows decisions 0079, 0094 and 0110 and is easy to reverse.

#### Test evidence (Mac mini)

- `packages/effect-electric`: `pnpm check` 0, `eslint src examples` 0, `dprint check src docs test/fence.test.ts` 0,
  `vitest run` 12 files / 231 tests passed, coverage 100/100/100/100, no `[Electric]` warnings from the evict tests.
  Full `pnpm lint` fails on dprint import order in `test/fixtures.ts`, `test/ShapeProxy.test.ts` and
  `test/ElectricCollection.test.ts` import lines, all untouched by this change (pre-existing).
- `apps/mvp`: `pnpm typecheck` 0 (all four projects). `vitest run src/features/issues src/features/pulls`: 19 files /
  205 tests passed.
- `apps/mvp` full `vitest run src`: 3001 passed, 3 failed in 6 files (`boot.test.ts`, `agent/memory.test.ts`,
  `branch/creationFlows.test.ts`, `conversations/conversations.test.ts`, `views/agentViews.test.ts`,
  `views/steps.test.ts`). Source swap on plain main@origin `e1fdb6f0f2`: the same 6 files fail with the same 4
  assertions, so they are pre-existing.
- `pnpm docs:check` not run: the package docs are not mirrored to the site (no sync target found).

## w12-hold classification

Repository `/Users/williamcory/smithers-builders/w12-hold`, main `e1fdb6f0f2da`, judged against main@origin `e1fdb6f0f2da` on 2026-11-02T01:42:48.472Z.

Candidates: `((((~::main@origin & ~empty() & ~::remote_bookmarks(remote=origin)) ~ (::builder/effect-upgrade)) ~ (c611edaced1e312b97ab368a7ecb10a7471dfbf0 | cffe1a19ea044a72ae11814bcf917f57da713a29)) ~ (d7f78f322eb0ab30774567a7fb5da431e34cb67c | ce76b7db9d1e96b70af69af895ce3405ed6cce7c | a18463f362c961c69831241f875d73a83b7ec2d8 | ce573689e458a7f775031eb532c9c839a9f0a732 | 66c605c5dae59ce810b10368e52ecb4ca055d2d2 | a73f55bf60147d7f568b5e4c081b4bbbf78a12f1 | 9bf30b880faed3320c2c1b7f66ed5cb0c8431845 | 529136c596569247cdbce8c42b47a13cd092d67f)) ~ ((description(substring:"🧪 fix(cli): read and claim the takeover fixture under one writer") | description(substring:"🧪 fix(mvp): release the zombie probe FIFO as its owner") | description(substring:"🐛 fix(cli): share the engine memo map during native materialization") | description(substring:"🧪 fix(control): isolate PostgreSQL inventory fixtures") | description(substring:"📝 docs: regenerate Effect 4.1 API and reference artifacts") | description(substring:"🔎 chore(control): trace resume stages across host restart") | description(substring:"🧪 test(agent): exercise policy defaults and reader race failures") | description(substring:"🐛 fix(persistence): preserve stored schema fingerprints across union formatting changes") | description(substring:"📝 docs: record Effect 4.1 compatibility fixes and validation") | description(substring:"🔒 fix(control): redact Effect 4.1 protocol defects at serialization") | description(substring:"🧪 fix(cli): exercise terminal cleanup through native WebSocket transport") | description(substring:"🐛 fix(cli): preserve guided input under Effect terminal capability checks") | description(substring:"🐛 fix(database): classify native SQL acquisition defects as storage failures") | description(substring:"🧪 fix(agent): synchronize restart and quota tests with durable parks and I/O") | description(substring:"🧪 fix(electric): drain the response before checking completion records") | description(substring:"🧪 fix(database): test refused logins independently of local trust auth") | description(substring:"🐛 fix(patterns): commit per-item progress before continuing a round") | description(substring:"🧪 fix(docs): validate configured deployment routes offline") | description(substring:"🐛 fix(build): preserve WebSocket exports in private 4.1 adapters") | description(substring:"🐛 fix(home): send installation to its instructions") | description(substring:"📝 fix(docs): match the conversation command access policy") | description(substring:"📝 fix(docs): keep the published rc.16 quickstart on its Effect cohort") | description(substring:"🐛 fix(build): align Undici pins with the Effect 4.1 adapter") | description(substring:"🐛 fix(platform-node): mount tool packages beyond nested module scopes") | description(substring:"🧪 test(build-cli): install real fixture dependencies within confinement") | description(substring:"🧪 test(engine-store): await child and queue persistence on the real clock") | description(substring:"🧪 test(gateway): require strict framing and redacted decoder defects") | description(substring:"🐛 fix(control): preserve observed waits over unversioned approval history") | description(substring:"🧪 test(runtime): expose durable step and CLI startup failures") | description(substring:"🧪 test(platform-bun): require nonmutating jj snapshot probes") | description(substring:"🐛 fix(observability): normalize native SDK OTLP numbers before transport") | description(substring:"🐛 fix(plan): preserve schema identity bytes across Effect 4.1") | description(substring:"🧪 test(journal): observe SQL polling and renewal on the real clock") | description(substring:"🐛 fix(build-cli): preserve declared dependency reads in scratch runs") | description(substring:"🧪 test(targets): match the current repository pipeline") | description(substring:"🧪 test(flows): synchronize journal overflow with its persistence barrier") | description(substring:"🐛 fix(control): preserve trusted external schemes with absolute adapter URLs") | description(substring:"🐛 fix(capability): validate release grants and exclude refusal test sources") | description(substring:"🐛 fix(alchemy): migrate OAuth and host services to native crypto families") | description(substring:"🐛 fix(build-cli): tag the unrecorded affected-gates failure") | description(substring:"🐛 fix(build-cli): initialize the sealed result-cache tree in scratch runs") | description(substring:"🧪 test(model-host): exclude the hidden agents command from grants") | description(substring:"🧪 test(harness): give calibration integration tests real source provenance") | description(substring:"♻️ refactor(platform-node): remove superseded confinement branches") | description(substring:"🧪 test(agent): await terminal outcomes after cooldown wakes") | description(substring:"🧪 test(platform-node): exercise source edits after TypeScript erasure") | description(substring:"🧪 test(platform-node): wait for explicit lifecycle receipts") | description(substring:"🐛 fix(observability): classify retry and flow-realm refusals") | description(substring:"🐛 fix(engine-store): restore current and legacy serialized failure exits") | description(substring:"🔒 fix(process): keep redacted words out of native spawn errors") | description(substring:"🐛 fix(database): surface migration failures through the typed channel") | description(substring:"🐛 fix(platform-browser): keep receipt reconciliation failures typed") | description(substring:"🐛 fix(process): preserve prototype-named environment entries in Effect 4.1") | description(substring:"🐛 fix(process): reject shell arguments consistently with Effect 4.1") | description(substring:"🐛 fix(process): preserve both halves of additional descriptors") | description(substring:"🐛 fix(lint): validate Vibe-only examples through the compiler") | description(substring:"🐛 fix(sql): narrow SQL insert batches for Effect 4.1") | description(substring:"🐛 fix(receipts): retain original keys for native key enumeration") | description(substring:"🐛 fix(http): preserve extension methods when rebuilding requests") | description(substring:"🐛 fix(socket): retain the ws transport through Effect NodeWS") | description(substring:"🐛 fix(process): preserve redacted arguments until host execution") | description(substring:"🐛 fix(crypto): use Effect digest and secure random families") | description(substring:"🐛 fix(filesystem): supply guarded directory entries for Effect 4.1") | description(substring:"🐛 fix(filesystem): implement Effect no-follow metadata reads") | description(substring:"🐛 fix(platform-browser): identify the SQLite WASM SQL driver") | description(substring:"🐛 fix(database): adopt Effect scoped transaction acquisition") | description(substring:"⬆️ chore(deps): pin the Effect cohort to 4.1.0")) & committer_date(after:"2026-10-29"))`.

| Class | Commits |
|---|---|
| EMPTY-ISH | 4 |
| ON-MAIN | 291 |
| PARTIAL | 132 |
| SCAFFOLD | 2 |
| STRANDED | 3 |
| SUPERSEDED | 212 |

### Heads

Net: the head against its fork point with main: hunks on main / superseded / missing / partial, and missing lines.

| Head | Bookmark / working copy | Commits | Classes | Net on/superseded/missing/partial (lines) | Missing files |
|---|---|---|---|---|---|
| `51b4598687` | cfg-build@ | 11 | SUPERSEDED 5, ON-MAIN 5, PARTIAL 1 | 118/5/2/3 (16) | apps/mvp/docs/decisions/0128-gates-on-cloudflare-job-machines.md (11), apps/mvp/docs/rulings.md (1), apps/mvp/docs/work/cf-gates.md (2), apps/mvp/worker/BranchSandboxes.ts (1) |
| `60fb9113b5` | ci-agent@ | 61 | SUPERSEDED 30, ON-MAIN 29, PARTIAL 2 | 271/20/5/10 (128) | packages/smithers/agent/harness/src/internal/RealmFlowBundle.ts (1), packages/smithers/agent/model-host/test/HostTools.test.ts (1), packages/smithers/agent/test/Agent.test.ts (50), packages/smithers/a |
| `9dae978249` |  | 14 | ON-MAIN 7, SUPERSEDED 5, PARTIAL 2 | 120/0/2/2 (50) | apps/mvp/worker/RepoApi.test.ts (2), apps/mvp/worker/test/harness.ts (1), apps/mvp/worker/test/reset.test.ts (42), apps/mvp/worker/test/reset.ts (5) |
| `801ae69887` |  | 23 | ON-MAIN 16, SUPERSEDED 5, PARTIAL 2 | 227/4/2/2 (50) | apps/mvp/worker/RepoApi.test.ts (2), apps/mvp/worker/test/harness.ts (1), apps/mvp/worker/test/reset.test.ts (42), apps/mvp/worker/test/reset.ts (5) |
| `79b7a879cd` | builder/ci-shard | 3 | ON-MAIN 2, PARTIAL 1 | 96/0/0/1 (1) | .smithers/flows/release/pack-release.test.mjs (1) |
| `9445aa0c85` | builder/ci-flows2 | 4 | ON-MAIN 4 | 0/0/0/0 (0) |  |
| `4ed2c81157` | builder/bb6-cli | 28 | SUPERSEDED 9, ON-MAIN 19 | 0/0/0/0 (0) |  |
| `3033b230f6` | builder/drift-helper | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `d2b355bf5e` |  | 43 | SUPERSEDED 10, ON-MAIN 29, PARTIAL 3, EMPTY-ISH 1 | 219/5/3/3 (12) | .github/workflows/ci.yml (2), PACKAGE.ts (5), packages/smithers/build/targets/src/GithubCiGen.ts (4), packages/smithers/flows/platform-browser/package.json (1) |
| `3cdca413c0` | builder/ci-release | 24 | ON-MAIN 20, SUPERSEDED 3, PARTIAL 1 | 88/1/6/6 (39) | .smithers/flows/release/check-npm-dedupe.mjs (14), .smithers/flows/release/pack-release.mjs (10), .smithers/flows/release/pack-release.test.mjs (10), .smithers/flows/release/release-graph.test.mjs (3) |
| `c1d2717c45` | builder/ci-ui | 14 | ON-MAIN 12, SUPERSEDED 1, PARTIAL 1 | 65/4/7/1 (9) | .changeset/ci-playwright-toolchain.md (1), .github/workflows/ci.yml (2), PACKAGE.ts (2), packages/smithers/build/targets/src/GithubCiGen.ts (2) |
| `d16b924d3c` | builder/ci-drift | 6 | SUPERSEDED 3, ON-MAIN 3 | 0/0/0/0 (0) |  |
| `6447f92bba` | builder/ci-flows | 18 | ON-MAIN 13, SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `0b4ecc8849` | builder/ci-build | 7 | ON-MAIN 3, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `adb4c688e3` | builder/ci-repo | 11 | ON-MAIN 7, SUPERSEDED 2, EMPTY-ISH 1, PARTIAL 1 | 47/2/1/0 (1) | packages/smithers/flows/platform-browser/package.json (1) |
| `32db9cc7f2` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1423db6ecc` |  | 6 | PARTIAL 2, ON-MAIN 4 | 202/1/2/0 (2) | .smithers/flows/release/fixtures/public-api-baseline.json (1), packages/smithers/flows/engine-store/test/CycleDetectionSql.test.ts (1) |
| `c0347a9c39` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c499102e10` |  | 3 | ON-MAIN 1, PARTIAL 1, SUPERSEDED 1 | 56/2/1/3 (10) | apps/mvp/docs/work/w17-private.md (7), apps/mvp/src/features/chat/engineAvailability.test.ts (1), apps/mvp/src/screens/branch/BranchScreen.tsx (2) |
| `e4b126616a` | builder/w17-private | 1 | PARTIAL 1 | 31/1/1/3 (10) | apps/mvp/docs/work/w17-private.md (7), apps/mvp/src/features/chat/engineAvailability.test.ts (1), apps/mvp/src/screens/branch/BranchScreen.tsx (2) |
| `aa86bdc1ff` | builder/w17-ui | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cc87e618b5` |  | 3 | SUPERSEDED 1, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `a33f7fcaea` | builder/auth | 16 | ON-MAIN 1, SUPERSEDED 6, PARTIAL 8, SCAFFOLD 1 | 383/16/0/2 (3) | apps/mvp/worker/Answers.ts (2), apps/mvp/worker/RepoApi.ts (1) |
| `2bf9537d13` | lander/w8mig-held | 30 | EMPTY-ISH 1, PARTIAL 29 | 33/0/1714/522 (119259) | .smithers/coding-project.json (3), .smithers/flows/coding/command-receipts.ts (1), .smithers/flows/coding/steering.ts (2), .smithers/flows/package.json (1) |
| `9d424aa53e` |  | 30 | EMPTY-ISH 1, PARTIAL 29 | 33/0/1714/522 (119259) | .smithers/coding-project.json (3), .smithers/flows/coding/command-receipts.ts (1), .smithers/flows/coding/steering.ts (2), .smithers/flows/package.json (1) |
| `321ccd7c31` |  | 12 | SCAFFOLD 2, PARTIAL 7, SUPERSEDED 3 | 314/14/154/18 (1954) | .changeset/confirmed-machine-ownership.md (1), apps/mvp/db/Database.test.ts (25), apps/mvp/db/Database.ts (6), apps/mvp/db/migrations/0072_sandbox_daily_limit.ts (14) |
| `1ba8d1efde` | builder/toasts2 | 23 | STRANDED 3, PARTIAL 18, ON-MAIN 2 | 9/0/169/18 (2429) | apps/mvp/docs/decisions/0121-operation-progress.md (27), apps/mvp/docs/features/issues.md (2), apps/mvp/docs/features/notifications.md (8), apps/mvp/docs/features/todos.md (9) |
| `f02a185170` |  | 4 | PARTIAL 4 | 9/0/169/18 (2428) | apps/mvp/docs/decisions/0121-operation-progress.md (27), apps/mvp/docs/features/issues.md (2), apps/mvp/docs/features/notifications.md (8), apps/mvp/docs/features/todos.md (9) |
| `62d8a6f3ce` |  | 20 | PARTIAL 7, SUPERSEDED 8, ON-MAIN 5 | 343/15/115/13 (876) | apps/mvp/db/Database.test.ts (17), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0072_sandbox_daily_limit.ts (14), apps/mvp/docs/decisions/0122-who-may-ask.md (62) |
| `4bbb57c3f9` | builder/w15-webkit | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `86f688d42c` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `618f8d2383` |  | 22 | PARTIAL 3, SUPERSEDED 8, ON-MAIN 11 | 95/7/76/27 (1196) | apps/mvp/docs/decisions/0121-operation-progress.md (10), apps/mvp/docs/features/notifications.md (2), apps/mvp/docs/features/todos.md (5), apps/mvp/docs/work/w13-toasts.md (12) |
| `650117a1db` | builder/who-may-ask | 10 | PARTIAL 6, ON-MAIN 1, SUPERSEDED 3 | 274/13/115/13 (876) | apps/mvp/db/Database.test.ts (17), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0072_sandbox_daily_limit.ts (14), apps/mvp/docs/decisions/0122-who-may-ask.md (62) |
| `55d2437b03` |  | 3 | PARTIAL 1, ON-MAIN 1, SUPERSEDED 1 | 47/5/2/1 (15) | apps/mvp/e2e/flow-editor-storage.spec.ts (12), apps/mvp/e2e/repo-browse.spec.ts (3) |
| `dab3fbbb2c` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `bf9dcdee57` |  | 3 | SUPERSEDED 1, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `39d8ecdc5b` |  | 16 | ON-MAIN 5, SUPERSEDED 9, PARTIAL 2 | 73/81/1/0 (2) | apps/site/package.json (2) |
| `e72b2cbf43` | builder/mobile-w8 | 1 | PARTIAL 1 | 16/1/2/2 (6) | apps/mvp/e2e/fullPageScreenshot.ts (3), apps/mvp/e2e/mobile-baseline.ts (2), apps/mvp/tests/fixtures/mobile-layout.tsx (1) |
| `a80b82ce4b` | builder/bb5-app | 13 | PARTIAL 3, SUPERSEDED 7, ON-MAIN 3 | 402/40/1/3 (4) | apps/mvp/src/features/commands/commands.test.ts (1), apps/mvp/src/features/commands/commands.ts (1), apps/mvp/worker/index.ts (1), apps/site/package.json (1) |
| `d1d3cc9af8` | builder/w12-followups | 1 | PARTIAL 1 | 64/12/3/1 (4) | apps/mvp/src/features/commands/commands.test.ts (2), apps/mvp/src/features/commands/commands.ts (2) |
| `64c69c1597` | builder/bb4-docs | 39 | ON-MAIN 23, PARTIAL 3, SUPERSEDED 13 | 151/4/2/5 (27) | apps/site/package.json (2), apps/site/public/docs/reference/cli.md (3), apps/site/public/llms-full.txt (3), apps/site/src/content/docs/docs/reference/cli.md (3) |
| `717f550e01` | builder/bb4-app2 | 11 | PARTIAL 6, ON-MAIN 2, SUPERSEDED 3 | 49/4/44/13 (390) | apps/mvp/docs/features/issues.md (1), apps/mvp/docs/features/notifications.md (3), apps/mvp/docs/features/todos.md (1), apps/mvp/docs/work/bugbash4-app2.md (20) |
| `36145de11d` | builder/bb3-cli | 10 | ON-MAIN 8, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `9bd3469684` | builder/bb2-webkit | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `30798c67e1` | builder/bb4-views | 5 | SUPERSEDED 3, PARTIAL 2 | 57/4/1/2 (5) | apps/mvp/e2e/minimum-font.spec.ts (2), apps/mvp/src/features/runs/graph.ts (1), packages/smithers/ui/src/flow-graph/FlowGraph.tsx (2) |
| `9a64fd80d6` |  | 3 | ON-MAIN 2, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `918b603ad2` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `84b10cb9b0` |  | 6 | ON-MAIN 5, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `938a8c940e` |  | 4 | ON-MAIN 3, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2996dbbfcc` |  | 5 | ON-MAIN 4, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a36bf79263` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a91b10af06` |  | 8 | SUPERSEDED 6, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `881ce02e3d` |  | 11 | SUPERSEDED 6, ON-MAIN 5 | 0/0/0/0 (0) |  |
| `3ce9d3ae4b` |  | 5 | SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `0be3bde878` |  | 5 | ON-MAIN 3, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `45a19eaed2` |  | 13 | ON-MAIN 5, SUPERSEDED 8 | 0/0/0/0 (0) |  |
| `2fb3fbb2f9` |  | 17 | ON-MAIN 6, SUPERSEDED 11 | 0/0/0/0 (0) |  |
| `1570cd8ccd` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `64738e065c` |  | 7 | ON-MAIN 2, SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `24bbdd43fd` |  | 10 | ON-MAIN 2, SUPERSEDED 8 | 0/0/0/0 (0) |  |
| `3760d55952` |  | 8 | ON-MAIN 6, SUPERSEDED 2 | 0/0/0/0 (0) |  |

### Live workspaces skipped

| Workspace | Directory | Why |
|---|---|---|
| land-effect | `/Users/williamcory/smithers-builders/ws-land-effect` | edited .changeset/crypto-uuid-v5.md |
| mx-held | `/Users/williamcory/smithers-builders/ws-mx-held` | edited .git-blame-ignore-revs |
| 8 commits | `` | committed in the last 6 hours |

### Commits

| Authored | Commit | Class | Hunks on/superseded/missing/partial | Stack | Subject | Evidence or gap |
|---|---|---|---|---|---|---|
| 2026-10-21 22:45 | `2573fcc888` | PARTIAL | 11/0/67/4 | lander/w8mig-held | ♻️ refactor(capability): @smthrs/capability is written in VibeLang | packages/smithers/flows/capability/PACKAGE.ts: "src/internal/PatternResource.vibe"; packages/smithers/flows/capability/PACKAGE.ts: paths: ["src/evaluate.ts", "src/Rule.vibe", "src/RuleEffect.vibe", "src/internal |
| 2026-10-21 22:45 | `096c7bf740` | PARTIAL | 11/0/67/4 | 9d424aa53e | ♻️ refactor(capability): @smthrs/capability is written in VibeLang | packages/smithers/flows/capability/PACKAGE.ts: "src/internal/PatternResource.vibe"; packages/smithers/flows/capability/PACKAGE.ts: paths: ["src/evaluate.ts", "src/Rule.vibe", "src/RuleEffect.vibe", "src/internal |
| 2026-10-21 22:52 | `365e177627` | PARTIAL | 1/0/8/1 | lander/w8mig-held | ♻️ refactor(canonical): @smthrs/canonical is written in VibeLang | packages/smithers/flows/canonical/PACKAGE.ts: const sources = Input.glob("{src,examples}/**/*.{ts,vibe}"); packages/smithers/flows/canonical/PACKAGE.ts: paths: ["src/internal/canonicalize.ts", "src/Canonical.vibe", "src/ |
| 2026-10-21 22:52 | `071fe16954` | PARTIAL | 1/0/8/1 | 9d424aa53e | ♻️ refactor(canonical): @smthrs/canonical is written in VibeLang | packages/smithers/flows/canonical/PACKAGE.ts: const sources = Input.glob("{src,examples}/**/*.{ts,vibe}"); packages/smithers/flows/canonical/PACKAGE.ts: paths: ["src/internal/canonicalize.ts", "src/Canonical.vibe", "src/ |
| 2026-10-21 23:02 | `2c0711c847` | PARTIAL | 2/0/15/2 | lander/w8mig-held | ♻️ refactor(crypto): @smthrs/crypto is written in VibeLang | packages/smithers/flows/crypto/PACKAGE.ts: paths: ["src/Sha256.vibe"]; packages/smithers/flows/crypto/PACKAGE.ts: paths: ["src/Sha256.vibe"] |
| 2026-10-21 23:02 | `1d1bc1daf4` | PARTIAL | 2/0/15/2 | 9d424aa53e | ♻️ refactor(crypto): @smthrs/crypto is written in VibeLang | packages/smithers/flows/crypto/PACKAGE.ts: paths: ["src/Sha256.vibe"]; packages/smithers/flows/crypto/PACKAGE.ts: paths: ["src/Sha256.vibe"] |
| 2026-10-22 00:29 | `2a2eda6019` | PARTIAL | 0/0/28/6 | lander/w8mig-held | ♻️ refactor(jj): @smthrs/jj is written in VibeLang | packages/smithers/flows/jj/PACKAGE.ts: tests: Smithers.glob("test/**/*.test.{ts,vibe}", { exclude: ["test/faults/**"] }; packages/smithers/flows/jj/PACKAGE.ts: paths: ["src/node/NodeJj.ts", "src/browser/BrowserJj.vibe"] |
| 2026-10-22 00:29 | `52048dca28` | PARTIAL | 0/0/28/6 | 9d424aa53e | ♻️ refactor(jj): @smthrs/jj is written in VibeLang | packages/smithers/flows/jj/PACKAGE.ts: tests: Smithers.glob("test/**/*.test.{ts,vibe}", { exclude: ["test/faults/**"] }; packages/smithers/flows/jj/PACKAGE.ts: paths: ["src/node/NodeJj.ts", "src/browser/BrowserJj.vibe"] |
| 2026-10-23 22:05 | `0173323a1d` | PARTIAL | 4/0/37/2 | lander/w8mig-held | ♻️ refactor(secrets): @smthrs/secrets is written in VibeLang | packages/smithers/flows/secrets/PACKAGE.ts: sources: Input.glob("src/**/*.{ts,vibe}"),; packages/smithers/flows/secrets/PACKAGE.ts: paths: ["src/Egress.vibe", "src/Binding.vibe"] |
| 2026-10-23 22:05 | `19f5ab8784` | PARTIAL | 4/0/37/2 | 9d424aa53e | ♻️ refactor(secrets): @smthrs/secrets is written in VibeLang | packages/smithers/flows/secrets/PACKAGE.ts: sources: Input.glob("src/**/*.{ts,vibe}"),; packages/smithers/flows/secrets/PACKAGE.ts: paths: ["src/Egress.vibe", "src/Binding.vibe"] |
| 2026-10-23 22:25 | `5770ab83c0` | PARTIAL | 2/0/18/2 | lander/w8mig-held | ♻️ refactor(keys): @smthrs/keys is written in VibeLang | packages/smithers/flows/keys/PACKAGE.ts: sources: Input.glob("{src,examples}/**/*.{ts,vibe}"); packages/smithers/flows/keys/PACKAGE.ts: paths: ["src/deriveKey.vibe", "src/DerivedKey.vibe", "src/KeyDerivationError.ts" |
| 2026-10-23 22:25 | `074eaaef34` | PARTIAL | 2/0/18/2 | 9d424aa53e | ♻️ refactor(keys): @smthrs/keys is written in VibeLang | packages/smithers/flows/keys/PACKAGE.ts: sources: Input.glob("{src,examples}/**/*.{ts,vibe}"); packages/smithers/flows/keys/PACKAGE.ts: paths: ["src/deriveKey.vibe", "src/DerivedKey.vibe", "src/KeyDerivationError.ts" |
| 2026-10-23 22:43 | `4bb4ec5bb8` | PARTIAL | 5/0/121/14 | lander/w8mig-held | ♻️ refactor(plan): @smthrs/plan is written in VibeLang | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/StepKey.vibe", "src/KeyMaterial.vibe", "src/internal/JsonMirror.ts"; packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/Node.ts", "src/internal/node.vibe"] |
| 2026-10-23 22:43 | `b56da8aceb` | PARTIAL | 5/0/121/14 | 9d424aa53e | ♻️ refactor(plan): @smthrs/plan is written in VibeLang | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/StepKey.vibe", "src/KeyMaterial.vibe", "src/internal/JsonMirror.ts"; packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/Node.ts", "src/internal/node.vibe"] |
| 2026-10-23 22:45 | `fcfd8d3bff` | PARTIAL | 7/0/79/9 | lander/w8mig-held | ♻️ refactor(database): @smthrs/database is written in VibeLang | .smithers/flows/test/coding-steering.test.ts: import * as DurableWriter from "../../../packages/smithers/flows/database/src/Du; packages/smithers/flows/database/PACKAGE.ts: tests: Smithers.glob("test/**/*.test.{ts,vibe}" |
| 2026-10-23 22:45 | `c161ceb385` | PARTIAL | 7/0/79/9 | 9d424aa53e | ♻️ refactor(database): @smthrs/database is written in VibeLang | .smithers/flows/test/coding-steering.test.ts: import * as DurableWriter from "../../../packages/smithers/flows/database/src/Du; packages/smithers/flows/database/PACKAGE.ts: tests: Smithers.glob("test/**/*.test.{ts,vibe}" |
| 2026-10-23 22:55 | `05fcb2725b` | PARTIAL | 8/0/109/11 | lander/w8mig-held | ♻️ refactor(observability): @smthrs/observability is written in VibeLang | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Endpoint.vibe", "src/Otlp.ts", "src/NodeOtel.vibe"]; packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Otlp.ts", "src/Endpoint.vibe", "src/Resou |
| 2026-10-23 22:55 | `537a107b5d` | PARTIAL | 8/0/109/11 | 9d424aa53e | ♻️ refactor(observability): @smthrs/observability is written in VibeLang | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Endpoint.vibe", "src/Otlp.ts", "src/NodeOtel.vibe"]; packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Otlp.ts", "src/Endpoint.vibe", "src/Resou |
| 2026-10-23 23:00 | `3dc4b2fcb2` | PARTIAL | 4/0/26/6 | lander/w8mig-held | ♻️ refactor(plan-store): @smthrs/plan-store is written in VibeLang | packages/smithers/flows/plan-store/PACKAGE.ts: paths: ["src/PlanStore.vibe"]; packages/smithers/flows/plan-store/PACKAGE.ts: paths: ["src/PlanStore.vibe"] |
| 2026-10-23 23:00 | `8986d3e1bb` | PARTIAL | 4/0/26/6 | 9d424aa53e | ♻️ refactor(plan-store): @smthrs/plan-store is written in VibeLang | packages/smithers/flows/plan-store/PACKAGE.ts: paths: ["src/PlanStore.vibe"]; packages/smithers/flows/plan-store/PACKAGE.ts: paths: ["src/PlanStore.vibe"] |
| 2026-10-23 23:10 | `cf790665a4` | PARTIAL | 2/0/79/6 | lander/w8mig-held | ♻️ refactor(step-cache): @smthrs/step-cache is written in VibeLang | .smithers/flows/test/coding-vibe-landing.test.ts: import * as CacheStore from "../../../packages/smithers/flows/step-cache/src/Cac; .smithers/flows/test/todo-conflict.test.ts: import * as CacheStore from "../../../packag |
| 2026-10-23 23:10 | `974d62d21d` | PARTIAL | 2/0/79/6 | 9d424aa53e | ♻️ refactor(step-cache): @smthrs/step-cache is written in VibeLang | .smithers/flows/test/coding-vibe-landing.test.ts: import * as CacheStore from "../../../packages/smithers/flows/step-cache/src/Cac; .smithers/flows/test/todo-conflict.test.ts: import * as CacheStore from "../../../packag |
| 2026-10-23 23:35 | `4c50696630` | PARTIAL | 1/0/78/13 | lander/w8mig-held | ♻️ refactor(artifacts): @smthrs/artifacts is written in VibeLang | packages/smithers/flows/artifacts/PACKAGE.ts: * which packages are in it. It runs after `lib`, as the Node suite does: its; packages/smithers/flows/artifacts/PACKAGE.ts: "src/FileSystemArtifactStore.vibe", |
| 2026-10-23 23:35 | `85d792112e` | PARTIAL | 1/0/78/13 | 9d424aa53e | ♻️ refactor(artifacts): @smthrs/artifacts is written in VibeLang | packages/smithers/flows/artifacts/PACKAGE.ts: * which packages are in it. It runs after `lib`, as the Node suite does: its; packages/smithers/flows/artifacts/PACKAGE.ts: "src/FileSystemArtifactStore.vibe", |
| 2026-10-23 23:57 | `bcaec730eb` | PARTIAL | 3/0/111/12 | lander/w8mig-held | ♻️ refactor(notifications): @smthrs/notifications is written in VibeLang | .smithers/flows/coding/steering.ts: import * as NotificationEvent from "../../../packages/smithers/notifications/src; .smithers/flows/test/coding-steering.test.ts: import * as NotificationEvent from "../../../packages/sm |
| 2026-10-23 23:57 | `ed10267055` | PARTIAL | 3/0/111/12 | 9d424aa53e | ♻️ refactor(notifications): @smthrs/notifications is written in VibeLang | .smithers/flows/coding/steering.ts: import * as NotificationEvent from "../../../packages/smithers/notifications/src; .smithers/flows/test/coding-steering.test.ts: import * as NotificationEvent from "../../../packages/sm |
| 2026-10-24 00:05 | `27dee37c55` | PARTIAL | 3/0/51/25 | lander/w8mig-held | ♻️ refactor(build): @smthrs/build is written in VibeLang | packages/smithers/build/PACKAGE.ts: sources: Smithers.glob("{src,examples}/**/*.{ts,vibe}"),; packages/smithers/build/PACKAGE.ts: Smithers.glob("examples/**/*.{ts,vibe}"), |
| 2026-10-24 00:05 | `ca178a2eec` | PARTIAL | 3/0/51/25 | 9d424aa53e | ♻️ refactor(build): @smthrs/build is written in VibeLang | packages/smithers/build/PACKAGE.ts: sources: Smithers.glob("{src,examples}/**/*.{ts,vibe}"),; packages/smithers/build/PACKAGE.ts: Smithers.glob("examples/**/*.{ts,vibe}"), |
| 2026-10-24 00:31 | `45fa413b4d` | PARTIAL | 1/0/99/60 | lander/w8mig-held | ♻️ refactor(time-travel): @smthrs/time-travel is written in VibeLang | packages/smithers/flows/time-travel/PACKAGE.ts: "src/internal/Lease.vibe",; packages/smithers/flows/time-travel/PACKAGE.ts: paths: ["src/internal/Recovery.ts", "src/internal/Lease.vibe", "src/internal/Run |
| 2026-10-24 00:31 | `058a6d5713` | PARTIAL | 1/0/99/60 | 9d424aa53e | ♻️ refactor(time-travel): @smthrs/time-travel is written in VibeLang | packages/smithers/flows/time-travel/PACKAGE.ts: "src/internal/Lease.vibe",; packages/smithers/flows/time-travel/PACKAGE.ts: paths: ["src/internal/Recovery.ts", "src/internal/Lease.vibe", "src/internal/Run |
| 2026-10-24 01:29 | `de609431a8` | PARTIAL | 1/0/51/35 | lander/w8mig-held | ♻️ refactor(run-store): @smthrs/run-store is written in VibeLang | packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/Ownership.vibe"]; packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/Heartbeat.ts", "src/Ownership.vibe"] |
| 2026-10-24 01:29 | `bcf7e4727c` | PARTIAL | 1/0/51/35 | 9d424aa53e | ♻️ refactor(run-store): @smthrs/run-store is written in VibeLang | packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/Ownership.vibe"]; packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/Heartbeat.ts", "src/Ownership.vibe"] |
| 2026-10-24 01:37 | `44a3b7303c` | PARTIAL | 3/0/137/83 | lander/w8mig-held | ♻️ refactor(sync): @smthrs/sync is written in VibeLang | apps/site/PACKAGE.ts: Smithers.file("//packages/smithers/flows/sync/src/SyncProtocol.vibe"),; packages/smithers/flows/sync/PACKAGE.ts: testSources: Smithers.glob("{test,examples}/**/*.{ts,vibe}") |
| 2026-10-24 01:37 | `24a1c089cf` | PARTIAL | 3/0/137/83 | 9d424aa53e | ♻️ refactor(sync): @smthrs/sync is written in VibeLang | apps/site/PACKAGE.ts: Smithers.file("//packages/smithers/flows/sync/src/SyncProtocol.vibe"),; packages/smithers/flows/sync/PACKAGE.ts: testSources: Smithers.glob("{test,examples}/**/*.{ts,vibe}") |
| 2026-10-24 01:38 | `c371c44e2c` | PARTIAL | 4/0/254/41 | lander/w8mig-held | ♻️ refactor(targets): @smthrs/targets is written in VibeLang | .smithers/flows/release/fixtures/public-api-baseline.json: "InMemoryWorkspaceSandbox.d.ts": "449a2d4ed4f8068cc9d816621ba6ae8882dbd772995e98; .smithers/flows/release/fixtures/public-api-baseline.json: "SeatResolver.d.ts": |
| 2026-10-24 01:38 | `7012bf4b7b` | PARTIAL | 4/0/254/41 | 9d424aa53e | ♻️ refactor(targets): @smthrs/targets is written in VibeLang | .smithers/flows/release/fixtures/public-api-baseline.json: "InMemoryWorkspaceSandbox.d.ts": "449a2d4ed4f8068cc9d816621ba6ae8882dbd772995e98; .smithers/flows/release/fixtures/public-api-baseline.json: "SeatResolver.d.ts": |
| 2026-10-24 02:34 | `482b8d85ed` | PARTIAL | 12/0/235/5 | lander/w8mig-held | ♻️ refactor(control): @smthrs/control is written in VibeLang | .smithers/coding-project.json: "packages/smithers/control/src/Monitor.vibe"; .smithers/coding-project.json: "packages/smithers/control/src/Monitor.vibe": [ |
| 2026-10-24 02:34 | `7d65a14cdb` | PARTIAL | 12/0/235/5 | 9d424aa53e | ♻️ refactor(control): @smthrs/control is written in VibeLang | .smithers/coding-project.json: "packages/smithers/control/src/Monitor.vibe"; .smithers/coding-project.json: "packages/smithers/control/src/Monitor.vibe": [ |
| 2026-10-24 03:06 | `2e0fa82161` | PARTIAL | 1/0/18/1 | lander/w8mig-held | ♻️ refactor(platform-bun): @smthrs/platform-bun is written in VibeLang | .smithers/coding-project.json: "packages/smithers/flows/platform-bun/src/BunRuntime.vibe",; packages/smithers/flows/platform-bun/package.json: "src/**/*.vibe", |
| 2026-10-24 03:06 | `6ec37d61b0` | PARTIAL | 1/0/18/1 | 9d424aa53e | ♻️ refactor(platform-bun): @smthrs/platform-bun is written in VibeLang | .smithers/coding-project.json: "packages/smithers/flows/platform-bun/src/BunRuntime.vibe",; packages/smithers/flows/platform-bun/package.json: "src/**/*.vibe", |
| 2026-10-24 03:16 | `1a6536e69c` | PARTIAL | 9/0/151/21 | lander/w8mig-held | ♻️ refactor(platform-node): @smthrs/platform-node is written in VibeLang | .smithers/flows/test/coding-planning-authority.test.ts: import * as ProcessConfinement from "../../../packages/smithers/flows/platform-n; apps/mvp/docs/work/vibelang-w11-platform-node.md: title: Retain W11 native host re |
| 2026-10-24 03:16 | `87a5d7de7f` | PARTIAL | 9/0/151/21 | 9d424aa53e | ♻️ refactor(platform-node): @smthrs/platform-node is written in VibeLang | .smithers/flows/test/coding-planning-authority.test.ts: import * as ProcessConfinement from "../../../packages/smithers/flows/platform-n; apps/mvp/docs/work/vibelang-w11-platform-node.md: title: Retain W11 native host re |
| 2026-10-24 16:19 | `dd114e660f` | PARTIAL | 8/0/143/10 | lander/w8mig-held | ♻️ refactor(triggers): @smthrs/triggers is written in VibeLang | packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Webhook.vibe", "src/Channel.ts"]; packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Webhook.vibe", "src/TriggerError.vibe"] |
| 2026-10-24 16:19 | `c421d08c51` | PARTIAL | 8/0/143/10 | 9d424aa53e | ♻️ refactor(triggers): @smthrs/triggers is written in VibeLang | packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Webhook.vibe", "src/Channel.ts"]; packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Webhook.vibe", "src/TriggerError.vibe"] |
| 2026-10-24 16:25 | `40bbf12c93` | PARTIAL | 0/0/92/33 | lander/w8mig-held | ♻️ refactor(testing): @smthrs/testing is written in VibeLang | .smithers/flows/test/coding-builtin-routes.test.ts: import * as FlowInvoker from "../../../packages/smithers/agent/fs/src/FlowInvoke; packages/testing/PACKAGE.ts: testSources: Smithers.glob("{test,examples}/**/*.{ts,vibe |
| 2026-10-24 16:25 | `8465f4fec3` | PARTIAL | 0/0/92/33 | 9d424aa53e | ♻️ refactor(testing): @smthrs/testing is written in VibeLang | .smithers/flows/test/coding-builtin-routes.test.ts: import * as FlowInvoker from "../../../packages/smithers/agent/fs/src/FlowInvoke; packages/testing/PACKAGE.ts: testSources: Smithers.glob("{test,examples}/**/*.{ts,vibe |
| 2026-10-24 16:27 | `82b0e67070` | PARTIAL | 1/0/86/15 | lander/w8mig-held | ♻️ refactor(build-cli): @smthrs/build-cli's Effect modules are written in VibeLang | apps/mvp/docs/rules.md: The Jev targets run through `JevLint` in `@smthrs/targets`. The build CLI must p; packages/smithers/build/PACKAGE.ts: Smithers.file("//packages/smithers/build/build-cli/src/TargetExecution.vibe"), |
| 2026-10-24 16:27 | `8de2ae211e` | PARTIAL | 1/0/86/15 | 9d424aa53e | ♻️ refactor(build-cli): @smthrs/build-cli's Effect modules are written in VibeLang | apps/mvp/docs/rules.md: The Jev targets run through `JevLint` in `@smthrs/targets`. The build CLI must p; packages/smithers/build/PACKAGE.ts: Smithers.file("//packages/smithers/build/build-cli/src/TargetExecution.vibe"), |
| 2026-10-24 16:59 | `7cc894fc1d` | PARTIAL | 8/0/56/11 | lander/w8mig-held | ♻️ refactor(eval-agent): @smthrs/eval-agent is written in VibeLang | packages/smithers/agent/regression/PACKAGE.ts: const sources = [Smithers.glob("//packages/smithers/agent/regression/*.ts"), Smi; packages/smithers/agent/regression/PACKAGE.ts: runner: Smithers.entrypoint(Smithers.file("/ |
| 2026-10-24 16:59 | `1a2289e0bc` | PARTIAL | 8/0/56/11 | 9d424aa53e | ♻️ refactor(eval-agent): @smthrs/eval-agent is written in VibeLang | packages/smithers/agent/regression/PACKAGE.ts: const sources = [Smithers.glob("//packages/smithers/agent/regression/*.ts"), Smi; packages/smithers/agent/regression/PACKAGE.ts: runner: Smithers.entrypoint(Smithers.file("/ |
| 2026-10-25 04:35 | `c1554780d7` | PARTIAL | 4/0/63/7 | lander/w8mig-held | ♻️ refactor(mcp): @smthrs/mcp is written in VibeLang | packages/smithers/mcp/PACKAGE.ts: paths: ["src/internal/StdioTransport.vibe", "src/McpClient.vibe"]; packages/smithers/mcp/PACKAGE.ts: "src/internal/StdioTransport.vibe", |
| 2026-10-25 04:35 | `dec766fba3` | PARTIAL | 4/0/63/7 | 9d424aa53e | ♻️ refactor(mcp): @smthrs/mcp is written in VibeLang | packages/smithers/mcp/PACKAGE.ts: paths: ["src/internal/StdioTransport.vibe", "src/McpClient.vibe"]; packages/smithers/mcp/PACKAGE.ts: "src/internal/StdioTransport.vibe", |
| 2026-10-25 05:48 | `5ca8268ef6` | PARTIAL | 5/0/113/23 | lander/w8mig-held | ♻️ refactor(gateway): @smthrs/gateway is written in VibeLang | .smithers/flows/coding/command-receipts.ts: import { CommandReceipt } from "../../../packages/smithers/gateway/src/RuntimeBr; packages/smithers/gateway/PACKAGE.ts: testSources: Input.glob("{test,examples}/**/*.{ts,vibe}" |
| 2026-10-25 05:48 | `356ea97f5e` | PARTIAL | 5/0/113/23 | 9d424aa53e | ♻️ refactor(gateway): @smthrs/gateway is written in VibeLang | .smithers/flows/coding/command-receipts.ts: import { CommandReceipt } from "../../../packages/smithers/gateway/src/RuntimeBr; packages/smithers/gateway/PACKAGE.ts: testSources: Input.glob("{test,examples}/**/*.{ts,vibe}" |
| 2026-10-26 17:35 | `2f041dbd22` | PARTIAL | 3/0/89/1 | lander/w8mig-held | ⬆️ chore(deps): VibeLang 0.0.9 | .smithers/flows/package.json: "vibelang": "0.0.9"; .smithers/flows/review/seeded-bugs/package.json: "vibelang": "0.0.9" |
| 2026-10-26 17:35 | `740ee4b309` | PARTIAL | 3/0/89/1 | 9d424aa53e | ⬆️ chore(deps): VibeLang 0.0.9 | .smithers/flows/package.json: "vibelang": "0.0.9"; .smithers/flows/review/seeded-bugs/package.json: "vibelang": "0.0.9" |
| 2026-10-26 21:13 | `e72b2cbf43` | PARTIAL | 16/1/2/2 | builder/mobile-w8 | 🐛 fix(mvp): keep screenshot captures out of edited mobile recordings | apps/mvp/e2e/fullPageScreenshot.ts: return await page.screenshot({ ...(path === undefined ? {} : { path }), fullPage; apps/mvp/e2e/mobile-baseline.ts: const current = await fullPageScreenshot(page, info.outputPath(`${nam |
| 2026-10-26 22:07 | `b541b10c4b` | SUPERSEDED | 6/5/0/0 | 3760d55952 | 🐛 fix(repo-view): render sanitized README HTML and hide comments | apps/mvp/docs/work/bb2-markdown.md: main carried then changed it: a056df6fe4 (📝 docs(markdown): record rendering policy and W12 validation) |
| 2026-10-26 22:08 | `b207c70a23` | SUPERSEDED | 16/2/0/0 | builder/bb2-webkit | 🔎 fix(storage): expose flow editor restore and SQL admission failures | apps/mvp/docs/work/bugbash3-flows-storage.md: changed later in its stack (head 9bd3469684) |
| 2026-10-26 22:10 | `3fcc12729e` | SUPERSEDED | 9/2/0/0 | 3760d55952 | 🐛 fix(markdown): hide leading YAML metadata in document previews | apps/mvp/e2e/markdown-rendering.spec.ts: main carried then changed it: 98b17d082e (🐛 fix(markdown): keep list continuation lines inside their items) |
| 2026-10-26 22:12 | `119ccae788` | ON-MAIN | 5/0/0/0 | 3760d55952 | 🐛 fix(markdown): scroll phone tables without splitting cell words |  |
| 2026-10-26 22:13 | `3ab1db8c6e` | ON-MAIN | 24/0/0/0 | 3760d55952 | 🐛 fix(markdown): highlight TypeScript shell and VibeLang fences |  |
| 2026-10-26 22:15 | `a36bf79263` | ON-MAIN | 31/0/0/0 | a36bf79263 | 🐛 fix(mvp): isolate Electric ownership from app deployments |  |
| 2026-10-26 22:15 | `a59b5bceb8` | ON-MAIN | 10/0/0/0 | 3760d55952 | 🐛 fix(repo-view): name image-only README links |  |
| 2026-10-26 22:15 | `ec18510a25` | ON-MAIN | 8/0/0/0 | 3760d55952 | 🐛 fix(repo-view): render GitHub alert titles in Markdown previews |  |
| 2026-10-26 22:17 | `0ad08f02f9` | ON-MAIN | 9/0/0/0 | 3760d55952 | 🐛 fix(markdown): keep list continuation lines inside their items |  |
| 2026-10-26 22:23 | `f16caa19ca` | PARTIAL | 10/0/41/4 | lander/w8mig-held | 🐛 fix(mvp): make refs freshness tests follow upstream changes | apps/mvp/bench/cerebras-load/admission.test.ts: const child=spawnSync(process.execPath,['--import=vibelang/register',new URL('./; apps/mvp/db/Database.test.ts: promisify(execFile)("pnpm", ["run", "db:migrate"], { |
| 2026-10-26 22:23 | `fc6afb5464` | PARTIAL | 10/0/41/4 | 9d424aa53e | 🐛 fix(mvp): make refs freshness tests follow upstream changes | apps/mvp/bench/cerebras-load/admission.test.ts: const child=spawnSync(process.execPath,['--import=vibelang/register',new URL('./; apps/mvp/db/Database.test.ts: promisify(execFile)("pnpm", ["run", "db:migrate"], { |
| 2026-10-26 22:26 | `3760d55952` | ON-MAIN | 4/0/0/0 | 3760d55952 | 📝 docs(markdown): record rendering policy and W12 validation |  |
| 2026-10-26 22:28 | `8df98d3314` | SUPERSEDED | 4/1/0/0 | 64738e065c | 🐛 fix(mvp): include unlabeled issues in No commitment | apps/mvp/docs/work/bugbash2-lists.md: main carried then changed it: e1da21dd12 (🐛 fix(mvp): settle empty lists from applied shape receipts) |
| 2026-10-26 22:28 | `be9cbb3b5c` | SUPERSEDED | 14/2/0/0 | 24bbdd43fd | 🐛 fix(mvp): recover unknown routes in the app shell | apps/mvp/docs/work/bugbash-notfound-1026.md: main carried then changed it: 5accd1cb13 (📝 docs(mvp): record not-found fixes and deployment checks) |
| 2026-10-26 22:29 | `e2b3aebc18` | SUPERSEDED | 3/1/0/0 | 881ce02e3d | 🐛 fix(mvp): inspect the first failed run step | apps/mvp/docs/work/bugbash2-runs-1026.md: main carried then changed it: 3edbe7e211 (🐛 fix(runs): show pending repository history while sync loads) |
| 2026-10-26 22:29 | `82cf1a0b34` | SUPERSEDED | 2/2/0/0 | 64738e065c | 🐛 fix(mvp): retain sync knowledge across commitment filters | apps/mvp/src/screens/issues/IssuesScreen.tsx: main carried then changed it: a521d7babd (✨ feat(mvp): search and sort synced issue and pull request lists) |
| 2026-10-26 22:30 | `338cd9007a` | ON-MAIN | 4/0/0/0 | 881ce02e3d | 🐛 fix(ui): show failed step reasons without opening attempts |  |
| 2026-10-26 22:30 | `a38b1b5394` | SUPERSEDED | 3/1/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): name the chat page for heading navigation | apps/mvp/docs/work/bugbash2-accessibility.md: main carried then changed it: 88d7a3521b (📝 docs(mvp): record accessibility fixes and lander checks) |
| 2026-10-26 22:30 | `d3974e4406` | SUPERSEDED | 20/5/0/0 | 64738e065c | ✨ feat(mvp): search and sort synced issue and pull request lists | apps/mvp/docs/features/issues.md: main carried then changed it: b450a52fc2 (🐛 fix(mvp): repair mobile layout and explain private browser limits) |
| 2026-10-26 22:31 | `93265e3ac5` | ON-MAIN | 3/0/0/0 | 881ce02e3d | 🐛 fix(runs): collapse unused alternative cleanup nodes |  |
| 2026-10-26 22:31 | `1a1f90d08e` | SUPERSEDED | 7/1/0/0 | 881ce02e3d | 🐛 fix(runs): share skipped state across graph and inspector | apps/mvp/src/features/runs/graph.ts: main carried then changed it: 416120a2c8 (🐛 fix(runs): collapse unused alternative cleanup nodes) |
| 2026-10-26 22:31 | `bfc0b8014b` | SUPERSEDED | 6/1/0/0 | 1570cd8ccd | 🐛 fix(mvp): explain the clone prerequisite for code browsing | apps/mvp/docs/work/code-bugbash-w12.md: main carried then changed it: a445f8f34b (🐛 fix(mvp): redirect confirmed file paths from tree to blob) |
| 2026-10-26 22:31 | `d7821ee836` | ON-MAIN | 7/0/0/0 | 64738e065c | 🐛 fix(mvp): name TODOs linked from issues |  |
| 2026-10-26 22:31 | `8874c1ada0` | SUPERSEDED | 6/1/0/0 | 24bbdd43fd | 🐛 fix(mvp): fence run credentials until session confirmation | apps/mvp/e2e/visitor-credentials.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:31 | `d654447c81` | SUPERSEDED | 10/3/0/0 | 24bbdd43fd | 🐛 fix(mvp): redirect settings and repository aliases | apps/mvp/src/router.tsx: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:32 | `5db3738b15` | ON-MAIN | 11/0/0/0 | 881ce02e3d | 🐛 fix(runs): gate cloud history on resolved sign-in |  |
| 2026-10-26 22:32 | `6d4df52c7c` | SUPERSEDED | 9/11/0/0 | 3ce9d3ae4b | 🐛 fix(settings): validate drafts before testing saved models | apps/mvp/docs/decisions/0118-test-saved-model-after-validation.md: main deleted it in 805018246b (🐛 fix(settings): validate drafts before testing saved models) |
| 2026-10-26 22:32 | `d54bc01428` | ON-MAIN | 6/0/0/0 | 0be3bde878 | 🐛 fix(mvp): open notification commits at their recorded revision |  |
| 2026-10-26 22:32 | `9844fedab9` | SUPERSEDED | 3/1/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): reach chat before message history by keyboard | apps/mvp/src/screens/app/AppShell.tsx: main carried then changed it: af88f72aeb (🐛 fix(mvp): keep toast overlays below pinned message controls) |
| 2026-10-26 22:32 | `88cb46d71b` | SUPERSEDED | 3/1/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): add a keyboard skip link | apps/mvp/src/screens/root/root.css: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:32 | `cd120b6429` | SUPERSEDED | 4/3/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): focus new page content after navigation | apps/mvp/src/features/navigation/components/PageFocus.tsx: main deleted it in cd82880923 (♿ fix(mvp): focus the new issue title once when opening) |
| 2026-10-26 22:32 | `ca847bc4cc` | SUPERSEDED | 1/4/0/0 | 64738e065c | 🐛 fix(mvp): wait for installed list rows before announcing empty | apps/mvp/src/screens/issues/IssuesScreen.tsx: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:32 | `5f70710329` | SUPERSEDED | 7/3/0/0 | 24bbdd43fd | 🐛 fix(mvp): offer sign-in on visitor settings pages | apps/mvp/src/features/secrets/components/SecretsPage.tsx: main carried then changed it: 18c3cc4fef (🎨 style(mvp): settings, flows, repository settings and secrets as cards) |
| 2026-10-26 22:33 | `62b9c154e2` | SUPERSEDED | 3/3/0/0 | a91b10af06 | 🐛 fix(mvp): preserve typing while the composer mounts | apps/mvp/docs/features/chat.md: main carried then changed it: a4bf001cb2 (🐛 fix(mvp): show and enforce the composer length limit) |
| 2026-10-26 22:33 | `a6f7d6e0ba` | SUPERSEDED | 0/2/0/0 | 3ce9d3ae4b | 🐛 fix(settings): name what each model tier does | apps/mvp/src/features/personal-model/components/PersonalModelSettings.tsx: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model connections like Amp's: Claude and Codex subscriptions, Jev, Kimi K3 through Moonsho |
| 2026-10-26 22:33 | `8831adfbf6` | SUPERSEDED | 1/6/0/0 | 3ce9d3ae4b | ♿ fix(settings): name model credential fields by protocol | apps/mvp/e2e/byok-first.spec.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model connections like Amp's: Claude and Codex subscriptions, Jev, Kimi K3 through Moonshot (decision 0132, AUTH-10)) |
| 2026-10-26 22:33 | `936fdda00c` | SUPERSEDED | 17/1/0/0 | 0be3bde878 | 🐛 fix(ui): open notification subjects directly and separate details | apps/mvp/src/features/attention/components/NotificationsPanel.tsx: main carried then changed it: 8fa97b98dd (🐛 fix(mvp): keep failed clones at their reason and retry) |
| 2026-10-26 22:33 | `dc7d8248f3` | SUPERSEDED | 2/1/0/0 | 45a19eaed2 | 🔗 fix(home): point installation to the install guide | apps/site/package.json: main carried then changed it: ad6740a596 (💬 fix(settings): name the work each model tier answers) |
| 2026-10-26 22:33 | `4851b7b084` | SUPERSEDED | 3/1/0/0 | 45a19eaed2 | 🎨 fix(docs): remove misleading global release banner | apps/site/package.json: main carried then changed it: 05ae782867 (🔗 fix(home): point installation to the install guide) |
| 2026-10-26 22:33 | `88fc960937` | SUPERSEDED | 0/10/0/0 | 45a19eaed2 | 📝 fix(docs): define flow commands and protected actions | apps/site/docs/app/pages/flows.md: main carried then changed it: 9662836059 (🐛 fix: land W13 browser, writes, views, CLI, privacy and docs) |
| 2026-10-26 22:33 | `5d6ca5baba` | SUPERSEDED | 5/1/0/0 | 45a19eaed2 | 📝 fix(docs): keep generated coding model defaults | apps/site/package.json: main carried then changed it: 22ff42267b (📝 fix(docs): define flow commands and protected actions) |
| 2026-10-26 22:33 | `eb5ac322e3` | SUPERSEDED | 14/6/0/0 | 45a19eaed2 | 📝 fix(docs): match hosted onboarding to the current app | apps/mvp/docs/work/bugbash2-docs.md: main carried then changed it: 03f08b99ac (✅ docs: record completed W12 validation) |
| 2026-10-26 22:33 | `d0572f077e` | SUPERSEDED | 5/1/0/0 | 64738e065c | 🐛 fix(mvp): wait for stack sync before reporting a missing TODO | apps/mvp/src/screens/stack/TodoScreen.tsx: main carried then changed it: cf9b8a0d72 (🎨 style(mvp): issues, pull requests, the stack and a repository's runs as cards) |
| 2026-10-26 22:33 | `398f3c10d4` | SUPERSEDED | 4/5/0/0 | 24bbdd43fd | 🐛 fix(mvp): settle unsynced item details with recovery | apps/mvp/e2e/missing-items.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:34 | `cc4a4cd652` | ON-MAIN | 19/0/0/0 | 881ce02e3d | 🐛 fix(ci): retain command output for run step records |  |
| 2026-10-26 22:34 | `3ce9d3ae4b` | SUPERSEDED | 2/2/0/0 | 3ce9d3ae4b | 🐛 fix(settings): name who adds repository secrets | apps/mvp/e2e/settings-secrets-empty.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:34 | `a28e33a1d2` | SUPERSEDED | 0/2/0/0 | 3ce9d3ae4b | 🐛 fix(settings): align model tiers with credential columns | apps/mvp/e2e/settings-layout.spec.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model connections like Amp's: Claude and Codex subscriptions, Jev, Kimi K3 through Moonshot (decision 0132, AUTH-10)) |
| 2026-10-26 22:34 | `484ed255f9` | ON-MAIN | 5/0/0/0 | 0be3bde878 | 🐛 fix(mvp): keep failed clones at their reason and retry |  |
| 2026-10-26 22:34 | `b26eb86d4e` | SUPERSEDED | 6/3/0/0 | 45a19eaed2 | 💬 fix(settings): name the work each model tier answers | apps/mvp/docs/features/personal-model.md: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model connections like Amp's: Claude and Codex subscriptions, Jev, Kimi K3 through Moonshot (decision 0132, AUTH-10)) |
| 2026-10-26 22:34 | `cf166677ca` | SUPERSEDED | 2/1/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): redirect plural pull request item URLs | apps/mvp/src/router.tsx: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:34 | `a872c6d174` | SUPERSEDED | 2/1/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): keep docs navigation out of document headings | apps/mvp/e2e/accessibility-docs.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:34 | `d9ce91f4cf` | ON-MAIN | 2/0/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): separate TODO action name from shortcut hint |  |
| 2026-10-26 22:34 | `02cb78f956` | SUPERSEDED | 13/2/0/0 | 1570cd8ccd | 🐛 fix(mvp): retain navigation and offline states for uncached pages | apps/mvp/src/screens/issues/IssueScreen.tsx: main carried then changed it: cf9b8a0d72 (🎨 style(mvp): issues, pull requests, the stack and a repository's runs as cards) |
| 2026-10-26 22:34 | `64738e065c` | ON-MAIN | 7/0/0/0 | 64738e065c | 🐛 fix(mvp): settle empty lists from applied shape receipts |  |
| 2026-10-26 22:34 | `f1f0771caa` | SUPERSEDED | 11/3/0/0 | 24bbdd43fd | 🐛 fix(mvp): expose repository refusal without a blank retry window | apps/mvp/e2e/missing-repository.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:35 | `05dbf38a86` | ON-MAIN | 8/0/0/0 | 881ce02e3d | 🐛 fix(runs): put engine details behind readable records |  |
| 2026-10-26 22:35 | `0be3bde878` | ON-MAIN | 9/0/0/0 | 0be3bde878 | 🐛 fix(mvp): link failed header status to its answer run |  |
| 2026-10-26 22:35 | `bdb6aa303d` | SUPERSEDED | 5/4/0/0 | 0be3bde878 | 🐛 fix(mvp): format timeline preview timestamps | apps/mvp/src/features/timeline/view.test.ts: main carried then changed it: d9240f088e (🐛 fix(timeline): notify every summary-preventing failure, keep semantic phases open with rolling summaries, show each message's own  |
| 2026-10-26 22:35 | `ad36c628b2` | ON-MAIN | 4/0/0/0 | 45a19eaed2 | 💬 fix(docs): offer recovery for unavailable pages |  |
| 2026-10-26 22:35 | `b964cee8c7` | SUPERSEDED | 4/1/0/0 | 45a19eaed2 | 💬 fix(issues): label scheduling filters in product words | apps/mvp/src/screens/issues/IssuesScreen.tsx: main carried then changed it: cf9b8a0d72 (🎨 style(mvp): issues, pull requests, the stack and a repository's runs as cards) |
| 2026-10-26 22:35 | `e5e09bac9b` | SUPERSEDED | 6/2/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): focus the new issue title once when opening | apps/mvp/src/features/navigation/components/PageFocus.tsx: main deleted it in cd82880923 (♿ fix(mvp): focus the new issue title once when opening) |
| 2026-10-26 22:36 | `dae982dd96` | SUPERSEDED | 15/1/0/0 | 881ce02e3d | 🐛 fix(runs): remove redundant placement and live labels | apps/mvp/src/features/runs/components/RunPageView.tsx: main carried then changed it: 6855753cba (✨ feat(mvp): stop and steer a TODO's external agent from its run's page (decision 0142)) |
| 2026-10-26 22:36 | `73c9366f40` | SUPERSEDED | 18/2/0/0 | 881ce02e3d | 🐛 fix(runs): make table names and durations readable | apps/mvp/src/features/runs/page.test.ts: main carried then changed it: 2c02d5f116 (🐛 fix(runs): preserve the originating run list on return) |
| 2026-10-26 22:36 | `22ae7dafa9` | SUPERSEDED | 2/2/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): name model credential fields by protocol | apps/mvp/src/features/personal-model/components/PersonalModelSettings.tsx: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model connections like Amp's: Claude and Codex subscriptions, Jev, Kimi K3 through Moonsho |
| 2026-10-26 22:36 | `be18c3cf0e` | ON-MAIN | 5/0/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): apply browser language and writing direction |  |
| 2026-10-26 22:36 | `e86d7607e4` | SUPERSEDED | 8/1/0/0 | 24bbdd43fd | 🐛 fix(mvp): redirect tree file aliases to blobs | apps/mvp/src/features/repo/repo.ts: main carried then changed it: 175fff9527 (🔧 fix(mvp): reconcile W12 navigation and regenerate artifacts) |
| 2026-10-26 22:36 | `77a91ff4a5` | SUPERSEDED | 8/4/0/0 | 24bbdd43fd | 🐛 fix(mvp): adopt GitHub canonical repository URLs | apps/mvp/src/features/repo/repo.ts: main carried then changed it: 02103773d5 (🐛 fix(mvp): redirect tree file aliases to blobs) |
| 2026-10-26 22:37 | `f2ec1fba26` | SUPERSEDED | 12/2/0/0 | 881ce02e3d | 🐛 fix(runs): preserve the originating run list on return | apps/mvp/src/screens/actions/ActionRunScreen.tsx: main carried then changed it: 903a316c94 (🎨 style(mvp): Runs pages on the shared page frame) |
| 2026-10-26 22:37 | `3d793be711` | ON-MAIN | 8/0/0/0 | 45a19eaed2 | 🎨 fix(docs): align documentation with the Paper product palette |  |
| 2026-10-26 22:37 | `1570cd8ccd` | SUPERSEDED | 9/1/0/0 | 1570cd8ccd | 🐛 fix(mvp): redirect confirmed file paths from tree to blob | apps/mvp/e2e/tree-file.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-26 22:37 | `b0927dd6ea` | ON-MAIN | 7/0/0/0 | 24bbdd43fd | 🐛 fix(mvp): bound overlong file absence and breadcrumb width |  |
| 2026-10-26 22:38 | `27be437416` | ON-MAIN | 2/0/0/0 | 45a19eaed2 | 🧪 test(docs): cover deployed documentation and copy regressions |  |
| 2026-10-26 22:39 | `881ce02e3d` | SUPERSEDED | 6/3/0/0 | 881ce02e3d | 🐛 fix(runs): show pending repository history while sync loads | apps/mvp/e2e/run-records.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-27 00:06 | `d343ab11f3` | SUPERSEDED | 6/2/0/0 | 2fb3fbb2f9 | ♿ fix(ui): expose page focus through the public UI library | apps/mvp/src/screens/root/root.css: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-27 00:07 | `1763f97388` | SUPERSEDED | 4/1/0/0 | a91b10af06 | 🐛 fix(mvp): show repository command formats on first Enter | apps/mvp/docs/features/slash-commands.md: main carried then changed it: 2936562175 (🐛 fix(mvp): keep refused navigation in chat) |
| 2026-10-27 00:07 | `5eef0b2ef8` | ON-MAIN | 5/0/0/0 | 45a19eaed2 | 📝 fix(docs): label the private dependency in Node provider example |  |
| 2026-10-27 00:07 | `06b7bc5206` | SUPERSEDED | 2/1/0/0 | 2fb3fbb2f9 | ♿ fix(ui): preserve title input in sequential keyboard navigation | packages/smithers/ui/src/page-focus.tsx: main carried then changed it: 115a0e95d6 (🐛 fix(mvp): preserve report focus and live pull comparisons) |
| 2026-10-27 00:08 | `d40f12d712` | SUPERSEDED | 5/3/0/0 | a91b10af06 | 🐛 fix(mvp): distinguish empty conversation search results | apps/mvp/docs/features/conversations.md: main carried then changed it: 83e66b9289 (🐛 fix(mvp): name repositories in conversation archive controls) |
| 2026-10-27 00:08 | `18faf8e395` | SUPERSEDED | 7/1/0/0 | a91b10af06 | 🐛 fix(mvp): show and enforce the composer length limit | apps/mvp/src/features/commands/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-27 00:08 | `50026ce25e` | SUPERSEDED | 9/3/0/0 | a91b10af06 | 🐛 fix(mvp): keep refused navigation in chat | apps/mvp/src/features/commands/actions.ts: main carried then changed it: 9662836059 (🐛 fix: land W13 browser, writes, views, CLI, privacy and docs) |
| 2026-10-27 00:09 | `0fca9c2498` | ON-MAIN | 11/0/0/0 | a91b10af06 | 🐛 fix(mvp): name repositories in conversation archive controls |  |
| 2026-10-27 00:09 | `bc4e1248bd` | SUPERSEDED | 1/1/0/0 | 45a19eaed2 | 📝 docs: record W12 documentation validation receipts | apps/mvp/docs/work/bugbash2-docs.md: main carried then changed it: 03f08b99ac (✅ docs: record completed W12 validation) |
| 2026-10-27 00:11 | `c47ec924c8` | ON-MAIN | 3/0/0/0 | 2fb3fbb2f9 | 🧪 test(ui): exercise focus across a persistent route outlet |  |
| 2026-10-27 00:12 | `b297223e85` | ON-MAIN | 2/0/0/0 | a91b10af06 | 🧪 test(mvp): retain deferred chat findings for deployment |  |
| 2026-10-27 00:12 | `5d8d403ac0` | ON-MAIN | 5/0/0/0 | 2fb3fbb2f9 | ♿ fix(ui): expose one named chat message log |  |
| 2026-10-27 00:13 | `a91b10af06` | SUPERSEDED | 2/1/0/0 | a91b10af06 | 🧪 test(mvp): exercise navigation refusal and late dispatch outcomes | apps/mvp/src/features/commands/commands.test.ts: main carried then changed it: e14f3bc21c (✨ feat(mvp): show background progress as a projection of receipts) |
| 2026-10-27 00:13 | `1d98e5d5b3` | SUPERSEDED | 2/2/0/0 | 2fb3fbb2f9 | ♿ fix(mvp): expose landing identity and source landmarks | apps/mvp/src/screens/landing/landing.css: main carried then changed it: cbb40294a0 (🎨 style(mvp): the app bar, conversations, landing and bug report in the mock look) |
| 2026-10-27 00:13 | `f1eb3e9a58` | ON-MAIN | 1/0/0/0 | 2fb3fbb2f9 | 🧹 fix(mvp): document invalid locale fallback |  |
| 2026-10-27 00:18 | `2fb3fbb2f9` | ON-MAIN | 2/0/0/0 | 2fb3fbb2f9 | 📝 docs(mvp): record accessibility fixes and lander checks |  |
| 2026-10-27 00:23 | `24bbdd43fd` | ON-MAIN | 1/0/0/0 | 24bbdd43fd | 📝 docs(mvp): record not-found fixes and deployment checks |  |
| 2026-10-27 00:33 | `45a19eaed2` | ON-MAIN | 2/0/0/0 | 45a19eaed2 | ✅ docs: record completed W12 validation |  |
| 2026-10-27 00:38 | `24001774d5` | SUPERSEDED | 7/1/0/0 | 938a8c940e | 🐛 fix(triggers): identify invalid cron search dates (agentmisc-3) | apps/mvp/docs/work/package-bugbash3-agent.md: main carried then changed it: 6e31766aa4 (🐛 fix(fs): distinguish malformed argv from resource bounds (agentmisc-5)) |
| 2026-10-27 00:40 | `4fe4719ce2` | SUPERSEDED | 5/2/0/0 | 84b10cb9b0 | 🐛 fix(secrets): scrub mixed percent-encoded echoes | apps/mvp/docs/work/bb3-flows.md: main carried then changed it: fbdc8eed66 (📝 docs: record bb3 flows proof and remaining gate blockers) |
| 2026-10-27 00:40 | `cb8c72a135` | ON-MAIN | 5/0/0/0 | 2996dbbfcc | 🐛 fix(terminal-frame): preserve balanced delimiters in web links |  |
| 2026-10-27 00:40 | `fbc5145212` | ON-MAIN | 3/0/0/0 | 2996dbbfcc | 🐛 fix(repo-view): retain literal percent signs in document links |  |
| 2026-10-27 00:40 | `d2beb0f125` | ON-MAIN | 3/0/0/0 | 2996dbbfcc | 🐛 fix(repo-view): omit the root sentinel from child entries |  |
| 2026-10-27 00:40 | `bcb454c8d4` | SUPERSEDED | 3/1/0/0 | 2996dbbfcc | 🐛 fix(ui): cancel the copied timer before starting another copy | apps/mvp/docs/work/package-bugbash3-ui.md: main carried then changed it: db756087e9 (📝 fix(ui-styleguide): use Paper in the palette quickstart) |
| 2026-10-27 00:41 | `49015ab6e0` | ON-MAIN | 4/0/0/0 | 84b10cb9b0 | 🐛 fix(secrets): scrub every JSON string escape form |  |
| 2026-10-27 00:41 | `2996dbbfcc` | ON-MAIN | 7/0/0/0 | 2996dbbfcc | 📝 fix(ui-styleguide): use Paper in the palette quickstart |  |
| 2026-10-27 00:42 | `f3883402bb` | ON-MAIN | 4/0/0/0 | builder/bb3-cli | 📝 fix(cli): remove retired CodexAuth namespace documentation |  |
| 2026-10-27 00:42 | `5865009f9a` | SUPERSEDED | 4/1/0/0 | builder/bb3-cli | 🐛 fix(platform-node): classify mkdir and touch denials as writes | apps/mvp/docs/work/package-bugbash3-cli.md: changed later in its stack (head 36145de11d) |
| 2026-10-27 00:43 | `096b55fe37` | ON-MAIN | 4/0/0/0 | 84b10cb9b0 | 🐛 fix(rpc): refuse inexact slash TODO identifiers |  |
| 2026-10-27 00:44 | `3c2197369b` | ON-MAIN | 5/0/0/0 | 938a8c940e | 📝 fix(plugin): import Effect in the standalone API example (agentcore-4) |  |
| 2026-10-27 00:45 | `6a8eb275c7` | ON-MAIN | 7/0/0/0 | 938a8c940e | 🐛 fix(triggers): validate interval endpoints before cron catch-up (agentmisc-4) |  |
| 2026-10-27 00:46 | `938a8c940e` | ON-MAIN | 15/0/0/0 | 938a8c940e | 🐛 fix(fs): distinguish malformed argv from resource bounds (agentmisc-5) |  |
| 2026-10-27 00:47 | `b5071cef34` | ON-MAIN | 12/0/0/0 | 84b10cb9b0 | 🐛 fix(capability): apply restrictions to either path form |  |
| 2026-10-27 00:52 | `9cdf592abe` | ON-MAIN | 3/0/0/0 | builder/bb3-cli | 📝 fix(std): yield the attribution effect in the test guide |  |
| 2026-10-27 00:52 | `b99cf92092` | ON-MAIN | 8/0/0/0 | builder/bb3-cli | 📝 fix(model): include provider names in route examples |  |
| 2026-10-27 00:52 | `0040ed87ca` | ON-MAIN | 3/0/0/0 | builder/bb3-cli | 📝 fix(cli): document only implemented generators |  |
| 2026-10-27 00:52 | `50a2554526` | ON-MAIN | 5/0/0/0 | builder/bb3-cli | 📝 fix(cli): align public API tables with runtime exports |  |
| 2026-10-27 00:53 | `ef03787f85` | ON-MAIN | 8/0/0/0 | builder/bb3-cli | 🐛 fix(migrate): report credential refusals and actual repair attempts |  |
| 2026-10-27 00:54 | `15d144e2d1` | SUPERSEDED | 0/3/0/0 | builder/bb3-cli | 🧪 test(build-cli): retain the known-broken prepared-output regression | apps/mvp/docs/work/package-bugbash3-cli.md: changed later in its stack (head 36145de11d) |
| 2026-10-27 00:55 | `40bc53279f` | ON-MAIN | 5/0/0/0 | 84b10cb9b0 | 📚 fix(control): document sanitization of every defect |  |
| 2026-10-27 00:56 | `143642f373` | ON-MAIN | 1/0/0/0 | builder/bb3-cli | 🧪 test(cli): retain known-broken install flow bindings |  |
| 2026-10-27 01:12 | `9bd3469684` | SUPERSEDED | 46/7/0/0 | builder/bb2-webkit | fix(mvp): retain unfinished flow inputs and allow session editors | apps/mvp/e2e/device-storage-readonly.spec.ts: main carried then changed it: d97e8f6ec5 (🧪 fix(mvp): preserve the behavior of W13 follow-up journeys) |
| 2026-10-27 01:12 | `2da75b66c3` | SUPERSEDED | 27/1/0/0 | builder/bb2-webkit | fix(platform-browser): preserve WebKit worker schema identity and cached SQLite assets | packages/smithers/flows/platform-browser/src/BrowserSqlite.ts: main carried then changed it: b450a52fc2 (🐛 fix(mvp): repair mobile layout and explain private browser limits) |
| 2026-10-27 01:21 | `84b10cb9b0` | ON-MAIN | 2/0/0/0 | 84b10cb9b0 | 📝 docs: record bb3 flows proof and remaining gate blockers |  |
| 2026-10-27 01:39 | `e81e70ded6` | SUPERSEDED | 8/1/0/0 | 9a64fd80d6 | 🐛 fix(observability): redact every OTLP signal at transport boundary | apps/mvp/docs/work/bugbash3-flowsdata.md: main carried then changed it: 7b00088cf2 (📝 fix(database): show SQLite null-prototype rows in quickstart) |
| 2026-10-27 01:45 | `ea45fd3867` | ON-MAIN | 6/0/0/0 | 9a64fd80d6 | 🐛 fix(time-travel): reject frames beyond the committed journal tail |  |
| 2026-10-27 01:56 | `9a64fd80d6` | ON-MAIN | 5/0/0/0 | 9a64fd80d6 | 📝 fix(database): show SQLite null-prototype rows in quickstart |  |
| 2026-10-27 02:10 | `36145de11d` | ON-MAIN | 15/0/0/0 | builder/bb3-cli | 🐛 fix(build-cli): require every declared output after successful tools |  |
| 2026-10-27 02:10 | `9157cef7e5` | PARTIAL | 10/0/1/1 | builder/bb4-views | 🐛 fix(mvp): distinguish undispatched actions from execution failures | apps/mvp/src/features/runs/graph.ts: const shownNodes = nodes.map((node, index) => steps[index]!.row.state === "skipp; packages/smithers/ui/src/flow-graph/FlowGraph.tsx: const words = { next: "Queued", current: "Working" |
| 2026-10-27 02:13 | `918b603ad2` | ON-MAIN | 7/0/0/0 | 918b603ad2 | 🐛 fix(mvp): keep normalized sign-in redirects on origin |  |
| 2026-10-27 02:19 | `51acfef35e` | PARTIAL | 6/1/0/1 | builder/bb4-views | 🐛 fix(ui): bound the wordmark independently of minimum font size | apps/mvp/e2e/minimum-font.spec.ts: test("landing: the decorative wordmark fits with a native 20px minimum font", as; apps/mvp/src/screens/landing/landing.css: main carried then changed it: cbb40294a0 (🎨 style(mvp): the  |
| 2026-10-27 02:21 | `65d92738ce` | SUPERSEDED | 24/12/0/0 | builder/bb5-app | 🐛 fix(mvp): durably admit issue creation before returning | apps/mvp/docs/work/bugbash4-writes.md: changed later in its stack (head a80b82ce4b) |
| 2026-10-27 02:32 | `9c8e319c2e` | SUPERSEDED | 23/1/0/0 | builder/bb4-views | 🐛 fix(mvp): recover PR details with authoritative absence receipts | apps/mvp/src/screens/pulls/PullScreen.tsx: main carried then changed it: d3985028c7 (✨ feat(pulls): review on request for any open pull request (0129)) |
| 2026-10-27 02:32 | `039f346820` | SUPERSEDED | 0/1/0/0 | builder/bb4-views | ✅ test(mvp): retain the native minimum-font settings regression | apps/mvp/e2e/minimum-font-settings.spec.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model connections like Amp's: Claude and Codex subscriptions, Jev, Kimi K3 through Moonshot (decision 0132, AUTH-10)) |
| 2026-10-27 02:33 | `d9d3378f53` | SUPERSEDED | 0/4/0/0 | builder/bb5-app | 🐛 fix(mvp): label queued issue creation Requested | apps/mvp/docs/features/issues.md: main carried then changed it: e14f3bc21c (✨ feat(mvp): show background progress as a projection of receipts) |
| 2026-10-27 02:37 | `5b86d9d1d2` | SUPERSEDED | 7/2/0/0 | builder/bb5-app | 🐛 fix(mvp): recover unavailable issue write URLs | apps/mvp/e2e/write-admission.spec.ts: main carried then changed it: 39b7705c9e (🧪 fix(mvp): locate the unavailable write state by its text) |
| 2026-10-27 02:40 | `30798c67e1` | SUPERSEDED | 22/1/0/0 | builder/bb4-views | 🐛 fix(mvp): retain original-file downloads above the preview cap | apps/mvp/worker/RepoApi.test.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide first run and narrow AUTH-8 to repository conversations and clone caps) |
| 2026-10-27 02:42 | `6a00d1869c` | SUPERSEDED | 9/9/0/0 | builder/bb5-app | 🐛 fix(mvp): retain failed comment admission feedback | apps/mvp/docs/features/issues.md: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-27 03:02 | `b6b6552142` | SUPERSEDED | 45/12/0/0 | builder/bb5-app | 🐛 fix(mvp): follow branch writes in the shared toast lifecycle | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild migration registration and merge device schema history) |
| 2026-10-27 03:11 | `97bc387e62` | SUPERSEDED | 8/1/0/0 | builder/bb4-app2 | 🐛 fix(mvp): explain blank report refusals | apps/mvp/docs/features/bugs.md: main carried then changed it: 115a0e95d6 (🐛 fix(mvp): preserve report focus and live pull comparisons) |
| 2026-10-27 03:11 | `c57466fbbc` | PARTIAL | 4/1/1/0 | builder/bb4-docs | 🐛 fix(cli): hide removed agents from command discovery | apps/site/package.json: "check:docs": "node --test --test-concurrency=1 scripts/regressions/*.test.mjs s; packages/smithers/test/RemovedAgentsDocs.test.ts: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:11 | `33ca5ffd06` | SUPERSEDED | 9/1/0/0 | builder/bb4-app2 | 🐛 fix(mvp): redact private paths in report error records | apps/mvp/e2e/bug-report-privacy.spec.ts: main carried then changed it: d97e8f6ec5 (🧪 fix(mvp): preserve the behavior of W13 follow-up journeys) |
| 2026-10-27 03:14 | `4bdef22248` | SUPERSEDED | 2/1/0/0 | builder/bb4-docs | 📝 fix(testing): document the restore script directive | packages/testing/docs/guides/script-a-model.md: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:14 | `42af1509f8` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 📝 fix(targets): use public reference factories in cheat sheet |  |
| 2026-10-27 03:14 | `7f61808ed0` | ON-MAIN | 3/0/0/0 | builder/bb4-docs | 📝 fix(testing): show script tags in their emitted order |  |
| 2026-10-27 03:14 | `3755b09157` | ON-MAIN | 3/0/0/0 | builder/bb4-docs | 🐛 fix(cli): derive agent help from its configuration declaration |  |
| 2026-10-27 03:15 | `0ac9f06b87` | SUPERSEDED | 3/1/0/0 | builder/bb4-docs | 📝 fix(docs): teach supported personal flow actions | apps/mvp/e2e/docs-flow-reference.spec.ts: main carried then changed it: 936ff90497 (🐛 fix(site): fit phone headings and qualify production checks) |
| 2026-10-27 03:15 | `53de3d97d9` | SUPERSEDED | 2/1/0/0 | builder/bb4-docs | 📝 fix(docs): remove the current wiki configuration claim | apps/site/docs/app/pages/flows.md: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:16 | `7fa10453e2` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 📝 fix(docs): publish generic operator model and sandbox settings |  |
| 2026-10-27 03:16 | `b7efb496dc` | SUPERSEDED | 3/1/0/0 | builder/bb4-docs | 📝 fix(docs): publish core and plugin chat commands | apps/site/docs/app/toc.ts: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:16 | `2e84d7db0d` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 📝 fix(docs): publish the current settings guide |  |
| 2026-10-27 03:17 | `ca23e330cb` | PARTIAL | 4/0/0/1 | builder/bb4-app2 | 🐛 fix(ui): show keyboard focus on tab panels | apps/mvp/e2e/run-panel-focus.spec.ts: test.skip(!run, "needs E2E_INSPECT_RUN naming an existing readable run") |
| 2026-10-27 03:17 | `a55bcc266f` | PARTIAL | 5/0/0/1 | builder/bb4-app2 | 🐛 fix(mvp): distinguish repeated flow drafts | apps/mvp/e2e/flow-draft-labels.spec.ts: test.skip(!name, "needs E2E_DUPLICATE_DRAFT_NAME with two existing personal draf |
| 2026-10-27 03:17 | `ef953b2a71` | SUPERSEDED | 4/1/0/0 | builder/bb4-app2 | 🐛 fix(mvp): show connection state on plugin pages | apps/mvp/src/screens/plugin/PluginScreen.tsx: main carried then changed it: cbb40294a0 (🎨 style(mvp): the app bar, conversations, landing and bug report in the mock look) |
| 2026-10-27 03:17 | `a330106c4a` | ON-MAIN | 10/0/0/0 | builder/bb4-app2 | 🐛 fix(mvp): identify unreadable offline homes |  |
| 2026-10-27 03:17 | `b05ce23101` | PARTIAL | 5/1/1/0 | builder/bb4-app2 | 🐛 fix(mvp): retain refused repository commands | apps/mvp/src/features/commands/actions.ts: if (result._tag === "Success" && result.success._tag === "Done") return; apps/mvp/src/features/commands/actions.ts: main carried then changed it: bb772e7b57 (🐛 fix(mvp): await  |
| 2026-10-27 03:17 | `121ab7025d` | SUPERSEDED | 5/2/0/0 | builder/bb4-docs | 📝 fix(docs): render terminal agent options and token budgets | apps/site/scripts/gen-cli-reference.mjs: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:17 | `d61ab228cb` | ON-MAIN | 2/0/0/0 | builder/bb4-docs | 🐛 fix(docs): preserve literal flags in reference prose |  |
| 2026-10-27 03:17 | `8b25021deb` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 📝 fix(docs): state the CLI reference discovery scope |  |
| 2026-10-27 03:17 | `4b25112e89` | SUPERSEDED | 3/4/0/0 | builder/bb4-docs | 🐛 fix(docs): capture callable change and generator reference schemas | apps/site/scripts/gen-cli-data.mjs: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:18 | `4a09fdc9a4` | ON-MAIN | 3/0/0/0 | builder/bb4-docs | 🐛 fix(docs): keep short inline flags on one line |  |
| 2026-10-27 03:18 | `6aaa1a8a44` | ON-MAIN | 3/0/0/0 | builder/bb4-docs | 🐛 fix(docs): show horizontal table overflow on phones |  |
| 2026-10-27 03:18 | `50a36091c1` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 🐛 fix(docs): render captured CLI integration help |  |
| 2026-10-27 03:20 | `7026b52d45` | ON-MAIN | 3/0/0/0 | builder/bb4-app2 | 📝 fix(mvp): disclose GitHub prefill transmission |  |
| 2026-10-27 03:21 | `e7a6f6771b` | SUPERSEDED | 1/1/0/0 | builder/bb4-docs | 🧪 test(cli): retain the broken strict npm consumer and upgrade decision | apps/site/scripts/regressions/published-cli-types.test.mjs: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:21 | `1c0340fe9e` | ON-MAIN | 1/0/0/0 | builder/bb4-docs | 🧪 test(docs): align reference scope assertions |  |
| 2026-10-27 03:21 | `967918f8d6` | SUPERSEDED | 4/3/0/0 | builder/bb4-docs | 📝 fix(flows): run the quickstart against the published runtime export | packages/smithers/flows/docs/installation.md: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:22 | `7db7a18fb5` | PARTIAL | 1/0/31/7 | builder/bb4-app2 | 🐛 fix(mvp): track background launches in shared attention | apps/mvp/docs/features/notifications.md: ## Background dispatch progress; apps/mvp/docs/work/bugbash4-app2.md: status: done |
| 2026-10-27 03:24 | `e5ad4a7958` | SUPERSEDED | 7/1/0/0 | builder/bb4-docs | 🧪 test(docs): cover reference supplements and malformed capture failures | apps/site/scripts/gen-cli-reference.test.mjs: changed later in its stack (head 64c69c1597) |
| 2026-10-27 03:24 | `06d6413437` | ON-MAIN | 5/0/0/0 | builder/bb4-docs | 🧪 test(docs): declare reference regressions and published page checks |  |
| 2026-10-27 03:32 | `1306d2d3c3` | PARTIAL | 1/0/6/2 | builder/bb4-app2 | 🐛 fix(mvp): toast issue creation through its write receipt | apps/mvp/docs/features/issues.md: Create issue appears in the shared toast stack while it launches and while its o; apps/mvp/e2e/issue-progress.spec.ts: await expect.poll(() => operationToasts(page)).toEqual(expect.array |
| 2026-10-27 03:35 | `2ee1b2148e` | PARTIAL | 3/0/0/2 | builder/bb4-docs | 🐛 fix(cli): align packaged skills with removed agents | packages/smithers/test/CatalogCli.fixture.json: "agent": "run"; packages/smithers/test/CatalogCli.fixture.json: "method": "GET", |
| 2026-10-27 03:35 | `717f550e01` | PARTIAL | 1/0/7/2 | builder/bb4-app2 | 🐛 fix(mvp): toast TODO drafting and commitment | apps/mvp/docs/features/todos.md: Make TODO and Commit use the shared attention stack. Make TODO settles when its ; apps/mvp/e2e/todo-progress.spec.ts: await expect.poll(() => operationToasts(page)).toEqual(expect.arrayCo |
| 2026-10-27 04:39 | `10c28e38dd` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 🎨 style(docs): retain formatter output for regression assertions |  |
| 2026-10-27 04:39 | `1342e3c1ed` | ON-MAIN | 2/0/0/0 | builder/bb4-docs | 🧪 test(cli): isolate the known declaration failure from install failures |  |
| 2026-10-27 04:39 | `2789561154` | ON-MAIN | 1/0/0/0 | builder/bb4-docs | 🎨 style(cloudflare): format the latency benchmark expression |  |
| 2026-10-27 04:39 | `058da7957e` | ON-MAIN | 2/0/0/0 | builder/bb4-docs | 📝 fix(platform-node): label the private model host example |  |
| 2026-10-27 04:39 | `89d869b40d` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 📝 fix(targets): document the optional host port defaults |  |
| 2026-10-27 04:39 | `aa2228b412` | SUPERSEDED | 7/1/0/0 | builder/bb4-docs | 🧪 test(docs): exercise the generator against real capture directories | apps/site/PACKAGE.ts: main carried then changed it: fb190038b8 (🐛 fix(site): inventory configured domains and scoped docs routes) |
| 2026-10-27 04:39 | `10153926e4` | SUPERSEDED | 0/1/0/0 | builder/bb4-docs | 📝 fix(docs): name the clone action without a repository request | apps/site/docs/app/pages/commands.md: main carried then changed it: f7340c3e8f (🐛 fix(docs): reflect Guest access to conversation and clone commands) |
| 2026-10-27 04:39 | `7614bc6de9` | SUPERSEDED | 5/1/0/0 | builder/bb4-docs | 🐛 fix(docs): validate declared app routes linked by guides | apps/site/scripts/built-site.test.mjs: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 production followups and CLI references) |
| 2026-10-27 04:39 | `9386a89272` | ON-MAIN | 1/0/0/0 | builder/bb4-docs | 📝 fix(docs): qualify maintenance skill paths from the repository root |  |
| 2026-10-27 04:39 | `da248aac19` | ON-MAIN | 6/0/0/0 | builder/bb4-docs | 📝 fix(flows): pin and execute the documented published install |  |
| 2026-10-27 04:39 | `ed31d06135` | SUPERSEDED | 1/2/0/0 | builder/bb4-docs | 🐛 fix(cli): describe the TUI budget as an override | apps/site/scripts/gen-cli-data.test.mjs: changed later in its stack (head 64c69c1597) |
| 2026-10-27 04:41 | `92f06ac601` | PARTIAL | 4/2/0/1 | 39d8ecdc5b | 🐛 fix(cli): forward TUI daily cap and workspace flags | packages/smithers/test/TuiFlags.test.ts: afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: ; apps/mvp/docs/work/bugbash4-cli-docs.md: changed later in its stack (head 39d8ecdc5b) |
| 2026-10-27 04:42 | `28d08fc1a0` | PARTIAL | 40/4/0/1 | builder/bb5-app | 🐛 fix(mvp): return 404 for unsupported app documents | apps/mvp/worker/index.ts: const status = isAppRoute(url.pathname) ? 200 : 404; apps/mvp/docs/work/bugbash4-bb5-app.md: changed later in its stack (head a80b82ce4b) |
| 2026-10-27 04:43 | `97edf0d6d6` | SUPERSEDED | 1/2/0/0 | 39d8ecdc5b | 📝 fix(docs): reference deferred clock and native fact namespaces | packages/smithers/flows/engine-store/docs/api.md: main carried then changed it: 3b734cb691 (🧹 fix(lint): enforce import scopes and clear workspace gates) |
| 2026-10-27 04:43 | `058c34053a` | PARTIAL | 3/1/1/0 | 39d8ecdc5b | 📝 fix(engine): identify the owner and failure channel of identity conflicts | apps/site/package.json: "check:docs": "node --test --test-concurrency=1 scripts/support-matrix.test.mjs ; packages/smithers/flows/engine/docs/api.md: main carried then changed it: 3b734cb691 (🧹 fix(lint): enforce import |
| 2026-10-27 04:43 | `cc3f9671d0` | SUPERSEDED | 1/1/0/0 | 39d8ecdc5b | 📝 fix(cli): describe the actual TUI token cap default | packages/smithers/test/TuiFlags.test.ts: main carried then changed it: cc218226f2 (⚡ perf(cli): complete cache handoff for late process journeys) |
| 2026-10-27 04:44 | `a4271e418c` | SUPERSEDED | 5/1/0/0 | 39d8ecdc5b | 🐛 fix(cli): avoid loading browser sync through the native runtime barrel | apps/mvp/docs/work/bugbash4-cli-docs.md: changed later in its stack (head 39d8ecdc5b) |
| 2026-10-27 04:46 | `026021612a` | SUPERSEDED | 1/45/0/0 | 39d8ecdc5b | 📝 fix(docs): document verified public flow API members | apps/site/src/content/docs/docs/reference/api/canonical.mdx: main carried then changed it: 3b734cb691 (🧹 fix(lint): enforce import scopes and clear workspace gates) |
| 2026-10-27 04:47 | `00b4fbb9e6` | SUPERSEDED | 2/1/0/0 | builder/bb5-app | 🔀 chore(mvp): integrate pending write-admission prerequisite | apps/mvp/docs/features/issues.md: main carried then changed it: b450a52fc2 (🐛 fix(mvp): repair mobile layout and explain private browser limits) |
| 2026-10-27 04:47 | `26c9377564` | SUPERSEDED | 1/6/0/0 | 39d8ecdc5b | 📝 fix(build): reference public install and manifest helpers | apps/site/src/content/docs/docs/reference/api/build.mdx: main carried then changed it: 3b734cb691 (🧹 fix(lint): enforce import scopes and clear workspace gates) |
| 2026-10-27 04:47 | `40f1903e9d` | SUPERSEDED | 4/2/0/0 | 39d8ecdc5b | 📝 fix(harness): index lifecycle and fresh realm public modules | apps/site/src/content/docs/docs/reference/api/harness.mdx: main carried then changed it: 3b734cb691 (🧹 fix(lint): enforce import scopes and clear workspace gates) |
| 2026-10-27 04:47 | `835f5a035c` | SUPERSEDED | 1/2/0/0 | 39d8ecdc5b | 📝 fix(agent): state the one-hour default quota park ceiling | apps/site/src/content/docs/docs/reference/api/agent.mdx: main carried then changed it: 3b734cb691 (🧹 fix(lint): enforce import scopes and clear workspace gates) |
| 2026-10-27 04:48 | `4805577f0d` | SUPERSEDED | 15/27/0/0 | 39d8ecdc5b | 📝 fix(site): explain the private UI contributor reference | apps/site/docs/reference/api/index.mdx: main carried then changed it: 1c1d58de23 (📝 fix(site): include every published library in the API index) |
| 2026-10-27 04:48 | `2509fe5fa5` | ON-MAIN | 3/0/0/0 | 39d8ecdc5b | 📝 fix(site): list published build targets and views references |  |
| 2026-10-27 04:49 | `b73a47a6ab` | ON-MAIN | 1/0/0/0 | builder/bb4-docs | 🎨 style(cli): format the skill loader import |  |
| 2026-10-27 04:51 | `2a0177fac5` | ON-MAIN | 17/0/0/0 | builder/bb5-app | 🐛 fix(tanstack-db): keep repository identities out of diagnostics |  |
| 2026-10-27 04:58 | `3da7216162` | PARTIAL | 62/2/1/3 | builder/bb4-docs | 📝 docs: regenerate synchronized command and guide projections | apps/site/public/docs/reference/cli.md: \| `--verbose` \| boolean \| `false` \| no \| Show redacted diagnostic details \|; apps/site/public/llms-full.txt: \| `--verbose` \| boolean \| `false` \| no \| Show redacted diagnostic detai |
| 2026-10-27 04:59 | `3c8b8bfdd3` | ON-MAIN | 4/0/0/0 | builder/bb4-docs | 🧪 test(docs): capture the real CLI without replacing its services |  |
| 2026-10-27 05:03 | `64c69c1597` | ON-MAIN | 1/0/0/0 | builder/bb4-docs | 📝 docs: record bug bash evidence and remaining validation gates |  |
| 2026-10-27 05:03 | `aee1dd2975` | ON-MAIN | 2/0/0/0 | builder/bb4-docs | 🐛 fix(docs): render captures from the selected reference directory |  |
| 2026-10-27 05:18 | `e6fbc25450` | PARTIAL | 4/0/0/1 | builder/bb5-app | 🐛 fix(site): omit the noindex bug redirect from the sitemap | apps/site/package.json: "test": "node --test --test-concurrency=1 scripts/record-tape.test.mjs scripts/s |
| 2026-10-27 05:19 | `f6cb5dd0af` | ON-MAIN | 20/0/0/0 | builder/bb5-app | 🐛 fix(mvp): redact repository paths before browser telemetry leaves |  |
| 2026-10-27 05:40 | `1d67551546` | ON-MAIN | 10/0/0/0 | builder/bb5-app | 🐛 fix(mvp): settle visitor issue counts from public snapshots |  |
| 2026-10-27 05:42 | `32087e268b` | SUPERSEDED | 17/4/0/0 | builder/bb5-app | 🐛 fix(mvp): explain unavailable repository issue lists | apps/mvp/src/features/repo/actions.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide first run and narrow AUTH-8 to repository conversations and clone caps) |
| 2026-10-27 05:51 | `a80b82ce4b` | PARTIAL | 237/19/1/1 | builder/bb5-app | 🐛 fix(mvp): durably admit every device write before returning | apps/mvp/src/features/commands/commands.test.ts: import { Deferred, Effect, type ManagedRuntime, Metric } from "effect"; apps/mvp/src/features/commands/commands.ts: readonly choose: (index: number, how: "accept" \| "compl |
| 2026-10-27 06:22 | `d1d3cc9af8` | PARTIAL | 64/12/3/1 | builder/w12-followups | 🐛 fix(mvp): repair W12 production followups | apps/mvp/src/features/commands/commands.test.ts: import { choose as chooseCommand, submit as submitCommand } from "./actions"; apps/mvp/src/features/commands/commands.test.ts: Commands \| Chat \| ChatStore \| CommandsStore  |
| 2026-10-27 09:38 | `509d4fcaf0` | SUPERSEDED | 6/4/0/0 | builder/auth 321ccd7c31 | 📝 docs(site): walk the quickstart through the first run | apps/site/docs/app/pages/quickstart.md: changed later in its stack (head a33f7fcaea, 321ccd7c31, 62d8a6f3ce) |
| 2026-10-27 09:38 | `da66767c1d` | PARTIAL | 55/9/0/2 | builder/auth 321ccd7c31 | ✨ feat(mvp): guide a new person's first run on /app | apps/mvp/docs/features/first-run.md: \| `tests/FirstRun.test.ts` \| the views' markup in each state: the one sign-in li; apps/mvp/tests/FirstRun.test.ts: test("the steps, the composer's place and the header's sign-in, for  |
| 2026-10-27 09:38 | `b17602651c` | SUPERSEDED | 14/4/0/0 | builder/auth 321ccd7c31 | 🧪 test(mvp): brand-new local people and a scripted hello for end-to-end tests | apps/mvp/e2e/devices.ts: changed later in its stack (head a33f7fcaea, 321ccd7c31, 62d8a6f3ce) |
| 2026-10-27 09:38 | `d60764abc7` | SUPERSEDED | 14/2/0/0 | builder/auth 321ccd7c31 | ✨ feat(mvp): tell a visitor whether the deployment's own model answers | apps/mvp/src/features/auth/actions.ts: changed later in its stack (head a33f7fcaea, 321ccd7c31, 62d8a6f3ce) |
| 2026-10-27 09:38 | `da5b4eda61` | SUPERSEDED | 6/4/0/0 | builder/who-may-ask | 📝 docs(site): walk the quickstart through the first run | apps/site/docs/app/pages/quickstart.md: changed later in its stack (head 650117a1db) |
| 2026-10-27 09:38 | `a5146c03eb` | PARTIAL | 55/9/0/2 | builder/who-may-ask | ✨ feat(mvp): guide a new person's first run on /app | apps/mvp/docs/features/first-run.md: \| `tests/FirstRun.test.ts` \| the views' markup in each state: the one sign-in li; apps/mvp/tests/FirstRun.test.ts: test("the steps, the composer's place and the header's sign-in, for  |
| 2026-10-27 09:38 | `76a976fbe1` | SUPERSEDED | 14/4/0/0 | builder/who-may-ask | 🧪 test(mvp): brand-new local people and a scripted hello for end-to-end tests | apps/mvp/e2e/devices.ts: changed later in its stack (head 650117a1db) |
| 2026-10-27 09:38 | `2db5992275` | SUPERSEDED | 14/2/0/0 | builder/who-may-ask | ✨ feat(mvp): tell a visitor whether the deployment's own model answers | apps/mvp/src/features/auth/actions.ts: changed later in its stack (head 650117a1db) |
| 2026-10-27 09:53 | `39d8ecdc5b` | ON-MAIN | 19/0/0/0 | 39d8ecdc5b | 📝 fix(site): include every published library in the API index |  |
| 2026-10-27 09:53 | `d91d9a9d1f` | SUPERSEDED | 15/1/0/0 | 39d8ecdc5b | 📝 fix(ui): document public helpers and component props | packages/smithers/ui/docs/api.md: main carried then changed it: b65aa03472 (✨ feat(timeline): rebuild the rail to the mock, with logical phases) |
| 2026-10-27 09:53 | `6018d42a46` | ON-MAIN | 2/0/0/0 | 39d8ecdc5b | 🧪 test(crypto): guard every public API reference entry |  |
| 2026-10-27 09:53 | `58bfddf672` | ON-MAIN | 5/0/0/0 | 39d8ecdc5b | 📝 fix(build): document the index command |  |
| 2026-10-27 09:53 | `43cf66f8c6` | ON-MAIN | 10/0/0/0 | 39d8ecdc5b | 📝 fix(cli): document branch TODO and operator operations |  |
| 2026-10-27 10:09 | `420dad6229` | ON-MAIN | 15/0/0/0 | bf9dcdee57 | 🐛 fix(engine-store): create quickstart database parents |  |
| 2026-10-27 10:20 | `5c4ab688a3` | ON-MAIN | 15/0/0/0 | bf9dcdee57 | 🐛 fix(cli): select executable CI renderers |  |
| 2026-10-27 10:25 | `bf9dcdee57` | SUPERSEDED | 16/1/0/0 | bf9dcdee57 | 🐛 fix(cli): retire orphaned generated create-app skills | packages/repo-targets/contracts/fixtures/public-export-surface.json: landed as 67f85a3588 (same author and time, committed later) |
| 2026-10-27 10:26 | `069c784f0a` | SUPERSEDED | 21/1/0/0 | builder/bb6-cli | 🐛 fix(memory): retain message timestamps on idempotent retries | apps/mvp/docs/work/package-bugbash4-cli.md: main carried then changed it: 3b6b30a14d (🐛 fix(build-cli): cache successful Filegroup results) |
| 2026-10-27 10:26 | `16357a3f21` | SUPERSEDED | 19/1/0/0 | 62d8a6f3ce | 🐛 fix(memory): retain message timestamps on idempotent retries | apps/mvp/docs/work/package-bugbash4-cli.md: main carried then changed it: 3b6b30a14d (🐛 fix(build-cli): cache successful Filegroup results) |
| 2026-10-27 10:52 | `29b7b4d3bf` | PARTIAL | 0/6/38/3 | builder/toasts2 f02a185170 | 🐛 fix(mvp): keep branch launch progress through completion | apps/mvp/docs/decisions/0121-operation-progress.md: 2026-10-27. Implements the existing instant-chat rule and decision 0009 for `/ne; apps/mvp/docs/features/notifications.md: `/new` reserves device progress before cleari |
| 2026-10-27 10:52 | `6c5d84c8cb` | PARTIAL | 0/5/38/4 | 618f8d2383 | 🐛 fix(mvp): keep branch launch progress through completion | apps/mvp/docs/decisions/0121-operation-progress.md: 2026-10-27. Implements the existing instant-chat rule and decision 0009 for `/ne; apps/mvp/docs/features/notifications.md: `/new` reserves device progress before cleari |
| 2026-10-27 10:56 | `61fa01fba5` | PARTIAL | 3/2/13/5 | builder/toasts2 f02a185170 | 🐛 fix(mvp): project shared issue progress from admission receipts | apps/mvp/docs/features/issues.md: Create issue also appears in the shared toast stack. Progress reads the existing; apps/mvp/e2e/issue-progress.spec.ts: test("Create issue: shared progress follows its write across naviga |
| 2026-10-27 10:56 | `9c9b33924b` | PARTIAL | 3/2/13/5 | 618f8d2383 | 🐛 fix(mvp): project shared issue progress from admission receipts | apps/mvp/docs/features/issues.md: Create issue also appears in the shared toast stack. Progress reads the existing; apps/mvp/e2e/issue-progress.spec.ts: test("Create issue: shared progress follows its write across naviga |
| 2026-10-27 10:58 | `4541d349a0` | PARTIAL | 4/3/55/9 | builder/toasts2 f02a185170 | 🐛 fix(mvp): keep shared TODO progress through its real receipt | apps/mvp/docs/decisions/0121-operation-progress.md: Retry resolves the exact retained identity before looking for another pending re; apps/mvp/docs/features/notifications.md: Operation presentation writes trace `notifica |
| 2026-10-27 10:58 | `618f8d2383` | PARTIAL | 4/0/58/9 | 618f8d2383 | 🐛 fix(mvp): keep shared TODO progress through its real receipt | apps/mvp/docs/decisions/0121-operation-progress.md: Retry resolves the exact retained identity before looking for another pending re; apps/mvp/docs/features/notifications.md: Operation presentation writes trace `notifica |
| 2026-10-27 10:58 | `0b5092ff58` | ON-MAIN | 11/0/0/0 | dab3fbbb2c | 🐛 fix(mvp): fence branch startup and preserve symbol lookups |  |
| 2026-10-27 11:03 | `bd973afb82` | ON-MAIN | 5/0/0/0 | builder/bb6-cli | 🐛 fix(cli): classify trigger declaration errors as user input |  |
| 2026-10-27 11:03 | `419ed39df7` | SUPERSEDED | 3/1/0/0 | builder/bb6-cli | 🐛 fix(cli): report a missing host installation clearly | packages/smithers/docs/guides/wire-the-mcp-server.md: main carried then changed it: 5bcd94cba3 (🐛 fix(cli): answer malformed MCP JSON without losing later requests) |
| 2026-10-27 11:03 | `8833c0e8b4` | ON-MAIN | 4/0/0/0 | builder/bb6-cli | 📝 fix(cli): align MCP tool examples with discovery |  |
| 2026-10-27 11:03 | `753d7d8137` | ON-MAIN | 6/0/0/0 | builder/bb6-cli | 📝 fix(cli): describe memory namespaces tags and time units |  |
| 2026-10-27 11:03 | `f77c50f23a` | ON-MAIN | 7/0/0/0 | builder/bb6-cli | 🐛 fix(cli): keep evaluation JSON output free of logs |  |
| 2026-10-27 11:03 | `4650a4a403` | ON-MAIN | 5/0/0/0 | 62d8a6f3ce | 🐛 fix(cli): classify trigger declaration errors as user input |  |
| 2026-10-27 11:03 | `158918eb8d` | SUPERSEDED | 3/1/0/0 | 62d8a6f3ce | 🐛 fix(cli): report a missing host installation clearly | packages/smithers/docs/guides/wire-the-mcp-server.md: main carried then changed it: 5bcd94cba3 (🐛 fix(cli): answer malformed MCP JSON without losing later requests) |
| 2026-10-27 11:03 | `cbf5f21756` | ON-MAIN | 4/0/0/0 | 62d8a6f3ce | 📝 fix(cli): align MCP tool examples with discovery |  |
| 2026-10-27 11:03 | `fd2fd2340f` | ON-MAIN | 6/0/0/0 | 62d8a6f3ce | 📝 fix(cli): describe memory namespaces tags and time units |  |
| 2026-10-27 11:03 | `c894f7733f` | ON-MAIN | 7/0/0/0 | 62d8a6f3ce | 🐛 fix(cli): keep evaluation JSON output free of logs |  |
| 2026-10-27 11:04 | `e0ac500e64` | SUPERSEDED | 10/1/0/0 | builder/bb6-cli | 🐛 fix(build-cli): cache successful Filegroup results | apps/mvp/docs/work/package-bugbash4-cli.md: main carried then changed it: 892bbbf763 (🐛 fix(build-cli): type gate refusals and retain execution receipts) |
| 2026-10-27 11:04 | `ea79553a91` | ON-MAIN | 3/0/0/0 | builder/bb6-cli | 📝 fix(cli): document the MCP doctor command |  |
| 2026-10-27 11:04 | `4acc06be74` | SUPERSEDED | 14/1/0/0 | builder/bb6-cli | 🐛 fix(cli): answer malformed MCP JSON without losing later requests | packages/smithers/test/McpTransport.test.ts: main carried then changed it: c57aa856b6 (✅ test(cli): check MCP tool middleware against a fixture install) |
| 2026-10-27 11:04 | `087f0a7f0a` | SUPERSEDED | 7/1/0/0 | builder/bb6-cli | 🐛 fix(build-cli): resolve absolute owner paths within the workspace | packages/smithers/build/build-cli/src/Owners.ts: main carried then changed it: 417af8c017 (🐛 fix(build-cli): map owners paths spelled through a symlinked workspace alias) |
| 2026-10-27 11:04 | `f9e3a2ee2b` | SUPERSEDED | 6/1/0/0 | 62d8a6f3ce | 🐛 fix(build-cli): cache successful Filegroup results | apps/mvp/docs/work/package-bugbash4-cli.md: main carried then changed it: 892bbbf763 (🐛 fix(build-cli): type gate refusals and retain execution receipts) |
| 2026-10-27 11:04 | `3128b927b9` | ON-MAIN | 3/0/0/0 | 62d8a6f3ce | 📝 fix(cli): document the MCP doctor command |  |
| 2026-10-27 11:04 | `889db1de5b` | SUPERSEDED | 7/2/0/0 | 62d8a6f3ce | 🐛 fix(cli): retain scaffold dispatch with MCP transport cleanup | packages/smithers/src/Cli.ts: landed as 5bcd94cba3 (same author and time, committed later) |
| 2026-10-27 11:04 | `c27ba8c9a1` | SUPERSEDED | 7/1/0/0 | 62d8a6f3ce | 🐛 fix(build-cli): resolve absolute owner paths within the workspace | packages/smithers/build/build-cli/src/Owners.ts: main carried then changed it: 417af8c017 (🐛 fix(build-cli): map owners paths spelled through a symlinked workspace alias) |
| 2026-10-27 11:10 | `dab3fbbb2c` | SUPERSEDED | 25/2/0/0 | dab3fbbb2c | 🧪 fix(mvp): preserve the behavior of W13 follow-up journeys | apps/mvp/e2e/repo-browse.spec.ts: landed as d97e8f6ec5 (same author and time, committed later) |
| 2026-10-27 13:29 | `85463b1edd` | PARTIAL | 34/6/6/1 | builder/auth 321ccd7c31 | 📝 docs(mvp): who may ask, ruling AUTH-8 and decision 0122 | apps/mvp/docs/decisions/0122-who-may-ask.md: - Records, none with a person's id or content: `chat.question`, `repo.clone.requ; apps/mvp/docs/features/sandbox-budgets.md: \| A person's own branch machines' hours per UTC da |
| 2026-10-27 13:29 | `dce268bc03` | PARTIAL | 170/8/86/7 | builder/auth 321ccd7c31 | ✨ feat(mvp): anyone signed in asks on a repository where they are a Member (AUTH-8) | apps/mvp/db/Database.test.ts: for (const failure of ["start_timeout", "lost", "path", "not_found", "not_a_file; apps/mvp/db/Database.ts: import sandboxDailyLimit from "./migrations/0072_sandbox_daily_limit.ts"; apps/mvp/ |
| 2026-10-27 13:29 | `bbdbb128ec` | PARTIAL | 34/6/6/1 | builder/who-may-ask | 📝 docs(mvp): who may ask, ruling AUTH-8 and decision 0122 | apps/mvp/docs/decisions/0122-who-may-ask.md: - Records, none with a person's id or content: `chat.question`, `repo.clone.requ; apps/mvp/docs/features/sandbox-budgets.md: \| A person's own branch machines' hours per UTC da |
| 2026-10-27 13:29 | `ca05763bcf` | ON-MAIN | 1/0/0/0 | builder/who-may-ask | 🧪 test(mvp): resync's conflict case writes another size than git's checkout |  |
| 2026-10-27 13:29 | `7dc5af5c24` | PARTIAL | 170/8/86/7 | builder/who-may-ask | ✨ feat(mvp): anyone signed in asks on a repository where they are a Member (AUTH-8) | apps/mvp/db/Database.test.ts: for (const failure of ["start_timeout", "lost", "path", "not_found", "not_a_file; apps/mvp/db/Database.ts: import sandboxDailyLimit from "./migrations/0072_sandbox_daily_limit.ts"; apps/mvp/ |
| 2026-10-27 16:04 | `86f688d42c` | SUPERSEDED | 13/11/0/0 | 86f688d42c | 🐛 fix(mvp): retain write inputs before asynchronous admission | apps/mvp/docs/decisions/0122-write-input-receipts.md: main deleted it in a29c886b0c (📝 docs(mvp): record confirmed write-source cleanup) |
| 2026-10-27 16:04 | `111179544c` | SUPERSEDED | 40/19/0/0 | 618f8d2383 | 🐛 fix(mvp): retain write inputs before asynchronous admission | apps/mvp/docs/decisions/0122-write-input-receipts.md: main deleted it in a29c886b0c (📝 docs(mvp): record confirmed write-source cleanup) |
| 2026-10-27 16:08 | `790645f366` | SUPERSEDED | 21/2/0/0 | 55d2437b03 | 🐛 fix(mvp): preserve report focus and live pull comparisons | apps/mvp/docs/features/pulls.md: main carried then changed it: d3985028c7 (✨ feat(pulls): review on request for any open pull request (0129)) |
| 2026-10-27 16:29 | `764e1898c8` | SUPERSEDED | 11/2/0/0 | 618f8d2383 | 🐛 fix(mvp): prefer admitted writes over stale recovery rows | apps/mvp/docs/features/issues.md: main carried then changed it: a48a1333fc (🐛 fix(mvp): retire slash issue receipts without form navigation) |
| 2026-10-27 16:37 | `d5f0facae9` | ON-MAIN | 4/0/0/0 | 618f8d2383 | 🧪 fix(mvp): preserve the configured session in WebKit devices |  |
| 2026-10-27 16:45 | `23a19aff65` | ON-MAIN | 6/0/0/0 | 618f8d2383 | 🐛 fix(mvp): preserve newer drafts when admission completes |  |
| 2026-10-27 16:51 | `e40d3b845a` | ON-MAIN | 1/0/0/0 | 618f8d2383 | 🧪 fix(mvp): locate the unavailable write state by its text |  |
| 2026-10-27 16:52 | `55d2437b03` | PARTIAL | 12/5/1/0 | 55d2437b03 | 🧪 fix(mvp): preserve strict errors across WebKit navigation | apps/mvp/e2e/repo-browse.spec.ts: expectConsoleError(`Refused to load ${new URL(`${SPOON}/blob/main/styles.css`, b; apps/mvp/docs/infrastructure.md: main carried then changed it: 83f457a48c (🧪 fix(mvp): isolate WebKit p |
| 2026-10-27 16:52 | `38d77be08e` | ON-MAIN | 14/0/0/0 | 55d2437b03 | 🔎 feat(electric): identify each shape request phase |  |
| 2026-10-27 16:53 | `b70ac74b1c` | SUPERSEDED | 7/2/0/0 | 618f8d2383 | 🐛 fix(mvp): finish and fence explicit write retries | apps/mvp/src/writeAdmission.ts: main carried then changed it: e14f3bc21c (✨ feat(mvp): show background progress as a projection of receipts) |
| 2026-10-27 16:53 | `cd102ca007` | ON-MAIN | 1/0/0/0 | 618f8d2383 | 🧪 fix(mvp): assert the dropped TODO article |  |
| 2026-10-27 16:55 | `2281395bd0` | ON-MAIN | 4/0/0/0 | 618f8d2383 | 🧪 fix(mvp): read fresh snapshots when polling TODO cleanup |  |
| 2026-10-27 17:03 | `7bb998d0c3` | PARTIAL | 16/0/1/1 | builder/auth 321ccd7c31 | ✨ feat(mvp): cap clone reservations per person | apps/mvp/worker/ExecutionHost.test.ts: const budgets = { maxRepositories: 100, clonesPerPerson: 3, maxStoredBytes: 3e9,; apps/mvp/worker/Repos.ts: if (mine!.n >= limits.clonesPerPerson && existing?.requestedBy !== reques |
| 2026-10-27 17:03 | `5d55c55fd6` | PARTIAL | 16/0/1/1 | builder/who-may-ask | ✨ feat(mvp): cap clone reservations per person | apps/mvp/worker/ExecutionHost.test.ts: const budgets = { maxRepositories: 100, clonesPerPerson: 3, maxStoredBytes: 3e9,; apps/mvp/worker/Repos.ts: if (mine!.n >= limits.clonesPerPerson && existing?.requestedBy !== reques |
| 2026-10-27 17:04 | `838ab4b68a` | SUPERSEDED | 4/4/0/0 | 618f8d2383 | 🐛 fix(mvp): await slash source cleanup before retiring its receipt | apps/mvp/src/features/commands/actions.ts: main carried then changed it: e14f3bc21c (✨ feat(mvp): show background progress as a projection of receipts) |
| 2026-10-27 17:05 | `c8b25bca51` | PARTIAL | 1/0/25/3 | builder/auth 321ccd7c31 | ✨ feat(mvp): cap concurrent TODO machines per person | apps/mvp/worker/BranchSandboxes.ts: const todoMachines = yield* Budget.todoMachinesPerPerson.pipe(Effect.orDie); apps/mvp/worker/BranchSandboxes.ts: stop: Effect.andThen(Machine.save(machine, generation).pipe(Effect.igno |
| 2026-10-27 17:05 | `0e08398476` | ON-MAIN | 6/0/0/0 | 618f8d2383 | 🐛 fix(effect-tanstack-db): expose pending write receipts by key |  |
| 2026-10-27 17:05 | `061266093c` | PARTIAL | 1/0/25/3 | builder/who-may-ask | ✨ feat(mvp): cap concurrent TODO machines per person | apps/mvp/worker/BranchSandboxes.ts: const todoMachines = yield* Budget.todoMachinesPerPerson.pipe(Effect.orDie); apps/mvp/worker/BranchSandboxes.ts: stop: Effect.andThen(Machine.save(machine, generation).pipe(Effect.igno |
| 2026-10-27 17:05 | `0f0ce956e2` | SUPERSEDED | 19/5/0/0 | 618f8d2383 | 🐛 fix(mvp): expose refused TODO input admission | apps/mvp/e2e/faults.ts: main carried then changed it: a607f642cb (🧪 fix(mvp): isolate the write-admission host fault) |
| 2026-10-27 17:19 | `edea3cfd32` | PARTIAL | 2/0/14/1 | builder/auth 321ccd7c31 | 📝 docs(mvp): record W16 write receipts and per-person admission caps | apps/mvp/docs/decisions/0122-who-may-ask.md: or retry loop is added. A started TODO retains its slot until confirmed stopped;; apps/mvp/docs/decisions/0122-who-may-ask.md: Postgres was unavailable. Every wake of a runnin |
| 2026-10-27 17:19 | `650117a1db` | PARTIAL | 2/0/14/1 | builder/who-may-ask | 📝 docs(mvp): record clone and TODO admission caps | apps/mvp/docs/decisions/0122-who-may-ask.md: or retry loop is added. A started TODO retains its slot until confirmed stopped;; apps/mvp/docs/decisions/0122-who-may-ask.md: Postgres was unavailable. Every wake of a runnin |
| 2026-10-27 17:28 | `1947f74931` | ON-MAIN | 2/0/0/0 | 618f8d2383 | 🧪 fix(mvp): release the device turn after late SQLite callbacks |  |
| 2026-10-27 17:34 | `b3b2441ed3` | ON-MAIN | 10/0/0/0 | 618f8d2383 | 🧪 fix(mvp): isolate the write-admission host fault |  |
| 2026-10-27 17:34 | `d32d801af8` | ON-MAIN | 3/0/0/0 | 618f8d2383 | 🐛 fix(mvp): fence retry aliases after an identity receipt refuses |  |
| 2026-10-27 17:34 | `180a5feff6` | SUPERSEDED | 15/1/0/0 | 618f8d2383 | 🐛 fix(mvp): share confirmed composer cleanup across write recovery | apps/mvp/src/features/commands/actions.ts: main carried then changed it: e14f3bc21c (✨ feat(mvp): show background progress as a projection of receipts) |
| 2026-10-27 17:34 | `017f2ce657` | SUPERSEDED | 24/4/0/0 | 618f8d2383 | 🐛 fix(mvp): distinguish retyped command source generations | apps/mvp/src/features/commands/actions.ts: main carried then changed it: e14f3bc21c (✨ feat(mvp): show background progress as a projection of receipts) |
| 2026-10-27 17:40 | `3de55a2662` | ON-MAIN | 2/0/0/0 | 618f8d2383 | 🎨 style(effect-tanstack-db): satisfy the existing formatter gate |  |
| 2026-10-27 17:46 | `e547c3cc7f` | ON-MAIN | 3/0/0/0 | 618f8d2383 | 📝 docs(mvp): record confirmed write-source cleanup |  |
| 2026-10-27 18:06 | `303d0545eb` | SUPERSEDED | 6/1/0/0 | 618f8d2383 | 🧪 test(mvp): cover refused write-source receipts | apps/mvp/docs/work/w14-writes.md: main carried then changed it: a48a1333fc (🐛 fix(mvp): retire slash issue receipts without form navigation) |
| 2026-10-27 19:24 | `f02a185170` | PARTIAL | 11/0/131/6 | f02a185170 | 🐛 fix(mvp): reconcile progress across interrupted write admission | apps/mvp/docs/decisions/0121-operation-progress.md: On reload, a Commit notice is presentation rather than admission evidence. Recon; apps/mvp/docs/features/issues.md: A resumed Create issue stays Requested while its rec |
| 2026-10-27 19:24 | `62d8a6f3ce` | PARTIAL | 13/1/1/0 | 62d8a6f3ce | 🧪 test(cli): cover MCP lifetime and operator error branches | apps/mvp/docs/work/package-bugbash4-cli.md: owner: bb6-cli2; packages/smithers/test/McpTransport.test.ts: main carried then changed it: c57aa856b6 (✅ test(cli): check MCP tool middleware against a fixture install) |
| 2026-10-27 20:47 | `c19955e568` | PARTIAL | 9/3/3/0 | builder/auth 321ccd7c31 | 🐛 fix(mvp): close failed TODO starts and scope recovered writes and slash authority | apps/mvp/docs/decisions/0122-who-may-ask.md: Failed TODO startup stops the actual container before closing its durable budget; apps/mvp/worker/branch/Budget.test.ts: expect(await runtime.runPromiseExit(Budget.failedWake( |
| 2026-10-27 20:51 | `4bbb57c3f9` | ON-MAIN | 30/0/0/0 | builder/w15-webkit | 🧪 fix(mvp): isolate WebKit devices and prove departure diagnostics |  |
| 2026-10-27 22:03 | `7ec478c2f6` | SCAFFOLD | 37/0/75/7 | builder/auth 321ccd7c31 | checkpoint(auth): preserve Astra round 9 working copy before scope reduction | .changeset/confirmed-machine-ownership.md: Add SandboxObject.wakeRunning to reconfigure an existing container without start; apps/mvp/db/Database.test.ts: SELECT indexdef AS definition FROM pg_indexes WHERE schemaname =  |
| 2026-10-28 00:35 | `70cd464d09` | PARTIAL | 0/2/70/3 | builder/toasts2 | 🐛 fix(mvp): retain notice generations and abandoned-owner evidence | apps/mvp/docs/decisions/0121-operation-progress.md: Failure presentation is background metadata: the action releases its input and f; apps/mvp/src/boot.ts: AttentionStore.layer({ origin, tabId: host.editorTabId, lock: ho |
| 2026-10-28 00:35 | `e75d8dfa55` | PARTIAL | 1/10/32/0 | builder/toasts2 | 🐛 fix(mvp): timestamp failed progress from the real refusal receipt | apps/mvp/docs/decisions/0121-operation-progress.md: Local refusal receipts include their actual time. Repeated delivery refuses keep; apps/mvp/src/device/history.ts: export const IssueRequestedV3 = Schema.Struct({ ...Iss |
| 2026-10-28 00:35 | `62cd70f9e2` | PARTIAL | 1/2/7/0 | builder/toasts2 | 🐛 fix(mvp): fence the first retained Create issue recovery row | apps/mvp/docs/decisions/0121-operation-progress.md: Confirmed terminal flow evidence is monotonic across both tab-local inspection a; apps/mvp/docs/features/notifications.md: A confirmed terminal flow receipt shared by a |
| 2026-10-28 00:35 | `1b1f1dede1` | STRANDED | 0/0/6/0 | builder/toasts2 | 🐛 fix(mvp): prefer shared terminal evidence over older local Working proof | apps/mvp/src/flows/progress.test.ts: import { ConversationNew } from "../features/conversations/flows"; apps/mvp/src/flows/progress.test.ts: for (const state of ["waiting", "working"] as const) expect(confirmedProgress(r |
| 2026-10-28 00:35 | `02844075cb` | PARTIAL | 3/7/25/1 | builder/toasts2 | 🐛 fix(mvp): fence cross-tab progress with durable admission tokens | apps/mvp/docs/decisions/0121-operation-progress.md: The local recovery row distinguishes admission-in-progress from actual Not sent ; apps/mvp/docs/features/notifications.md: Recovery rows retain an admission-attempt tok |
| 2026-10-28 00:35 | `1e7acbc65d` | PARTIAL | 0/5/22/1 | builder/toasts2 | 🐛 fix(mvp): correlate Commit progress with its admitting tab | apps/mvp/docs/decisions/0121-operation-progress.md: Commit’s local progress schema v2 adds optional stable tab ownership without cha; apps/mvp/docs/features/notifications.md: A Commit intent retains its originating tab I |
| 2026-10-28 00:35 | `d42c45a647` | PARTIAL | 0/0/1/1 | builder/toasts2 | 🐛 fix(mvp): release the synchronous Discard action immediately | apps/mvp/docs/work/toasts2.md: updated: 2026-10-28T05:03:00Z; apps/mvp/src/features/todos/actions.ts: yield* store.removeDraft(draft.value).pipe(Effect.andThen(record("discard_draft" |
| 2026-10-28 00:35 | `3a5762c084` | PARTIAL | 0/2/18/0 | builder/toasts2 | 🐛 fix(mvp): retain consumed draft identities across delivery retries | apps/mvp/docs/decisions/0121-operation-progress.md: Draft removal retains an id-only receipt before deleting its matching source, se; apps/mvp/docs/features/todos.md: Discard and Commit cleanup persist an id-only draft-r |
| 2026-10-28 00:35 | `83eb2a5099` | ON-MAIN | 1/0/0/0 | builder/toasts2 | 🧪 test(platform-browser): assert mode bits without privileged access checks |  |
| 2026-10-28 00:35 | `1be995b47a` | PARTIAL | 1/0/16/0 | builder/toasts2 | 🐛 fix(platform-browser): announce recovery for unfinished progress inspection | apps/mvp/docs/decisions/0121-operation-progress.md: Unfinished engine progress is inspected again on a new leader announcement, incl; apps/mvp/docs/features/notifications.md: Retained Commit sources recheck repository au |
| 2026-10-28 00:35 | `296075d579` | ON-MAIN | 3/0/0/0 | builder/toasts2 | 🎨 style(platform-browser): satisfy the existing formatter gate |  |
| 2026-10-28 00:35 | `b700372146` | PARTIAL | 2/2/26/0 | builder/toasts2 | 🐛 fix(mvp): preserve terminal proof across presentation rollback | apps/mvp/docs/decisions/0121-operation-progress.md: Confirmed engine progress lives in a local collection independently of the persi; apps/mvp/src/features/attention/actions.ts: const current = yield* progress.get(id); a |
| 2026-10-28 00:35 | `a9236605ca` | PARTIAL | 0/5/14/0 | builder/toasts2 | 🐛 fix(mvp): preserve restored issue admission and refusal feedback | apps/mvp/docs/decisions/0121-operation-progress.md: A terminal engine receipt lives in a local collection independently of the persi; apps/mvp/docs/features/issues.md: A resumed Create issue stays Requested while its rec |
| 2026-10-28 00:35 | `989b55f1b8` | PARTIAL | 0/2/5/0 | builder/toasts2 | 🐛 fix(mvp): confirm the durable retry version before dispatch | apps/mvp/src/features/attention/actions.ts: import { FlowProgress, progressId, retentions as progressRetentions } from "../.; apps/mvp/src/features/attention/actions.ts: yield* Effect.logWithLevel(kept._tag === "Success" |
| 2026-10-28 00:35 | `bbb37dd6b4` | PARTIAL | 1/6/11/1 | builder/toasts2 | 🐛 fix(mvp): refresh recovery authority and fence resumed Commit | apps/mvp/docs/decisions/0121-operation-progress.md: Review follow-up: each successful device session confirmation restarts retained ; apps/mvp/src/features/attention/operationNotice.test.ts: import { check as checkSessio |
| 2026-10-28 00:35 | `289753bb82` | PARTIAL | 0/2/6/0 | builder/toasts2 | 🐛 fix(mvp): retain terminal engine proof independently of metadata | apps/mvp/src/flows/contract.ts: "smithers_flow_progress_retention",; apps/mvp/src/flows/progress.test.ts: import { operationNotice } from "../features/attention/operationNotice"; apps/mvp/src/flows/progress.test.ts: chan |
| 2026-10-28 00:35 | `5ba9a4b482` | PARTIAL | 2/2/14/1 | builder/toasts2 | 🐛 fix(mvp): reconcile orphan Commit notices after source restoration | apps/mvp/docs/decisions/0121-operation-progress.md: On reload, a Commit notice is presentation rather than admission evidence. Recon; apps/mvp/docs/features/todos.md: Interrupted Commit presentation refreshes repository  |
| 2026-10-28 00:36 | `111a75ef17` | PARTIAL | 0/0/18/1 | builder/toasts2 | 🐛 fix(mvp): preserve completion above failed notification versions | apps/mvp/docs/decisions/0121-operation-progress.md: Notification versions advance across same-id retries. Each reservation spans eig; apps/mvp/docs/features/notifications.md: Same-id Retry advances the notification versi |
| 2026-10-28 00:38 | `1ba8d1efde` | STRANDED | 0/0/2/0 | builder/toasts2 | 📝 docs(mvp): stop toast reconciliation at the design review limit | apps/mvp/docs/work/toasts2.md: updated: 2026-10-28T07:38:59Z; apps/mvp/docs/work/toasts2.md: Stopped at the requested review limit. Astra round eight found another cross-tab |
| 2026-10-28 00:38 | `30d2274d39` | STRANDED | 0/0/2/0 | builder/toasts2 | 🧪 test(mvp): expect the current TODO outbox migration payload | apps/mvp/src/device/migrations.test.ts: test("a queued TODO v1 write upgrades through v2 to v3 without losing its reques; apps/mvp/src/device/migrations.test.ts: expect(write.mutations[0].modified).toEqual({ ...source.mu |
| 2026-10-28 01:32 | `321ccd7c31` | SCAFFOLD | 0/0/1/0 | 321ccd7c31 | 🧪 test: temporary retirement crash red proof | apps/mvp/worker/branch/Startup.ts: yield* box.storage.put("retired", generation) |
| 2026-10-28 01:34 | `cc87e618b5` | SUPERSEDED | 89/5/0/0 | cc87e618b5 | ✨ feat(mvp): show background progress as a projection of receipts | apps/mvp/docs/decisions/0124-background-progress.md: main carried then changed it: f33bc37579 (🐛 fix(mvp): project committed TODO results after recovery cleanup) |
| 2026-10-28 01:34 | `60137de34d` | ON-MAIN | 8/0/0/0 | cc87e618b5 | ✨ feat(mvp): fold Create issue and Commit results into the person's feed |  |
| 2026-10-28 01:34 | `f13f678099` | ON-MAIN | 10/0/0/0 | cc87e618b5 | ✨ feat(platform-browser): follow the engine's runs by flow and window, reading again after a failed read |  |
| 2026-10-28 01:59 | `376d024e34` | PARTIAL | 166/20/0/9 | builder/auth | 🔒 fix(mvp): narrow AUTH-8 to conversations and distinct clone counts | apps/mvp/db/Database.test.ts: const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.r; apps/mvp/src/features/terminal/terminal.test.ts: await until(() => expect(tab.dispatched("done")).toBe(2));  |
| 2026-10-28 02:04 | `33f95c2ae8` | SUPERSEDED | 38/4/0/0 | builder/auth | 🔒 fix(mvp): guard shared terminals, branch machines and TODO steering | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild migration registration and merge device schema history) |
| 2026-10-28 02:19 | `2726478326` | SUPERSEDED | 17/1/0/0 | builder/auth | 🔒 fix(mvp): close terminal attachments when session authority changes | apps/mvp/docs/work/who-caps.md: changed later in its stack (head a33f7fcaea) |
| 2026-10-28 03:05 | `14ed9812cb` | SUPERSEDED | 3/1/0/0 | builder/auth | 🧪 test(mvp): qualify the narrowed auth boundary | apps/mvp/docs/work/who-caps.md: changed later in its stack (head a33f7fcaea) |
| 2026-10-28 04:35 | `a33f7fcaea` | ON-MAIN | 2/0/0/0 | builder/auth | 📚 docs(mvp): record paired auth full-suite qualification |  |
| 2026-10-28 05:20 | `2bf9537d13` | EMPTY-ISH | 0/0/0/0 | lander/w8mig-held | 🔧 chore: regenerate the lockfile and the target index for the VibeLang stack |  |
| 2026-10-28 05:20 | `9d424aa53e` | EMPTY-ISH | 0/0/0/0 | 9d424aa53e | 🔧 chore: regenerate the lockfile and the target index for the VibeLang stack |  |
| 2026-10-28 09:40 | `aab3082678` | PARTIAL | 26/3/1/3 | c499102e10 | 🐛 fix(mvp): show honest states when the browser engine cannot run | apps/mvp/docs/work/w17-private.md: contract. No memory engine, remote rerouting or durable-admission bypass is adde; apps/mvp/src/features/chat/engineAvailability.test.ts: import { engineStopped } from "./engineAvailabil |
| 2026-10-28 09:40 | `b44724fbcf` | SUPERSEDED | 29/2/0/0 | c499102e10 | 🐛 fix(mvp): repair W17 layout and browser durability checks | apps/mvp/docs/features/issues.md: changed later in its stack (head c499102e10) |
| 2026-10-28 09:40 | `e4b126616a` | PARTIAL | 31/1/1/3 | builder/w17-private | 🐛 fix(mvp): show honest states when the browser engine cannot run | apps/mvp/docs/work/w17-private.md: contract. No memory engine, remote rerouting or durable-admission bypass is adde; apps/mvp/src/features/chat/engineAvailability.test.ts: import { engineStopped } from "./engineAvailabil |
| 2026-10-28 09:40 | `aa86bdc1ff` | SUPERSEDED | 30/1/0/0 | builder/w17-ui | 🐛 fix(mvp): repair W17 layout and browser durability checks | apps/mvp/src/screens/docs/docs-screen.css: main carried then changed it: ab6e3e2bc8 (🎨 style(mvp): repository home, files, docs and branches in the shared frame) |
| 2026-10-28 13:56 | `c499102e10` | ON-MAIN | 3/0/0/0 | c499102e10 | 🐛 fix(mvp): integrate W19 browser availability and layout repairs |  |
| 2026-10-28 22:49 | `c0347a9c39` | ON-MAIN | 7/0/0/0 | c0347a9c39 | 🧪 fix(mvp): compare desktop pages with bounded exact PNG captures |  |
| 2026-10-29 01:29 | `a999d8d1ea` | ON-MAIN | 12/0/0/0 | 1423db6ecc | 🐛 fix(repo-targets): reject import rules with empty source scopes |  |
| 2026-10-29 02:09 | `5b58790328` | PARTIAL | 175/2/1/0 | 1423db6ecc | 🧹 fix(lint): resolve workspace source and formatting findings | packages/smithers/flows/engine-store/test/CycleDetectionSql.test.ts: import { tempDirectory } from "./TempDirectory.ts"; .smithers/home.json: main carried then changed it: c410c1346f (🐛 fix(home): send installation to i |
| 2026-10-29 02:09 | `a50bde216f` | ON-MAIN | 4/0/0/0 | 1423db6ecc | 🐛 fix(agent): preserve interruption during saved flow cleanup |  |
| 2026-10-29 02:09 | `e689ef98a2` | ON-MAIN | 3/0/0/0 | 1423db6ecc | 🐛 fix(build-cli): retain failure metadata for large argument vectors |  |
| 2026-10-29 02:09 | `b0984dc702` | ON-MAIN | 2/0/0/0 | 1423db6ecc | 🐛 fix(build): clear infrastructure test lint errors |  |
| 2026-10-29 03:38 | `1423db6ecc` | PARTIAL | 7/0/1/0 | 1423db6ecc | 🔧 fix(docs): budget measured guarded documentation checks | .smithers/flows/release/fixtures/public-api-baseline.json: "Executor.d.ts": "d131186e53ec62594bed1e7ae0d06df6022f95cfee63bfc9b51b7bb4617a32 |
| 2026-10-29 11:11 | `32db9cc7f2` | SUPERSEDED | 34/1/0/0 | 32db9cc7f2 | 🐛 fix(cli): load provider SDKs only when selected | packages/smithers/src/cli/ControlBridge.ts: main carried then changed it: fa717a6d0a (🐛 fix(control): drain run logs after the committed terminal state) |
| 2026-10-29 16:18 | `7354f3b969` | SUPERSEDED | 0/1/0/0 | 60fb9113b5 | 📝 docs(ci): track assigned agent CI repairs | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-29 16:18 | `2c7297fbd5` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 📚 docs(ci): record restored repository-contract gates |  |
| 2026-10-29 16:18 | `bb784f2323` | ON-MAIN | 14/0/0/0 | d2b355bf5e | 🧪 fix(views): cover installation and reload deadline recovery |  |
| 2026-10-29 16:18 | `22e998f20e` | SUPERSEDED | 9/1/0/0 | d2b355bf5e | 🐛 fix(conformance): follow private UI and release staging contracts | packages/repo-targets/conformance/workspaceInventory.test.ts: main carried then changed it: 333e31a579 (🧪 fix(conformance): pin the terminal unit directory selector) |
| 2026-10-29 16:18 | `568be52ba5` | ON-MAIN | 1/0/0/0 | d2b355bf5e | 📚 fix(test-pins): register existing broken and opt-in proofs |  |
| 2026-10-29 16:18 | `cee4914fe4` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 🐛 fix(test): declare runner fixtures with external tool installations |  |
| 2026-10-29 16:18 | `407ae56bc6` | SUPERSEDED | 1/1/0/0 | d2b355bf5e | 🔧 fix(exports): register intentionally added public entry points | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: 21404c7f79 (🐛 fix(agent): publish Transcript, and review the runner's public exports (Acp, AgentRunner, ExternalAgent, Transcrip |
| 2026-10-29 16:18 | `6fed4678e9` | ON-MAIN | 7/0/0/0 | d2b355bf5e | 🐛 fix(release): resolve exact workspace dependencies before staging |  |
| 2026-10-29 16:18 | `bd90c2110b` | ON-MAIN | 1/0/0/0 | d2b355bf5e | 🐛 fix(drift): check the app docs and CLI reference projections |  |
| 2026-10-29 16:18 | `d44553b272` | EMPTY-ISH | 0/0/0/0 | d2b355bf5e | 🔧 fix(lockfile): refresh Bun workspace dependency identities |  |
| 2026-10-29 16:18 | `5c3995a5e5` | PARTIAL | 6/0/1/0 | d2b355bf5e | 🐛 fix(deps): declare the modules loaded by published runtime APIs | packages/smithers/flows/platform-browser/package.json: "@smthrs/database": "1.0.0-rc.16", |
| 2026-10-29 16:18 | `d99b767f3a` | ON-MAIN | 4/0/0/0 | d2b355bf5e | 🐛 fix(repo-targets): distinguish review snapshots from executable imports |  |
| 2026-10-29 16:18 | `adb4c688e3` | ON-MAIN | 2/0/0/0 | builder/ci-repo | 📚 docs(ci): record restored repository-contract gates |  |
| 2026-10-29 16:18 | `d11957eb2d` | ON-MAIN | 14/0/0/0 | builder/ci-repo | 🧪 fix(views): cover installation and reload deadline recovery |  |
| 2026-10-29 16:18 | `a7d4c6d31f` | SUPERSEDED | 9/1/0/0 | builder/ci-repo | 🐛 fix(conformance): follow private UI and release staging contracts | packages/repo-targets/conformance/workspaceInventory.test.ts: main carried then changed it: 333e31a579 (🧪 fix(conformance): pin the terminal unit directory selector) |
| 2026-10-29 16:18 | `1d16770b34` | ON-MAIN | 1/0/0/0 | builder/ci-repo | 📚 fix(test-pins): register existing broken and opt-in proofs |  |
| 2026-10-29 16:18 | `8c8a68d6c8` | ON-MAIN | 2/0/0/0 | builder/ci-repo | 🐛 fix(test): declare runner fixtures with external tool installations |  |
| 2026-10-29 16:18 | `edb0aded2d` | SUPERSEDED | 1/1/0/0 | builder/ci-repo | 🔧 fix(exports): register intentionally added public entry points | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: 21404c7f79 (🐛 fix(agent): publish Transcript, and review the runner's public exports (Acp, AgentRunner, ExternalAgent, Transcrip |
| 2026-10-29 16:18 | `cf426c88d4` | ON-MAIN | 7/0/0/0 | builder/ci-repo | 🐛 fix(release): resolve exact workspace dependencies before staging |  |
| 2026-10-29 16:18 | `1ccad4637e` | ON-MAIN | 1/0/0/0 | builder/ci-repo | 🐛 fix(drift): check the app docs and CLI reference projections |  |
| 2026-10-29 16:18 | `86a3a470cd` | EMPTY-ISH | 0/0/0/0 | builder/ci-repo | 🔧 fix(lockfile): refresh Bun workspace dependency identities |  |
| 2026-10-29 16:18 | `2e684346ef` | PARTIAL | 6/0/1/0 | builder/ci-repo | 🐛 fix(deps): declare the modules loaded by published runtime APIs | packages/smithers/flows/platform-browser/package.json: "@smthrs/database": "1.0.0-rc.16", |
| 2026-10-29 16:18 | `b1c00a9bfd` | ON-MAIN | 4/0/0/0 | builder/ci-repo | 🐛 fix(repo-targets): distinguish review snapshots from executable imports |  |
| 2026-10-29 16:18 | `a5dedfc2bb` | SUPERSEDED | 1/1/0/0 | builder/ci-release | 🐛 fix(ci): retire legacy backend and native bridge gate assertions | .smithers/flows/release/release-graph.test.mjs: landed as 3d6190e934 (same author and time, committed later) |
| 2026-10-29 16:18 | `bc4ee4f5bc` | SUPERSEDED | 0/1/0/0 | builder/ci-flows | 📝 docs(ci): claim flow engine and host CI repairs | apps/mvp/docs/work/ci-red-flows.md: main carried then changed it: e21378f127 (🐛 fix(sandbox): fence redelivered detached workers before output opens) |
| 2026-10-29 16:19 | `b5fc77716d` | SUPERSEDED | 10/3/0/0 | d2b355bf5e | 🧹 chore(ci): retire the unused Plue main mirror | .github/workflows/ci.yml: main carried then changed it: 684f616436 (🔒 fix(ci): run Drift's gates unprivileged and delete the dormant root setup) |
| 2026-10-29 16:19 | `34a5e383f4` | SUPERSEDED | 6/1/0/0 | d2b355bf5e | 🐛 fix(build-cli): seal an empty result cache in scratch checks | apps/mvp/docs/work/ci-red-build.md: main carried then changed it: 8fc31b5507 (🐛 fix(build-cli): tag artifact known-red refusals) |
| 2026-10-29 16:19 | `5f1d6fe309` | SUPERSEDED | 10/3/0/0 | builder/ci-drift | 🧹 chore(ci): retire the unused Plue main mirror | .github/workflows/ci.yml: main carried then changed it: 684f616436 (🔒 fix(ci): run Drift's gates unprivileged and delete the dormant root setup) |
| 2026-10-29 16:19 | `ad7ed4e46c` | SUPERSEDED | 6/1/0/0 | builder/ci-build | 🐛 fix(build-cli): seal an empty result cache in scratch checks | apps/mvp/docs/work/ci-red-build.md: main carried then changed it: 8fc31b5507 (🐛 fix(build-cli): tag artifact known-red refusals) |
| 2026-10-29 16:20 | `50e904a899` | ON-MAIN | 10/0/0/0 | d2b355bf5e | 🔎 fix(ui): name browser probe setup failures |  |
| 2026-10-29 16:20 | `59fa796ed2` | ON-MAIN | 10/0/0/0 | builder/ci-ui | 🔎 fix(ui): name browser probe setup failures |  |
| 2026-10-29 16:20 | `9ae0a736e5` | ON-MAIN | 3/0/0/0 | builder/ci-flows | 🧪 test(platform-node): distinguish edited plans from comments |  |
| 2026-10-29 16:20 | `e9cb05a491` | SUPERSEDED | 4/1/0/0 | builder/ci-flows | 🧪 test(platform-node): wait for host readiness receipts | packages/smithers/flows/platform-node/test/NodeRuntimeReap.integration.test.ts: main carried then changed it: e8add3673f (🧪 test(platform-node): wait for explicit lifecycle receipts) |
| 2026-10-29 16:20 | `d6cfd034ff` | ON-MAIN | 1/0/0/0 | builder/ci-flows | 🧪 test(platform-bun): pin explicit stale workspace recovery |  |
| 2026-10-29 16:21 | `1419a153e2` | SUPERSEDED | 1/12/0/0 | d2b355bf5e | 🐛 fix(ci): bind trusted setup to its verified Ubuntu image | .github/workflows/trusted-drift.yml: main deleted it in 684f616436 (🔒 fix(ci): run Drift's gates unprivileged and delete the dormant root setup) |
| 2026-10-29 16:21 | `fef68049f0` | ON-MAIN | 19/0/0/0 | builder/ci-flows | 🐛 fix(engine-store): flush explicit long-running step progress |  |
| 2026-10-29 16:21 | `27407ac571` | SUPERSEDED | 1/12/0/0 | builder/ci-drift | 🐛 fix(ci): bind trusted setup to its verified Ubuntu image | .github/workflows/trusted-drift.yml: main deleted it in 684f616436 (🔒 fix(ci): run Drift's gates unprivileged and delete the dormant root setup) |
| 2026-10-29 16:21 | `f8297f61c4` | ON-MAIN | 2/0/0/0 | builder/ci-flows | 🧪 test(flows): synchronize journal overflow with the writer |  |
| 2026-10-29 16:21 | `a550008fc5` | ON-MAIN | 6/0/0/0 | builder/ci-flows | 🧪 test(platform-browser): prove admission without a timing race |  |
| 2026-10-29 16:22 | `10775d21dc` | ON-MAIN | 1/0/0/0 | builder/ci-flows | 🧪 test(flows): recognize Node 26 experimental runtime diagnostics |  |
| 2026-10-29 16:22 | `4363ee9366` | ON-MAIN | 1/0/0/0 | builder/ci-release | 🐛 fix(release): check installation copy after banner removal |  |
| 2026-10-29 16:22 | `e0de43ffb7` | ON-MAIN | 1/0/0/0 | builder/ci-release | 🐛 fix(release): check the published quickstart contract |  |
| 2026-10-29 16:22 | `1d8b352314` | ON-MAIN | 5/0/0/0 | builder/ci-release | 🐛 fix(release): preserve workspace protocols across version bumps |  |
| 2026-10-29 16:22 | `b161773259` | ON-MAIN | 1/0/0/0 | builder/ci-release | 🐛 fix(docs): use the public model entry in the Jev fixture |  |
| 2026-10-29 16:23 | `81c0d9cb67` | ON-MAIN | 2/0/0/0 | builder/ci-release | 🐛 fix(ci): inventory the provider load flow during discovery |  |
| 2026-10-29 16:23 | `cb712caea6` | ON-MAIN | 5/0/0/0 | builder/ci-release | 🐛 fix(release): retain failed packing command diagnostics |  |
| 2026-10-29 16:24 | `4f8aed9953` | ON-MAIN | 2/0/0/0 | 60fb9113b5 | 🧪 test(cli): check scaffolded prompts with the VibeLang compiler |  |
| 2026-10-29 16:24 | `d9045203de` | SUPERSEDED | 1/1/0/0 | 60fb9113b5 | 🧪 test(cli): resolve Vitest independently of temporary pnpm shims | packages/smithers/test/CliTestLanes.test.ts: main carried then changed it: fd2b368517 (⚡ perf(cli): share one compiler coordinator across bounded tests) |
| 2026-10-29 16:24 | `d6fe514103` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 🧪 fix(platform-node): decode TLS fixture URLs before spawning Node |  |
| 2026-10-29 16:24 | `5eb80dadff` | ON-MAIN | 5/0/0/0 | builder/ci-flows | 🧪 test(engine-store): use database time at queue crash boundaries |  |
| 2026-10-29 16:24 | `3c166a0df0` | PARTIAL | 2/0/7/2 | builder/ci-release | 🐛 fix(release): resolve workspace links before staging registry artifacts | .smithers/flows/release/check-npm-dedupe.mjs: import { readWorkspaceManifests, resolveWorkspaceDependencies } from "./pack-rel; .smithers/flows/release/check-npm-dedupe.mjs: for (const section of ["dependencies", "devDep |
| 2026-10-29 16:24 | `590356cfcb` | ON-MAIN | 2/0/0/0 | builder/ci-drift | 🧪 fix(platform-node): decode TLS fixture URLs before spawning Node |  |
| 2026-10-29 16:27 | `6bf5fd4fc4` | SUPERSEDED | 4/14/0/0 | builder/ci-flows | 🐛 fix(ci): install browsers required by flow host suites | .github/workflows/ci.yml: landed as b4cec29b5e (same author and time, committed later) |
| 2026-10-29 16:28 | `64562fa464` | ON-MAIN | 3/0/0/0 | builder/ci-release | 🐛 fix(docs): reflect Guest access to conversation and clone commands |  |
| 2026-10-29 16:28 | `77423fbbae` | ON-MAIN | 13/0/0/0 | builder/ci-release | 🐛 fix(site): inventory configured domains and scoped docs routes |  |
| 2026-10-29 16:29 | `dd2b870ca6` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 🐛 fix(release): declare the kernel's HTTP write capability |  |
| 2026-10-29 16:29 | `dde82dc3b5` | SUPERSEDED | 4/1/0/0 | d2b355bf5e | 🧪 fix(capability): scan authoring grants without test fixtures | .smithers/flows/README.md: main carried then changed it: 454bbb1c89 (🧪 fix(ci): isolate artifact assertions and format lane docs) |
| 2026-10-29 16:29 | `6423d995cb` | ON-MAIN | 10/0/0/0 | d2b355bf5e | 📚 fix(docs): make reference examples compile independently |  |
| 2026-10-29 16:29 | `eea02689c1` | SUPERSEDED | 0/1/0/0 | d2b355bf5e | 🧪 test(targets): match the pipeline after the SCOPE-3 removal | packages/smithers/build/targets/test/GithubWorkflow.test.ts: main carried then changed it: 9a82813033 (⚡️ fix(ci): shard package and workspace suites by hosted durations) |
| 2026-10-29 16:29 | `1a0c678078` | ON-MAIN | 4/0/0/0 | builder/ci-flows | 🧪 test(platform-browser): supply Chromium Web Locks under Bun |  |
| 2026-10-29 16:29 | `4b1e923656` | ON-MAIN | 2/0/0/0 | builder/ci-build | 🐛 fix(release): declare the kernel's HTTP write capability |  |
| 2026-10-29 16:29 | `6bdf51d4e3` | SUPERSEDED | 4/1/0/0 | builder/ci-build | 🧪 fix(capability): scan authoring grants without test fixtures | .smithers/flows/README.md: main carried then changed it: 454bbb1c89 (🧪 fix(ci): isolate artifact assertions and format lane docs) |
| 2026-10-29 16:29 | `9ef18bf672` | ON-MAIN | 10/0/0/0 | builder/ci-build | 📚 fix(docs): make reference examples compile independently |  |
| 2026-10-29 16:29 | `7ae823d30d` | SUPERSEDED | 0/1/0/0 | builder/ci-build | 🧪 test(targets): match the pipeline after the SCOPE-3 removal | packages/smithers/build/targets/test/GithubWorkflow.test.ts: main carried then changed it: 9a82813033 (⚡️ fix(ci): shard package and workspace suites by hosted durations) |
| 2026-10-29 16:31 | `fce533f0a1` | ON-MAIN | 5/0/0/0 | d2b355bf5e | 🐛 fix(sandbox): compare guest worktree roots as physical paths |  |
| 2026-10-29 16:31 | `7461646591` | ON-MAIN | 5/0/0/0 | builder/ci-drift | 🐛 fix(sandbox): compare guest worktree roots as physical paths |  |
| 2026-10-29 16:33 | `daebd7b638` | ON-MAIN | 3/0/0/0 | builder/ci-flows | 🐛 fix(platform-node): remove an obsolete grant-widening guard |  |
| 2026-10-29 16:34 | `0e0520ba01` | ON-MAIN | 3/0/0/0 | d2b355bf5e | 🐛 fix(tui): execute failure fixture branches inside a durable action |  |
| 2026-10-29 16:34 | `e3bda3172e` | ON-MAIN | 3/0/0/0 | d2b355bf5e | 🐛 fix(terminal-frame): select only the unit test directory |  |
| 2026-10-29 16:34 | `092e861ed0` | SUPERSEDED | 19/1/0/0 | d2b355bf5e | 🔧 fix(ci): reconcile shared browser prerequisites without ci-flows | .github/workflows/release.yml: main carried then changed it: 522c2d02e6 (🔧 fix(ci): reconcile browser setup and regenerate W25 outputs) |
| 2026-10-29 16:34 | `b1370741b5` | ON-MAIN | 3/0/0/0 | builder/ci-ui | 🐛 fix(tui): execute failure fixture branches inside a durable action |  |
| 2026-10-29 16:34 | `cbab53a0a2` | ON-MAIN | 3/0/0/0 | builder/ci-ui | 🐛 fix(terminal-frame): select only the unit test directory |  |
| 2026-10-29 16:34 | `2c705e50e9` | PARTIAL | 15/10/0/1 | builder/ci-ui | 🐛 fix(ci): declare browser and terminal test prerequisites | .changeset/ci-playwright-toolchain.md: Declare pinned Playwright browser installation in generated CI toolchains.; .github/workflows/ci.yml: landed as 67cee6b848 (same author and time, committed later) |
| 2026-10-29 16:34 | `15b60105a5` | ON-MAIN | 1/0/0/0 | builder/ci-flows | 🧪 test(flows): respect parallel delegation dispatch order |  |
| 2026-10-29 16:35 | `06153f40c9` | ON-MAIN | 1/0/0/0 | d2b355bf5e | 🧪 fix(ui): measure the mobile bell through its unread count |  |
| 2026-10-29 16:35 | `e532588ad8` | ON-MAIN | 1/0/0/0 | d2b355bf5e | 🧪 fix(tui): retain redacted Cloud refusal details |  |
| 2026-10-29 16:35 | `f8c19b5dea` | ON-MAIN | 6/0/0/0 | d2b355bf5e | 🧪 fix(tui): verify answerable final-frame questions |  |
| 2026-10-29 16:35 | `4668539df9` | SUPERSEDED | 13/2/0/0 | d2b355bf5e | 🐛 fix(build-cli): admit planned dependency installations in confined trees | apps/mvp/docs/work/ci-red-build.md: main carried then changed it: 8fc31b5507 (🐛 fix(build-cli): tag artifact known-red refusals) |
| 2026-10-29 16:35 | `f93e1bea1d` | SUPERSEDED | 0/1/0/0 | builder/ci-ui | 🧪 fix(targets): align the pipeline roster with SCOPE-3 | packages/smithers/build/targets/test/GithubWorkflow.test.ts: main carried then changed it: 9a82813033 (⚡️ fix(ci): shard package and workspace suites by hosted durations) |
| 2026-10-29 16:35 | `44a58646e8` | ON-MAIN | 1/0/0/0 | builder/ci-ui | 🧪 fix(ui): measure the mobile bell through its unread count |  |
| 2026-10-29 16:35 | `7b565f0392` | ON-MAIN | 1/0/0/0 | builder/ci-ui | 🧪 fix(tui): retain redacted Cloud refusal details |  |
| 2026-10-29 16:35 | `ba427fb4f2` | ON-MAIN | 6/0/0/0 | builder/ci-ui | 🧪 fix(tui): verify answerable final-frame questions |  |
| 2026-10-29 16:35 | `eedd42fa61` | SUPERSEDED | 13/2/0/0 | builder/ci-build | 🐛 fix(build-cli): admit planned dependency installations in confined trees | apps/mvp/docs/work/ci-red-build.md: main carried then changed it: 8fc31b5507 (🐛 fix(build-cli): tag artifact known-red refusals) |
| 2026-10-29 16:35 | `fb8f1a5ff2` | ON-MAIN | 1/0/0/0 | builder/ci-release | 📝 docs(work): record release CI repair evidence |  |
| 2026-10-29 16:39 | `de641aa8bc` | ON-MAIN | 4/0/0/0 | builder/ci-release | 🐛 fix(views): match the CLI Node support floor |  |
| 2026-10-29 16:40 | `86e87aadbf` | SUPERSEDED | 1/1/0/0 | 60fb9113b5 | 🧪 test(control): isolate inventory snapshots from tail reconciliation | packages/smithers/control/test/SqlControlRuntime.test.ts: landed as a0d15298a7 (same author and time, committed later) |
| 2026-10-29 16:40 | `c6763e4df8` | ON-MAIN | 8/0/0/0 | builder/ci-flows | 🧪 test(engine-store): configure real connection-loss endpoints |  |
| 2026-10-29 16:41 | `61d96e6d4d` | ON-MAIN | 1/0/0/0 | builder/ci-release | 🐛 fix(ci): read flow fixture inventory through jj or mirror receipt |  |
| 2026-10-29 16:42 | `2119f31718` | ON-MAIN | 8/0/0/0 | 60fb9113b5 | 🧪 test(electric): provision required integration services for CI |  |
| 2026-10-29 16:42 | `c77b44254c` | ON-MAIN | 2/0/0/0 | 60fb9113b5 | 🧪 test(harbor): accept supported curl refusal exit codes |  |
| 2026-10-29 16:42 | `990f3e67c6` | ON-MAIN | 3/0/0/0 | 60fb9113b5 | 🧪 test(gateway): require safe request decoding defects |  |
| 2026-10-29 16:43 | `5706bb95fc` | ON-MAIN | 3/0/0/0 | d2b355bf5e | 🐛 fix(build-cli): tag artifact known-red refusals |  |
| 2026-10-29 16:43 | `0b4ecc8849` | ON-MAIN | 3/0/0/0 | builder/ci-build | 🐛 fix(build-cli): tag artifact known-red refusals |  |
| 2026-10-29 16:44 | `f6a98f4a65` | ON-MAIN | 4/0/0/0 | builder/ci-release | 🐛 fix(observability): constrain API peers to the supported SDK range |  |
| 2026-10-29 16:48 | `ac46d42797` | PARTIAL | 44/1/0/4 | d2b355bf5e | 🔒 fix(ci): run Drift's gates unprivileged and delete the dormant root setup | PACKAGE.ts: knownRed: ".github/ci-known-red.json",; packages/repo-targets/contracts/drift-job.test.mjs: const { default: YAML } = await import('yaml'); .smithers/flows/release/fixtures/public-api-baseline.json: main carr |
| 2026-10-29 16:48 | `3dc525a89b` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 📝 docs(site): regenerate the sandbox API page and llms bundle after the physical-root note |  |
| 2026-10-29 16:48 | `d16b924d3c` | SUPERSEDED | 44/5/0/0 | builder/ci-drift | 🔒 fix(ci): run Drift's gates unprivileged and delete the dormant root setup | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 522c2d02e6 (🔧 fix(ci): reconcile browser setup and regenerate W25 outputs) |
| 2026-10-29 16:48 | `3add4b9fb1` | ON-MAIN | 2/0/0/0 | builder/ci-drift | 📝 docs(site): regenerate the sandbox API page and llms bundle after the physical-root note |  |
| 2026-10-29 16:51 | `3fb642651b` | ON-MAIN | 10/0/0/0 | builder/ci-flows | 🧪 test(platform-cloudflare): provision the container egress image |  |
| 2026-10-29 17:01 | `8933fbe083` | ON-MAIN | 14/0/0/0 | d2b355bf5e | 🔎 fix(tui): retain erased PTY diagnostics and pane status |  |
| 2026-10-29 17:01 | `266b0417ef` | ON-MAIN | 14/0/0/0 | builder/ci-ui | 🔎 fix(tui): retain erased PTY diagnostics and pane status |  |
| 2026-10-29 17:05 | `b3c25603c5` | ON-MAIN | 24/0/0/0 | 60fb9113b5 | 🐛 fix(agent): admit each durable resume delegation once |  |
| 2026-10-29 17:07 | `626f5177df` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 🧪 fix(tui): await rendered form and budget input |  |
| 2026-10-29 17:07 | `715289f0a0` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 🧪 fix(tui): recognize wrapped Vim filenames before resize |  |
| 2026-10-29 17:07 | `d490bb851a` | ON-MAIN | 4/0/0/0 | d2b355bf5e | 🐛 fix(tui): commit card focus before the next terminal key |  |
| 2026-10-29 17:07 | `e1f16b7bb1` | ON-MAIN | 2/0/0/0 | builder/ci-ui | 🧪 fix(tui): await rendered form and budget input |  |
| 2026-10-29 17:07 | `4e4dcd0b7c` | ON-MAIN | 2/0/0/0 | builder/ci-ui | 🧪 fix(tui): recognize wrapped Vim filenames before resize |  |
| 2026-10-29 17:07 | `fc2e3df4fd` | ON-MAIN | 4/0/0/0 | builder/ci-ui | 🐛 fix(tui): commit card focus before the next terminal key |  |
| 2026-10-29 17:13 | `ba8c828d5c` | SUPERSEDED | 5/1/0/0 | builder/ci-flows | 🧪 test(platform-browser): expire reads after worker admission | packages/smithers/flows/platform-browser/docs/testing.md: landed as a6488efb27 (same author and time, committed later) |
| 2026-10-29 17:22 | `67612def33` | SUPERSEDED | 10/1/0/0 | builder/ci-release | 🐛 fix(release): reuse library builds completed by the release graph | .smithers/flows/release/pack-release.mjs: main carried then changed it: 618be78a70 (✨ feat(sandbox): the box image runs the deploy's own smthrs, packed from its commit (0144)) |
| 2026-10-29 17:39 | `0f4d7d1cec` | ON-MAIN | 9/0/0/0 | d2b355bf5e | 🐛 fix(tui): preserve Node SIGPIPE handling during flow execution |  |
| 2026-10-29 17:39 | `bcd9cdaae9` | ON-MAIN | 9/0/0/0 | builder/ci-ui | 🐛 fix(tui): preserve Node SIGPIPE handling during flow execution |  |
| 2026-10-29 17:49 | `ecefae103d` | SUPERSEDED | 2/2/0/0 | 60fb9113b5 | 🧪 test(agent): bound real-engine coverage worker contention | packages/smithers/agent/README.md: main carried then changed it: 75ca81036a (⚡ perf(agent): finish the complete queue with three workers) |
| 2026-10-29 17:52 | `29316a597f` | SUPERSEDED | 0/1/0/0 | builder/ci-flows | 🧪 test(targets): follow the SCOPE-3 pipeline inventory | packages/smithers/build/targets/test/GithubWorkflow.test.ts: main carried then changed it: 9a82813033 (⚡️ fix(ci): shard package and workspace suites by hosted durations) |
| 2026-10-29 18:01 | `6447f92bba` | ON-MAIN | 2/0/0/0 | builder/ci-flows | 📝 docs(ci): record passing flow engine and host gates |  |
| 2026-10-29 18:05 | `55afdb287c` | ON-MAIN | 1/0/0/0 | builder/ci-release | 📝 docs(work): record remaining release gate repairs |  |
| 2026-10-29 18:08 | `ca184cecec` | PARTIAL | 1/0/0/9 | 60fb9113b5 | 🧪 test(agent): cover policy fallback and unreadable state boundaries | packages/smithers/agent/test/Agent.test.ts: Effect.updateContext((_: Context.Context<FlowRuntime.FlowRuntime \| FlowRuntime.F; packages/smithers/agent/test/Agent.test.ts: "recovers quota after its cooldown ($resetAtEpochM |
| 2026-10-29 18:19 | `725d74d19d` | ON-MAIN | 7/0/0/0 | builder/ci-release | 🐛 fix(build): preserve package imports in CommonJS distributions |  |
| 2026-10-29 18:23 | `7f63bcc661` | ON-MAIN | 1/0/0/0 | builder/ci-release | 🧪 test(release): isolate each missing artifact in packing checks |  |
| 2026-10-29 18:27 | `9c89fe74fa` | ON-MAIN | 9/0/0/0 | 60fb9113b5 | 🧪 test(agent): provision ModelStep PostgreSQL through the declared target |  |
| 2026-10-29 18:39 | `39754ceeaf` | SUPERSEDED | 3/1/0/0 | 60fb9113b5 | 🐛 fix(runtime): type host probes without Node ambient declarations | packages/smithers/flows/engine-store/src/internal/NodeJournal.ts: main carried then changed it: f441e866e3 (🚨 fix(cli): satisfy lint on the CI-repair stack's new modules) |
| 2026-10-29 18:43 | `fc9cf80964` | ON-MAIN | 5/0/0/0 | d2b355bf5e | 🐛 fix(ci): retain packaged terminal failure artifacts |  |
| 2026-10-29 18:43 | `c1d2717c45` | ON-MAIN | 5/0/0/0 | builder/ci-ui | 🐛 fix(ci): retain packaged terminal failure artifacts |  |
| 2026-10-29 18:45 | `4d85e90640` | SUPERSEDED | 8/2/0/0 | builder/ci-release | 🐛 fix(cli): install the PostgreSQL peer required by public declarations | packages/smithers/package.json: landed as ad31a575b6 (same author and time, committed later) |
| 2026-10-29 18:45 | `6fabeddc43` | ON-MAIN | 3/0/0/0 | builder/ci-release | 🐛 fix(sandbox): construct generic command payload schemas explicitly |  |
| 2026-10-29 18:48 | `e2f760682b` | SUPERSEDED | 15/9/0/0 | 60fb9113b5 | ⚡ perf(cli): reuse validated VibeLang compiles across suite phases | packages/smithers/PACKAGE.ts: main carried then changed it: fd2b368517 (⚡ perf(cli): share one compiler coordinator across bounded tests) |
| 2026-10-29 18:55 | `65e49580f6` | PARTIAL | 12/2/2/0 | d2b355bf5e | 🔧 chore(ci): stage W25 subset projection regeneration | .github/workflows/ci.yml: id: setup; .github/workflows/ci.yml: id: setup; .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 55801588bb (🔧 chore: regenerate W26 API baseline, target |
| 2026-10-29 18:55 | `0779172c5e` | ON-MAIN | 2/0/0/0 | d2b355bf5e | 🐛 fix(ci): select the cloud contract test by path |  |
| 2026-10-29 19:15 | `712e5abbac` | ON-MAIN | 13/0/0/0 | builder/ci-release | 🐛 fix(build): retain module metadata in native CommonJS libraries |  |
| 2026-10-29 19:27 | `c38c2da7db` | ON-MAIN | 5/0/0/0 | builder/ci-release | 🐛 fix(release): preserve published guide pins across future cuts |  |
| 2026-10-29 19:43 | `d5b7b32e00` | ON-MAIN | 5/0/0/0 | 60fb9113b5 | 🧪 test(cli): await real native recovery admission |  |
| 2026-10-29 19:54 | `584f58678c` | ON-MAIN | 1/0/0/0 | d2b355bf5e | 🧪 fix(conformance): pin the terminal unit directory selector |  |
| 2026-10-29 19:58 | `a8ffa71f5f` | ON-MAIN | 5/0/0/0 | builder/bb6-cli | ✅ test(build-cli): cover Owners.ts bounded upstream claims, text rendering, and rdeps |  |
| 2026-10-29 20:12 | `eafbdb61fc` | ON-MAIN | 1/0/0/0 | d2b355bf5e | 🧪 test(ci): cover cache-free Nix and shared CI artifacts |  |
| 2026-10-29 20:17 | `6d548f8900` | ON-MAIN | 4/0/0/0 | builder/ci-release | 🐛 fix(release): follow relocated native host dependencies in consumer profiles |  |
| 2026-10-29 20:18 | `3cdca413c0` | ON-MAIN | 9/0/0/0 | builder/ci-release | 🐛 fix(release): exercise the quickstart against its published package contract |  |
| 2026-10-29 20:22 | `16aa6a0432` | SUPERSEDED | 20/1/0/0 | builder/bb6-cli | ♻️ refactor(cli): drop unreachable host and root fallbacks | packages/smithers/src/Cli.ts: landed as 8e27a6d593 (same author and time, committed later) |
| 2026-10-29 20:27 | `621c1fcc65` | SUPERSEDED | 0/4/0/0 | 60fb9113b5 | ⚡ perf(cli): split the coverage tail into smaller groups | packages/smithers/PACKAGE.ts: main carried then changed it: fd2b368517 (⚡ perf(cli): share one compiler coordinator across bounded tests) |
| 2026-10-29 20:28 | `327dd4df36` | SUPERSEDED | 1/2/0/0 | 60fb9113b5 | 🐛 fix(cli): preserve the declared serial fault tier in coverage shards | packages/smithers/PACKAGE.ts: main carried then changed it: fd2b368517 (⚡ perf(cli): share one compiler coordinator across bounded tests) |
| 2026-10-29 20:38 | `7a2cf43532` | ON-MAIN | 10/0/0/0 | builder/bb6-cli | ♻️ refactor(cli): expose host service seams and drop a dead evaluation mapping |  |
| 2026-10-29 20:55 | `eafab11705` | SUPERSEDED | 7/2/0/0 | 60fb9113b5 | ⚡ perf(cli): bound canonical spelling scan work | packages/smithers/test/CanonicalSpellings.test.ts: main carried then changed it: b2e64afeb1 (⚡ perf(cli): avoid parsing unrelated escaped SDK source) |
| 2026-10-29 21:20 | `fcfb1c3832` | ON-MAIN | 1/0/0/0 | builder/bb6-cli | ✅ test(build-cli): cover PackageRunner Clean, Materialize, inert GitHub and gate-refusal arms |  |
| 2026-10-29 21:22 | `c447197348` | ON-MAIN | 8/0/0/0 | builder/bb6-cli | ✅ test(cli): cover Evaluation and HostService |  |
| 2026-10-29 21:22 | `af4b667173` | ON-MAIN | 1/0/0/0 | builder/bb6-cli | 🐛 fix(cli): keep setup handoff timeout and oversized-body refusals |  |
| 2026-10-29 21:22 | `8c826a2252` | ON-MAIN | 1/0/0/0 | builder/bb6-cli | ✅ test(build-cli): cover PackageRunner direct Serve failure and empty Markdown page |  |
| 2026-10-29 21:24 | `0ba67527f4` | ON-MAIN | 5/0/0/0 | d2b355bf5e | 🧪 fix(ci): isolate artifact assertions and format lane docs |  |
| 2026-10-29 21:31 | `11354f162d` | PARTIAL | 5/0/1/1 | 60fb9113b5 | 🧪 test(cli): measure human-wait budgets with a controlled clock | packages/smithers/test/ModuleHumanWaitBudget.test.ts: for (const key of ["used", "max", "next"]) if (typeof record[key] === "number") ; packages/smithers/test/ModuleHumanWaitBudget.test.ts: return { kind: events[0]?.kind |
| 2026-10-29 21:34 | `759e200e38` | ON-MAIN | 1/0/0/0 | 60fb9113b5 | 🧪 test(cli): scope lease receipts to the external-worker executions |  |
| 2026-10-29 21:40 | `e1611c2f72` | ON-MAIN | 5/0/0/0 | 60fb9113b5 | 🧪 test(cli): await metadata-only cancellation settlement |  |
| 2026-10-29 21:59 | `063636e139` | ON-MAIN | 6/0/0/0 | builder/bb6-cli | ✅ test(cli): cover Cli, ControlBridge, operator Memory and Triggers |  |
| 2026-10-29 22:38 | `759aed8a89` | ON-MAIN | 6/0/0/0 | builder/bb6-cli | 🐛 fix(cli): cancel MCP parse-error drain waits with their session |  |
| 2026-10-29 22:39 | `a0852e64ca` | ON-MAIN | 3/0/0/0 | builder/bb6-cli | 🐛 fix(build-cli): map owners paths spelled through a symlinked workspace alias |  |
| 2026-10-29 22:41 | `33af5ba050` | ON-MAIN | 5/0/0/0 | 60fb9113b5 | 🧪 test(cli): bind timeout injection to catalog construction |  |
| 2026-10-29 22:47 | `a2e09fb3a2` | ON-MAIN | 2/0/0/0 | builder/bb6-cli | ✅ test(cli): pin the message identity test to a fixture-owned memory database |  |
| 2026-10-29 22:55 | `6dd3785e96` | ON-MAIN | 3/0/0/0 | builder/bb6-cli | 🐛 fix(cli): run the documented smthrs mcp doctor |  |
| 2026-10-29 22:55 | `e8e539bfb6` | ON-MAIN | 5/0/0/0 | builder/bb6-cli | ✅ test(cli): check MCP tool middleware against a fixture install |  |
| 2026-10-29 23:01 | `40db842d28` | ON-MAIN | 7/0/0/0 | 60fb9113b5 | 🔎 test(cli): retain safe adoption process diagnostics |  |
| 2026-10-29 23:26 | `7aca1b947c` | SUPERSEDED | 0/3/0/0 | 60fb9113b5 | 📝 docs(ci): record completed CLI fixture repairs | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 00:23 | `4d9d5762c1` | ON-MAIN | 7/0/0/0 | builder/bb6-cli | 🐛 fix(cli): resume evaluations after durable-store failure |  |
| 2026-10-30 01:00 | `36781cbe96` | SUPERSEDED | 5/5/0/0 | 60fb9113b5 | ⚡ perf(test): preserve caller-owned Node compile caches | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: fa717a6d0a (🐛 fix(control): drain run logs after the committed terminal state) |
| 2026-10-30 02:18 | `7a68f0e341` | SUPERSEDED | 1/5/0/0 | 60fb9113b5 | ⚡ perf(cli): release long fixed test groups earlier | packages/smithers/PACKAGE.ts: main carried then changed it: fd2b368517 (⚡ perf(cli): share one compiler coordinator across bounded tests) |
| 2026-10-30 02:49 | `4284e05451` | ON-MAIN | 6/0/0/0 | 60fb9113b5 | 🧪 test(cli): inspect refused input admissions without another host boot |  |
| 2026-10-30 03:34 | `b6d5c554f3` | SUPERSEDED | 2/6/0/0 | 60fb9113b5 | ⚡ perf(cli): share one compiler coordinator across bounded tests | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 04:36 | `34d7dd5a65` | SUPERSEDED | 3/2/0/0 | 60fb9113b5 | ⚡ perf(cli): keep offline host preloads out of compiler workers | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 05:36 | `7c22f39aa9` | SUPERSEDED | 6/2/0/0 | 60fb9113b5 | 🐛 fix(cli): schedule peer recovery before the coverage tail | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 05:40 | `f3c87542d3` | SUPERSEDED | 10/1/0/0 | 60fb9113b5 | ⚡ perf(cli): preserve child caches across V8 coverage workers | packages/smithers/test/temporaryEnvironment.ts: main carried then changed it: 50ee1b1d45 (⚡ perf(cli): restore scoped caches at binary process boundaries) |
| 2026-10-30 06:13 | `e4e5a06c22` | SUPERSEDED | 8/4/0/0 | 60fb9113b5 | 🐛 fix(control): drain run logs after the committed terminal state | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 06:50 | `b72ac91ae4` | SUPERSEDED | 134/3/0/0 | builder/bb6-cli | 🐛 fix(build-cli): validate scratch publication and planned authority | apps/mvp/docs/work/package-bugbash4-cli.md: main carried then changed it: 892bbbf763 (🐛 fix(build-cli): type gate refusals and retain execution receipts) |
| 2026-10-30 06:59 | `5a53586532` | ON-MAIN | 10/0/0/0 | builder/bb6-cli | 🧪 test(cli): exercise injected durable evaluation hosts |  |
| 2026-10-30 07:00 | `3c7d50500b` | ON-MAIN | 2/0/0/0 | 60fb9113b5 | 🧪 test(cli): assert the explicit child cache environment |  |
| 2026-10-30 07:11 | `b5e58c94be` | SUPERSEDED | 1/1/0/0 | 60fb9113b5 | 🧪 test(cli): isolate cross-host lease expiry from local observation | packages/smithers/test/fixtures/external-peer-scenario.ts: landed as 1352229d91 (same author and time, committed later) |
| 2026-10-30 07:16 | `52a9645020` | SUPERSEDED | 8/1/0/0 | 60fb9113b5 | 🐛 fix(cli): close health probes before releasing discovery | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 07:27 | `2bed55e9dd` | PARTIAL | 6/2/1/1 | 801ae69887 | 🐛 fix(mvp): remove catalog DDL from conversation test resets | apps/mvp/worker/test/reset.test.ts: expect(yield* sql`SELECT message_id FROM message_pins UNION ALL SELECT message_i; apps/mvp/worker/test/reset.ts: * empty tables. Repeated schema migrations bloat that catalog on a long |
| 2026-10-30 07:27 | `63942d2a02` | PARTIAL | 6/2/1/1 | 9dae978249 | 🐛 fix(mvp): remove catalog DDL from conversation test resets | apps/mvp/worker/test/reset.test.ts: expect(yield* sql`SELECT message_id FROM message_pins UNION ALL SELECT message_i; apps/mvp/worker/test/reset.ts: * empty tables. Repeated schema migrations bloat that catalog on a long |
| 2026-10-30 07:41 | `d2b355bf5e` | SUPERSEDED | 0/5/0/0 | d2b355bf5e | 🔧 chore(ci): regenerate W25 projections and schema without ci-flows | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 522c2d02e6 (🔧 fix(ci): reconcile browser setup and regenerate W25 outputs) |
| 2026-10-30 08:04 | `4306a2b055` | SUPERSEDED | 7/2/0/0 | 801ae69887 | 🐛 fix(mvp): bound test catalog state with an owned real stack | apps/mvp/docs/infrastructure.md: main carried then changed it: e825e36ce4 (🐛 fix(mvp): sort UTC timestamps and bound fixture cancellation) |
| 2026-10-30 08:04 | `caef8cac17` | SUPERSEDED | 7/2/0/0 | 9dae978249 | 🐛 fix(mvp): bound test catalog state with an owned real stack | apps/mvp/docs/infrastructure.md: main carried then changed it: e825e36ce4 (🐛 fix(mvp): sort UTC timestamps and bound fixture cancellation) |
| 2026-10-30 08:07 | `cae048e782` | SUPERSEDED | 24/4/0/0 | 60fb9113b5 | ⚡ perf(cli): restore scoped caches at binary process boundaries | packages/smithers/test/Bin.test.ts: main carried then changed it: a9f30dca47 (⚡ perf(cli): distribute serial binary contracts across the bounded pool) |
| 2026-10-30 08:30 | `aeb83aa719` | SUPERSEDED | 1/1/0/0 | 801ae69887 | 🧪 test(mvp): exercise triage pause through its durable public API | apps/mvp/src/features/issues/issues.test.ts: main carried then changed it: 83e2659e60 (🧪 test(mvp): confirm session before testing a privileged replay) |
| 2026-10-30 08:30 | `f47a2df62d` | SUPERSEDED | 1/1/0/0 | 9dae978249 | 🧪 test(mvp): exercise triage pause through its durable public API | apps/mvp/src/features/issues/issues.test.ts: main carried then changed it: 83e2659e60 (🧪 test(mvp): confirm session before testing a privileged replay) |
| 2026-10-30 08:46 | `e591f265ba` | SUPERSEDED | 6/3/0/0 | 60fb9113b5 | 🐛 fix(engine-store): sample timer deadlines in their own fibers | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: f778157ede (⚡ perf(cli): load bootstrap modules with native TypeScript) |
| 2026-10-30 08:58 | `653286dc42` | SUPERSEDED | 31/2/0/0 | 801ae69887 | 🐛 fix(mvp): keep device fixtures local and scope backend-only tests | apps/mvp/src/features/chat/chat.test.ts: main carried then changed it: aeb6a24009 (🧪 test(mvp): control transient display time and isolate backend fixtures) |
| 2026-10-30 08:58 | `be2c8cbb71` | SUPERSEDED | 31/2/0/0 | 9dae978249 | 🐛 fix(mvp): keep device fixtures local and scope backend-only tests | apps/mvp/src/features/chat/chat.test.ts: main carried then changed it: aeb6a24009 (🧪 test(mvp): control transient display time and isolate backend fixtures) |
| 2026-10-30 09:47 | `3bdf374783` | PARTIAL | 10/0/0/1 | 801ae69887 | 🐛 fix(mvp): isolate WAL writes and settle optional clone metadata | apps/mvp/worker/RepoApi.test.ts: // PostgreSQL keeps microseconds; the request's Clock reads milliseconds. Set an |
| 2026-10-30 09:47 | `10cd4df2eb` | PARTIAL | 10/0/0/1 | 9dae978249 | 🐛 fix(mvp): isolate WAL writes and settle optional clone metadata | apps/mvp/worker/RepoApi.test.ts: // PostgreSQL keeps microseconds; the request's Clock reads milliseconds. Set an |
| 2026-10-30 09:55 | `3033b230f6` | ON-MAIN | 10/0/0/0 | builder/drift-helper | 🐛 fix(ci): install native filesystem helper for Drift |  |
| 2026-10-30 09:58 | `8237bc6f56` | SUPERSEDED | 11/3/0/0 | 60fb9113b5 | ⚡ perf(cli): distribute serial binary contracts across the bounded pool | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: c99d93fa76 (⚡ perf(cli): dispatch binary process contracts before short unit files) |
| 2026-10-30 09:58 | `330e7da2a9` | ON-MAIN | 2/0/0/0 | 801ae69887 | 🧪 test(mvp): give comment admission its signed-in actor |  |
| 2026-10-30 09:58 | `a26c42db5a` | ON-MAIN | 2/0/0/0 | 9dae978249 | 🧪 test(mvp): give comment admission its signed-in actor |  |
| 2026-10-30 10:22 | `8d60454912` | SUPERSEDED | 51/5/0/0 | 801ae69887 | 🧪 test(mvp): control transient display time and isolate backend fixtures | apps/mvp/docs/infrastructure.md: main carried then changed it: 70039f6151 (🧪 test(mvp): hold display time while a done toast syncs late) |
| 2026-10-30 10:22 | `b05f717c18` | SUPERSEDED | 51/5/0/0 | 9dae978249 | 🧪 test(mvp): control transient display time and isolate backend fixtures | apps/mvp/docs/infrastructure.md: main carried then changed it: 70039f6151 (🧪 test(mvp): hold display time while a done toast syncs late) |
| 2026-10-30 10:33 | `84c88d46ab` | SUPERSEDED | 1/2/0/0 | 60fb9113b5 | ⚡ perf(cli): dispatch binary process contracts before short unit files | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 10:52 | `ceb4ee7f1f` | SUPERSEDED | 4/1/0/0 | 801ae69887 | 🧪 test(mvp): confirm session before testing a privileged replay | apps/mvp/src/features/issues/issues.test.ts: main carried then changed it: 0305a4a909 (🧪 test(mvp): make shared issue fixtures wait for confirmed authority) |
| 2026-10-30 10:52 | `2c0b5d1788` | SUPERSEDED | 4/1/0/0 | 9dae978249 | 🧪 test(mvp): confirm session before testing a privileged replay | apps/mvp/src/features/issues/issues.test.ts: main carried then changed it: 0305a4a909 (🧪 test(mvp): make shared issue fixtures wait for confirmed authority) |
| 2026-10-30 10:56 | `6925324ce0` | SUPERSEDED | 5/1/0/0 | builder/bb6-cli | 🧪 test(cli): retain subprocess stage diagnostics | packages/smithers/test/RunObservabilityCli.test.ts: main carried then changed it: ed42593998 (🔎 test(cli): retain live-run startup and child-cache receipts) |
| 2026-10-30 11:01 | `4ed2c81157` | SUPERSEDED | 33/1/0/0 | builder/bb6-cli | 🐛 fix(build-cli): type gate refusals and retain execution receipts | packages/smithers/build/build-cli/test/RawErrorSites.test.ts: main carried then changed it: 31365ca555 (🧪 fix(build-cli): pin merged raw error count and format the owners table) |
| 2026-10-30 11:10 | `90dae8ce09` | ON-MAIN | 5/0/0/0 | 801ae69887 | 🧪 test(mvp): make shared issue fixtures wait for confirmed authority |  |
| 2026-10-30 11:10 | `3144df937b` | ON-MAIN | 5/0/0/0 | 9dae978249 | 🧪 test(mvp): make shared issue fixtures wait for confirmed authority |  |
| 2026-10-30 11:27 | `004ea075b9` | ON-MAIN | 3/0/0/0 | 801ae69887 | 🧪 test(mvp): wait for the expected cross-device pin |  |
| 2026-10-30 11:27 | `d2723c2ed5` | ON-MAIN | 3/0/0/0 | 9dae978249 | 🧪 test(mvp): wait for the expected cross-device pin |  |
| 2026-10-30 11:28 | `ac7f4d45c1` | PARTIAL | 0/0/0/1 | builder/ci-shard | 🧪 fix(release): follow removal of the global docs banner | .smithers/flows/release/pack-release.test.mjs: // c95d756e removed the global release banner; the install contract remains. |
| 2026-10-30 11:43 | `9f473a3b8a` | ON-MAIN | 3/0/0/0 | 801ae69887 | 🧪 test(mvp): force concurrent draft saves to overlap |  |
| 2026-10-30 11:43 | `2796cd1f6e` | ON-MAIN | 3/0/0/0 | 9dae978249 | 🧪 test(mvp): force concurrent draft saves to overlap |  |
| 2026-10-30 11:52 | `a805868e85` | ON-MAIN | 16/0/0/0 | 801ae69887 | ✨ feat(build-cli): select every target in one package |  |
| 2026-10-30 11:52 | `cec6cb6841` | ON-MAIN | 16/0/0/0 | builder/ci-shard | ✨ feat(build-cli): select every target in one package |  |
| 2026-10-30 11:57 | `4a09864158` | SUPERSEDED | 9/1/0/0 | 60fb9113b5 | 🐛 fix(cli): finish log following after a proven local writer crash | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 11:59 | `169ec7475a` | ON-MAIN | 1/0/0/0 | 801ae69887 | 🧪 fix(engine): bound private dispatch contract inspection |  |
| 2026-10-30 11:59 | `b897a593cc` | ON-MAIN | 1/0/0/0 | builder/ci-flows2 | 🧪 fix(engine): bound private dispatch contract inspection |  |
| 2026-10-30 12:16 | `adc5c64c07` | ON-MAIN | 10/0/0/0 | 801ae69887 | 🐛 fix(sandbox): fence redelivered detached workers before output opens |  |
| 2026-10-30 12:16 | `0e4387098f` | ON-MAIN | 3/0/0/0 | 801ae69887 | 🧪 fix(platform-cloudflare): prove writer overlap without a speed ratio |  |
| 2026-10-30 12:16 | `d75d1f416c` | ON-MAIN | 1/0/0/0 | 801ae69887 | 🧪 fix(sync): keep fuzz insertion markers outside the seed alphabet |  |
| 2026-10-30 12:16 | `9445aa0c85` | ON-MAIN | 10/0/0/0 | builder/ci-flows2 | 🐛 fix(sandbox): fence redelivered detached workers before output opens |  |
| 2026-10-30 12:16 | `0dc930885c` | ON-MAIN | 3/0/0/0 | builder/ci-flows2 | 🧪 fix(platform-cloudflare): prove writer overlap without a speed ratio |  |
| 2026-10-30 12:16 | `7bc0f58f0d` | ON-MAIN | 1/0/0/0 | builder/ci-flows2 | 🧪 fix(sync): keep fuzz insertion markers outside the seed alphabet |  |
| 2026-10-30 12:19 | `9ca5b309d0` | ON-MAIN | 12/0/0/0 | 801ae69887 | 🐛 fix(mvp): sort UTC timestamps and bound fixture cancellation |  |
| 2026-10-30 12:19 | `deb0d0035b` | ON-MAIN | 12/0/0/0 | 9dae978249 | 🐛 fix(mvp): sort UTC timestamps and bound fixture cancellation |  |
| 2026-10-30 12:55 | `77f35ed412` | ON-MAIN | 3/0/0/0 | 60fb9113b5 | 🧪 test(cli): assert cancellation exits from committed receipts |  |
| 2026-10-30 12:57 | `f79adc5131` | SUPERSEDED | 7/8/0/0 | 60fb9113b5 | ⚡ perf(cli): load bootstrap modules with native TypeScript | .changeset/cli-native-bootstrap.md: main carried then changed it: 3d3ebadf92 (🐛 fix(cli): preserve persisted callback compiler identities) |
| 2026-10-30 12:57 | `2c0adafc41` | ON-MAIN | 2/0/0/0 | 801ae69887 | 📝 docs(mvp): record timeout repair verification |  |
| 2026-10-30 12:57 | `6b985b4f92` | ON-MAIN | 2/0/0/0 | 9dae978249 | 📝 docs(mvp): record timeout repair verification |  |
| 2026-10-30 13:47 | `961ae3d923` | SUPERSEDED | 3/2/0/0 | 60fb9113b5 | ⚡ perf(cli): schedule cold test files from actual source sizes | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 14:51 | `47d50dfda6` | SUPERSEDED | 8/1/0/0 | 60fb9113b5 | 🐛 fix(cli): preserve persisted callback compiler identities | packages/smithers/src/internal/Bootstrap.ts: main carried then changed it: 6477188f0f (⚡ perf(cli): import Node services by subpath, not the platform barrel) |
| 2026-10-30 14:52 | `e8dc2d90e7` | ON-MAIN | 80/0/0/0 | 801ae69887 | ⚡️ fix(ci): shard package and workspace suites by hosted durations |  |
| 2026-10-30 14:52 | `79b7a879cd` | ON-MAIN | 80/0/0/0 | builder/ci-shard | ⚡️ fix(ci): shard package and workspace suites by hosted durations |  |
| 2026-10-30 15:15 | `b384bd8140` | SUPERSEDED | 5/1/0/0 | 60fb9113b5 | ⚡ perf(cli): retain owned caches through guide shell launches | packages/smithers/test/QuickstartGuides.test.ts: main carried then changed it: 26b5f0f38a (🔎 test(cli): retain guide stages in the final failure summary) |
| 2026-10-30 15:16 | `7e46e8c25b` | SUPERSEDED | 0/1/0/0 | 60fb9113b5 | 📝 docs(ci): retain bootstrap proofs and the remaining CLI deadline | apps/mvp/docs/work/ci-agent-reds.md: main carried then changed it: 4cf4474942 (📝 docs: record remaining CI reds and current validation limits) |
| 2026-10-30 16:05 | `5a201d9d94` | ON-MAIN | 18/0/0/0 | 60fb9113b5 | ⚡ perf(cli): complete cache handoff for late process journeys |  |
| 2026-10-30 16:14 | `1373f0beef` | ON-MAIN | 3/0/0/0 | 60fb9113b5 | ⚡ perf(cli): start process journeys before large unit tables |  |
| 2026-10-30 17:26 | `2ad70a597f` | ON-MAIN | 7/0/0/0 | 60fb9113b5 | ⚡ perf(cli): bound the complete test queue at six workers |  |
| 2026-10-30 18:18 | `f966373c7a` | ON-MAIN | 5/0/0/0 | 60fb9113b5 | ⚡ perf(cli): check public type contracts with the native compiler |  |
| 2026-10-30 18:25 | `e29e7c3f59` | ON-MAIN | 2/0/0/0 | 60fb9113b5 | 🔎 test(cli): retain guide stages in the final failure summary |  |
| 2026-10-30 18:28 | `cdf83b1657` | ON-MAIN | 3/0/0/0 | 60fb9113b5 | ⚡ perf(cli): avoid parsing unrelated escaped SDK source |  |
| 2026-10-30 18:40 | `b9dcef1528` | ON-MAIN | 3/0/0/0 | 60fb9113b5 | ⚡ perf(cli): bound guide controls to Bash startup |  |
| 2026-10-30 19:16 | `8fad6f8801` | ON-MAIN | 4/0/0/0 | 60fb9113b5 | ⚡ perf(cli): keep offline SDK preloads out of the native compiler |  |
| 2026-10-30 19:16 | `9f62b36b03` | ON-MAIN | 3/0/0/0 | 801ae69887 | 🐛 fix(ci): give the local gate runner one gate per CI shard |  |
| 2026-10-30 19:17 | `84ea99c528` | ON-MAIN | 4/0/0/0 | 801ae69887 | 🔧 chore: regenerate the API baseline and docs projections for W27 |  |
| 2026-10-30 19:20 | `ce35b398ed` | ON-MAIN | 7/0/0/0 | 60fb9113b5 | 🔎 test(cli): retain live-run startup and child-cache receipts |  |
| 2026-10-30 19:47 | `647a368ca5` | ON-MAIN | 2/0/0/0 | 801ae69887 | 🐛 fix(ci): time the build-cli importRules target in the shard measurements |  |
| 2026-10-30 19:52 | `3e5157fcd3` | ON-MAIN | 2/0/0/0 | 60fb9113b5 | 🧪 test(cli): assert the required PostgreSQL declaration dependency |  |
| 2026-10-30 19:53 | `e062be9ad0` | PARTIAL | 1/2/0/1 | 51b4598687 | 📝 docs(mvp): rule and design gates on Cloudflare job machines | apps/mvp/docs/decisions/0128-gates-on-cloudflare-job-machines.md: # 0128: Gates run as repository flows on Cloudflare job machines; apps/mvp/docs/rulings.md: landed as e7c8133635 (same author and time, committed later) |
| 2026-10-30 19:57 | `801ae69887` | ON-MAIN | 2/0/0/0 | 801ae69887 | ⚡️ fix(ci): parse the workflows once in the gate runner contract |  |
| 2026-10-30 20:01 | `51b4598687` | SUPERSEDED | 7/1/0/0 | 51b4598687 |  | apps/mvp/infra/gate/entry.sh: main carried then changed it: 6c9e4781c2 (📝 docs(mvp): point the gates' code and docs at decision 0145) |
| 2026-10-30 20:01 | `641370fcac` | ON-MAIN | 6/0/0/0 | 51b4598687 | 🧪 test(mvp): prove the gate on a smithers-gates-* stage |  |
| 2026-10-30 20:01 | `28fb70388e` | ON-MAIN | 2/0/0/0 | 51b4598687 | ✨ feat(mvp): deploy a prebuilt branch sandbox image with SANDBOX_IMAGE |  |
| 2026-10-30 20:01 | `4db333c2a2` | SUPERSEDED | 8/1/0/0 | 51b4598687 | ✨ feat(mvp): refuse a repository flow whose job names an undeclared machine | apps/mvp/worker/ci/RepoFlow.ts: main carried then changed it: 7bf773f965 (✨ feat(mvp): a repository flow's inputs read in the realm, a run by hand's inputs and Retry failed's jobs in repo/Run, and a run whose jobs failed |
| 2026-10-30 20:01 | `3e707fe4aa` | SUPERSEDED | 0/1/0/0 | 51b4598687 | 🧪 test(mvp): skip the live GitHub read unless GitHub itself answered | apps/mvp/worker/RepoUpstream.test.ts: main carried then changed it: 6c9e4781c2 (📝 docs(mvp): point the gates' code and docs at decision 0145) |
| 2026-10-30 20:01 | `54fb506722` | ON-MAIN | 2/0/0/0 | 51b4598687 | 🐛 fix(mvp): check a job's commit out over an image's base checkout |  |
| 2026-10-30 20:01 | `3770b2e850` | ON-MAIN | 4/0/0/0 | 51b4598687 | 🐛 fix(mvp): release a job's machine without checkpointing its checkout |  |
| 2026-10-30 20:10 | `667a4d4157` | ON-MAIN | 7/0/0/0 | 51b4598687 | 🧪 test(mvp): run the two internet-bound tests offline |  |
| 2026-10-30 20:11 | `0a8e3a686b` | SUPERSEDED | 42/2/0/0 | 51b4598687 | ✨ feat(sandbox): run CI job graphs in waves with needs and named machines | apps/mvp/docs/features/ci.md: main carried then changed it: 7bf773f965 (✨ feat(mvp): a repository flow's inputs read in the realm, a run by hand's inputs and Retry failed's jobs in repo/Run, and a run whose jobs failed r |
| 2026-10-30 20:28 | `64a277abbb` | SUPERSEDED | 49/3/0/0 | 51b4598687 | ✨ feat(mvp): declare the gate job machine and run-scoped artifacts | apps/mvp/worker/BranchSandboxes.ts: landed as 3f5d7d17aa (same author and time, committed later) |
| 2026-10-30 20:59 | `c3eda3ccd4` | ON-MAIN | 4/0/0/0 | 60fb9113b5 | 🧪 test(cli): pass the owned compile cache to SSH children |  |
| 2026-10-30 21:01 | `bc51864ee7` | ON-MAIN | 1/0/0/0 | 60fb9113b5 | 📝 docs: record remaining CI reds and current validation limits |  |
| 2026-10-30 21:01 | `d8b5f275b7` | ON-MAIN | 6/0/0/0 | 60fb9113b5 | ⚡ perf(journal): skip impossible credential URL candidates |  |
| 2026-10-30 21:01 | `c4b8d05b26` | ON-MAIN | 2/0/0/0 | 60fb9113b5 | ⚡ perf(agent): finish the complete queue with three workers |  |
| 2026-10-30 21:01 | `c0fcb5e008` | ON-MAIN | 4/0/0/0 | 60fb9113b5 | 🔎 test(cli): retain successful and failed startup stages |  |
| 2026-10-30 21:14 | `60fb9113b5` | SUPERSEDED | 21/19/0/0 | 60fb9113b5 |  | .probe-ci-agent/attr.mjs: main has no .probe-ci-agent (package removed) |
| 2026-10-30 21:30 | `9dae978249` | ON-MAIN | 15/0/0/0 | 9dae978249 | 🧪 test(mvp): hold display time while a done toast syncs late |  |
