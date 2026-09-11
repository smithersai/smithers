# workflow/

The review workflow itself: four durable stages on `@smthrs/flow` plus the
pure functions they call.

## The stages

`reviewFlow.ts` declares them.

| Stage | What it does |
| --- | --- |
| `Review` | Runs `PrepareReview`, then hands off. |
| `ReviewFiles` | Runs one `concurrency`-wide batch per durable round, carries its accumulated outcomes to the next round, then finalizes. Simultaneous file-review calls never exceed this width. |
| `VerifyReview` | Adjudicates the findings, applies the verdicts. |
| `NarrateReview` | Narrates, quizzes, renders and writes the walkthrough. |

Why separate stages: `Node.all` fixes its width when the graph is built, and
the file list a review fans out over is something the first step discovers.
`Flow.to` ends a round and starts the next one with its payload decoded as real
data, which is what lets `ReviewFiles` read `prepared.prompt.files` and build one
node per file in the current batch. A self-handoff starts the next batch only
after the current one settles. Verification is its own round for the same
reason: whether to narrate and quiz is decided from the POST-verification findings, and those do
not exist until the verifying round has settled.

## The parts

- `reviewActions.ts` — the non-model steps: `PrepareReview` (one git read,
  because the preview, the walkthrough's changes and the review prompts must
  describe the same working tree; `loadReviewSnapshot` reads it and the three
  builders are pure over what it returns), `MergeFileBatch`, `FinalizeReview`,
  `ApplyVerdicts`, `RenderWalkthrough`.
- `reviewAgentActions.ts` — the model steps: `ReviewFile`, `VerifyFindings`,
  `NarrateChanges`, `QuizChanges`. Each declares its `output` schema, which the
  agent boundary renders into the run's system teaching and enforces on the way
  back with one correction re-prompt.
- `reviewSeats.ts` — which `provider:model` string each logical seat maps to.
  The flow declares logical seats (`review`, `review-verify`, …) so a step
  identity does not move when the model behind it changes.
- `reviewSeatResolver.ts` — the only file that reads a credential. It turns a
  logical seat into a live provider route, and honours `ANTHROPIC_BASE_URL` so
  the metered proxy the GitHub Action runs behind still works.
- `reviewLayer.ts` — two compositions, one seam apart: `layerMemory` for tests
  and the eval, `layerNode` for a real run over a SQLite file.
- `reviewSchemas.ts` — what each round hands the next. A later round reads only
  what it was handed: re-running `git diff` in the last round would read a
  working tree that may have moved under the run.
- Verification: `verifyFindings.ts` builds the prompt,
  `verifyVerdictsSchema.ts` defaults `index` to -1 so a verdict that lost its
  index is ignored rather than silently targeting finding 0, and
  `applyFindingVerdicts.ts` applies keep/drop/demote (demote never raises
  severity).
- Input: `reviewInputSchema.ts` extends `openCodeReviewInputSchema.ts`;
  `normalizeReviewInput.ts` and `normalizeOpenCodeReviewInput.ts` strip nulls
  so a caller that spells "not supplied" as `null` gets the declared defaults.
- Review data, one schema per file: `reviewModeSchema.ts`,
  `reviewTargetSchema.ts`, `previewEntrySchema.ts`, `previewOutputSchema.ts`,
  `reviewCommentSeveritySchema.ts` (the one severity list),
  `reviewCommentCategorySchema.ts`, `reviewCommentSchema.ts`,
  `reviewWarningSchema.ts`, `reviewSummarySchema.ts`,
  `reviewRunStatusSchema.ts`, `reviewRunOutputSchema.ts`,
  `nativeReviewFileSchema.ts`, `nativeReviewPromptSchema.ts`,
  `nativeReviewAgentOutputSchema.ts`, `workflowSummarySchema.ts`.
- `openCodeReview.ts` re-exports those schemas plus `../git` and `../review`
  for one release, because `@smthrs/review/workflow/openCodeReview` is a
  published entry point. New code imports the owning file.

The steps call two sibling directories:

- `../git/` reads the change set: `runCommand.ts`, `runGit.ts`,
  `parseGitDiff.ts`, `loadDiffs.ts` (range, commit, or working tree, with
  untracked files and provider-directory filtering), `effectivePath.ts`,
  `diffStatus.ts`, `diffRecord.ts`.
- `../review/` decides what to review and folds the answers:
  `loadReviewSnapshot.ts` (one git read), `resolveReviewTarget.ts`,
  `reviewMode.ts`, `validateReviewInput.ts`, `globMatch.ts`,
  `buildFileFilter.ts` (`.opencodereview/rule.json`), `whyExcluded.ts`,
  `previewFromSnapshot.ts`, `reviewChecklistForPath.ts`,
  `buildFileReviewPrompt.ts` (the per-file seat prompt), `reviewFileTaskId.ts`,
  `nativeReviewPromptFromSnapshot.ts`, `anchorFinding.ts`,
  `dedupeFindings.ts`, `rankSeverity.ts`, `finalizeNativeReview.ts`.

## Failure is data

Every model step is wrapped in `Node.catch`. A file review that fails becomes a
`subtask_error` warning against that file, a verifier that fails leaves the
findings unverified with a `verifier_error` warning, and a narrator that fails
falls back to the deterministic story. 0.x spelled all three `continueOnFail`.
