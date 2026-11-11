# Appendix C. Every internal action and flow

> Superseded on 2026-10-20 by `apps/mvp/docs/rulings.md` (SCOPE-3). Kept as prior art.

Companion to [Appendix B](mvp.md). Appendix B lists what a person or agent can do. This appendix lists every `Flow.make`, `Action.make` and `AgentAction.make` tag that ships, so no shared UI behavior is missing from the Inspect view.

Inventoried from `main` on 2026-10-02 with:

```
rg -n "Flow\.make[(<]|Action\.make[(<]|AgentAction\.make[(<]" flows packages/smithers/agent
```

Test files, fixtures, doc examples and templates are excluded.

## Reading this appendix

| Column | Meaning |
| --- | --- |
| **id** | The exact tag string. For the 31 prompt flows written as `flow.mdx`, which have no `Flow.make`, the id is the directory path under `flows/`. A name built at runtime is shown in angle brackets. |
| **kind** | `flow`, `action`, or `agent action` with its seat. |
| **source** | `file:line`. An MDX flow has no line (shown as `:1`). |
| **runs in** | **Machine**: the branch VM's coding host. **Install**: the backend on the Mac. |
| **MVP** | **Keep**: TODO flow, review, learning, wiki refresh, jj stack, std tools. **Defer §14**: maintainer release. **Defer §16**: deferred list. **Cut**: not in the product. **Internal ops**: Smithers' own release and CI tooling; it stays in the repo and is not product. |
| **renders as** | For Keep rows, the title a person sees in the Inspect cell. `-` for every other row. |

Rendering rule: a step is titled by what it did, in plain past tense ("Planned the change", "Ran checks"). Std tools use the B.3 rendering. Every cell opens a plain-language explanation.

Packages with no tags: `docs` (empty), `notes` (a helper module for personal calendar-to-notes, removed in the second-round scope, #3404), `invoke` (host code that validates tags), `migrate-smithers-v1` (tests only), `test` (tests only), `release-support` (runtime helpers; its steps are in `release`).

Where each row runs follows the TODO flow: planning, editing, checks and review run in the branch Machine; stack landing, wiki refresh and the old job machinery run on the Install.

## C.1 coding

The TODO flow: route, plan, implement, verify, review, correct, land, and refresh the wiki.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `coding/prepare-atom` | action | .smithers/flows/coding/atoms.vibe:17 | Open the working copy for one atom | Machine | Keep | Opened the working copy |
| `coding/prepare-atom-mutation` | action | .smithers/flows/coding/atoms.vibe:23 | Record the atom's base before editing | Machine | Keep | Prepared to edit |
| `coding/observe-atom` | action | .smithers/flows/coding/atoms.vibe:39 | Capture the atom's resulting change | Machine | Keep | Saved the edit |
| `coding/edit-atom` | agent action (coding/implement) | .smithers/flows/coding/atoms.vibe:49 | Agent edits files for one atom | Machine | Keep | Edited the files |
| `coding/check-command` | action | .smithers/flows/coding/checks.vibe:20 | Run the check's command | Machine | Keep | Ran checks |
| `coding/CommandCheck` | flow | .smithers/flows/coding/checks.vibe:27 | Run one command as a check | Machine | Keep | Ran checks |
| `coding/select-owner-repair` | agent action (coding/implement) | .smithers/flows/coding/correction.vibe:142 | Agent picks which change owns a repair | Machine | Keep | Chose what to fix |
| `coding/read-correction-history` | action | .smithers/flows/coding/correction.vibe:155 | Read earlier correction rounds | Machine | Keep | Read earlier fixes |
| `coding/prepare-repair-context` | action | .smithers/flows/coding/correction.vibe:165 | Gather evidence for a repair | Machine | Keep | Gathered repair context |
| `coding/prepare-owner-repair` | action | .smithers/flows/coding/correction.vibe:170 | Set up the owner's repair | Machine | Keep | Prepared the repair |
| `coding/prepare-return-mythical-tip` | action | .smithers/flows/coding/correction.vibe:175 | Return to the stack tip after repair | Machine | Keep | Returned to the stack tip |
| `coding/refresh-restacked-evidence` | action | .smithers/flows/coding/correction.vibe:180 | Refresh evidence after a restack | Install | Keep | Refreshed evidence |
| `coding/run-correction-round` | action | .smithers/flows/coding/correction.vibe:185 | Run the correction round's edits | Machine | Keep | Fixed review findings |
| `coding/finish-correction` | action | .smithers/flows/coding/correction.vibe:191 | Finish a correction round | Machine | Keep | Finished the fix round |
| `coding/record-learning` | action | .smithers/flows/coding/correction.vibe:197 | Record what a correction taught | Machine | Keep | Saved a lesson |
| `coding/begin-correction` | action | .smithers/flows/coding/correction.vibe:202 | Start a correction round | Machine | Keep | Started a fix round |
| `coding/RepairPass` | flow | .smithers/flows/coding/correction.vibe:337 | One bounded owner repair pass | Machine | Keep | Repaired the change |
| `coding/RecheckCorrected` | flow | .smithers/flows/coding/correction.vibe:375 | Recheck after a correction | Machine | Keep | Re-checked the fix |
| `coding/CorrectionRound` | flow | .smithers/flows/coding/correction.vibe:390 | Run one correction round | Machine | Keep | Fixed review findings |
| `coding/CorrectPlan` | flow | .smithers/flows/coding/correction.vibe:410 | Plan and run correction rounds | Machine | Keep | Fixed review findings |
| `coding/dispatch-turn` | agent action (?) | .smithers/flows/coding/dispatch.vibe:152 | Agent works one turn in the workspace | Machine | Keep | Worked a turn |
| `coding/observe-dispatch` | action | .smithers/flows/coding/dispatch.vibe:167 | Record the turn's result | Machine | Keep | Saved the turn |
| `coding/Dispatch` | flow | .smithers/flows/coding/dispatch/flow.ts:25 | Run one dispatched agent turn | Machine | Keep | Ran an agent turn |
| `coding/record-fast-gated-progress` | action | .smithers/flows/coding/feedback.vibe:23 | Record progress after quick checks | Machine | Keep | Recorded progress |
| `coding/record-slow-feedback` | action | .smithers/flows/coding/feedback.vibe:29 | Record feedback from slow checks | Machine | Keep | Recorded feedback |
| `coding/ObservePlan` | flow | .smithers/flows/coding/feedback.vibe:150 | Watch a plan run and record progress | Machine | Keep | Tracked progress |
| `coding/read-feedback-cancellation` | action | .smithers/flows/coding/feedback.vibe:162 | Read whether feedback was cancelled | Machine | Keep | Read your steer |
| `coding/ImplementPlan` | flow | .smithers/flows/coding/flow.ts:42 | Implement every atom of the plan | Machine | Keep | Implemented the plan |
| `coding/ImplementAtom` | flow | .smithers/flows/coding/implementation/flow.ts:13 | Prepare, edit and observe one atom | Machine | Keep | Implemented one step |
| `coding/ImplementAtoms` | flow | .smithers/flows/coding/implementation/flow.ts:86 | Implement atoms in order | Machine | Keep | Implemented the plan |
| `coding/check-jev-rules` | action | .smithers/flows/coding/jev-check.vibe:44 | Evaluate Jev rules on the change | Machine | Keep | Checked rules |
| `coding/JevCheck` | flow | .smithers/flows/coding/jev-check.vibe:51 | Check the change against Jev rules | Machine | Keep | Checked rules |
| `coding/ReadNative` | action | .smithers/flows/coding/native.vibe:305 | Read native jj changes | Install | Keep | Read the changes |
| `coding/ApplyNative` | action | .smithers/flows/coding/native.vibe:311 | Apply native jj changes | Install | Keep | Applied the changes |
| `coding/configure-planning-wiki` | action | .smithers/flows/coding/planning-wiki.vibe:37 | Choose the wiki the planner reads | Install | Keep | Chose wiki pages |
| `coding/find-planning-wiki-review` | action | .smithers/flows/coding/planning-wiki.vibe:43 | Find a recorded wiki review to reuse | Install | Keep | Found wiki notes |
| `coding/refresh-planning-wiki` | action | .smithers/flows/coding/planning-wiki.vibe:49 | Refresh wiki pages the plan needs | Install | Keep | Refreshed wiki pages |
| `coding/RefreshWiki` | flow | .smithers/flows/coding/planning-wiki.vibe:60 | Refresh planning wiki before planning | Install | Keep | Refreshed wiki pages |
| `coding/gather-planning-context` | action | .smithers/flows/coding/planning.vibe:82 | Collect wiki, code and history for planning | Machine | Keep | Gathered context |
| `coding/review-request` | agent action (coding/plan) | .smithers/flows/coding/planning.vibe:88 | Agent reviews the request for gaps | Machine | Keep | Reviewed the request |
| `coding/draft-plan` | agent action (coding/plan) | .smithers/flows/coding/planning.vibe:105 | Agent drafts the plan | Machine | Keep | Drafted the plan |
| `coding/finalize-plan` | action | .smithers/flows/coding/planning.vibe:123 | Settle the plan's atoms | Machine | Keep | Finalized the plan |
| `coding/decline-request` | action | .smithers/flows/coding/planning.vibe:129 | Decline a request with evidence | Machine | Keep | Declined the request |
| `coding/verify-planning-context` | action | .smithers/flows/coding/planning.vibe:134 | Check planning context is current | Machine | Keep | Checked the context |
| `coding/PreparePlan` | flow | .smithers/flows/coding/planning.vibe:142 | Gather context, review, draft and finalize plan | Machine | Keep | Planned the change |
| `coding/capture-poc-source` | action | .smithers/flows/coding/poc.vibe:21 | Capture the source for the prototype | Machine | Keep | Captured the source |
| `coding/draft-poc` | agent action (coding/poc) | .smithers/flows/coding/poc.vibe:27 | Agent proposes prototype file contents | Machine | Keep | Drafted a prototype |
| `coding/materialize-poc` | action | .smithers/flows/coding/poc.vibe:40 | Apply the prototype in isolation | Machine | Keep | Applied the prototype |
| `coding/review-poc` | agent action (coding/poc) | .smithers/flows/coding/poc.vibe:45 | Agent reviews the prototype | Machine | Keep | Reviewed the prototype |
| `coding/retain-poc` | action | .smithers/flows/coding/poc.vibe:66 | Save the prototype result | Machine | Keep | Saved the prototype |
| `coding/Poc` | flow | .smithers/flows/coding/poc.vibe:74 | Draft and review an unvalidated prototype | Machine | Keep | Drafted a prototype |
| `coding/PrepareRequest` | flow | .smithers/flows/coding/preparation.ts:8 | Prepare the request's first plan | Machine | Keep | Prepared the request |
| `coding/Prototype` | flow | .smithers/flows/coding/prototype/flow.ts:10 | Draft a throwaway prototype for planning | Machine | Keep | Drafted a prototype |
| `coding/merge-request-feedback` | action | .smithers/flows/coding/request/flow.ts:26 | Fold steer text into the request | Machine | Keep | Took in your steer |
| `coding/refuse-plan-approval` | action | .smithers/flows/coding/request/flow.ts:31 | Refuse a plan approval that is not allowed | Machine | Keep | Refused a plan approval |
| `coding/CoordinateRequest` | flow | .smithers/flows/coding/request/flow.ts:93 | Coordinate planning, POC and finalization | Machine | Keep | Worked the TODO |
| `coding/Request` | flow | .smithers/flows/coding/request/flow.ts:158 | Plan, implement and prepare one request | Machine | Replaced by the `todo` flow (T-FLW-11): its steps survive inside the single run; this separate entry point is removed | Worked the TODO |
| `coding/capture-review-check` | action | .smithers/flows/coding/review-check.vibe:75 | Capture the change for review | Machine | Keep | Captured the change |
| `coding/review-lens` | agent action (?) | .smithers/flows/coding/review-check.vibe:83 | Agent reviews through one lens | Machine | Keep | Reviewed through one lens |
| `coding/finish-review-check` | action | .smithers/flows/coding/review-check.vibe:95 | Combine lens findings into a receipt | Machine | Keep | Collected review findings |
| `coding/ReviewCapturedChange` | flow | .smithers/flows/coding/review-check.vibe:102 | Review a captured change | Machine | Keep | Reviewed the change |
| `coding/ReviewCheck` | flow | .smithers/flows/coding/review-check.vibe:120 | Run review lenses on the change | Machine | Keep | Reviewed the change |
| `coding/review-security` | action | .smithers/flows/coding/security-review-check.vibe:97 | Agent reviews the change for security | Machine | Keep | Reviewed security |
| `coding/SecurityReviewCheck` | flow | .smithers/flows/coding/security-review-check.vibe:105 | Security review as a check | Machine | Keep | Reviewed security |
| `coding/audit-security` | action | .smithers/flows/coding/security-review-check.vibe:390 | Audit a revision for security issues | Machine | Keep | Audited security |
| `coding/SecurityAudit` | flow | .smithers/flows/coding/security-review-check.vibe:397 | Security audit of a revision | Machine | Keep | Audited security |
| `coding/admit-retained-source` | action | .smithers/flows/coding/source-admission.vibe:10 | Admit a retained source revision | Install | Keep | Opened the source |
| `coding/prepare-stack-base` | action | .smithers/flows/coding/stack.vibe:27 | Prepare the stack's base | Install | Keep | Prepared the stack |
| `coding/create-stack-base` | action | .smithers/flows/coding/stack.vibe:34 | Create the stack's base change | Install | Keep | Created the stack base |
| `coding/receive-request-feedback` | action | .smithers/flows/coding/steering.vibe:156 | Wait for steer on the request | Machine | Keep | Waited for your steer |
| `factory/route-todo` | action | .smithers/flows/coding/todo.vibe:45 | Jev picks implement, bug, feature or close | Machine | Keep | Chose how to start |
| `factory/stamp-route` | action | .smithers/flows/coding/todo.vibe:57 | Fail a declined TODO with its route | Machine | Keep | Declined the TODO |
| `factory/Todo` | flow | .smithers/flows/coding/todo.vibe:78 | Route a TODO, then plan it | Machine | Keep | Routed the TODO |
| `coding/todo-delivery` | action | .smithers/flows/coding/todo.vibe:39 | Resolve the planned request for delivery | Machine | Keep | Prepared the delivery |
| `coding/todo-pause-requested` | action | .smithers/flows/coding/todo-pause.vibe:10 | Read whether a person asked the TODO to pause | Machine | Keep | - |
| `system/human-task` | action | packages/smithers/flows/flow/src/HumanTask.ts:135 | Wait for a person's answer | Machine | Keep | Waited for your answer |
| `coding/todo-resume` | action | .smithers/flows/coding/todo-pause.vibe:37 | Read whether a person resumed a paused TODO | Machine | Keep | - |
| `system/wait-for` | action | packages/smithers/flows/flow/src/WaitFor.ts:66 | Wait durably for a signal (the TODO's pause watch) | Machine | Keep | - |
| `system/sleep` | action | packages/smithers/flows/flow/src/Sleep.ts:66 | Sleep durably | Machine | Keep | - |
| `coding/admit-verify-source` | action | .smithers/flows/coding/verify-schema.vibe:34 | Admit the candidate source for verify | Machine | Keep | Opened the candidate |
| `coding/Verify` | flow | .smithers/flows/coding/verify/flow.ts:16 | Re-run required checks on a rebased candidate | Machine | Replaced by the `todo` flow (T-FLW-11): its steps survive inside the single run; this separate entry point is removed | Re-ran checks |
| `coding/fence-vibe-source` | action | .smithers/flows/coding/vibe-admission.vibe:19 | Pin the exact source being landed | Install | Keep | Pinned the change |
| `coding/VerifyVibe` | flow | .smithers/flows/coding/vibe-admission.vibe:25 | Verify the request before landing | Install | Keep | Verified before landing |
| `coding/AdmitVibe` | flow | .smithers/flows/coding/vibe-admission.vibe:58 | Admit the request's source for landing | Install | Keep | Opened the change for landing |
| `coding/review-final-history` | agent action (coding/implement) | .smithers/flows/coding/vibe-cleanup.vibe:35 | Agent reviews the final history | Machine | Keep | Reviewed the history |
| `coding/repair-final-history` | agent action (coding/implement) | .smithers/flows/coding/vibe-cleanup.vibe:47 | Agent corrects a refused final history once | Machine | Keep | Corrected the history |
| `coding/validate-final-history` | action | .smithers/flows/coding/vibe-cleanup.vibe:56 | Validate the final history | Machine | Keep | Checked the history |
| `coding/prepare-final-description` | action | .smithers/flows/coding/vibe-cleanup.vibe:62 | Prepare the final description | Machine | Keep | Drafted the commit message |
| `coding/confirm-final-description` | action | .smithers/flows/coding/vibe-cleanup.vibe:68 | Confirm the final description | Machine | Keep | Confirmed the commit message |
| `coding/DescribeFinalAtom` | flow | .smithers/flows/coding/vibe-cleanup.vibe:74 | Describe the final commit | Install | Keep | Wrote the commit message |
| `coding/refresh-final-history` | action | .smithers/flows/coding/vibe-cleanup.vibe:84 | Refresh history after rewrite | Machine | Keep | Refreshed the history |
| `coding/RecheckFinalHistory` | flow | .smithers/flows/coding/vibe-cleanup.vibe:91 | Recheck the rewritten history | Machine | Keep | Re-checked the history |
| `coding/finish-final-history` | action | .smithers/flows/coding/vibe-cleanup.vibe:135 | Finish the history rewrite | Machine | Keep | Finished the history |
| `coding/RewriteFinalHistory` | flow | .smithers/flows/coding/vibe-cleanup.vibe:141 | Rewrite final commit history | Install | Keep | Tidied the history |
| `coding/ProposeFinalHistory` | flow | .smithers/flows/coding/vibe-cleanup.vibe:168 | Review the final history, repairing a refusal once | Machine | Keep | Reviewed the history |
| `coding/CleanVibeHistory` | flow | .smithers/flows/coding/vibe-cleanup.vibe:187 | Tidy the change's final history | Install | Keep | Tidied the history |
| `coding/read-vibe-request` | action | .smithers/flows/coding/vibe-evidence.vibe:18 | Read the request being landed | Install | Keep | Read the request |
| `coding/read-vibe-lander` | action | .smithers/flows/coding/vibe-lander.vibe:9 | Read the lander's state | Install | Keep | Read landing state |
| `coding/read-vibe-stack` | action | .smithers/flows/coding/vibe-landing.vibe:47 | Read the stack | Install | Keep | Read the stack |
| `coding/submit-vibe-lane` | action | .smithers/flows/coding/vibe-landing.vibe:53 | Submit the change to its lane | Install | Keep | Queued the change |
| `coding/read-vibe-delivery` | action | .smithers/flows/coding/vibe-landing.vibe:60 | Read delivery status | Install | Keep | Read delivery status |
| `coding/open-vibe-pull` | action | .smithers/flows/coding/vibe-landing.vibe:66 | Open the GitHub pull request | Install | Keep | Opened the pull request |
| `coding/prepare-vibe-append` | action | .smithers/flows/coding/vibe-landing.vibe:72 | Prepare to append to the stack | Install | Keep | Prepared to add to the stack |
| `coding/create-vibe-landing` | action | .smithers/flows/coding/vibe-landing.vibe:78 | Create the landing record | Install | Keep | Added to the stack |
| `coding/queue-vibe-append` | action | .smithers/flows/coding/vibe-landing.vibe:84 | Queue the stack append | Install | Keep | Queued for the stack |
| `coding/observe-vibe-append` | action | .smithers/flows/coding/vibe-landing.vibe:90 | Watch the append finish | Install | Keep | Added to the stack |
| `coding/verify-vibe-landed` | action | .smithers/flows/coding/vibe-landing.vibe:96 | Check the change landed | Install | Keep | Confirmed it landed |
| `coding/prepare-vibe-candidate` | action | .smithers/flows/coding/vibe-landing.vibe:107 | Prepare the local candidate | Install | Keep | Prepared the change |
| `coding/fast-forward-vibe` | action | .smithers/flows/coding/vibe-landing.vibe:114 | Fast-forward the local ref | Install | Keep | Moved the branch forward |
| `coding/open-vibe-local-pull` | action | .smithers/flows/coding/vibe-landing.vibe:120 | Open a local pull request | Install | Keep | Opened the pull request |
| `coding/observe-vibe-pull-checks` | action | .smithers/flows/coding/vibe-landing.vibe:126 | Watch the pull request's checks | Machine | Keep | Watched PR checks |
| `coding/merge-vibe-local-pull` | action | .smithers/flows/coding/vibe-landing.vibe:133 | Merge the local pull request | Install | Keep | Merged the change |
| `coding/LandVibe` | flow | .smithers/flows/coding/vibe-landing.vibe:271 | Append, open PR and land the change | Install | Keep | Landed the change |
| `coding/publish-vibe-source` | action | .smithers/flows/coding/vibe-publication.vibe:9 | Publish the verified source | Install | Keep | Published the change |
| `coding/PublishVibeSource` | flow | .smithers/flows/coding/vibe-publication.vibe:17 | Publish the source to the stack | Install | Keep | Published the change |
| `coding/Vibe` | flow | .smithers/flows/coding/vibe/flow.ts:13 | Land one approved request | Machine | Replaced by the `todo` flow (T-FLW-11): its steps survive inside the single run; this separate entry point is removed | Landed the change |
| `coding/capture-wiki-check` | action | .smithers/flows/coding/wiki-check.ts:51 | Capture wiki state for checking | Machine | Keep | Captured the wiki |
| `coding/finish-wiki-check` | action | .smithers/flows/coding/wiki-check.ts:57 | Turn wiki review into a receipt | Machine | Keep | Checked the wiki |
| `coding/ReviewCapturedWiki` | flow | .smithers/flows/coding/wiki-check.ts:82 | Review a captured wiki state | Install | Keep | Checked the wiki |
| `coding/WikiCheck` | flow | .smithers/flows/coding/wiki-check.ts:93 | Check the wiki against the revision | Machine | Keep | Checked the wiki |
| `coding/import-dependency-docs` | action | .smithers/flows/coding/wiki-refresh.ts:55 | Import dependency docs to the wiki | Install | Keep | Imported dependency docs |
| `coding/install-dependency-pages` | action | .smithers/flows/coding/wiki-refresh.ts:66 | Install dependency wiki pages | Install | Keep | Added dependency pages |
| `coding/read-published-wiki` | action | .smithers/flows/coding/wiki-refresh.ts:95 | Read the published wiki | Install | Keep | Read the wiki |
| `coding/Wiki` | flow | .smithers/flows/coding/wiki/flow.ts:17 | Refresh wiki pages after a fold | Machine | Keep | Refreshed the wiki |
| `coding/validate-plan` | action | .smithers/flows/coding/workflow.vibe:22 | Validate the plan's shape | Machine | Keep | Checked the plan |
| `coding/implement-change` | action | .smithers/flows/coding/workflow.vibe:27 | Run the change's implement step | Machine | Keep | Implemented the change |
| `coding/check` | action | .smithers/flows/coding/workflow.vibe:38 | Run a declared check on the change | Machine | Keep | Ran checks |
| `coding/fast-gate` | action | .smithers/flows/coding/workflow.vibe:43 | Run quick checks before review | Machine | Keep | Ran quick checks |
| `coding/assess` | action | .smithers/flows/coding/workflow.vibe:53 | Judge whether the change meets the plan | Machine | Keep | Assessed the change |

### Current TODO composition controls (T-CAT-01, E-19)

These machine-side steps use the attempt pin and existing install admission. A `-` rendering groups bookkeeping under Engine. `stack.candidate` and `stack.propose` retain their install-side credential and candidate guards (§10.4.4).

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `stack.candidate` | action | .smithers/flows/coding/stack.vibe:50 | Submit the current attempt candidate | Machine | Keep | Saved the candidate |
| `stack.propose` | action | .smithers/flows/coding/stack.vibe:56 | Submit the verified candidate for publication | Machine | Keep | Proposed the candidate |
| `coding/todo-review-input` | action | .smithers/flows/coding/todo.vibe:52 | Await the next committed review or steer input | Machine | Keep | - |
| `coding/todo-review` | flow | .smithers/flows/coding/todo.vibe:97 | Continue the same attempt after review input | Machine | Keep | - |
| `coding/todo-boundary` | flow | .smithers/flows/coding/todo-pause.vibe:54 | Park and resume at a safe TODO boundary | Machine | Keep | - |
| `coding/FlowLoad` | flow | .smithers/flows/coding/flow-load/flow.ts:12 | Validate the pinned repository flow source | Machine | Keep | Validated the flows |
| `coding/load-flows` | action | .smithers/flows/coding/flow-load.vibe:69 | Typecheck the immutable flow source without executing it | Machine | Keep | Validated the flows |

## C.2 review

The ordinary `/review` flow: per-file review, independent verification, and a walkthrough.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `review/change` | flow | .smithers/flows/review/change/flow.mdx:1 | Review one change by flow | Machine | Replaced by the `todo` flow (T-FLW-11): its steps survive inside the single run; this separate entry point is removed | Reviewed the change |
| `review` | flow | .smithers/flows/review/flow.ts:11 | Review a change and render a walkthrough | Machine | Keep | Reviewed the change |
| `smithers-review/PrepareReview` | action | .smithers/flows/review/src/workflow/reviewActions.ts:60 | Resolve the revisions and file batches | Machine | Keep | Prepared the review |
| `smithers-review/MergeFileBatch` | action | .smithers/flows/review/src/workflow/reviewActions.ts:101 | Merge per-file findings | Machine | Keep | Collected findings |
| `smithers-review/FinalizeReview` | action | .smithers/flows/review/src/workflow/reviewActions.ts:129 | Assemble the review result | Machine | Keep | Finished the review |
| `smithers-review/ApplyVerdicts` | action | .smithers/flows/review/src/workflow/reviewActions.ts:179 | Apply verdicts to findings | Machine | Keep | Settled findings |
| `smithers-review/RenderWalkthrough` | action | .smithers/flows/review/src/workflow/reviewActions.ts:229 | Render the walkthrough | Machine | Keep | Rendered the walkthrough |
| `smithers-review/ReviewFile` | agent action (?) | .smithers/flows/review/src/workflow/reviewAgentActions.ts:38 | Agent reviews one file | Machine | Keep | Reviewed one file |
| `smithers-review/VerifyFindings` | agent action (?) | .smithers/flows/review/src/workflow/reviewAgentActions.ts:56 | Agent confirms or drops findings | Machine | Keep | Verified findings |
| `smithers-review/NarrateChanges` | agent action (?) | .smithers/flows/review/src/workflow/reviewAgentActions.ts:91 | Agent narrates the changes | Machine | Keep | Wrote the walkthrough |
| `smithers-review/NarrateReview` | flow | .smithers/flows/review/src/workflow/reviewFlow.ts:51 | Narrate the change | Machine | Keep | Wrote the walkthrough |
| `smithers-review/VerifyReview` | flow | .smithers/flows/review/src/workflow/reviewFlow.ts:106 | Verify findings independently | Machine | Keep | Verified findings |
| `smithers-review/ReviewFiles` | flow | .smithers/flows/review/src/workflow/reviewFlow.ts:157 | Review each file batch | Machine | Keep | Reviewed the files |

## C.3 wiki

Generated wiki pages with cited, reviewed content and incremental reuse.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `smithers/Wiki` | flow | .smithers/flows/wiki/flow.ts:9 | Build and review wiki pages | Machine | Keep | Refreshed the wiki |
| `wiki/load-recorded-reviews` | action | .smithers/flows/wiki/reuse.ts:54 | Load earlier page reviews | Install | Keep | Found earlier reviews |
| `wiki/select-recorded-review` | action | .smithers/flows/wiki/reuse.ts:59 | Choose a reusable review | Install | Keep | Reused a review |
| `wiki/bind-review-provenance` | action | .smithers/flows/wiki/reuse.ts:64 | Bind a review to its source | Install | Keep | Linked a review to its source |
| `wiki/publish-recorded-reviews` | action | .smithers/flows/wiki/reuse.ts:69 | Publish reused reviews | Install | Keep | Saved wiki pages |
| `smithers/IncrementalWiki` | flow | .smithers/flows/wiki/reuse.ts:75 | Re-review only changed wiki sections | Install | Keep | Refreshed the wiki |
| `wiki/collect-page` | action | .smithers/flows/wiki/workflow.vibe:10 | Collect a page's sources | Install | Keep | Collected sources for a page |
| `wiki/review-page` | agent action (wiki/reviewer) | .smithers/flows/wiki/workflow.vibe:16 | Agent writes or reviews a page | Machine | Keep | Reviewed a wiki page |
| `wiki/validate-review` | action | .smithers/flows/wiki/workflow.vibe:47 | Validate the page review | Install | Keep | Checked a wiki page |
| `wiki/check-citations` | action | .smithers/flows/wiki/workflow.vibe:58 | Check page citations | Install | Keep | Checked citations |
| `wiki/assess-review` | action | .smithers/flows/wiki/workflow.vibe:98 | Judge the review's quality | Install | Keep | Assessed a wiki page |
| `wiki/write-snapshot` | action | .smithers/flows/wiki/workflow.vibe:103 | Write the wiki snapshot | Install | Keep | Saved wiki pages |

## C.4 memory

Mine finished runs for lessons (the learning run) and calibrate recall.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `memory/calibrate/run` | action | .smithers/flows/memory/calibrate/flow.ts:30 | Refit thresholds and report recall | Install | Cut | - |
| `memory/calibrate` | flow | .smithers/flows/memory/calibrate/flow.ts:43 | Refit memory thresholds from journals | Install | Cut | - |
| `memory/mine/run` | action | .smithers/flows/memory/mine/flow.ts:13 | Extract facts and decisions from a journal | Install | Keep | Saved lessons |
| `memory/mine` | flow | .smithers/flows/memory/mine/flow.ts:20 | Mine a finished run for lessons | Machine | Keep | Saved lessons |

## C.5 create-flow

The authoring pipeline behind `/flow.new`: clarify, design, scaffold, provision, document, fix.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `create-flow/clarify` | flow | .smithers/flows/create-flow/clarify/flow.mdx:1 | Ask what the flow should do | Machine | Keep | Asked what the flow should do |
| `create-flow/design` | flow | .smithers/flows/create-flow/design/flow.mdx:1 | Design the flow's shape | Machine | Keep | Designed the flow |
| `create-flow/document` | flow | .smithers/flows/create-flow/document/flow.mdx:1 | Write the flow's docs | Machine | Keep | Documented the flow |
| `create-flow/fix` | flow | .smithers/flows/create-flow/fix/flow.mdx:1 | Fix failures in the new flow | Machine | Keep | Fixed the flow |
| `create-flow` | flow | .smithers/flows/create-flow/flow.mdx:1 | Clarify, design, scaffold and fix a flow | Machine | Keep | Created a flow |
| `create-flow/provision` | flow | .smithers/flows/create-flow/provision/flow.mdx:1 | Provision what the flow needs | Machine | Keep | Set up the flow |
| `create-flow/scaffold` | flow | .smithers/flows/create-flow/scaffold/flow.mdx:1 | Write the flow's files | Machine | Keep | Wrote the flow |

## C.6 create-skill

An authoring pipeline for agent skills.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `create-skill/clarify` | flow | .smithers/flows/create-skill/clarify/flow.mdx:1 | Ask what the skill should do | Install | Cut | - |
| `create-skill/design` | flow | .smithers/flows/create-skill/design/flow.mdx:1 | Design the skill blueprint | Install | Cut | - |
| `create-skill/document` | flow | .smithers/flows/create-skill/document/flow.mdx:1 | Document the skill | Install | Cut | - |
| `create-skill/scaffold` | flow | .smithers/flows/create-skill/scaffold/flow.mdx:1 | Write the skill files | Install | Cut | - |

## C.7 Standard tools (packages/smithers/agent)

Tool flows the coding host binds to the agent, plus declared-but-unbound tools and agent-runtime steps.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `remember` | flow | packages/smithers/agent/memory/src/Flows.ts:183 | Save a fact | Machine | Keep | Learning receipt |
| `recall (namespaced)` | flow | packages/smithers/agent/memory/src/Flows.ts:197 | Recall within one approved memory namespace | Machine | Keep | The "Context" line and the preflight cell in Inspect |
| `memory` | flow | packages/smithers/agent/src/Memory.ts:331 | Pick context from wiki, code, history | Machine | Keep | The "Context" line and the preflight cell in Inspect |
| `recall` | flow | packages/smithers/agent/src/StandardFlows.ts:327 | Recall facts and history | Machine | Keep | The "Context" line and the preflight cell in Inspect |
| `jev` | flow | packages/smithers/agent/src/StandardFlows.ts:715 | Typed decision by Jev | Machine | Keep | Inspect only: "Decided <question>" |
| `wait` | flow | packages/smithers/agent/src/StandardFlows.ts:843 | Durable sleep | Machine | Keep | Inspect: "Waited" |
| `ask` | flow | packages/smithers/agent/src/StandardFlows.ts:964 | Ask a person | Machine | Keep | Needs you |
| `apply_patch` | flow | packages/smithers/agent/std/src/ApplyPatch.ts:123 | Apply a multi-file patch | Machine | Keep | An attributed edit in the File and Diff cards |
| `bash` | flow | packages/smithers/agent/std/src/Bash.ts:264 | Run a shell command | Machine | Keep | Terminal card (agent session). Missing: no terminal today |
| `edit` | flow | packages/smithers/agent/std/src/Edit.ts:143 | Replace text in a file | Machine | Keep | An attributed edit in the File and Diff cards |
| `explore` | flow | packages/smithers/agent/std/src/Explore.ts:123 | Delegate a read-only search | Machine | Cut | - |
| `fetch` | flow | packages/smithers/agent/std/src/Fetch.ts:107 | Fetch a URL | Machine | Cut | - |
| `glob` | flow | packages/smithers/agent/std/src/Glob.ts:150 | Find files by pattern | Machine | Keep | A "read" line in branch activity, opening the File card |
| `grep` | flow | packages/smithers/agent/std/src/Grep.ts:218 | Search file contents | Machine | Keep | A "read" line in branch activity, opening the File card |
| `http-post` | flow | packages/smithers/agent/std/src/HttpPost.ts:108 | POST to a URL | Machine | Cut | - |
| `ls` | flow | packages/smithers/agent/std/src/Ls.ts:114 | List a directory | Machine | Keep | A "read" line in branch activity, opening the File card |
| `lsp` | flow | packages/smithers/agent/std/src/Lsp.ts:128 | Query a language server | Machine | Cut | - |
| `read` | flow | packages/smithers/agent/std/src/Read.ts:140 | Read a file | Machine | Keep | A "read" line in branch activity, opening the File card |
| `shell_command` | flow | packages/smithers/agent/std/src/ShellCommand.ts:157 | Run one command, no session | Machine | Cut | - |
| `test` | flow | packages/smithers/agent/std/src/TestRun.ts:202 | Run the declared tests | Machine | Keep | Terminal card plus checks. Missing: needs SMITHERS_TEST_COMMAND |
| `update_plan` | flow | packages/smithers/agent/std/src/UpdatePlan.ts:146 | Update the agent's plan list | Machine | Cut | - |
| `webfetch` | flow | packages/smithers/agent/std/src/WebFetch.ts:111 | Fetch a page as text | Machine | Cut | - |
| `websearch` | flow | packages/smithers/agent/std/src/WebSearch.ts:109 | Search the web | Machine | Cut | - |
| `write` | flow | packages/smithers/agent/std/src/Write.ts:106 | Write a file (versioned) | Machine | Keep | An attributed edit in the File and Diff cards |
| `<park>/parked` | action | packages/smithers/agent/src/Agent.ts:660 | Emit model-parked event | Machine | Keep | - |
| `agent/capacity/<seat>/cool/<n>` | action | packages/smithers/agent/src/Agent.ts:749 | Park a seat on quota | Machine | Keep | Waiting for a model |
| `<quota-park>/<session>` | action | packages/smithers/agent/src/AgentAction.ts:802 | Park on quota per session | Machine | Keep | - |
| `<structured-output-count>/<name>` | action | packages/smithers/agent/src/AgentAction.ts:962 | Count structured outputs | Machine | Keep | - |
| `agent/run` | flow | packages/smithers/agent/src/AgentSession.ts:2060 | One agent turn loop | Machine | Keep | Inspect: "Worked a turn" |
| `agent/opening-memory` | action | packages/smithers/agent/src/AgentSession.ts:3562 | Load memory at turn start | Machine | Keep | Inspect: "Loaded context" |
| `agent/opening-instructions` | action | packages/smithers/agent/src/AgentSession.ts:3575 | Load workspace instructions | Machine | Keep | Inspect: "Read the instructions" |
| `agent/spawn` | flow | packages/smithers/agent/src/ChildFlows.ts:113 | Start a child agent | Machine | Cut | - |
| `agent/send` | flow | packages/smithers/agent/src/ChildFlows.ts:128 | Steer a running child agent | Machine | Cut | - |
| `agent/await` | flow | packages/smithers/agent/src/ChildFlows.ts:142 | Wait for a child agent | Machine | Cut | - |
| `agent/send (stamp)` | action | packages/smithers/agent/src/EngineChildren.ts:538 | Stamp a sent message | Machine | Keep | - |
| `<seal-step>` | action | packages/smithers/agent/src/FlowEngineLike.ts:1046 | Record a sealed model step | Machine | Keep | - |
| `<cell-call:flow>` | action | packages/smithers/agent/src/FlowEngineLike.ts:1212 | Record one tool (cell) call | Machine | Keep | Each tool call renders per B.3 |
| `<boundary:name>` | action | packages/smithers/agent/src/FlowEngineLike.ts:1293 | Cross an irreversible boundary | Machine | Keep | - |
| `flows/show-script` | flow | packages/smithers/agent/src/PromoteFlows.ts:139 | Show a flow script | Machine | Cut | - |
| `flows/write-flow` | flow | packages/smithers/agent/src/PromoteFlows.ts:162 | Write a flow file | Machine | Cut | - |
| `agent/route-seat` | action | packages/smithers/agent/src/SeatRouter.ts:519 | Pick the model seat | Machine | Keep | Inspect: "Chose a model" |
| `smithers.guide` | flow | packages/smithers/agent/src/SmithersPlugin.ts:226 | Plugin: Smithers guide | Machine | Cut | - |
| `smithers.flows` | flow | packages/smithers/agent/src/SmithersPlugin.ts:240 | Plugin: list flows | Machine | Cut | - |
| `smithers.run` | flow | packages/smithers/agent/src/SmithersPlugin.ts:251 | Plugin: run a flow | Machine | Cut | - |
| `smithers.inspect` | flow | packages/smithers/agent/src/SmithersPlugin.ts:267 | Plugin: inspect a run | Machine | Cut | - |
| `agent/trace/checkpoint` | action | packages/smithers/agent/src/internal/StepTrace.ts:94 | Checkpoint a step trace | Machine | Keep | - |

## C.8 repository

The old job machinery: issue and PR jobs, replies, setup, evaluation, triggers, checks.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `repository/register-candidate` | action | .smithers/flows/repository/activation.vibe:92 | Register a candidate setup | Install | Cut | - |
| `repository/RegisterCandidate` | flow | .smithers/flows/repository/activation.vibe:98 | Register a candidate flow | Install | Cut | - |
| `repository/probe-trial` | action | .smithers/flows/repository/activation.vibe:112 | Trial a candidate setup | Install | Cut | - |
| `repository/request-manual` | action | .smithers/flows/repository/activation.vibe:134 | Request a manual run | Install | Cut | - |
| `repository/DispatchManual` | flow | .smithers/flows/repository/activation.vibe:140 | Dispatch a manual run | Install | Cut | - |
| `repository/probe-manual` | action | .smithers/flows/repository/activation.vibe:146 | Probe a manual run | Install | Cut | - |
| `repository/draft-change` | agent action (repository/author) | .smithers/flows/repository/changes.vibe:34 | Agent drafts a change for an issue | Install | Defer §14 | - |
| `repository/select-change-source` | action | .smithers/flows/repository/changes.vibe:52 | Choose the change's source | Install | Defer §14 | - |
| `repository/prepare-change` | action | .smithers/flows/repository/changes.vibe:65 | Prepare a proposed change | Install | Defer §14 | - |
| `repository/retain-proposed-change` | action | .smithers/flows/repository/changes.vibe:71 | Save a proposed change | Install | Defer §14 | - |
| `repository/prepare-change-entry` | action | .smithers/flows/repository/changes.vibe:76 | Prepare the change entry | Install | Defer §14 | - |
| `repository/create-native-source` | action | .smithers/flows/repository/changes.vibe:82 | Create a native source | Install | Defer §14 | - |
| `repository/verify-written-change` | action | .smithers/flows/repository/changes.vibe:88 | Verify the written change | Install | Defer §14 | - |
| `repository/retain-source-admission-failure` | action | .smithers/flows/repository/changes.vibe:94 | Save a source admission failure | Install | Defer §14 | - |
| `repository/ApplyChange` | flow | .smithers/flows/repository/changes.vibe:106 | Apply a drafted change | Install | Defer §14 | - |
| `repository/ProposalStep` | flow | .smithers/flows/repository/changes.vibe:202 | Propose a change from an issue | Install | Defer §14 | - |
| `repository/capture-checks` | action | .smithers/flows/repository/checks.vibe:241 | Capture check evidence | Install | Cut | - |
| `repository/execute-command-check` | action | .smithers/flows/repository/checks.vibe:247 | Run a command check | Install | Cut | - |
| `repository/retain-semantic-check` | action | .smithers/flows/repository/checks.vibe:253 | Save an AI check result | Install | Cut | - |
| `repository/jev-semantic-check` | action | .smithers/flows/repository/checks.vibe:269 | Jev runs an AI check | Install | Cut | - |
| `repository/CommandCheck` | flow | .smithers/flows/repository/checks.vibe:275 | Run a command check | Install | Cut | - |
| `repository/AICheck` | flow | .smithers/flows/repository/checks.vibe:286 | Run an AI check | Install | Cut | - |
| `repository/run-checks` | action | .smithers/flows/repository/checks.vibe:301 | Run configured checks | Install | Cut | - |
| `repository/CheckStep` | flow | .smithers/flows/repository/checks.vibe:306 | Run one check step | Install | Cut | - |
| `repository/prepare-landing` | action | .smithers/flows/repository/delivery.vibe:25 | Prepare a landing | Install | Defer §14 | - |
| `repository/report-check-receipt` | action | .smithers/flows/repository/delivery.vibe:32 | Report a check receipt | Install | Defer §14 | - |
| `repository/create-landing` | action | .smithers/flows/repository/delivery.vibe:38 | Create a landing record | Install | Defer §14 | - |
| `repository/queue-landing` | action | .smithers/flows/repository/delivery.vibe:44 | Queue a landing | Install | Defer §14 | - |
| `repository/observe-landing` | action | .smithers/flows/repository/delivery.vibe:54 | Watch a landing finish | Install | Defer §14 | - |
| `repository/retain-landing` | action | .smithers/flows/repository/delivery.vibe:68 | Save a landing result | Install | Defer §14 | - |
| `repository/retain-delivery-failure` | action | .smithers/flows/repository/delivery.vibe:73 | Save a delivery failure | Install | Defer §14 | - |
| `repository/DeliverChange` | flow | .smithers/flows/repository/delivery.vibe:78 | Land a job's change | Install | Defer §14 | - |
| `repository/jev-score` | action | .smithers/flows/repository/evaluation.vibe:41 | Jev scores an evaluation case | Install | Cut | - |
| `repository/score-case` | agent action (repository/evaluator) | .smithers/flows/repository/evaluation.vibe:47 | Agent scores an evaluation case | Install | Cut | - |
| `repository/retain-eval-score` | action | .smithers/flows/repository/evaluation.vibe:66 | Save an evaluation score | Install | Cut | - |
| `repository/ScoreExecution` | flow | .smithers/flows/repository/evaluation.vibe:71 | Score one evaluation run | Install | Cut | - |
| `repository/evaluate-candidate` | action | .smithers/flows/repository/evaluation.vibe:89 | Evaluate a candidate setup | Install | Cut | - |
| `repository/CaptureCase` | flow | .smithers/flows/repository/evaluation.vibe:114 | Capture an evaluation case | Install | Cut | - |
| `repository/capture` | action | .smithers/flows/repository/inspection.vibe:23 | Capture repository evidence | Install | Defer §14 | - |
| `repository/start-budget` | action | .smithers/flows/repository/inspection.vibe:172 | Start a job's budget | Install | Defer §14 | - |
| `repository/assert-budget` | action | .smithers/flows/repository/inspection.vibe:178 | Stop a job over budget | Install | Defer §14 | - |
| `repository/ApproveStep` | flow | .smithers/flows/repository/jobs.vibe:127 | Wait for a person's approval | Install | Defer §14 | - |
| `repository/research` | agent action (seat repository/research) | .smithers/flows/repository/jobs.vibe:203 | Agent researches a request | Install | Defer §14 | - |
| `repository/propose-repro` | agent action (seat repository/propose-repro) | .smithers/flows/repository/jobs.vibe:207 | Agent proposes a reproduction | Install | Defer §14 | - |
| `repository/review` | agent action (seat repository/review) | .smithers/flows/repository/jobs.vibe:211 | Agent reviews an outside change | Install | Defer §14 | - |
| `repository/jev-duplicates` | action | .smithers/flows/repository/jobs.vibe:219 | Jev finds duplicate issues | Install | Defer §14 | - |
| `repository/retain-observation` | action | .smithers/flows/repository/jobs.vibe:225 | Save a job observation | Install | Defer §14 | - |
| `repository/execute-repro` | action | .smithers/flows/repository/jobs.vibe:230 | Run a proposed reproduction | Install | Defer §14 | - |
| `repository/jev-reproduction` | action | .smithers/flows/repository/jobs.vibe:247 | Jev judges a reproduction | Install | Defer §14 | - |
| `repository/retain-reproduction-review` | action | .smithers/flows/repository/jobs.vibe:253 | Save the reproduction review | Install | Defer §14 | - |
| `repository/ReviewReproduction` | flow | .smithers/flows/repository/jobs.vibe:258 | Review a reproduction | Install | Defer §14 | - |
| `repository/retain-step-failure` | action | .smithers/flows/repository/jobs.vibe:267 | Save a step failure | Install | Defer §14 | - |
| `repository/FailedStep` | flow | .smithers/flows/repository/jobs.vibe:272 | Record a failed job step | Install | Defer §14 | - |
| `repository/InvestigateStep` | flow | .smithers/flows/repository/jobs.vibe:347 | Investigate an issue or PR | Install | Defer §14 | - |
| `repository/finish-job` | action | .smithers/flows/repository/jobs.vibe:360 | Close out a job | Install | Defer §14 | - |
| `repository/validate-author-reply` | action | .smithers/flows/repository/jobs.vibe:370 | Check an author's reply | Install | Defer §14 | - |
| `repository/CheckReply` | flow | .smithers/flows/repository/jobs.vibe:375 | Check an author reply | Install | Defer §14 | - |
| `repository/await-author-reply` | action | .smithers/flows/repository/jobs.vibe:381 | Wait for the author | Install | Defer §14 | - |
| `repository/AwaitReply` | flow | .smithers/flows/repository/jobs.vibe:386 | Wait for an author reply | Install | Defer §14 | - |
| `repository/continue-author` | action | .smithers/flows/repository/jobs.vibe:392 | Resume after an author reply | Install | Defer §14 | - |
| `repository/run-steps` | action | .smithers/flows/repository/jobs.vibe:400 | Run a job's configured steps | Install | Defer §14 | - |
| `repository/capture-job` | action | .smithers/flows/repository/jobs.vibe:410 | Capture a job's evidence | Install | Defer §14 | - |
| `repository/CaptureFollowup` | flow | .smithers/flows/repository/jobs.vibe:416 | Capture follow-up evidence | Install | Defer §14 | - |
| `repository/Investigate` | flow | .smithers/flows/repository/jobs.vibe:422 | Investigate an incoming issue or PR | Install | Defer §14 | - |
| `repository/Job` | flow | .smithers/flows/repository/jobs.vibe:433 | Run one configured job | Install | Defer §14 | - |
| `repository/reply-budget` | action | .smithers/flows/repository/replies.vibe:98 | Reserve the reply budget | Install | Defer §14 | - |
| `repository/ConfirmReply` | flow | .smithers/flows/repository/replies.vibe:108 | Confirm a drafted reply | Install | Defer §14 | - |
| `repository/publish-reply` | action | .smithers/flows/repository/replies.vibe:131 | Post an approved reply | Install | Defer §14 | - |
| `repository/PublishReply` | flow | .smithers/flows/repository/replies.vibe:137 | Post a reply after approval | Install | Defer §14 | - |
| `repository/suggest-setup` | agent action (repository/research) | .smithers/flows/repository/setup.ts:212 | Agent suggests a job setup | Install | Cut | - |
| `repository/Capture` | flow | .smithers/flows/repository/setup.ts:243 | Capture setup evidence | Install | Cut | - |
| `repository/Suggest` | flow | .smithers/flows/repository/setup.ts:249 | Suggest a setup | Install | Cut | - |
| `repository/RunEvaluation` | flow | .smithers/flows/repository/setup.ts:255 | Evaluate a candidate setup | Install | Cut | - |
| `repository/execute-setup` | action | .smithers/flows/repository/setup.ts:261 | Run setup | Install | Cut | - |
| `repository/Setup` | flow | .smithers/flows/repository/setup.ts:267 | Set up a repository job | Install | Cut | - |
| `repository/refuse-setup` | action | .smithers/flows/repository/setup.ts:276 | Refuse a setup | Install | Cut | - |
| `repository/RunSetup` | flow | .smithers/flows/repository/setup.ts:281 | Run or refuse setup | Install | Cut | - |
| `repository/refuse-job` | action | .smithers/flows/repository/setup.ts:290 | Refuse a job | Install | Cut | - |
| `repository/RunJob` | flow | .smithers/flows/repository/setup.ts:291 | Run or refuse a job | Install | Cut | - |
| `repository/recover-trigger` | action | .smithers/flows/repository/triggers.vibe:105 | Recover a stuck trigger | Install | Defer §16 | - |
| `repository/RecoverTrigger` | flow | .smithers/flows/repository/triggers.vibe:111 | Recover a trigger | Install | Defer §16 | - |
| `repository/prepare-trigger` | action | .smithers/flows/repository/triggers.vibe:118 | Prepare a trigger | Install | Defer §16 | - |
| `repository/PrepareTrigger` | flow | .smithers/flows/repository/triggers.vibe:124 | Prepare a trigger | Install | Defer §16 | - |
| `repository/activate-trigger` | action | .smithers/flows/repository/triggers.vibe:130 | Activate a trigger | Install | Defer §16 | - |
| `repository/ActivateTrigger` | flow | .smithers/flows/repository/triggers.vibe:136 | Activate a trigger | Install | Defer §16 | - |
| `repository/fire-trigger` | action | .smithers/flows/repository/triggers.vibe:142 | Fire a trigger | Install | Defer §16 | - |
| `repository/FireTrigger` | flow | .smithers/flows/repository/triggers.vibe:148 | Fire a trigger | Install | Defer §16 | - |
| `repository/execute-trigger` | action | .smithers/flows/repository/triggers.vibe:155 | Run a trigger's flow | Install | Defer §16 | - |
| `repository/Trigger` | flow | .smithers/flows/repository/triggers.vibe:161 | Run a trigger | Install | Defer §16 | - |
| `repository/refuse-trigger` | action | .smithers/flows/repository/triggers.vibe:170 | Refuse an unapproved trigger | Install | Defer §16 | - |
| `repository/RunTrigger` | flow | .smithers/flows/repository/triggers.vibe:175 | Run or refuse a trigger | Install | Defer §16 | - |

## C.9 checks

Check flows that `coding/Verify` runs against a candidate.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `checks/affected-lint` | flow | .smithers/flows/checks/affected-lint/flow.mdx:1 | Lint targets the change affects | Machine | Internal ops | - |
| `checks/affected-test` | flow | .smithers/flows/checks/affected-test/flow.mdx:1 | Test targets the change affects | Machine | Internal ops | - |
| `checks/bundle-bun` | flow | .smithers/flows/checks/bundle-bun/flow.mdx:1 | Run the coding bundle target on Bun | Machine | Internal ops | - |
| `checks/bundle` | flow | .smithers/flows/checks/bundle/flow.mdx:1 | Run the coding bundle acceptance target | Machine | Internal ops | - |
| `checks/drift` | flow | .smithers/flows/checks/drift/flow.mdx:1 | Report format, index and docs drift | Machine | Internal ops | - |
| `checks/lint` | flow | .smithers/flows/checks/lint/flow.mdx:1 | Lint the change hunk by hunk with Jev | Machine | Keep | Linted the change |
| `checks/native-bun` | flow | .smithers/flows/checks/native-bun/flow.mdx:1 | Run the native target on Bun | Machine | Internal ops | - |
| `checks/native` | flow | .smithers/flows/checks/native/flow.mdx:1 | Run the native coding acceptance target | Machine | Internal ops | - |
| `checks/policy` | flow | .smithers/flows/checks/policy/flow.mdx:1 | Run the coding policy acceptance target | Machine | Internal ops | - |
| `checks/review` | flow | .smithers/flows/checks/review/flow.mdx:1 | Review the change on a second provider | Machine | Keep | Reviewed the change |
| `checks/runtime` | flow | .smithers/flows/checks/runtime/flow.mdx:1 | Run the coding runtime acceptance target | Machine | Internal ops | - |
| `checks/security` | flow | .smithers/flows/checks/security/flow.mdx:1 | Run trusted security reviews | Machine | Keep | Reviewed security |
| `checks/wiki` | flow | .smithers/flows/checks/wiki/flow.ts:27 | Review the public wiki against a revision | Machine | Keep | Checked the wiki |

## C.10 issue

Issue reproduction and proof-of-concept prompts used by the issue job.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `issue/poc` | flow | .smithers/flows/issue/poc/flow.mdx:1 | Draft a proof of concept for an issue | Install | Defer §14 | - |
| `issue/repro` | flow | .smithers/flows/issue/repro/flow.mdx:1 | Research and reproduce an issue | Install | Defer §14 | - |

## C.11 pr-triage

Prompt flow that triages one outside pull request.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `pr-triage` | flow | .smithers/flows/pr-triage/flow.mdx:1 | Triage one outside pull request | Install | Defer §14 | - |

## C.12 issue-triage

Prompt flow that reproduces and triages one issue.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `issue-triage` | flow | .smithers/flows/issue-triage/flow.mdx:1 | Reproduce and triage one issue for a maintainer | Install | Defer §14 | - |

## C.13 security-audit

Nightly security audit that delegates to `coding/SecurityAudit`.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `security-audit` | flow | .smithers/flows/security-audit/flow.mdx:1 | Audit each package's security boundary nightly | Install | Defer §16 | - |

## C.14 lint

Example prompt flow that lints named files.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `lint` | flow | .smithers/flows/lint/flow.mdx:1 | Lint named files against repo conventions | Install | Internal ops | - |

## C.15 release-notes

Prompt flow that drafts release notes.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `release-notes` | flow | .smithers/flows/release-notes/flow.mdx:1 | Draft release notes from commits since the last tag | Install | Internal ops | - |

## C.16 release

Smithers release pipeline: prepare, check, build, pack, publish.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `smithers/Release` | flow | .smithers/flows/release/flow.ts:38 | Prepare, check, pack and publish a release | Install | Internal ops | - |
| `release/audit-documentation` | agent action (release/reviewer) | .smithers/flows/release/workflow.ts:13 | Agent audits docs before release | Install | Internal ops | - |
| `release/prepare-plan` | action | .smithers/flows/release/workflow.ts:25 | Plan the release | Install | Internal ops | - |
| `release/write-preparation` | action | .smithers/flows/release/workflow.ts:31 | Write the release preparation | Install | Internal ops | - |
| `release/validate` | action | .smithers/flows/release/workflow.ts:37 | Validate release inputs | Install | Internal ops | - |
| `release/checks` | action | .smithers/flows/release/workflow.ts:43 | Run release checks | Install | Internal ops | - |
| `release/build` | action | .smithers/flows/release/workflow.ts:49 | Build release artifacts | Install | Internal ops | - |
| `release/pack` | action | .smithers/flows/release/workflow.ts:55 | Pack release artifacts | Install | Internal ops | - |
| `release/smoke` | action | .smithers/flows/release/workflow.ts:61 | Smoke-test packed artifacts | Install | Internal ops | - |
| `release/verify-candidate` | action | .smithers/flows/release/workflow.ts:67 | Verify the release candidate | Install | Internal ops | - |
| `release/publish` | action | .smithers/flows/release/workflow.ts:73 | Publish to npm | Install | Internal ops | - |
| `release/outcome` | action | .smithers/flows/release/workflow.ts:81 | Report the release outcome | Install | Internal ops | - |

## C.17 release-content

Release changelog, thread and blog drafting with approval.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `smithers/ReleaseContent` | flow | .smithers/flows/release-content/flow.ts:135 | Draft release changelog, thread and blog | Install | Internal ops | - |
| `release-content/collect` | action | .smithers/flows/release-content/workflow.ts:28 | Collect release facts | Install | Internal ops | - |
| `release-content/record-ui` | action | .smithers/flows/release-content/workflow.ts:34 | Record UI captures | Install | Internal ops | - |
| `release-content/analyze` | agent action (release/analyst) | .smithers/flows/release-content/workflow.ts:40 | Agent analyzes the release | Install | Internal ops | - |
| `release-content/pick-template` | action | .smithers/flows/release-content/workflow.ts:54 | Choose a content template | Install | Internal ops | - |
| `release-content/outline-template` | agent action (release/writer) | .smithers/flows/release-content/workflow.ts:62 | Agent outlines the template | Install | Internal ops | - |
| `release-content/draft-changelog` | agent action (release/writer) | .smithers/flows/release-content/workflow.ts:72 | Agent drafts the changelog | Install | Internal ops | - |
| `release-content/draft-thread` | agent action (release/writer) | .smithers/flows/release-content/workflow.ts:82 | Agent drafts the thread | Install | Internal ops | - |
| `release-content/outline-blog` | agent action (release/writer) | .smithers/flows/release-content/workflow.ts:92 | Agent outlines the blog | Install | Internal ops | - |
| `release-content/draft-blog` | agent action (release/writer) | .smithers/flows/release-content/workflow.ts:102 | Agent drafts the blog | Install | Internal ops | - |
| `release-content/score` | agent action (release/reviewer) | .smithers/flows/release-content/workflow.ts:112 | Agent scores the drafts | Install | Internal ops | - |
| `release-content/check` | action | .smithers/flows/release-content/workflow.ts:122 | Check drafts against rules | Install | Internal ops | - |
| `release-content/revise` | agent action (release/writer) | .smithers/flows/release-content/workflow.ts:127 | Agent revises the drafts | Install | Internal ops | - |
| `release-content/quality-gate` | action | .smithers/flows/release-content/workflow.ts:137 | Gate drafts on quality | Install | Internal ops | - |
| `release-content/write-preview` | action | .smithers/flows/release-content/workflow.ts:142 | Write a preview | Install | Internal ops | - |
| `release-content/record-approval` | action | .smithers/flows/release-content/workflow.ts:148 | Record a person's approval | Install | Internal ops | - |
| `release-content/publish-files` | action | .smithers/flows/release-content/workflow.ts:154 | Write the content files | Install | Internal ops | - |
| `release-content/post-thread` | action | .smithers/flows/release-content/workflow.ts:161 | Post the thread | Install | Internal ops | - |
| `release-content/commit-files` | action | .smithers/flows/release-content/workflow.ts:168 | Commit the content files | Install | Internal ops | - |
| `release-content/outcome` | action | .smithers/flows/release-content/workflow.ts:176 | Report the content outcome | Install | Internal ops | - |

## C.18 rollout

Deploy, verify and restore (Smithers Cloud ops).

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `rollout/execute` | action | .smithers/flows/rollout/flow.ts:32 | Run the rollout | Install | Internal ops | - |
| `rollout` | flow | .smithers/flows/rollout/flow.ts:39 | Deploy, verify and restore on failure | Install | Internal ops | - |

## C.19 register-repository

Repository registration: analyze a link, wait for admin review, then set up.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `register-repository` | flow | flows/register-repository/flow.ts:31 | Analyze a repository and wait for admin review | Install | Cut | - |
| `register-repository/setup` | flow | flows/register-repository/setup/flow.ts:7 | Set up a repository after admin approval | Install | Cut | - |
| `register-repository/clone` | action | flows/register-repository/workflow.ts:27 | Confirm the checkout and record its commit | Install | Cut | - |
| `register-repository/theme` | action | flows/register-repository/workflow.ts:27 | Detect the repository's theme | Install | Cut | - |
| `register-repository/license` | action | flows/register-repository/workflow.ts:27 | Detect the license | Install | Cut | - |
| `register-repository/checks` | action | flows/register-repository/workflow.ts:27 | Find the repository's checks | Install | Cut | - |
| `register-repository/readiness` | action | flows/register-repository/workflow.ts:27 | Score agent readiness | Install | Cut | - |
| `register-repository/cleanup` | action | flows/register-repository/workflow.ts:27 | Find cleanup opportunities | Install | Cut | - |
| `register-repository/agent-share` | action | flows/register-repository/workflow.ts:27 | Estimate agent-authored share | Install | Cut | - |
| `register-repository/commits` | action | flows/register-repository/workflow.ts:27 | Summarize recent commits | Install | Cut | - |
| `register-repository/contributors` | action | flows/register-repository/workflow.ts:27 | Summarize contributors | Install | Cut | - |
| `register-repository/intake` | action | flows/register-repository/workflow.ts:27 | Describe contribution intake | Install | Cut | - |
| `register-repository/workflows` | action | flows/register-repository/workflow.ts:27 | Propose flows to build | Install | Cut | - |
| `register-repository/ci` | action | flows/register-repository/workflow.ts:27 | Estimate CI cost | Install | Cut | - |
| `register-repository/languages` | action | flows/register-repository/workflow.ts:27 | List languages | Install | Cut | - |
| `register-repository/setup/verify` | action | flows/register-repository/workflow.ts:45 | Verify the setup result | Install | Cut | - |

## C.20 issue-sweep

Our burndown tool: sweep open issues across agent accounts.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `issue-sweep/ensure-disk` | action | .smithers/flows/issue-sweep/disk.vibe:68 | Ensure disk for a worker | Install | Cut | - |
| `issue-sweep/disk-admission` | flow | .smithers/flows/issue-sweep/disk.vibe:75 | Admit a worker by free disk | Install | Cut | - |
| `issue-sweep/list-issues` | action | .smithers/flows/issue-sweep/flow.ts:88 | List issues to sweep | Install | Cut | - |
| `issue-sweep/accounts` | action | .smithers/flows/issue-sweep/flow.ts:96 | List usable agent accounts | Install | Cut | - |
| `issue-sweep` | flow | .smithers/flows/issue-sweep/flow.ts:135 | Burn down issues across accounts | Install | Cut | - |
| `issue-sweep/choose-placement` | action | .smithers/flows/issue-sweep/flow.ts:358 | Choose where an issue runs | Install | Cut | - |
| `issue-sweep/placement` | flow | .smithers/flows/issue-sweep/flow.ts:364 | Place an issue on a host | Install | Cut | - |
| `issue-sweep/fetch-issue` | action | .smithers/flows/issue-sweep/work/flow.ts:130 | Fetch one issue | Install | Cut | - |
| `issue-sweep/prepare-workspace` | action | .smithers/flows/issue-sweep/work/flow.ts:138 | Prepare the issue's workspace | Install | Cut | - |
| `issue-sweep/adopt` | action | .smithers/flows/issue-sweep/work/flow.ts:186 | Claim the issue | Install | Cut | - |
| `issue-sweep/readopt` | flow | .smithers/flows/issue-sweep/work/flow.ts:201 | Resume an adopted issue | Install | Cut | - |
| `issue-sweep/fix` | action | .smithers/flows/issue-sweep/work/flow.ts:212 | Run the coding flow on the issue | Install | Cut | - |
| `issue-sweep/work` | flow | .smithers/flows/issue-sweep/work/flow.ts:219 | Fix one issue in a workspace | Install | Cut | - |

## C.21 wrapped

Year-in-review prompt built from sessions and memory.

| id | kind | source | what | runs in | MVP | renders as |
| --- | --- | --- | --- | --- | --- | --- |
| `wrapped/memory` | action | .smithers/flows/wrapped/flow.ts:73 | Select memory for the prompt | Install | Cut | - |
| `wrapped/prompt` | action | .smithers/flows/wrapped/flow.ts:79 | Write the prompt | Install | Cut | - |
| `wrapped/session` | action | .smithers/flows/wrapped/flow.ts:85 | Recall a session | Install | Cut | - |
| `wrapped/launch` | action | .smithers/flows/wrapped/flow.ts:90 | Launch the follow-up run | Install | Cut | - |
| `wrapped` | flow | .smithers/flows/wrapped/flow.ts:108 | Build a year-in-review prompt from sessions | Install | Cut | - |
## C.22 Totals

By section, kind and MVP decision. Steps in the `std` section's agent-runtime group count as `Keep` because every agent turn runs them.

| Section | flow | action | agent action | Keep | Defer §14 | Defer §16 | Cut | Internal ops | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| coding | 36 | 76 | 9 | 121 | 0 | 0 | 0 | 0 | 121 |
| review | 5 | 5 | 3 | 13 | 0 | 0 | 0 | 0 | 13 |
| wiki | 2 | 9 | 1 | 12 | 0 | 0 | 0 | 0 | 12 |
| memory | 2 | 2 | 0 | 2 | 0 | 0 | 2 | 0 | 4 |
| create-flow | 7 | 0 | 0 | 7 | 0 | 0 | 0 | 0 | 7 |
| create-skill | 4 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 4 |
| Standard tools (packages/smithers/agent) | 34 | 12 | 0 | 29 | 0 | 0 | 17 | 0 | 46 |
| repository | 33 | 52 | 6 | 0 | 49 | 12 | 30 | 0 | 91 |
| checks | 13 | 0 | 0 | 4 | 0 | 0 | 0 | 9 | 13 |
| issue | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| pr-triage | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| issue-triage | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| security-audit | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| lint | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| release-notes | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| release | 1 | 10 | 1 | 0 | 0 | 0 | 0 | 12 | 12 |
| release-content | 1 | 11 | 8 | 0 | 0 | 0 | 0 | 20 | 20 |
| rollout | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| register-repository | 2 | 14 | 0 | 0 | 0 | 0 | 16 | 0 | 16 |
| issue-sweep | 5 | 8 | 0 | 0 | 0 | 0 | 13 | 0 | 13 |
| wrapped | 1 | 4 | 0 | 0 | 0 | 0 | 5 | 0 | 5 |
| **Total** | **154** | **204** | **28** | **188** | **53** | **13** | **87** | **45** | **386** |

Per decision: Keep 188, Defer §14 53, Defer §16 13, Cut 87, Internal ops 45. Per kind: flow 154, action 204, agent action 28. Total 386.

## C.23 Gaps

Tags the MVP needs but that look unbound or unimplemented:

1. **Single `todo` run.** `factory/Todo` only routes a TODO. The one durable `todo` run per attempt (B.5, T-FLW-11) that plans, implements, verifies, reviews and waits for rebase, steer and merge does not exist. Today the TODO is `coding/Request` plus `coding/Vibe` as separate runs.
2. **Learning.** `memory/mine` exists but nothing starts it after a merge, and no `improve.mine` tag exists anywhere. The Learning receipt and `learning.accept` have no producing flow.
3. **Stack operations.** No Flow tag exists for `stack.propose`, `todo.amend`, `todo.drop`, `stack.move`, `branch.fork`, `branch.rebase` or timeline summaries. `coding/LandVibe` and `coding/*vibe*` cover append and PR only, and merge still keys on `automerge` (B.5).
4. **`ask` for the implementing agent.** The `ask` tag exists, but `coding/edit-atom` and `coding/dispatch-turn` do not bind it, so Needs you never appears mid-edit.
5. **`bash` and `test`.** Both are bound, but `bash` has no agent-owned terminal session, and `test` binds only when `SMITHERS_TEST_COMMAND` is set.
6. **Unclear AI checks.** §8 cuts "AI checks", yet `checks/review`, `checks/security`, `checks/lint`, `checks/wiki` and the `coding/*Check` flows are marked Keep because Verify and review use them. Will must rule which of these stay.
7. **POC.** `coding/Poc` is marked Keep (B.3 lists POC as a TODO step), but `issue/poc` and `repository/propose-repro` are Defer §14. Confirm the TODO flow's Prototype step ships.
8. **Duplicate tags.** `recall` and `agent/send` each have two declarations (a flow and a namespaced or stamped variant). Pick one id per behavior (§2: no two implementations of one behavior).
9. **Plugin flows.** `smithers.guide`, `smithers.flows`, `smithers.run`, `smithers.inspect` are not in Appendix B. They are marked Cut; the CLI and skill replace them.
10. **Not bound by the coding host:** `fetch`, `webfetch`, `websearch`, `http-post`, `lsp`, `explore`, `update_plan`, `shell_command`, `agent/spawn`, `agent/send`, `agent/await`, `flows/show-script`, `flows/write-flow` (B.3 says not in the MVP).

Keep rows with no plausible person-facing rendering (Inspect-only plumbing; hide them behind "Show internals" or leave them out of the card):

- `<park>/parked`, `<quota-park>/<session>`, `agent/capacity/<seat>/cool/<n>`: quota parking. Render one "Waiting for a model" line; hide the rest.
- `<structured-output-count>/<name>`, `<seal-step>`, `<boundary:name>`, `agent/trace/checkpoint`, `agent/send (stamp)`: bookkeeping with nothing for a person to read.

### Product decisions on the gaps (product agent, 2026-10-02)

- **Checks (gap on §8).** §8 cuts AI checks only as a separate setup job. The check flows that the TODO flow's verify and review steps run (`checks/*`, `coding/*Check`) stay Keep. §8 is clarified.
- **POC (gap 7).** `coding/Poc` stays Keep as an optional step inside the TODO flow (`coding/CoordinateRequest` may prototype before planning). The standalone `issue/poc` and `repository/propose-repro` stay Defer §14.
- **Engine bookkeeping with no person-facing rendering** (quota parking, sealed-step, boundary and output-count bookkeeping, `agent/trace/checkpoint`, `agent/send` stamps). Inspect groups these under one collapsed "Engine" row per run. They are never shown as steps.
- **Missing tags.** The single `todo` run, the stack operations (`stack.propose`, `todo.amend`, `todo.drop`, `stack.move`, `branch.fork`, `branch.rebase`), learning after merge, timeline summaries, `ask` for the implementing agent, and agent-owned terminal sessions for `bash` are already build gaps in mvp.md §11 and engineering's tickets. This appendix gains their rows when they exist.

- **Placements and entry points (product, 2026-10-02, Astra A-26).** Repository flows and coding agents run on machines (M-30), so `coding/Vibe`, `coding/Wiki`, `smithers/Wiki`, `wiki/review-page` and `memory/mine` run on Machine. The four separately launched entry points (`coding/Request`, `coding/Vibe`, `coding/Verify`, `review/change`) are replaced by the single durable `todo` run (T-FLW-11), whose steps keep their Inspect renderings.
