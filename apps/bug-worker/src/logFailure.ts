/**
 * The stable reasons a refusal or outage is logged under. Workers Logs groups
 * and alerts on these; a provider's exception text never reaches the log,
 * because it can carry request data, private URLs or credentials.
 */
export type FailureCode =
  /** KV threw on a read, write or list. */
  | "storage_unavailable"
  /** The RateLimiter Durable Object threw or answered a non-2xx status. */
  | "rate_limiter_unavailable"
  /** The all-clients hourly cap refused a valid request. */
  | "global_limit";

/**
 * One JSON line per failure the Worker reports: a 503, or a 429 from the
 * all-clients cap. Workers Logs indexes JSON fields, so `event` names the
 * operation, `route` the route template (never a stored ID), and `code` the
 * allowlisted cause.
 */
export function logFailure(event: string, route: string, code: FailureCode): void {
  console.error(JSON.stringify({ event, route, code }));
}

/**
 * One JSON line per stored submission, so an operator finds every accepted
 * bug report and demo request in Workers Logs. It carries the ID only, never
 * submitted content.
 */
export function logAccepted(event: string, route: string, id: string): void {
  console.log(JSON.stringify({ event, route, id }));
}
