/**
 * The review flow's implementations that need a checkout and a filesystem.
 *
 * `PrepareReview` reads the change set from git or jj through the host's
 * process and filesystem services, and `RenderWalkthrough` writes the HTML
 * walkthrough to disk. Everything else the rounds run is pure and lives in
 * `reviewActions.ts`, so a host without a checkout can register the rounds
 * with its own implementations of these two.
 *
 * @since 1.0.0
 */
import { FileSystem, Layer } from "effect"
import * as Effect from "effect/Effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { withIo } from "../io.ts"
import { loadReviewSnapshot } from "../review/loadReviewSnapshot.ts"
import { preparedReviewOf } from "../review/preparedReviewOf.ts"
import { pluralize } from "../text/pluralize.ts"
import { normalizeStory } from "../walkthrough/normalizeStory.ts"
import { renderWalkthroughHtml } from "../walkthrough/renderWalkthroughHtml.ts"
import { walkthroughPath } from "../walkthrough/walkthroughPath.ts"
import { writeWalkthroughArtifact } from "../walkthrough/writeWalkthroughArtifact.ts"
import { PrepareReview, RenderWalkthrough } from "./reviewActions.ts"
import { ChangeSetUnreadable, reasonOf, WalkthroughUnwritable } from "./reviewFailureSchema.ts"

/**
 * The implementation layer for {@link PrepareReview}.
 *
 * @since 1.0.0
 * @category layers
 */
export const prepareReviewLayer = Layer.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return PrepareReview.toLayer(({ input }) =>
    Effect.gen(function*() {
      // Without review seats the per-file steps never run, so the finalizer must
      // see `runReview: false` and report "skipped" rather than "failed".
      const snapshot = yield* Effect.tryPromise({
        try: (signal) => withIo({ fs, spawner, signal }, () => loadReviewSnapshot(input, { out: input.out, db: "" })),
        catch: (cause) => new ChangeSetUnreadable({ repo: input.repo, message: reasonOf(cause) })
      })
      return preparedReviewOf(snapshot)
    })
  )
}))

/**
 * The implementation layer for {@link RenderWalkthrough}.
 *
 * @since 1.0.0
 * @category layers
 */
export const renderWalkthroughLayer = Layer.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return RenderWalkthrough.toLayer(
    ({ changes, input, review: originalReview, story: rawStory, target, narrateFailure }) =>
      Effect.gen(function*() {
        const warnings = [
          ...(narrateFailure ? [{ file: "", type: "narrator_error", message: narrateFailure }] : [])
        ]
        const review = warnings.length === 0 ? originalReview : {
          ...originalReview,
          status: originalReview.status === "success" ? "completed_with_warnings" as const : originalReview.status,
          warnings: [...originalReview.warnings, ...warnings]
        }
        const story = normalizeStory(rawStory, changes.files)
        const html = yield* Effect.promise(() =>
          renderWalkthroughHtml({
            title: input.title,
            story,
            files: changes.files,
            comments: review.comments,
            outcome: {
              status: review.status,
              warnings: review.warnings,
              files: changes.files.map((file) => {
                const errors = review.warnings.filter((warning) =>
                  warning.file === file.path && warning.type === "subtask_error"
                )
                const reason = !file.reviewed ?
                  file.excludeReason || "outside review scope"
                  : review.status === "skipped" ?
                  "review skipped"
                  : errors.length > 0 ?
                  errors.map((warning) => warning.message || "file review failed or incomplete").join("; ")
                  : review.status === "failed" ?
                  "review failed"
                  : ""
                return { path: file.path, status: reason ? "not_reviewed" as const : "reviewed" as const, reason }
              })
            },
            repoDir: target.repoDir,
            mode: target.mode,
            ref: target.ref,
            generatedAt: new Date().toISOString(),
            diffStyle: (input.split ? "split" : "unified")
          })
        )
        const outPath = walkthroughPath(target.repoDir, input.out)
        const artifactPath = yield* Effect.tryPromise({
          try: (signal) =>
            withIo({ fs, spawner, signal }, () => writeWalkthroughArtifact(target.repoDir, outPath, html)),
          catch: (cause) => new WalkthroughUnwritable({ path: outPath, message: reasonOf(cause) })
        })
        return {
          review,
          walkthrough: {
            path: outPath,
            artifactPath,
            bytes: Buffer.byteLength(html),
            chapters: story.chapters.length,
            files: changes.files.length,
            findings: review.comments.length,
            message: `Walkthrough written to ${outPath} (${pluralize(story.chapters.length, "chapter")}, ${
              pluralize(review.comments.length, "finding")
            }).`
          },
          story,
          ui: { kind: "html" as const, title: input.title || story.headline, html }
        }
      })
  )
}))
