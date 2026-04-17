import { JUMP_MAX_FRAME_NO } from "./JUMP_MAX_FRAME_NO.js";
import { JumpToFrameError } from "./JumpToFrameError.js";

/**
 * Validate a jump frame number argument.
 *
 * @param {unknown} frameNo
 * @returns {number}
 */
export function validateJumpFrameNo(frameNo) {
  if (
    typeof frameNo !== "number" ||
    !Number.isInteger(frameNo) ||
    frameNo < 0 ||
    frameNo > JUMP_MAX_FRAME_NO
  ) {
    throw new JumpToFrameError(
      "InvalidFrameNo",
      "frameNo must be a non-negative i32 integer.",
    );
  }
  return frameNo;
}
