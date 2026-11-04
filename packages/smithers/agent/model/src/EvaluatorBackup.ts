/**
 * Model-backed judgments and transport-only fallback for an Evaluator.
 *
 * @since 1.0.0-rc.1
 */

import { Effect, Stream } from "effect"
import * as Evaluator from "./Evaluator.ts"
import type * as Model from "./Model.vibe"
import { ModelRequest } from "./ModelRequest.ts"

/**
 * Judge through any Model using the same answer validation as a resolved seat.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const fromModel = (model: Model.Model, modelId: string): Evaluator.Evaluator =>
  Evaluator.Evaluator.of({
    evaluate: (request) =>
      Effect.suspend(() => {
        let emptyText = true
        const scriptedRequest: Model.Model = {
          stream: (judgeRequest) =>
            model.stream(
              new ModelRequest({
                ...judgeRequest,
                tools: [],
                toolChoice: "none",
                // GPT-6 Luna needs medium effort to read a completed judgment reliably.
                params: { reasoningEffort: "medium" }
              })
            ).pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "retry") emptyText = true
                  if (event.type === "text-delta" && event.text.trim() !== "") emptyText = false
                })
              )
            )
        }
        return Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate(request)).pipe(
          Effect.provide(Evaluator.layerFromSeat({ model: scriptedRequest, modelId })),
          Effect.mapError((error) =>
            emptyText && error.code === "invalid_answer"
              ? new Evaluator.EvaluatorError({
                code: "empty",
                message: "The model returned no judgment text.",
                ...(error.usage === undefined ? {} : { usage: error.usage })
              })
              : error
          )
        )
      })
  })

/**
 * Use the backup only when the primary is unavailable: unreachable, timed out,
 * or refusing with a server error or 429. An
 * unconfigured primary is a setup fault, not an outage: it fails with its own
 * typed `unconfigured` error and setup message and never falls back, so a
 * missing credential is reported instead of being answered by another model.
 * A refusal of the caller (4xx) or of the question never falls back, and
 * neither does a failure that carries paid usage: that reading was taken and
 * metered, and asking again would pay twice for one judgment whose response
 * can carry only one reading's usage. If both fail, retain the backup's
 * failure, except that a primary usage limit still takes precedence over a
 * backup transport or configuration failure.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const withFallback = (primary: Evaluator.Evaluator, backup: Evaluator.Evaluator): Evaluator.Evaluator =>
  Evaluator.Evaluator.of({
    evaluate: (request) =>
      primary.evaluate(request).pipe(
        Effect.catch((error) =>
          error.usage === undefined &&
            (error.code === "unreachable" || error.code === "timeout" ||
              (error.code === "refused" && error.status !== undefined && (error.status >= 500 || error.status === 429)))
            ? backup.evaluate(request).pipe(Effect.mapError((failure) =>
              (failure.code === "unreachable" || failure.code === "timeout" || failure.code === "unconfigured") &&
                error.code === "refused" && error.status === 429
                // The primary's reason, with whatever the backup's reading paid.
                ? failure.usage === undefined ? error : new Evaluator.EvaluatorError({
                  code: error.code,
                  message: error.message,
                  status: error.status,
                  ...(error.resetAtEpochMillis === undefined ? {} : { resetAtEpochMillis: error.resetAtEpochMillis }),
                  usage: failure.usage
                })
                : failure
            ))
            : Effect.fail(error)
        )
      )
  })
