export const DEVTOOLS_ERROR_CODES = [
    "RunNotFound",
    "InvalidRunId",
    "FrameOutOfRange",
    "SeqOutOfRange",
    "BackpressureDisconnect",
    "Unauthorized",
    "InvalidDelta",
] as const;
export type DevToolsErrorCode = (typeof DEVTOOLS_ERROR_CODES)[number];
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
] as const;
export type NodeOutputErrorCode = (typeof NODE_OUTPUT_ERROR_CODES)[number];
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
] as const;
export type NodeDiffErrorCode = (typeof NODE_DIFF_ERROR_CODES)[number];
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
] as const;
export type JumpToFrameErrorCode = (typeof JUMP_TO_FRAME_ERROR_CODES)[number];
export type ProtocolError = {
    code: DevToolsErrorCode | NodeOutputErrorCode | NodeDiffErrorCode | JumpToFrameErrorCode | string;
    message: string;
    hint?: string;
};
