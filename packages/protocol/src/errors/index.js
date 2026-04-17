// @smithers-type-exports-begin
/** @typedef {import("./DevToolsErrorCode.ts").DevToolsErrorCode} DevToolsErrorCode */
/** @typedef {import("./JumpToFrameErrorCode.ts").JumpToFrameErrorCode} JumpToFrameErrorCode */
/** @typedef {import("./NodeDiffErrorCode.ts").NodeDiffErrorCode} NodeDiffErrorCode */
/** @typedef {import("./NodeOutputErrorCode.ts").NodeOutputErrorCode} NodeOutputErrorCode */
/** @typedef {import("./ProtocolError.ts").ProtocolError} ProtocolError */
// @smithers-type-exports-end

export const DEVTOOLS_ERROR_CODES = [
    "RunNotFound",
    "InvalidRunId",
    "FrameOutOfRange",
    "SeqOutOfRange",
    "BackpressureDisconnect",
    "Unauthorized",
    "InvalidDelta",
];
export const NODE_OUTPUT_ERROR_CODES = [
    "InvalidRunId",
    "InvalidNodeId",
    "InvalidIteration",
    "RunNotFound",
    "NodeNotFound",
    "IterationNotFound",
    "NodeHasNoOutput",
    "SchemaConversionError",
    "MalformedOutputRow",
    "PayloadTooLarge",
];
export const NODE_DIFF_ERROR_CODES = [
    "InvalidRunId",
    "InvalidNodeId",
    "InvalidIteration",
    "RunNotFound",
    "NodeNotFound",
    "AttemptNotFound",
    "AttemptNotFinished",
    "VcsError",
    "WorkingTreeDirty",
    "DiffTooLarge",
];
export const JUMP_TO_FRAME_ERROR_CODES = [
    "InvalidRunId",
    "InvalidFrameNo",
    "RunNotFound",
    "FrameOutOfRange",
    "ConfirmationRequired",
    "Busy",
    "UnsupportedSandbox",
    "VcsError",
    "RewindFailed",
    "RateLimited",
    "Unauthorized",
];
