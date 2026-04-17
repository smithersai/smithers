// @smithers-type-exports-begin
/** @typedef {import("./CliExitCode.ts").CliExitCode} CliExitCode */
// @smithers-type-exports-end

/** Uniform CLI exit codes for the devtools live-run commands. */
export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_SERVER_ERROR = 2;
export const EXIT_DECLINED = 3;
export const EXIT_SIGINT = 130;

export const CLI_EXIT_CODES = Object.freeze({
    ok: EXIT_OK,
    userError: EXIT_USER_ERROR,
    serverError: EXIT_SERVER_ERROR,
    declined: EXIT_DECLINED,
    sigint: EXIT_SIGINT,
});
