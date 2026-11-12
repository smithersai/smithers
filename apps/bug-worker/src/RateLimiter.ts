import type { State } from "./durableState.ts";

/** The worker's request: the current hour and the bucket's budget for it. */
export type RateLimitRequest = { hour: number; limit: number };
type Window = { hour: number; count: number };

/**
 * One rate-limit bucket. A Durable Object runs one request at a time and the
 * count moves inside a storage transaction, so concurrent requests for the
 * same bucket cannot race past its budget the way a KV read-modify-write can.
 * Reachable only through the Worker's binding.
 */
export class RateLimiter {
  constructor(private readonly ctx: State) {}

  /**
   * POST {hour, limit}: admit and count one request, or refuse it; answers
   * {allowed}. The window only moves forward: an hour older than the stored
   * one counts against the stored window.
   */
  async fetch(request: Request): Promise<Response> {
    const { hour, limit } = await request.json() as RateLimitRequest;
    const allowed = await this.ctx.storage.transaction(async (txn) => {
      const window = await txn.get<Window>("window");
      // A request whose body arrived late carries an older hour; it is charged
      // to the stored window, so it can never rewind the count to zero.
      const current = window && window.hour > hour ? window.hour : hour;
      const count = window?.hour === current ? window.count : 0;
      if (count >= limit) return false;
      await txn.put<Window>("window", { hour: current, count: count + 1 });
      return true;
    });
    return Response.json({ allowed });
  }
}
