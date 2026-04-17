import { JUMP_RUN_ID_PATTERN } from "./JUMP_RUN_ID_PATTERN.js";
import { JumpToFrameError } from "./JumpToFrameError.js";

/**
 * Validate a jump run id argument.
 *
 * @param {unknown} runId
 * @returns {string}
 */
export function validateJumpRunId(runId) {
  if (typeof runId !== "string" || !JUMP_RUN_ID_PATTERN.test(runId)) {
    throw new JumpToFrameError(
      "InvalidRunId",
      "runId must match /^[a-z0-9_-]{1,64}$/.",
    );
  }
  return runId;
}
