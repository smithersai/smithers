import type { BugWorkerEnv } from "./env.ts";

/**
 * Compare without leaking length: both sides are hashed to a fixed-size
 * digest first, so the loop below always runs 32 iterations and a timing
 * side channel cannot reveal how long the admin token is.
 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ab = new Uint8Array(ah);
  const bb = new Uint8Array(bh);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Operator check shared by every admin route: the request must carry the
 * deployed `BUG_ADMIN_TOKEN` in `x-bug-admin`. Unset token means nobody passes.
 */
export async function isOperator(request: Request, env: BugWorkerEnv): Promise<boolean> {
  if (!env.BUG_ADMIN_TOKEN) return false;
  return timingSafeStringEqual(request.headers.get("x-bug-admin") ?? "", env.BUG_ADMIN_TOKEN);
}
