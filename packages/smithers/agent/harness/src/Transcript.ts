/**
 * Compatibility validation for durable agent journals and external transcript
 * decoders. Validation refuses journal versions that cannot safely resume.
 *
 * @since 0.1.0
 */

import type { JournalEvent } from "@smthrs/journal"
import { Result } from "effect"
import { HarnessError } from "./HarnessError.ts"

/**
 * Journal and model-key format after summaries became user context.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const journalVersion = 2

/**
 * The event-type namespace a session journals its controller events under.
 *
 * Resume validation reads only the entries under this prefix, and the writer
 * that produces them lives in another package, so the prefix is exported here
 * rather than spelled twice: a writer types its event types as
 * {@link ControlEventType} and a rename fails to compile instead of silently
 * emptying the set {@link validateJournal} inspects.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const controlEventPrefix = "control.agent."

/**
 * An event type {@link validateJournal} validates.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ControlEventType = `${typeof controlEventPrefix}${string}`

/**
 * Refuses history whose replay could address different sealed model steps.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateJournal = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Result.Result<void, HarnessError> => {
  for (const entry of entries) {
    if (!entry.eventType.startsWith(controlEventPrefix)) continue
    const payload = entry.payload as Record<string, unknown> | null
    if (payload === null || typeof payload !== "object" || payload["journalVersion"] !== journalVersion) {
      return Result.fail(
        new HarnessError({
          code: "incompatible_journal",
          message: `Journal sequence ${entry.seq} predates harness journal format ${journalVersion}; start a new run.`
        })
      )
    }
  }
  return Result.succeed(undefined)
}

/**
 * Pure external-source decoders; never create executable journal identities.
 * @since 1.0.0-rc.1
 */
export { decodeClaude, decodeCodex } from "./ExternalTranscript.ts"
export type { Decoded as ExternalDecoded, Entry as ExternalEntry } from "./ExternalTranscript.ts"
