export declare const smithersErrorDefinitions: {
    readonly INVALID_INPUT: {
        readonly category: "engine";
        readonly when: "Workflow input fails validation or the runtime receives a non-object input payload.";
    };
    readonly MISSING_INPUT: {
        readonly category: "engine";
        readonly when: "A resume run references an input row that is missing from the database.";
    };
    readonly MISSING_INPUT_TABLE: {
        readonly category: "engine";
        readonly when: "The workflow schema does not expose the expected input table during resume or hydration.";
    };
    readonly RESUME_METADATA_MISMATCH: {
        readonly category: "engine";
        readonly when: "Stored run metadata no longer matches the workflow being resumed.";
    };
    readonly UNKNOWN_OUTPUT_SCHEMA: {
        readonly category: "engine";
        readonly when: "A task references an output table that is not present in the schema registry.";
    };
    readonly INVALID_OUTPUT: {
        readonly category: "engine";
        readonly when: "Agent output cannot be parsed or validated against the declared output schema.";
    };
    readonly WORKTREE_CREATE_FAILED: {
        readonly category: "engine";
        readonly when: "Smithers fails to create or hydrate a git or jj worktree for a task.";
        readonly details: "{ worktreePath, vcsType, branch? }";
    };
    readonly VCS_NOT_FOUND: {
        readonly category: "engine";
        readonly when: "No supported git or jj repository root can be found for the workflow.";
        readonly details: "{ rootDir }";
    };
    readonly SNAPSHOT_NOT_FOUND: {
        readonly category: "engine";
        readonly when: "A requested time-travel snapshot or frame does not exist.";
        readonly details: "{ runId, frameNo }";
    };
    readonly VCS_WORKSPACE_CREATE_FAILED: {
        readonly category: "engine";
        readonly when: "Smithers fails to materialize a jj workspace for time-travel or replay.";
        readonly details: "{ runId, frameNo, vcsPointer, workspacePath }";
    };
    readonly TASK_TIMEOUT: {
        readonly category: "engine";
        readonly when: "A task compute callback exceeds its configured timeout.";
        readonly details: "{ nodeId, attempt, timeoutMs }";
    };
    readonly RUN_NOT_FOUND: {
        readonly category: "engine";
        readonly when: "A CLI or engine command references a run ID that does not exist in the database.";
        readonly details: "{ runId }";
    };
    readonly NODE_NOT_FOUND: {
        readonly category: "engine";
        readonly when: "A CLI command references a node ID that does not exist for the given run.";
        readonly details: "{ runId, nodeId }";
    };
    readonly INVALID_EVENTS_OPTIONS: {
        readonly category: "cli";
        readonly when: "The smithers events command receives invalid filter options.";
        readonly details: "{}";
    };
    readonly SANDBOX_BUNDLE_INVALID: {
        readonly category: "engine";
        readonly when: "A sandbox bundle fails validation.";
        readonly details: "{ bundlePath }";
    };
    readonly SANDBOX_BUNDLE_TOO_LARGE: {
        readonly category: "engine";
        readonly when: "A sandbox bundle exceeds the maximum allowed size.";
        readonly details: "{ bundlePath, maxBytes }";
    };
    readonly WORKFLOW_EXECUTION_FAILED: {
        readonly category: "engine";
        readonly when: "A child or builder workflow exits unsuccessfully without surfacing a typed error payload.";
        readonly details: "{ status }";
    };
    readonly SANDBOX_EXECUTION_FAILED: {
        readonly category: "engine";
        readonly when: "Sandbox setup or execution fails before a more specific sandbox error can be emitted.";
        readonly details: "{ sandboxId, runId?, maxConcurrent?, activeSandboxCount? }";
    };
    readonly TASK_HEARTBEAT_TIMEOUT: {
        readonly category: "engine";
        readonly when: "A task heartbeat timeout is exceeded while the task is still in progress.";
        readonly details: "{ nodeId, iteration, attempt, timeoutMs, staleForMs }";
    };
    readonly HEARTBEAT_PAYLOAD_TOO_LARGE: {
        readonly category: "engine";
        readonly when: "A task heartbeat payload exceeds the maximum persisted checkpoint size.";
        readonly details: "{ dataSizeBytes, maxBytes }";
    };
    readonly HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE: {
        readonly category: "engine";
        readonly when: "A task heartbeat payload contains values that cannot be serialized to JSON.";
        readonly details: "{ path, valueType? }";
    };
    readonly TASK_ABORTED: {
        readonly category: "engine";
        readonly when: "A running task is aborted through an AbortSignal or shutdown path.";
    };
    readonly RUN_CANCELLED: {
        readonly category: "engine";
        readonly when: "A run is cancelled while runtime work is still active.";
        readonly details: "{ runId }";
    };
    readonly RUN_NOT_RESUMABLE: {
        readonly category: "engine";
        readonly when: "A resume request targets a run state that cannot be resumed.";
        readonly details: "{ runId, status }";
    };
    readonly RUN_OWNER_ALIVE: {
        readonly category: "engine";
        readonly when: "Resume recovery is skipped because the previous runtime owner is still heartbeating.";
        readonly details: "{ runId, runtimeOwnerId }";
    };
    readonly RUN_STILL_RUNNING: {
        readonly category: "engine";
        readonly when: "A recovery or resume operation finds a run that is still active.";
        readonly details: "{ runId }";
    };
    readonly RUN_RESUME_CLAIM_LOST: {
        readonly category: "engine";
        readonly when: "A runtime loses the resume claim before it can update the run.";
        readonly details: "{ runId, runtimeOwnerId }";
    };
    readonly RUN_RESUME_CLAIM_FAILED: {
        readonly category: "engine";
        readonly when: "A runtime cannot claim a stale run for resume.";
        readonly details: "{ runId, runtimeOwnerId }";
    };
    readonly RUN_RESUME_ACTIVATION_FAILED: {
        readonly category: "engine";
        readonly when: "A claimed run cannot be moved back into active execution.";
        readonly details: "{ runId, runtimeOwnerId }";
    };
    readonly RUN_HIJACKED: {
        readonly category: "engine";
        readonly when: "A run is interrupted because another runtime hijacked execution.";
        readonly details: "{ runId, hijackTarget }";
    };
    readonly CONTINUATION_STATE_TOO_LARGE: {
        readonly category: "engine";
        readonly when: "Continue-as-new state exceeds the configured serialized size limit.";
        readonly details: "{ runId, sizeBytes, maxBytes }";
    };
    readonly INVALID_CONTINUATION_STATE: {
        readonly category: "engine";
        readonly when: "Continue-as-new state cannot be parsed or applied.";
    };
    readonly RALPH_MAX_REACHED: {
        readonly category: "engine";
        readonly when: "A Ralph loop reaches maxIterations with fail-on-max behavior.";
        readonly details: "{ ralphId, maxIterations }";
    };
    readonly SCHEDULER_ERROR: {
        readonly category: "engine";
        readonly when: "The scheduler cannot produce a valid execution decision.";
    };
    readonly SESSION_ERROR: {
        readonly category: "engine";
        readonly when: "The workflow session state machine reaches an invalid or failed state.";
    };
    readonly TASK_ID_REQUIRED: {
        readonly category: "components";
        readonly when: "<Task> is missing a valid string id.";
    };
    readonly TASK_MISSING_OUTPUT: {
        readonly category: "components";
        readonly when: "<Task> is missing its output prop.";
        readonly details: "{ nodeId }";
    };
    readonly DUPLICATE_ID: {
        readonly category: "components";
        readonly when: "Two nodes with the same runtime id are mounted in one workflow graph.";
        readonly details: "{ kind, id }";
    };
    readonly NESTED_LOOP: {
        readonly category: "components";
        readonly when: "<Loop> or <Ralph> is nested inside another loop construct that Smithers does not support.";
    };
    readonly WORKTREE_EMPTY_PATH: {
        readonly category: "components";
        readonly when: "<Worktree> is mounted with an empty path.";
    };
    readonly MDX_PRELOAD_INACTIVE: {
        readonly category: "components";
        readonly when: "A prompt object is rendered without the MDX preload layer being active.";
    };
    readonly CONTEXT_OUTSIDE_WORKFLOW: {
        readonly category: "components";
        readonly when: "Workflow context access happens outside an active Smithers workflow render.";
    };
    readonly MISSING_OUTPUT: {
        readonly category: "components";
        readonly when: "Code calls ctx.output() for a node result that does not exist.";
        readonly details: "{ nodeId, iteration }";
    };
    readonly DEP_NOT_SATISFIED: {
        readonly category: "components";
        readonly when: "A typed dep on <Task> references an upstream output that has not been produced yet.";
        readonly details: "{ taskId, depKey, resolvedNodeId }";
    };
    readonly ASPECT_BUDGET_EXCEEDED: {
        readonly category: "components";
        readonly when: "An Aspects budget has been exceeded.";
        readonly details: "{ kind, limit, current }";
    };
    readonly APPROVAL_OUTSIDE_TASK: {
        readonly category: "components";
        readonly when: "<Approval> is resolved outside the active task runtime.";
    };
    readonly APPROVAL_OPTIONS_REQUIRED: {
        readonly category: "components";
        readonly when: "An approval mode that requires explicit options is missing them.";
    };
    readonly WORKFLOW_MISSING_DEFAULT: {
        readonly category: "components";
        readonly when: "A workflow module does not export a default Smithers workflow.";
    };
    readonly TOOL_PATH_INVALID: {
        readonly category: "tools";
        readonly when: "A filesystem tool receives a non-string path.";
    };
    readonly TOOL_PATH_ESCAPE: {
        readonly category: "tools";
        readonly when: "A filesystem tool resolves a path outside the sandbox root, including through symlinks.";
    };
    readonly TOOL_FILE_TOO_LARGE: {
        readonly category: "tools";
        readonly when: "A read or edit operation exceeds the configured file size limit.";
    };
    readonly TOOL_CONTENT_TOO_LARGE: {
        readonly category: "tools";
        readonly when: "A write operation exceeds the configured content size limit.";
    };
    readonly TOOL_PATCH_TOO_LARGE: {
        readonly category: "tools";
        readonly when: "An edit patch exceeds the configured patch size limit.";
    };
    readonly TOOL_PATCH_FAILED: {
        readonly category: "tools";
        readonly when: "A unified diff patch cannot be applied to the target file.";
    };
    readonly TOOL_NETWORK_DISABLED: {
        readonly category: "tools";
        readonly when: "The bash tool tries to access the network while network access is disabled.";
    };
    readonly TOOL_GIT_REMOTE_DISABLED: {
        readonly category: "tools";
        readonly when: "The bash tool attempts a remote git operation while network access is disabled.";
    };
    readonly TOOL_COMMAND_FAILED: {
        readonly category: "tools";
        readonly when: "A bash tool command exits with a non-zero status.";
    };
    readonly TOOL_GREP_FAILED: {
        readonly category: "tools";
        readonly when: "The grep tool fails with an rg execution error.";
    };
    readonly AGENT_CLI_ERROR: {
        readonly category: "agents";
        readonly when: "A CLI-backed agent exits unsuccessfully, streams an explicit error, or its RPC transport fails.";
    };
    readonly AGENT_RPC_FILE_ARGS: {
        readonly category: "agents";
        readonly when: "Pi RPC mode is used with file arguments that the transport does not support.";
    };
    readonly AGENT_BUILD_COMMAND: {
        readonly category: "agents";
        readonly when: "An agent implementation forbids buildCommand() because it uses a custom generate() transport.";
    };
    readonly AGENT_DIAGNOSTIC_TIMEOUT: {
        readonly category: "agents";
        readonly when: "An internal agent diagnostic check exceeds the per-check timeout budget.";
    };
    readonly DB_MISSING_COLUMNS: {
        readonly category: "database";
        readonly when: "A table used by Smithers does not expose required columns such as runId or nodeId.";
    };
    readonly DB_REQUIRES_BUN_SQLITE: {
        readonly category: "database";
        readonly when: "The database adapter is not backed by a Bun SQLite client with exec().";
    };
    readonly DB_QUERY_FAILED: {
        readonly category: "database";
        readonly when: "A database read query throws or rejects while running inside an Effect.";
    };
    readonly DB_WRITE_FAILED: {
        readonly category: "database";
        readonly when: "A database write or migration fails, including after SQLite retry exhaustion.";
    };
    readonly STORAGE_ERROR: {
        readonly category: "database";
        readonly when: "A storage service operation fails before surfacing a more specific database code.";
    };
    readonly INTERNAL_ERROR: {
        readonly category: "effect";
        readonly when: "An unexpected internal exception crossed an Effect boundary without a more specific Smithers code.";
    };
    readonly PROCESS_ABORTED: {
        readonly category: "effect";
        readonly when: "A spawned child process is aborted by signal or shutdown.";
        readonly details: "{ command, args, cwd }";
    };
    readonly PROCESS_TIMEOUT: {
        readonly category: "effect";
        readonly when: "A spawned child process exceeds its total timeout.";
        readonly details: "{ command, args, cwd, timeoutMs }";
    };
    readonly PROCESS_IDLE_TIMEOUT: {
        readonly category: "effect";
        readonly when: "A spawned child process stops producing output longer than its idle timeout.";
        readonly details: "{ command, args, cwd, idleTimeoutMs }";
    };
    readonly PROCESS_SPAWN_FAILED: {
        readonly category: "effect";
        readonly when: "The runtime cannot spawn the requested child process.";
        readonly details: "{ command, args, cwd }";
    };
    readonly TASK_RUNTIME_UNAVAILABLE: {
        readonly category: "effect";
        readonly when: "Builder task runtime APIs are accessed outside an executing step.";
    };
    readonly SCHEMA_CHANGE_HOT: {
        readonly category: "hot";
        readonly when: "Hot reload detects a schema change that requires a full restart.";
    };
    readonly HOT_OVERLAY_FAILED: {
        readonly category: "hot";
        readonly when: "Building or cleaning the generated hot-reload overlay fails.";
    };
    readonly HOT_RELOAD_INVALID_MODULE: {
        readonly category: "hot";
        readonly when: "A hot-reloaded workflow module does not export a valid default workflow build.";
    };
    readonly SCORER_FAILED: {
        readonly category: "scorers";
        readonly when: "A scorer throws or rejects while Smithers is evaluating a result.";
    };
    readonly WORKFLOW_EXISTS: {
        readonly category: "cli";
        readonly when: "The workflow creation CLI refuses to overwrite an existing workflow file.";
    };
    readonly CLI_DB_NOT_FOUND: {
        readonly category: "cli";
        readonly when: "A CLI command cannot find a nearby smithers.db file.";
    };
    readonly CLI_AGENT_UNSUPPORTED: {
        readonly category: "cli";
        readonly when: "The ask command selects an agent integration that Smithers does not support in that mode.";
    };
    readonly PI_HTTP_ERROR: {
        readonly category: "integrations";
        readonly when: "The Pi or server integration receives a non-success HTTP response from Smithers.";
    };
    readonly EXTERNAL_BUILD_FAILED: {
        readonly category: "integrations";
        readonly when: "An external workflow host fails to build a Smithers HostNode payload.";
        readonly details: "{ scriptPath, error?, exitCode?, stderr?, stdout? }";
    };
    readonly SCHEMA_DISCOVERY_FAILED: {
        readonly category: "integrations";
        readonly when: "External workflow schema discovery fails or returns invalid output.";
        readonly details: "{ scriptPath, error?, exitCode?, stderr? }";
    };
    readonly OPENAPI_SPEC_LOAD_FAILED: {
        readonly category: "integrations";
        readonly when: "An OpenAPI spec cannot be loaded or parsed.";
    };
    readonly OPENAPI_OPERATION_NOT_FOUND: {
        readonly category: "integrations";
        readonly when: "The requested operationId does not exist in the OpenAPI spec.";
    };
    readonly OPENAPI_TOOL_EXECUTION_FAILED: {
        readonly category: "integrations";
        readonly when: "An OpenAPI tool call fails during HTTP execution.";
    };
};
