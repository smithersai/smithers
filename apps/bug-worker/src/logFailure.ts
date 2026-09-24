/**
 * One JSON line per failure the Worker reports: a 503, or a 200 whose side
 * effect failed (a confirmation email that was not sent). Workers Logs
 * indexes JSON fields, so `event` separates a KV outage from a GitHub outage
 * from a code defect, and `route` names the request that hit it.
 */
export function logFailure(event: string, request: Request, error: unknown): void {
  console.error(JSON.stringify({
    event,
    route: `${request.method} ${new URL(request.url).pathname}`,
    error: error instanceof Error ? error.message : String(error),
  }));
}
