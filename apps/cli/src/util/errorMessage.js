// @smithers-type-exports-begin
/** @typedef {import("./CliErrorMapping.ts").CliErrorMapping} CliErrorMapping */
// @smithers-type-exports-end

import {
    EXIT_USER_ERROR,
    EXIT_SERVER_ERROR,
} from "./exitCodes.js";

/**
 * Exhaustive map of every typed error code the four devtools RPCs may
 * return. Each entry yields a user-friendly message plus an actionable
 * hint and the uniform exit code to surface.
 *
 * Codes come from:
 * - getDevToolsSnapshot / streamDevTools  (ticket 0010, 0011)
 * - getNodeDiff                           (ticket 0012)
 * - getNodeOutput                         (ticket 0012)
 * - jumpToFrame                           (ticket 0013)
 *
 * Plus two transport-level codes used by the CLI itself when it cannot
 * reach the server or the auth token is missing.
 *
 * @type {Readonly<Record<string, CliErrorMapping>>}
 */
export const CLI_ERROR_MESSAGES = Object.freeze({
    // ----- Input validation (every Invalid* → exit 1) -----
    InvalidRunId: {
        message: "The run id is not in the expected shape.",
        hint: "Run ids must match /^[a-z0-9_-]{1,64}$/. Check for typos or pick a run from `smithers ps`.",
        exitCode: EXIT_USER_ERROR,
    },
    InvalidNodeId: {
        message: "The node id is not in the expected shape.",
        hint: "Node ids must match /^[a-zA-Z0-9:_-]{1,128}$/. Copy the id from `smithers tree` or `smithers node`.",
        exitCode: EXIT_USER_ERROR,
    },
    InvalidIteration: {
        message: "The iteration number is invalid.",
        hint: "Iteration must be a non-negative 32-bit integer. Omit --iteration to use the latest.",
        exitCode: EXIT_USER_ERROR,
    },
    InvalidFrameNo: {
        message: "The frame number is invalid.",
        hint: "Frame numbers must be non-negative integers. Omit --frame to use the latest frame.",
        exitCode: EXIT_USER_ERROR,
    },
    InvalidDelta: {
        message: "The server produced a delta the client cannot apply.",
        hint: "This usually self-corrects; retry the command. If it persists, file a bug with the run id.",
        exitCode: EXIT_SERVER_ERROR,
    },

    // ----- Lookups -----
    RunNotFound: {
        message: "No run with that id exists in the local database.",
        hint: "Use `smithers ps` to list runs.",
        exitCode: EXIT_USER_ERROR,
    },
    NodeNotFound: {
        message: "That node does not exist in this run.",
        hint: "Use `smithers tree <runId>` to see the available nodes.",
        exitCode: EXIT_USER_ERROR,
    },
    IterationNotFound: {
        message: "That iteration of the node does not exist.",
        hint: "Omit --iteration to use the latest iteration, or pick one from `smithers node`.",
        exitCode: EXIT_USER_ERROR,
    },
    AttemptNotFound: {
        message: "That node has no attempts yet.",
        hint: "Wait for the task to start, or rerun the workflow.",
        exitCode: EXIT_USER_ERROR,
    },
    AttemptNotFinished: {
        message: "The latest attempt is still running.",
        hint: "Wait for the task to finish before asking for a diff, or jump to a frame before it started.",
        exitCode: EXIT_USER_ERROR,
    },
    FrameOutOfRange: {
        message: "That frame number is outside the range recorded for this run.",
        hint: "Use `smithers tree <runId>` (without --frame) to see the latest frameNo.",
        exitCode: EXIT_USER_ERROR,
    },
    SeqOutOfRange: {
        message: "The requested sequence number is outside the live stream window.",
        hint: "Reconnect without --from-seq to rebase from a fresh snapshot.",
        exitCode: EXIT_USER_ERROR,
    },

    // ----- Stream lifecycle -----
    BackpressureDisconnect: {
        message: "The server disconnected the stream because the client fell behind.",
        hint: "Re-run with a slower consumer (e.g. pipe to `less -R`) or drop --watch.",
        exitCode: EXIT_SERVER_ERROR,
    },

    // ----- Auth -----
    Unauthorized: {
        message: "The request was rejected because credentials are missing or expired.",
        hint: "Run `smithers login` and try again.",
        exitCode: EXIT_SERVER_ERROR,
    },

    // ----- Rewind -----
    ConfirmationRequired: {
        message: "The server requires explicit confirmation for this rewind.",
        hint: "Rerun the command with --yes to confirm.",
        exitCode: EXIT_USER_ERROR,
    },
    Busy: {
        message: "Another rewind is already in progress for this run.",
        hint: "Wait for the current rewind to finish, then retry.",
        exitCode: EXIT_SERVER_ERROR,
    },
    UnsupportedSandbox: {
        message: "This run uses a sandbox type that cannot be rewound.",
        hint: "Only jj-backed runs are supported. Start the run under jj to rewind it.",
        exitCode: EXIT_SERVER_ERROR,
    },
    VcsError: {
        message: "The version control operation failed.",
        hint: "Inspect the workspace for a dirty working copy or missing commits and retry.",
        exitCode: EXIT_SERVER_ERROR,
    },
    RewindFailed: {
        message: "The rewind did not complete successfully.",
        hint: "Check `smithers why <runId>` for details and retry after addressing the cause.",
        exitCode: EXIT_SERVER_ERROR,
    },
    RateLimited: {
        message: "Too many rewind attempts in a short window.",
        hint: "Wait a minute and try again, or lower the rewind frequency.",
        exitCode: EXIT_SERVER_ERROR,
    },
    WorkingTreeDirty: {
        message: "The working tree has uncommitted changes that block the diff.",
        hint: "Commit or stash the changes (or run the command on a clean checkout) and retry.",
        exitCode: EXIT_SERVER_ERROR,
    },

    // ----- Diff / output payload -----
    DiffTooLarge: {
        message: "The diff exceeds the payload budget and cannot be sent in full.",
        hint: "Rerun with --stat for a summary only.",
        exitCode: EXIT_SERVER_ERROR,
    },
    NodeHasNoOutput: {
        message: "This node does not produce an output row.",
        hint: "Only tasks with a registered output table expose --pretty output.",
        exitCode: EXIT_USER_ERROR,
    },
    SchemaConversionError: {
        message: "The server could not derive a schema for this output row.",
        hint: "Use --json to print the raw row without schema ordering.",
        exitCode: EXIT_SERVER_ERROR,
    },
    MalformedOutputRow: {
        message: "The stored output row is not valid JSON.",
        hint: "Inspect the row with `smithers node` and file a bug if it reproduces.",
        exitCode: EXIT_SERVER_ERROR,
    },
    PayloadTooLarge: {
        message: "The output row exceeds the payload budget.",
        hint: "Use `--json | jq` to slice the row into smaller pieces, or inspect it via `smithers node`.",
        exitCode: EXIT_SERVER_ERROR,
    },

    // ----- Transport / infra (not produced by route functions, but the
    // boundary tests in the ticket reference them).
    ServerUnreachable: {
        message: "The smithers gateway is not reachable.",
        hint: "Check SMITHERS_HOST and verify the gateway is running.",
        exitCode: EXIT_SERVER_ERROR,
    },
    AuthExpired: {
        message: "The authentication session has expired.",
        hint: "Run `smithers login` to refresh credentials.",
        exitCode: EXIT_SERVER_ERROR,
    },
});

/**
 * @param {string | undefined | null} code
 * @param {string} [rawMessage]
 * @returns {CliErrorMapping}
 */
export function getCliErrorMapping(code, rawMessage) {
    if (code && Object.prototype.hasOwnProperty.call(CLI_ERROR_MESSAGES, code)) {
        return CLI_ERROR_MESSAGES[code];
    }
    return {
        message: rawMessage && rawMessage.length > 0
            ? rawMessage
            : (code ? `Unexpected error: ${code}` : "Unexpected error."),
        hint: "If this persists, file a bug with the run id and the command that was run.",
        exitCode: EXIT_SERVER_ERROR,
    };
}

/**
 * @param {string | undefined | null} code
 * @param {string} [rawMessage]
 * @returns {string}
 */
export function formatCliErrorForStderr(code, rawMessage) {
    const mapping = getCliErrorMapping(code, rawMessage);
    const heading = code
        ? `error: ${code}: ${mapping.message}`
        : `error: ${mapping.message}`;
    return `${heading}\n  hint: ${mapping.hint}`;
}
