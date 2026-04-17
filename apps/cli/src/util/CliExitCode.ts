/**
 * Uniform CLI exit codes for the devtools live-run commands.
 *
 * - 0   ok
 * - 1   user error (bad flags, missing id, declined confirmation)
 * - 2   server error (transport, backend, unexpected condition)
 * - 3   declined (user aborted at an interactive prompt)
 * - 130 sigint (ctrl-c during a watch/stream)
 */
export type CliExitCode = 0 | 1 | 2 | 3 | 130;
