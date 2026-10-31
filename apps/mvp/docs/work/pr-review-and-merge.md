---
title: PR review and merge (MVP 2, early feature 8a)
status: in-progress
area: app
owner: coding factory builder (Claude Opus, session 6253ecf2), from 19:10 on 2026-10-20: PRs, the todo run, /review. Until 19:10: unassigned; from 13:21:12 on 2026-10-20 it waits for the [triage](issue-triage.md) builder (same GitHub write path and list view). Until 13:21: unassigned; not in 0012's slice G0 (started 07:40:55 on 2026-10-20). Until 07:40: Panel G designed the PR pages, opening a PR and the merge flow in decision 0012 (written 06:58:11 on 2026-10-20, status: proposed; panel started 06:41:56). The `/review` findings flow has no owner. Until 06:41 on 2026-10-20: unassigned
updated: 2026-10-21 22:53 PDT
links: [issues.md, ../decisions/0012-git-end-to-end.md, pull-request-list-and-tabs.md, github-source-of-truth.md, review-requests-and-revisions.md, issue-triage.md, ../proposals/early-features.md, ../proposals/mvp-gaps.md, ../decisions/0007-roles-and-tags.md, roles-and-labels.md, design-questions.md, docs-check-flow-outcome.md, no-github-actions.md, second-build-machine.md]
---

## Tracker reconciliation — 2026-10-21 22:53 PDT

**What:** Review pull requests and let a person merge through durable, authorized writes.

**Why:** Complete the GitHub development loop without stale-base merges or duplicate recovery effects.

**Current state:** At 22:37 the lead reports the merge repair finished and tested: recheck the live base head immediately before merging and recover a lost response using a key in the commit message. The repair replaces part of an earlier review-lane fix, so one lander must land both together with migrations in order. This is a queued implementation receipt, not a completed production merge journey. Agents never approve or merge.

**Next step:** Land the coordinated stack, deploy, and prove moved-base refusal and lost-response recovery; a person performs the final merge.

**Open questions for Will:** None newly required.

Evidence: script-filtered user-typed messages and lead text replies over the latest approximately two hours, through 22:53 PDT, in session 6253ecf2. Both requested paths were checked; the continuation path is unavailable here, while continuation-era replies are present in the original session. Current rulings and queue answers prevail over older decisions and proposals. Surviving briefs inform handoff state; reboot-wiped files are not missing work. Implementation owners are retained; Codex curates documentation. Product checks above are reported receipts, not rerun by this tracker refresh.

## Earlier tracker history (retained)


## What

Swap github.com for our domain in a public PR URL: `/owner/repo/pull/N` shows the changed files with Pierre diffs. Review, `/review owner/repo#N` or asking Smithers runs one durable review flow that pins verified findings to diff lines. A person merges; agents never approve or merge.

## Why

Reviewing agent output is the user's bottleneck (mvp.md §1.2), and Will's MVP cut keeps review and merge as item 2. It needs no machine, so nothing in features 1 to 7 blocks it.

## State

- Proposed (8a, MVP item 2). Not started.
- The old `/review` never finished on a real install: its branch machine image lacked bubblewrap (rc.4).
- The review pipeline has 16 seeded fixtures: offline precision 85.7%, recall 50%.
- `early-features.md` notes nothing yet shows people want `/review`.
- 22:49 on 2026-10-19, design question 10 of 14 (0007 Q2): **merging is a flow.** Will: "Merging into main is actually triggering a workflow and that workflow is configurable. By default maintainers and up obviously." The Merge button runs the repository's merge flow, which the repository can customize; by default Maintainers and Admins may merge. Whatever a repository customizes, a person merges, never an agent and never a Guest ([roles and labels](roles-and-labels.md)).
- 2026-10-31: **the merge flow is built** ([decision 0131](../decisions/0131-merge-flow.md), merge-flow builder for effectscript-5d). `.smithers/merge.json` at the base names `github` (default) or `queue`; a queue merge posts one request comment as the person, and the repository's queue poller lands it. `smithersai/vibelang` chooses its nyc-01 queue.
- 22:56: the lead's MVP list keeps item 2 as: see the PR's diff and checks; a Maintainer merges through the merge flow. Cut until later: evidence views, pre-approval, stack-order rules. Will hasn't approved it ([MVP scope cut](mvp-scope-cut.md)).
- 23:00: Will: "Don't worry about the mvp ... But yes it's more or less right". The MVP list is reference only; work follows his feature list ([MVP scope cut](mvp-scope-cut.md)). Nobody builds this now.
- About 23:06: 0007 is accepted. Its catalog: `repo:approve` needs a Maintainer; `repo:merge` needs the merge flow's minimum, Maintainer by default and never below Member. An agent asked to merge opens its person's own Review & merge confirmation ([roles and labels](roles-and-labels.md)).
- **06:39:05 on 2026-10-20: in Will's priorities** ("finishing the entire git e2e flow"). Panel G designs the pull request pages, review and the merge flow; status moved from `todo` to `designing`. The agent's `/review` findings pinned to diff lines aren't in the panel's brief.
- Panel G's drafts (Sol 06:46, Opus 06:53): `pr/Merge { pr, headSha, method }` runs the repository's merge flow (Maintainer by default, always a person, never an agent or a Guest); it calls GitHub's `merge-async` fenced to the head the person saw, with squash by default. `pr/Review` with approve needs a Maintainer and is never an agent act. Details: [pull requests](pull-request-list-and-tabs.md).
- 06:58:11: decision 0012 written (status: proposed). Approve, Request changes and Merge are a person's acts only; the agent may request a merge and leave review comments as findings.
- 07:08:32 on 2026-10-20: Panel G is waiting on its last `pnpm docs:check`; no report ([docs check outcome](docs-check-flow-outcome.md)). Decision 0012 is unchanged since 06:58:11.
- **07:40:55 on 2026-10-20, Panel G done; the lead to Will:** "The git design is done (decision 0012), and building its first slice has started." Its first slice is issues: "list, view, create and comment on issues, across two devices" ([issues](issues.md)). Opening, reviewing and merging pull requests are 0012 §4 and workstreams W3 to W6, built after G0.
- **Status moved from designing to todo:** designed in 0012, not in the first slice.
- 13:19:52 on 2026-10-20: the lead's list: "Pull request list, review and merge; branch update and resync: not started (rest of 0012)".
- 13:21:12: the lead: start these when triage finishes, since they share its GitHub write path and list view. Not in the 13:22 batch.
- **13:21:27: no GitHub Actions** ([no GitHub Actions](no-github-actions.md)). "See the PR's diff and checks" now means its Smithers workflow runs on the head SHA. A merge GitHub refuses for its own required checks shows GitHub's refusal as it comes.

## Next

From 13:21 on 2026-10-20: after the [triage](issue-triage.md) builder finishes, 0012's W3 to W6 build opening, reviewing and merging PRs; the merge runs the repository's merge flow (Maintainers and Admins by default, always a person). The `/review` findings flow still has no owner.

Until 13:21 on 2026-10-20 the next step was: first slice: open a public PR, press Review, see findings; reload or a second device shows the same run. Posting and Merge wait for [auth](auth.md). Merge runs the repository's merge flow, with the default allowing Maintainers and Admins (since 22:49).

## Questions for Will

- Approve MVP item 2 as trimmed: diff, checks and a Merge button only? Asked again at 22:56 as part of "Is this the MVP?" ([MVP scope cut](mvp-scope-cut.md)). (Answered 23:00: "more or less right"; reference only.)
