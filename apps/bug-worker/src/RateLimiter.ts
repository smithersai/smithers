import type { State } from "./durableState.ts";

/**
 * The worker's request. A charge (the default) admits and counts one request
 * against `limit` for `hour`; a refund returns one admission charged to `hour`.
 */
export type RateLimitRequest =
  | { op?: "charge"; hour: number; limit: number }
  | { op: "refund"; hour: number };
/** The answer to a charge: whether it was admitted, and the hour it was charged to. */
export type RateLimitAnswer = { allowed: boolean; hour: number };
type Window = { hour: number; count: number };

const HOUR_MS = 3_600_000;

/**
 * One rate-limit bucket. A Durable Object runs one request at a time and the
 * count moves inside a storage transaction, so concurrent requests for the
 * same bucket cannot race past its budget the way a KV read-modify-write can.
 * Each window schedules an alarm at its end that deletes the object's
 * storage, so a bucket per client address leaves nothing stored once its hour
 * is over. Reachable only through the Worker's binding.
 */
export class RateLimiter {
  constructor(private readonly ctx: State) {}

  /**
   * POST a `RateLimitRequest`. A charge answers `RateLimitAnswer`; a refund
   * answers `{refunded}`. The window only moves forward: an hour older than
   * the stored one counts against the stored window.
   */
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as RateLimitRequest;
    if (body.op === "refund") {
      const refunded = await this.ctx.storage.transaction(async (txn) => {
        const window = await txn.get<Window>("window");
        // A window that has since rolled over has nothing to return.
        if (window === undefined || window.hour !== body.hour || window.count === 0) return false;
        await txn.put<Window>("window", { hour: window.hour, count: window.count - 1 });
        return true;
      });
      return Response.json({ refunded });
    }
    const { hour, limit } = body;
    const answer = await this.ctx.storage.transaction(async (txn) => {
      const window = await txn.get<Window>("window");
      // A request whose body arrived late carries an older hour; it is charged
      // to the stored window, so it can never rewind the count to zero.
      const current = window && window.hour > hour ? window.hour : hour;
      const count = window?.hour === current ? window.count : 0;
      if (count >= limit) return { allowed: false, hour: current, opened: false };
      await txn.put<Window>("window", { hour: current, count: count + 1 });
      return { allowed: true, hour: current, opened: window?.hour !== current };
    });
    // A new window moves the cleanup alarm to its end. The alarm replaces the
    // previous one, so it never fires inside a live window.
    if (answer.opened) await this.ctx.storage.setAlarm((answer.hour + 1) * HOUR_MS);
    return Response.json({ allowed: answer.allowed, hour: answer.hour } satisfies RateLimitAnswer);
  }

  /** The window has ended: drop the bucket, so the next request counts from one. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
