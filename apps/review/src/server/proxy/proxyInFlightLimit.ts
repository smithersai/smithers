/**
 * The most proxy calls one repository may have outstanding at once.
 *
 * `reserveUsage` refuses admission beyond it, and the GitHub Action caps the
 * review CLI's `--concurrency` at it so a proxy-backed run does not queue
 * behind its own refusals.
 */
export const PROXY_IN_FLIGHT_LIMIT = 4;
