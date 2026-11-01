---
title: Docs truth pass (every doc, AGENTS.md, .specs and memory match Will's rulings)
status: in-progress
area: process
owner: lead and docs/memory owners
updated: 2026-10-21 11:40 PDT
links: [ops-vault-history-repair.md, will-decision-queue.md, decisions-for-will.md, self-host-install.md, todos-and-stack.md, no-github-actions.md, prompt-flows-are-code-flows.md, mvp-scope-cut.md, web-first-desktop-later.md, ../rules.md, ../todo.md, ../../../../AGENTS.md, ../../../../.specs/product/mvp.md, ../decisions/0010-web-first-desktop-later.md, ../decisions/0016-todos-and-the-stack.md, ../rulings.md, everything-is-a-plugin.md]
---

## Tracker reconciliation — 2026-10-21 11:40 PDT

**What:** Reconcile Smithers and Smithers-Ops documentation with the current rulings.

**Why:** Stale product descriptions misdirect agents.

**Current state:** At 11:39 the lead reports the docs agent finished both repositories. Six Smithers commits await the lander; Smithers-Ops changes are committed and pushed. Public support promises remain a separate unresolved policy decision. This is authoring completion, not completed landing of all docs.

**Next step:** Land the six Smithers commits, check links after legacy removal and retain final verification. Shared ops checkout catch-up has its own active note.

**Open questions for Will:** None newly identified; support promises remain with their own queue question.

Evidence: lead text replies through 11:39 PDT in session 6253ecf2, extracted by script from the latest two hours; rulings and queue answers take precedence over shared briefs, designs and older docs. Product results are reported evidence; this refresh validates the site build only. Existing implementation ownership is retained; Codex curates this note.

## Current specification — 2026-10-21 11:31 PDT

**What:** Will, 2026-10-21 10:53 (Telegram, SCOPE-3 addendum): "make sure all docs Smithers-Ops etc. is up to date". The legacy-removal agent deletes the old code and fixes what points at it; this pass fixes the rest.

**Current state:** Repository commits in workspace `docs-truth`, queued with the lander: `f4f77c09` (apps/mvp docs: rules.md GH-9/GH-10, SDK-15, sign-in, PROC-21; infrastructure.md lists sandboxes, rooms, Code Storage and the model, Neon Launch plan, and the deployment record leaves the public repo; `todo.md` tracked; plugins in apps/mvp/AGENTS.md), `3f02584d` (LAND.md, REVIEW.md deleted, CONTRIBUTING.md), `b3f2eb8b` (maintainer-site README, libraries.md issue-claim row), `0aad6527` (docs/mvp history banners, M-55), `33d12ea7` (apps/DESIGN.md and apps/UPSTREAMS.md marked history). The lead settled rulings §18 itself. The private ops repository pushed to its `main`: `b97b1e5c` (AGENTS.md and CLAUDE.md "What is true now", Deploys.md with the production record, Areas, Org, Decisions index), `87df189f` (live skills rewritten, stopped ones retired), `0d135d07` (bin help and comments). `smithersai/smithers-infra` doesn't exist yet, so the vault's `Deploys.md` holds the record.

**Next step:** Root `AGENTS.md`'s plugin section still says the design is pending (decision 0017 was approved 2026-10-20); edit it once the legacy agent's root change lands. Left for the legacy agent: `apps/README.md`, the apps/site pages generated from `apps/app`, `docs/api/`, `packages/smithers/test/faults/README.md`, `.smithers/flows/coding` and `perf/working-together`. Needs a decision: `SUPPORT.md` (Pro billing and the old backend's export and erase commands), and the ops repository's shared checkout, which the agents' installed skills read and which sits far behind its `main`.

**Open questions for Will:** None.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 11:15 PDT

**What:** Bring current Smithers and Smithers-Ops documentation into agreement with rulings.

**Why:** Legacy descriptions and stale questions misdirect agents.

**Current state:** At 11:06 and 11:09 the lead reports five docs commits queued with the lander: app rules/infrastructure, tracked TODO list, landing/contributor guides, maintainer-site README, historical design banners and old-app references. The lead separately updates rulings §18 to settle deployment, private infrastructure, tracker and spend-alert questions. Grafana self-hosting, effectscript-ts identity and Cerebras capacity remain open. The broader two-repository pass has no completion receipt.

**Next step:** Land the documented updates, finish Smithers-Ops reconciliation, check links after the legacy docs move, and resolve stale public support promises in their own workstream. Preserve historical records.

**Open questions for Will:** None newly identified; settled decisions remain settled.

Evidence: script-filtered user text and lead replies from session 6253ecf2, approximately 09:14–11:14 PDT on 2026-10-21; current rulings (including PROC-21–23), queue answers, shared feature/host/panel briefs and designs, decisions, proposals, TODOs and rules. Engineering receipts are reported evidence; this refresh validates only the maintainer-site build. Existing implementation owners are retained; Codex curates these notes.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 11:04 PDT

**What:** Update current documentation in Smithers and Smithers-Ops to match Will’s rulings.

**Why:** Old instructions and pending questions must not contradict later decisions.

**Current state:** At 10:54–10:55 the lead starts a docs-update agent in response to Will’s Telegram request, covering both repositories and leaving old run folders alone. The earlier audit gaps remain until explicitly fixed: rulings §18 settled questions, stale deployment prerequisites, dependency age and write-only commit-status exceptions. No completed cross-repository documentation receipt is reported.

**Next step:** Complete the active two-repository reconciliation, preserve historical run folders, check links after legacy docs move, and record validation without reopening settled decisions.

**Open questions for Will:** None newly identified. Repository access, Neon and review routing are settled; Telegram setup is discretionary and must not be resurfaced.

Evidence: script-filtered human text and lead replies in session 6253ecf2, approximately 09:03–11:03 PDT; current rulings and queue answers take precedence over briefs, panel designs and older documentation. Product receipts are lead-reported; Codex curates documentation and validates only the maintainer-site build. Existing engineering ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 09:11 PDT

**What:** Reconcile current instructions and documentation with Will’s rulings; retain older decisions as history.

**Why:** Stale open questions and rules can send builders back to decisions Will already settled.

**Current state:** This audit confirms remaining contradictions in the requested source documents. Rulings §18 still lists first deploy, private hosted infrastructure and tracker authority as open despite the later HOST/SCOPE and PROC-9 rulings. todo.md still calls sign-in not deployed and leaves callback setup as a first-deploy prerequisite; the retained deployment workstream already records round 4 deployed. rules.md still describes a seven-day dependency rule despite SDK-15’s one-day rule, and bans commit statuses despite GH-10’s write-only smithers/<flow> exception. GH-9 retains npm/JSR provenance publishing on GitHub. These are documentation reconciliation gaps, not fresh questions for Will. This pass changes tracker notes only.

**Next step:** The owning docs lane reconciles §18, todo.md and rules.md with the specific later rulings, preserving historical text as superseded. Coordinate enforceable rule changes with import-rules-and-jev-lint.md; retain separate validation requirements for production callbacks and webhook delivery.

**Open questions for Will:** None newly required by these contradictions.

Evidence: current rulings (SDK-15, GH-9/GH-10, PROC-9 and PLUGIN-5), queue answers, requested source documents and script-filtered transcript window. Generated summaries, tool results and automated messages are excluded from human evidence. No product tests or version-control operations run; Codex is the documentation curator, and execution ownership is retained.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 17:34 PDT

**What:** Keep instructions, memory and docs consistent with latest rulings.

**Why:** Will’s 17:33 answer says contradicting personal instructions/memories must be changed or removed without asking.

**Current state:** The lead fixed personal review routing and jj workspace contradictions. Rulings §18 still lists the first deploy as undecided, despite the 17:32 approval. Root/app historical first-deploy blockers are superseded too. This tracker only edits work notes.

**Next step:** Owning docs lane reconciles the deploy approval and automatic contradiction cleanup across rulings, instructions and memory. Preserve historical decisions without presenting them as current blockers.

**Open questions for Will:** None.

Evidence: queue answers through 2026-10-21 00:34:14 UTC; script-filtered human text and lead replies from the latest two transcript hours through 00:33:48 UTC; current rulings, decisions, proposals, TODOs, rules and shared briefs. Latest answers supersede older blockers. Product tests are reported evidence; this tracker runs the maintainer-site build only.

## Earlier tracker history (retained)

## Current specification — 2026-10-20, 15:35 PDT

**What:** Reconcile repository docs, specs, memory, ops and stale queue questions with rulings.

**Why:** SCOPE-9 makes current product decisions authoritative.

**Current state:** At 15:27 PDT the lead reported the content truth pass complete across all three lanes. Memory: 418 stale memories removed, 47 updated, index reduced to 13 KB, and all remaining links resolve. Repository/spec reconciliation and 97 ops-file edits are reported complete; stale questions were removed. This completes the content pass, not landing: the ops vault has a pre-existing history conflict tracked separately in ops-vault-history-repair.md.

**Next step:** Collect repository landing receipts; finish the separately tracked ops history repair. Preserve the cleanup log and earlier records.

**Open questions for Will:** First deploy, hosted IaC location and tracker authority remain open in rulings §18; they do not block this completed reconciliation.

Evidence: last two hours of user-typed messages and lead text replies extracted from session `6253ecf2` through 15:34 PDT; queue answers through 14:36 PDT; current rulings, decisions, proposals, TODOs, rules and shared briefs/designs. Completion receipts are reported evidence; this tracker ran no product tests. Older briefs yield to later rulings.

## Earlier tracker history

## Current specification — 2026-10-20, 15:24 PDT

**What:** Align repository instructions, specs, memory, ops and queue with the rulings.

**Why:** Current apps/mvp and Will’s latest decisions supersede stale directions (SCOPE-9).

**Current state:** At 15:16:05 the lead reported repository instructions/docs reconciled, with M-53–57 and nineteen older decisions marked replaced, preserving history. At 15:23:55 the ops lane reported 97 vault files updated and 52 old org skills retired, but its commit failed on a pre-existing conflict. Memory cleanup has no completion receipt.

**Next step:** Finish memory cleanup, repair the ops history in an isolated workspace, collect landing receipts and recheck stale queue questions.

**Open questions for Will:** Rulings §18 still leaves first deploy, hosted IaC location and issue-claim versus maintainer tracker open.

Evidence: Will’s typed messages and lead text replies, extracted from session `6253ecf2` for its latest two hours through 15:23:55 PDT; [rulings](../rulings.md), queue answers through 14:36 PDT, shared briefs/designs and current decisions, proposals, TODOs and rules. Receipts above are reported, not fresh product tests run by this tracker.

## Earlier tracker history


## Current specification — 2026-10-20, 15:10 PDT

**What:** Align repository docs, ops, memory and queued questions with current rulings.

**Why:** SCOPE-9 establishes the current product and Will’s latest words as truth.

**Current state:** The three cleanup lanes remain in progress: repository docs, memory and ops. The lead reported 103 stale repository spots and 65 ops spots; of 836 memory files, 389 were slated for deletion and 78 for update/merge. The curator has removed eight settled/stale questions and added six questions plus one personal-file decision. A completed whole-pass receipt is not evidenced.

**Next step:** Collect completion receipts for each lane; retain sources and history. List personal-file contradictions for Will without editing his files.

**Open questions for Will:** First production deploy, hosted IaC location and issue-claim versus maintainer tracker remain open under rulings §18.

Evidence: recent user text and lead replies from session `6253ecf2`, extracted through 15:10 PDT; [rulings](../rulings.md) and queue answers through 14:36 PDT. Reported completion is distinguished from a test run by this tracker.

## Earlier tracker history


## Current specification — 2026-10-20, 14:55 PDT

**What:** Align repository docs, memory, ops and queue with the dated rulings.

**Why:** Current apps/mvp and Will’s latest words supersede the old stack.

**Current state:** Rulings file is written. At 14:53 the lead reports 103 stale repository spots, 65 ops spots, and 836 memory files with 389 slated for removal and 78 for update/merge. Three fix agents are running. At 14:54 the curator reports 8 stale/settled questions dropped and 7 genuine questions added; this supersedes the earlier planned count of 14.

**Next step:** Finish the three passes and preserve ruling/source receipts; list personal-file contradictions for Will without editing them.

**Open questions for Will:** First deploy, infrastructure-code location and issue-claim versus maintainer tracker remain unresolved in rulings §18.

Evidence: Will's typed messages and the lead's text updates in session `6253ecf2`, 12:54–14:55 PDT; [rulings](../rulings.md); queue answers through 14:36 PDT. These are reported receipts, not a new verification run by the tracker.

## Earlier tracker history

Previous owner record: rulings agent (Claude Opus), started by the lead about 14:25 on 2026-10-20; writes `apps/mvp/docs/rulings.md` and a stale inventory; then three fix agents (repository docs, Claude Code memory, `~/smithers-ops`); then the queue curator drops stale questions


## What

One pass that makes every written instruction agree with what Will has ruled in chat and in the queue, with the MVP being built now as the source of truth.

```
Will's chat + queue answers ──▶ apps/mvp/docs/rulings.md   (dated, quoted; latest ruling wins)
                                      │
                                      ├─▶ stale inventory: every contradicting line in
                                      │     root + scoped AGENTS.md, repo CLAUDE.md files,
                                      │     .specs, docs/, skills, ~/smithers-ops,
                                      │     Claude Code memory, stale queue questions
                                      ▼
         fix agent 1: repository docs   fix agent 2: memory   fix agent 3: ~/smithers-ops
                                      │
                                      ▼
                     curator drops the queue questions that only existed because a doc was stale
```

Marked out of date (the lead, 14:25:28): the old app, `packages/backend` as the only backend, the Mac mini install, GitHub Actions and the `mythical` stack. Will's global `~/.claude/CLAUDE.md` is his personal file: the agents only list its direct contradictions for him and don't edit it.

## Why

- **14:22:33 on 2026-10-20, Will (queue, on M-31):** "A lot of our docs are out of date we need to update them the source of truth is htis mvp. we are building and what we are doing now"
- **14:21:35, Will (queue, on 0016):** "Remove mythical history stuff we are adding that later not now"
- Stale docs cost Will time: several queue questions (M-31, the `mythical` stack, the self-hosted install) existed only because `AGENTS.md` and `.specs/product/mvp.md` still described another product.

## State

- **About 14:25 on 2026-10-20: the lead started the rulings agent** (to Will at 14:25:28: "I've started on bringing everything up to date, in two steps"). Step 1: one dated, quoted list at `apps/mvp/docs/rulings.md`, latest ruling wins, plus the stale inventory. Step 2: three fix agents in parallel, then the curator drops stale queue questions.
- 14:25 to 14:27, on disk: scratchpad `rulings-work/` holds the extracted main-session text (`main-session.txt`, `main-queued.txt`), text from 21 other sessions and their queue lines, and `queue-summary.txt`. `apps/mvp/docs/rulings.md` isn't on disk at 14:30.
- Covers two queue answers routed through `queue/dispatch.md` at 14:28: 0016's `mythical` history (removed for now; 0016 keeps the stack order in Postgres) and M-31 ([self-hosted install](self-host-install.md)).
- 14:30, the lead's update: "An agent is writing `apps/mvp/docs/rulings.md` and a stale inventory; three fix agents follow."

## Next

From 14:30 on 2026-10-20: `rulings.md` and the inventory; then the three fix agents, each change citing the ruling it applies; then the curator drops the stale queue questions. Expect root `AGENTS.md` (M-31, "One mythical stack", "`packages/backend` only"), `.specs/product/mvp.md` M-31, and the memory index to change.

## Questions for Will

None. The list of contradictions in `~/.claude/CLAUDE.md` comes to Will to edit himself.
