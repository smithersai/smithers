import * as effect_Cause from 'effect/Cause';

declare namespace smithersTaggedErrorCodes {
    let TaskAborted: "TASK_ABORTED";
    let TaskTimeout: "TASK_TIMEOUT";
    let TaskHeartbeatTimeout: "TASK_HEARTBEAT_TIMEOUT";
    let RunNotFound: "RUN_NOT_FOUND";
    let InvalidInput: "INVALID_INPUT";
    let DbWriteFailed: "DB_WRITE_FAILED";
    let AgentCliError: "AGENT_CLI_ERROR";
    let WorkflowFailed: "WORKFLOW_EXECUTION_FAILED";
}

type SmithersTaggedErrorTag$2 = keyof typeof smithersTaggedErrorCodes;

type TaggedErrorDetails$2 = Record<string, unknown>;
type GenericTaggedErrorArgs$5 = {
    readonly message: string;
    readonly details?: TaggedErrorDetails$2;
};

type SmithersTaggedErrorPayload$3 = {
    readonly _tag: "TaskAborted";
    readonly message: string;
    readonly details?: TaggedErrorDetails$2;
    readonly name?: string;
} | {
    readonly _tag: "TaskTimeout";
    readonly message: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly timeoutMs: number;
} | {
    readonly _tag: "TaskHeartbeatTimeout";
    readonly message: string;
    readonly nodeId: string;
    readonly iteration: number;
    readonly attempt: number;
    readonly timeoutMs: number;
    readonly staleForMs: number;
    readonly lastHeartbeatAtMs: number;
} | {
    readonly _tag: "RunNotFound";
    readonly message: string;
    readonly runId: string;
} | {
    readonly _tag: "InvalidInput";
    readonly message: string;
    readonly details?: TaggedErrorDetails$2;
} | {
    readonly _tag: "DbWriteFailed";
    readonly message: string;
    readonly details?: TaggedErrorDetails$2;
} | {
    readonly _tag: "AgentCliError";
    readonly message: string;
    readonly details?: TaggedErrorDetails$2;
} | {
    readonly _tag: "WorkflowFailed";
    readonly message: string;
    readonly details?: TaggedErrorDetails$2;
    readonly status?: number;
};

declare const TaskAborted_base: new (args: TaskAbortedArgs) => effect_Cause.YieldableError & {
    readonly _tag: "TaskAborted";
} & Readonly<TaskAbortedArgs>;
declare class TaskAborted extends TaskAborted_base {
}
type TaggedErrorDetails$1 = TaggedErrorDetails$2;
type TaskAbortedArgs = {
    readonly message: string;
    readonly details?: TaggedErrorDetails$1;
    readonly name?: string;
};

declare const TaskTimeout_base: new (args: TaskTimeoutArgs) => effect_Cause.YieldableError & {
    readonly _tag: "TaskTimeout";
} & Readonly<TaskTimeoutArgs>;
declare class TaskTimeout extends TaskTimeout_base {
}
type TaskTimeoutArgs = {
    readonly message: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly timeoutMs: number;
};

declare const TaskHeartbeatTimeout_base: new (args: TaskHeartbeatTimeoutArgs) => effect_Cause.YieldableError & {
    readonly _tag: "TaskHeartbeatTimeout";
} & Readonly<TaskHeartbeatTimeoutArgs>;
declare class TaskHeartbeatTimeout extends TaskHeartbeatTimeout_base {
}
type TaskHeartbeatTimeoutArgs = {
    readonly message: string;
    readonly nodeId: string;
    readonly iteration: number;
    readonly attempt: number;
    readonly timeoutMs: number;
    readonly staleForMs: number;
    readonly lastHeartbeatAtMs: number;
};

declare const RunNotFound_base: new (args: RunNotFoundArgs) => effect_Cause.YieldableError & {
    readonly _tag: "RunNotFound";
} & Readonly<RunNotFoundArgs>;
declare class RunNotFound extends RunNotFound_base {
}
type RunNotFoundArgs = {
    readonly message: string;
    readonly runId: string;
};

declare const InvalidInput_base: new (args: GenericTaggedErrorArgs$4) => effect_Cause.YieldableError & {
    readonly _tag: "InvalidInput";
} & Readonly<GenericTaggedErrorArgs$4>;
declare class InvalidInput extends InvalidInput_base {
}
type GenericTaggedErrorArgs$4 = GenericTaggedErrorArgs$5;

declare const DbWriteFailed_base: new (args: GenericTaggedErrorArgs$3) => effect_Cause.YieldableError & {
    readonly _tag: "DbWriteFailed";
} & Readonly<GenericTaggedErrorArgs$3>;
declare class DbWriteFailed extends DbWriteFailed_base {
}
type GenericTaggedErrorArgs$3 = GenericTaggedErrorArgs$5;

declare const AgentCliError_base: new (args: GenericTaggedErrorArgs$2) => effect_Cause.YieldableError & {
    readonly _tag: "AgentCliError";
} & Readonly<GenericTaggedErrorArgs$2>;
declare class AgentCliError extends AgentCliError_base {
}
type GenericTaggedErrorArgs$2 = GenericTaggedErrorArgs$5;

declare const WorkflowFailed_base: new (args: WorkflowFailedArgs) => effect_Cause.YieldableError & {
    readonly _tag: "WorkflowFailed";
} & Readonly<WorkflowFailedArgs>;
declare class WorkflowFailed extends WorkflowFailed_base {
}
type GenericTaggedErrorArgs$1 = GenericTaggedErrorArgs$5;
type WorkflowFailedArgs = GenericTaggedErrorArgs$1 & {
    readonly status?: number;
};

type SmithersTaggedError$3 = TaskAborted | TaskTimeout | TaskHeartbeatTimeout | RunNotFound | InvalidInput | DbWriteFailed | AgentCliError | WorkflowFailed;

type SmithersErrorOptions$2 = {
    readonly cause?: unknown;
    readonly includeDocsUrl?: boolean;
    readonly name?: string;
};

type SmithersErrorCategory$1 = "engine" | "components" | "tools" | "agents" | "database" | "effect" | "hot" | "scorers" | "cli" | "integrations";

type SmithersErrorDefinition$2 = {
    readonly category: SmithersErrorCategory$1;
    readonly when: string;
    readonly details?: string;
};

declare namespace smithersErrorDefinitions {
    namespace INVALID_INPUT {
        let category: string;
        let when: string;
    }
    namespace MISSING_INPUT {
        let category_1: string;
        export { category_1 as category };
        let when_1: string;
        export { when_1 as when };
    }
    namespace MISSING_INPUT_TABLE {
        let category_2: string;
        export { category_2 as category };
        let when_2: string;
        export { when_2 as when };
    }
    namespace RESUME_METADATA_MISMATCH {
        let category_3: string;
        export { category_3 as category };
        let when_3: string;
        export { when_3 as when };
    }
    namespace UNKNOWN_OUTPUT_SCHEMA {
        let category_4: string;
        export { category_4 as category };
        let when_4: string;
        export { when_4 as when };
    }
    namespace INVALID_OUTPUT {
        let category_5: string;
        export { category_5 as category };
        let when_5: string;
        export { when_5 as when };
    }
    namespace WORKTREE_CREATE_FAILED {
        let category_6: string;
        export { category_6 as category };
        let when_6: string;
        export { when_6 as when };
        export let details: string;
    }
    namespace VCS_NOT_FOUND {
        let category_7: string;
        export { category_7 as category };
        let when_7: string;
        export { when_7 as when };
        let details_1: string;
        export { details_1 as details };
    }
    namespace SNAPSHOT_NOT_FOUND {
        let category_8: string;
        export { category_8 as category };
        let when_8: string;
        export { when_8 as when };
        let details_2: string;
        export { details_2 as details };
    }
    namespace VCS_WORKSPACE_CREATE_FAILED {
        let category_9: string;
        export { category_9 as category };
        let when_9: string;
        export { when_9 as when };
        let details_3: string;
        export { details_3 as details };
    }
    namespace TASK_TIMEOUT {
        let category_10: string;
        export { category_10 as category };
        let when_10: string;
        export { when_10 as when };
        let details_4: string;
        export { details_4 as details };
    }
    namespace RUN_NOT_FOUND {
        let category_11: string;
        export { category_11 as category };
        let when_11: string;
        export { when_11 as when };
        let details_5: string;
        export { details_5 as details };
    }
    namespace NODE_NOT_FOUND {
        let category_12: string;
        export { category_12 as category };
        let when_12: string;
        export { when_12 as when };
        let details_6: string;
        export { details_6 as details };
    }
    namespace INVALID_EVENTS_OPTIONS {
        let category_13: string;
        export { category_13 as category };
        let when_13: string;
        export { when_13 as when };
        let details_7: string;
        export { details_7 as details };
    }
    namespace SANDBOX_BUNDLE_INVALID {
        let category_14: string;
        export { category_14 as category };
        let when_14: string;
        export { when_14 as when };
        let details_8: string;
        export { details_8 as details };
    }
    namespace SANDBOX_BUNDLE_TOO_LARGE {
        let category_15: string;
        export { category_15 as category };
        let when_15: string;
        export { when_15 as when };
        let details_9: string;
        export { details_9 as details };
    }
    namespace WORKFLOW_EXECUTION_FAILED {
        let category_16: string;
        export { category_16 as category };
        let when_16: string;
        export { when_16 as when };
        let details_10: string;
        export { details_10 as details };
    }
    namespace SANDBOX_EXECUTION_FAILED {
        let category_17: string;
        export { category_17 as category };
        let when_17: string;
        export { when_17 as when };
        let details_11: string;
        export { details_11 as details };
    }
    namespace TASK_HEARTBEAT_TIMEOUT {
        let category_18: string;
        export { category_18 as category };
        let when_18: string;
        export { when_18 as when };
        let details_12: string;
        export { details_12 as details };
    }
    namespace HEARTBEAT_PAYLOAD_TOO_LARGE {
        let category_19: string;
        export { category_19 as category };
        let when_19: string;
        export { when_19 as when };
        let details_13: string;
        export { details_13 as details };
    }
    namespace HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE {
        let category_20: string;
        export { category_20 as category };
        let when_20: string;
        export { when_20 as when };
        let details_14: string;
        export { details_14 as details };
    }
    namespace TASK_ABORTED {
        let category_21: string;
        export { category_21 as category };
        let when_21: string;
        export { when_21 as when };
    }
    namespace RUN_CANCELLED {
        let category_22: string;
        export { category_22 as category };
        let when_22: string;
        export { when_22 as when };
        let details_15: string;
        export { details_15 as details };
    }
    namespace RUN_NOT_RESUMABLE {
        let category_23: string;
        export { category_23 as category };
        let when_23: string;
        export { when_23 as when };
        let details_16: string;
        export { details_16 as details };
    }
    namespace RUN_OWNER_ALIVE {
        let category_24: string;
        export { category_24 as category };
        let when_24: string;
        export { when_24 as when };
        let details_17: string;
        export { details_17 as details };
    }
    namespace RUN_STILL_RUNNING {
        let category_25: string;
        export { category_25 as category };
        let when_25: string;
        export { when_25 as when };
        let details_18: string;
        export { details_18 as details };
    }
    namespace RUN_RESUME_CLAIM_LOST {
        let category_26: string;
        export { category_26 as category };
        let when_26: string;
        export { when_26 as when };
        let details_19: string;
        export { details_19 as details };
    }
    namespace RUN_RESUME_CLAIM_FAILED {
        let category_27: string;
        export { category_27 as category };
        let when_27: string;
        export { when_27 as when };
        let details_20: string;
        export { details_20 as details };
    }
    namespace RUN_RESUME_ACTIVATION_FAILED {
        let category_28: string;
        export { category_28 as category };
        let when_28: string;
        export { when_28 as when };
        let details_21: string;
        export { details_21 as details };
    }
    namespace RUN_HIJACKED {
        let category_29: string;
        export { category_29 as category };
        let when_29: string;
        export { when_29 as when };
        let details_22: string;
        export { details_22 as details };
    }
    namespace CONTINUATION_STATE_TOO_LARGE {
        let category_30: string;
        export { category_30 as category };
        let when_30: string;
        export { when_30 as when };
        let details_23: string;
        export { details_23 as details };
    }
    namespace INVALID_CONTINUATION_STATE {
        let category_31: string;
        export { category_31 as category };
        let when_31: string;
        export { when_31 as when };
    }
    namespace RALPH_MAX_REACHED {
        let category_32: string;
        export { category_32 as category };
        let when_32: string;
        export { when_32 as when };
        let details_24: string;
        export { details_24 as details };
    }
    namespace SCHEDULER_ERROR {
        let category_33: string;
        export { category_33 as category };
        let when_33: string;
        export { when_33 as when };
    }
    namespace SESSION_ERROR {
        let category_34: string;
        export { category_34 as category };
        let when_34: string;
        export { when_34 as when };
    }
    namespace TASK_ID_REQUIRED {
        let category_35: string;
        export { category_35 as category };
        let when_35: string;
        export { when_35 as when };
    }
    namespace TASK_MISSING_OUTPUT {
        let category_36: string;
        export { category_36 as category };
        let when_36: string;
        export { when_36 as when };
        let details_25: string;
        export { details_25 as details };
    }
    namespace DUPLICATE_ID {
        let category_37: string;
        export { category_37 as category };
        let when_37: string;
        export { when_37 as when };
        let details_26: string;
        export { details_26 as details };
    }
    namespace NESTED_LOOP {
        let category_38: string;
        export { category_38 as category };
        let when_38: string;
        export { when_38 as when };
    }
    namespace WORKTREE_EMPTY_PATH {
        let category_39: string;
        export { category_39 as category };
        let when_39: string;
        export { when_39 as when };
    }
    namespace MDX_PRELOAD_INACTIVE {
        let category_40: string;
        export { category_40 as category };
        let when_40: string;
        export { when_40 as when };
    }
    namespace CONTEXT_OUTSIDE_WORKFLOW {
        let category_41: string;
        export { category_41 as category };
        let when_41: string;
        export { when_41 as when };
    }
    namespace MISSING_OUTPUT {
        let category_42: string;
        export { category_42 as category };
        let when_42: string;
        export { when_42 as when };
        let details_27: string;
        export { details_27 as details };
    }
    namespace DEP_NOT_SATISFIED {
        let category_43: string;
        export { category_43 as category };
        let when_43: string;
        export { when_43 as when };
        let details_28: string;
        export { details_28 as details };
    }
    namespace ASPECT_BUDGET_EXCEEDED {
        let category_44: string;
        export { category_44 as category };
        let when_44: string;
        export { when_44 as when };
        let details_29: string;
        export { details_29 as details };
    }
    namespace APPROVAL_OUTSIDE_TASK {
        let category_45: string;
        export { category_45 as category };
        let when_45: string;
        export { when_45 as when };
    }
    namespace APPROVAL_OPTIONS_REQUIRED {
        let category_46: string;
        export { category_46 as category };
        let when_46: string;
        export { when_46 as when };
    }
    namespace WORKFLOW_MISSING_DEFAULT {
        let category_47: string;
        export { category_47 as category };
        let when_47: string;
        export { when_47 as when };
    }
    namespace TOOL_PATH_INVALID {
        let category_48: string;
        export { category_48 as category };
        let when_48: string;
        export { when_48 as when };
    }
    namespace TOOL_PATH_ESCAPE {
        let category_49: string;
        export { category_49 as category };
        let when_49: string;
        export { when_49 as when };
    }
    namespace TOOL_FILE_TOO_LARGE {
        let category_50: string;
        export { category_50 as category };
        let when_50: string;
        export { when_50 as when };
    }
    namespace TOOL_CONTENT_TOO_LARGE {
        let category_51: string;
        export { category_51 as category };
        let when_51: string;
        export { when_51 as when };
    }
    namespace TOOL_PATCH_TOO_LARGE {
        let category_52: string;
        export { category_52 as category };
        let when_52: string;
        export { when_52 as when };
    }
    namespace TOOL_PATCH_FAILED {
        let category_53: string;
        export { category_53 as category };
        let when_53: string;
        export { when_53 as when };
    }
    namespace TOOL_NETWORK_DISABLED {
        let category_54: string;
        export { category_54 as category };
        let when_54: string;
        export { when_54 as when };
    }
    namespace TOOL_GIT_REMOTE_DISABLED {
        let category_55: string;
        export { category_55 as category };
        let when_55: string;
        export { when_55 as when };
    }
    namespace TOOL_COMMAND_FAILED {
        let category_56: string;
        export { category_56 as category };
        let when_56: string;
        export { when_56 as when };
    }
    namespace TOOL_GREP_FAILED {
        let category_57: string;
        export { category_57 as category };
        let when_57: string;
        export { when_57 as when };
    }
    namespace AGENT_CLI_ERROR {
        let category_58: string;
        export { category_58 as category };
        let when_58: string;
        export { when_58 as when };
    }
    namespace AGENT_RPC_FILE_ARGS {
        let category_59: string;
        export { category_59 as category };
        let when_59: string;
        export { when_59 as when };
    }
    namespace AGENT_BUILD_COMMAND {
        let category_60: string;
        export { category_60 as category };
        let when_60: string;
        export { when_60 as when };
    }
    namespace AGENT_DIAGNOSTIC_TIMEOUT {
        let category_61: string;
        export { category_61 as category };
        let when_61: string;
        export { when_61 as when };
    }
    namespace DB_MISSING_COLUMNS {
        let category_62: string;
        export { category_62 as category };
        let when_62: string;
        export { when_62 as when };
    }
    namespace DB_REQUIRES_BUN_SQLITE {
        let category_63: string;
        export { category_63 as category };
        let when_63: string;
        export { when_63 as when };
    }
    namespace DB_QUERY_FAILED {
        let category_64: string;
        export { category_64 as category };
        let when_64: string;
        export { when_64 as when };
    }
    namespace DB_WRITE_FAILED {
        let category_65: string;
        export { category_65 as category };
        let when_65: string;
        export { when_65 as when };
    }
    namespace STORAGE_ERROR {
        let category_66: string;
        export { category_66 as category };
        let when_66: string;
        export { when_66 as when };
    }
    namespace INTERNAL_ERROR {
        let category_67: string;
        export { category_67 as category };
        let when_67: string;
        export { when_67 as when };
    }
    namespace PROCESS_ABORTED {
        let category_68: string;
        export { category_68 as category };
        let when_68: string;
        export { when_68 as when };
        let details_30: string;
        export { details_30 as details };
    }
    namespace PROCESS_TIMEOUT {
        let category_69: string;
        export { category_69 as category };
        let when_69: string;
        export { when_69 as when };
        let details_31: string;
        export { details_31 as details };
    }
    namespace PROCESS_IDLE_TIMEOUT {
        let category_70: string;
        export { category_70 as category };
        let when_70: string;
        export { when_70 as when };
        let details_32: string;
        export { details_32 as details };
    }
    namespace PROCESS_SPAWN_FAILED {
        let category_71: string;
        export { category_71 as category };
        let when_71: string;
        export { when_71 as when };
        let details_33: string;
        export { details_33 as details };
    }
    namespace TASK_RUNTIME_UNAVAILABLE {
        let category_72: string;
        export { category_72 as category };
        let when_72: string;
        export { when_72 as when };
    }
    namespace SCHEMA_CHANGE_HOT {
        let category_73: string;
        export { category_73 as category };
        let when_73: string;
        export { when_73 as when };
    }
    namespace HOT_OVERLAY_FAILED {
        let category_74: string;
        export { category_74 as category };
        let when_74: string;
        export { when_74 as when };
    }
    namespace HOT_RELOAD_INVALID_MODULE {
        let category_75: string;
        export { category_75 as category };
        let when_75: string;
        export { when_75 as when };
    }
    namespace SCORER_FAILED {
        let category_76: string;
        export { category_76 as category };
        let when_76: string;
        export { when_76 as when };
    }
    namespace WORKFLOW_EXISTS {
        let category_77: string;
        export { category_77 as category };
        let when_77: string;
        export { when_77 as when };
    }
    namespace CLI_DB_NOT_FOUND {
        let category_78: string;
        export { category_78 as category };
        let when_78: string;
        export { when_78 as when };
    }
    namespace CLI_AGENT_UNSUPPORTED {
        let category_79: string;
        export { category_79 as category };
        let when_79: string;
        export { when_79 as when };
    }
    namespace PI_HTTP_ERROR {
        let category_80: string;
        export { category_80 as category };
        let when_80: string;
        export { when_80 as when };
    }
    namespace EXTERNAL_BUILD_FAILED {
        let category_81: string;
        export { category_81 as category };
        let when_81: string;
        export { when_81 as when };
        let details_34: string;
        export { details_34 as details };
    }
    namespace SCHEMA_DISCOVERY_FAILED {
        let category_82: string;
        export { category_82 as category };
        let when_82: string;
        export { when_82 as when };
        let details_35: string;
        export { details_35 as details };
    }
    namespace OPENAPI_SPEC_LOAD_FAILED {
        let category_83: string;
        export { category_83 as category };
        let when_83: string;
        export { when_83 as when };
    }
    namespace OPENAPI_OPERATION_NOT_FOUND {
        let category_84: string;
        export { category_84 as category };
        let when_84: string;
        export { when_84 as when };
    }
    namespace OPENAPI_TOOL_EXECUTION_FAILED {
        let category_85: string;
        export { category_85 as category };
        let when_85: string;
        export { when_85 as when };
    }
}

type KnownSmithersErrorCode$3 = keyof typeof smithersErrorDefinitions;

type SmithersErrorCode$4 = KnownSmithersErrorCode$3 | (string & {});

type ErrorWrapOptions$2 = {
    readonly code?: SmithersErrorCode$4;
    readonly details?: Record<string, unknown>;
};

type EngineErrorCode$2 = "TASK_HEARTBEAT_TIMEOUT" | "DUPLICATE_ID" | "NESTED_LOOP" | "INVALID_CONTINUATION_STATE" | "TASK_ID_REQUIRED" | "TASK_MISSING_OUTPUT" | "WORKTREE_EMPTY_PATH" | "INVALID_INPUT" | "WORKFLOW_EXECUTION_FAILED" | "TASK_TIMEOUT" | "TASK_ABORTED" | "MISSING_OUTPUT" | "DEP_NOT_SATISFIED" | "RUN_CANCELLED" | "RUN_NOT_FOUND" | "NODE_NOT_FOUND" | "STORAGE_ERROR" | "SCHEDULER_ERROR" | "SESSION_ERROR" | "INTERNAL_ERROR";

declare const EngineError_base: new (args: EngineErrorArgs) => effect_Cause.YieldableError & {
    readonly _tag: "EngineError";
} & Readonly<EngineErrorArgs>;
declare class EngineError extends EngineError_base {
}
type EngineErrorCode$1 = EngineErrorCode$2;
type EngineErrorArgs = {
    readonly code: EngineErrorCode$1;
    readonly message: string;
    readonly context?: Record<string, unknown>;
};

declare const ERROR_REFERENCE_URL: "https://smithers.sh/reference/errors";

declare class SmithersError$1 extends Error {
    /**
   * @param {SmithersErrorCode} code
   * @param {string} summary
   * @param {Record<string, unknown>} [details]
   * @param {unknown | SmithersErrorOptions} [causeOrOptions]
   */
    constructor(code: SmithersErrorCode$3, summary: string, details?: Record<string, unknown>, causeOrOptions?: unknown | SmithersErrorOptions$1);
    /** @type {SmithersErrorCode} */
    code: SmithersErrorCode$3;
    /** @type {string} */
    summary: string;
    /** @type {string} */
    docsUrl: string;
    /** @type {Record<string, unknown> | undefined} */
    details: Record<string, unknown> | undefined;
    /** @type {unknown} */
    cause: unknown;
}
type SmithersErrorCode$3 = SmithersErrorCode$4;
type SmithersErrorOptions$1 = SmithersErrorOptions$2;

/**
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
declare function errorToJson(error: unknown): Record<string, unknown>;

/**
 * @param {unknown} error
 * @returns {SmithersError | undefined}
 */
declare function fromTaggedError(error: unknown): SmithersError$1 | undefined;

/** @typedef {import("./SmithersTaggedError.ts").SmithersTaggedError} SmithersTaggedError */
/** @typedef {import("./SmithersTaggedErrorPayload.ts").SmithersTaggedErrorPayload} SmithersTaggedErrorPayload */
/**
 * @param {SmithersTaggedErrorPayload} payload
 * @returns {SmithersTaggedError}
 */
declare function fromTaggedErrorPayload(payload: SmithersTaggedErrorPayload$2): SmithersTaggedError$2;
type SmithersTaggedError$2 = SmithersTaggedError$3;
type SmithersTaggedErrorPayload$2 = SmithersTaggedErrorPayload$3;

/** @typedef {import("./SmithersErrorCode.ts").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("./SmithersErrorDefinition.ts").SmithersErrorDefinition} SmithersErrorDefinition */
/**
 * @param {SmithersErrorCode} code
 * @returns {SmithersErrorDefinition | undefined}
 */
declare function getSmithersErrorDefinition(code: SmithersErrorCode$2): SmithersErrorDefinition$1 | undefined;
type SmithersErrorCode$2 = SmithersErrorCode$4;
type SmithersErrorDefinition$1 = SmithersErrorDefinition$2;

/** @typedef {import("./SmithersErrorCode.ts").SmithersErrorCode} SmithersErrorCode */
/**
 * @param {SmithersErrorCode} _code
 * @returns {string}
 */
declare function getSmithersErrorDocsUrl(_code: SmithersErrorCode$1): string;
type SmithersErrorCode$1 = SmithersErrorCode$4;

/** @typedef {import("./KnownSmithersErrorCode.ts").KnownSmithersErrorCode} KnownSmithersErrorCode */
/**
 * @param {string} code
 * @returns {code is KnownSmithersErrorCode}
 */
declare function isKnownSmithersErrorCode(code: string): code is KnownSmithersErrorCode$2;
type KnownSmithersErrorCode$2 = KnownSmithersErrorCode$3;

/** @typedef {import("./SmithersError.js").SmithersError} SmithersError */
/**
 * @param {unknown} value
 * @returns {value is SmithersError}
 */
declare function isSmithersError(value: unknown): value is SmithersError;
type SmithersError = SmithersError$1;

/** @typedef {import("./SmithersTaggedError.ts").SmithersTaggedError} SmithersTaggedError */
/**
 * @param {unknown} value
 * @returns {value is SmithersTaggedError}
 */
declare function isSmithersTaggedError(value: unknown): value is SmithersTaggedError$1;
type SmithersTaggedError$1 = SmithersTaggedError$3;

/** @typedef {import("./SmithersTaggedErrorTag.ts").SmithersTaggedErrorTag} SmithersTaggedErrorTag */
/**
 * @param {unknown} value
 * @returns {value is SmithersTaggedErrorTag}
 */
declare function isSmithersTaggedErrorTag(value: unknown): value is SmithersTaggedErrorTag$1;
type SmithersTaggedErrorTag$1 = SmithersTaggedErrorTag$2;

/** @typedef {import("./KnownSmithersErrorCode.ts").KnownSmithersErrorCode} KnownSmithersErrorCode */
declare const knownSmithersErrorCodes: KnownSmithersErrorCode$1[];
type KnownSmithersErrorCode$1 = KnownSmithersErrorCode$3;

/**
 * @param {unknown} cause
 * @param {string} [label]
 * @param {ErrorWrapOptions} [options]
 * @returns {SmithersError}
 */
declare function toSmithersError(cause: unknown, label?: string, options?: ErrorWrapOptions$1): SmithersError$1;
type ErrorWrapOptions$1 = ErrorWrapOptions$2;

/**
 * @param {unknown} error
 * @returns {SmithersTaggedErrorPayload | undefined}
 */
declare function toTaggedErrorPayload(error: unknown): SmithersTaggedErrorPayload$1 | undefined;
type SmithersTaggedErrorPayload$1 = SmithersTaggedErrorPayload$3;

type EngineErrorCode = EngineErrorCode$2;
type ErrorWrapOptions = ErrorWrapOptions$2;
type GenericTaggedErrorArgs = GenericTaggedErrorArgs$5;
type KnownSmithersErrorCode = KnownSmithersErrorCode$3;
type SmithersErrorCategory = SmithersErrorCategory$1;
type SmithersErrorCode = SmithersErrorCode$4;
type SmithersErrorDefinition = SmithersErrorDefinition$2;
type SmithersErrorOptions = SmithersErrorOptions$2;
type SmithersTaggedError = SmithersTaggedError$3;
type SmithersTaggedErrorPayload = SmithersTaggedErrorPayload$3;
type SmithersTaggedErrorTag = SmithersTaggedErrorTag$2;
type TaggedErrorDetails = TaggedErrorDetails$2;

export { AgentCliError, DbWriteFailed, ERROR_REFERENCE_URL, EngineError, type EngineErrorArgs, type EngineErrorCode, type ErrorWrapOptions, type GenericTaggedErrorArgs, InvalidInput, type KnownSmithersErrorCode, RunNotFound, type RunNotFoundArgs, SmithersError$1 as SmithersError, type SmithersErrorCategory, type SmithersErrorCode, type SmithersErrorDefinition, type SmithersErrorOptions, type SmithersTaggedError, type SmithersTaggedErrorPayload, type SmithersTaggedErrorTag, type TaggedErrorDetails, TaskAborted, type TaskAbortedArgs, TaskHeartbeatTimeout, type TaskHeartbeatTimeoutArgs, TaskTimeout, type TaskTimeoutArgs, WorkflowFailed, type WorkflowFailedArgs, errorToJson, fromTaggedError, fromTaggedErrorPayload, getSmithersErrorDefinition, getSmithersErrorDocsUrl, isKnownSmithersErrorCode, isSmithersError, isSmithersTaggedError, isSmithersTaggedErrorTag, knownSmithersErrorCodes, smithersErrorDefinitions, smithersTaggedErrorCodes, toSmithersError, toTaggedErrorPayload };
