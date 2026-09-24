import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";

/**
 * Who a failed send blames. `rejected`: the provider refused this message, so
 * retrying it later spends the recipient's attempt budget. `unavailable`: the
 * provider, the network, or our configuration failed (no answer, the timeout,
 * any 5xx, 401/403 credentials, 408 timeout, 409 concurrent idempotent request,
 * 429 rate limit); no recipient is at fault and the send is retried as is.
 */
export type SendOutcome = { ok: true } | { ok: false; kind: "rejected" | "unavailable"; error: string };

/** 4xx answers that describe provider or configuration state, never the message. */
const providerStatuses = new Set([401, 403, 408, 409, 429]);

/** One transactional send through Resend, deduplicated by the idempotency key for 24 hours. */
export async function sendMail(
  env: BugWorkerEnv,
  deps: BugWorkerDeps,
  message: { to: string; subject: string; text: string; idempotencyKey: string },
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await deps.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json",
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({ from: env.NOTIFICATION_FROM, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    return { ok: false, kind: "unavailable", error: cause instanceof Error ? cause.message : String(cause) };
  }
  if (response.ok) return { ok: true };
  const error = `Email provider returned HTTP ${response.status}`;
  const rejected = response.status >= 400 && response.status < 500 && !providerStatuses.has(response.status);
  return { ok: false, kind: rejected ? "rejected" : "unavailable", error };
}
