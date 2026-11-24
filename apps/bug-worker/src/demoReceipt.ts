import type { z } from "zod";
import { DEMO_REQUESTS_PER_HOUR, RATE_LIMIT_PER_HOUR } from "./checkRateLimit.ts";
import type { demoRequestSchema } from "./demoRequestSchema.ts";
import type { State } from "./durableState.ts";
import type { BugWorkerEnv } from "./env.ts";
import { newBugId } from "./newBugId.ts";

export const DEMO_REQUEST_TTL_SECONDS = 90 * 24 * 60 * 60;
const TTL_MS = DEMO_REQUEST_TTL_SECONDS * 1000;
const HOUR_MS = 3_600_000;
type Storage = State["storage"];
type Form = z.infer<typeof demoRequestSchema>;
export type DemoSubmission = { submissionId: string; form: Form; now: number; client: string };
export type DemoCharge = { id: string; client: string; hour: number };
type Admission = "yes" | "all" | "client";
type Receipt = { id: string; digest: string; received: number } & (
  | { phase: "reserved"; client: string }
  | { phase: "admitted" | "stored" }
);
export type DemoResult = { status: "accepted" | "replayed"; id: string }
  | { status: "all" | "client" | "conflict" | "storage_unavailable" | "rate_limiter_unavailable" };

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const formDigest = (form: Form) => sha256(JSON.stringify([form.firstName, form.lastName, form.workEmail, form.message]));

/** One object per demo intake hour. The ticket and both charges commit together.
 * Keep tickets until every receipt for this hour expires so a lost admission reply
 * can be retried even across an hour boundary. At most 200 tickets per object.
 */
export async function admitDemo(storage: Storage, charge: DemoCharge): Promise<Admission> {
  await storage.setAlarm((charge.hour + 1) * HOUR_MS + TTL_MS);
  return storage.transaction(async (txn) => {
    const ticket = "ticket:" + charge.id;
    if (await txn.get(ticket)) return "yes";
    const total = await txn.get<number>("total") ?? 0;
    if (total >= DEMO_REQUESTS_PER_HOUR) return "all";
    const key = "client:" + charge.client;
    const count = await txn.get<number>(key) ?? 0;
    if (count >= RATE_LIMIT_PER_HOUR) return "client";
    await txn.put(ticket, true);
    await txn.put(key, count + 1);
    await txn.put("total", total + 1);
    return "yes";
  });
}

async function chargeReceipt(env: BugWorkerEnv, receipt: Extract<Receipt, { phase: "reserved" }>): Promise<Admission | "rate_limiter_unavailable"> {
  const hour = Math.floor(receipt.received / HOUR_MS);
  try {
    const response = await env.RATE_LIMITS.getByName("demo-hour:" + hour).fetch(new Request("https://rate-limiter/demo-charge", {
      method: "POST", body: JSON.stringify({ id: receipt.id, client: receipt.client, hour }),
    }));
    if (response.ok) return await response.json() as Admission;
  } catch { /* Retry with the same ticket if the admission reply was lost. */ }
  return "rate_limiter_unavailable";
}

/** Called under the input gate of the object named for submissionId. */
export async function receiveDemo(storage: Storage, env: BugWorkerEnv, submission: DemoSubmission): Promise<Response> {
  const { submissionId, form, now, client } = submission;
  const reply = (result: DemoResult) => Response.json(result);
  try {
    const digest = await formDigest(form);
    let receipt = await storage.get<Receipt>("receipt");
    if (receipt && receipt.received + TTL_MS <= now) receipt = undefined;
    if (!receipt) {
      // Migrate an existing KV receipt on first replay. An orphan cannot attest to any form.
      const legacyId = await env.BUGS.get("demo-receipt:" + submissionId);
      if (legacyId) {
        const raw = await env.BUGS.get("demo:" + legacyId);
        if (!raw) return reply({ status: "storage_unavailable" });
        const lead = JSON.parse(raw);
        if (lead.id !== legacyId || !Number.isFinite(Date.parse(lead.receivedAt))) return reply({ status: "storage_unavailable" });
        receipt = { id: legacyId, digest: await formDigest(lead.request), received: Date.parse(lead.receivedAt), phase: "stored" };
      } else {
        receipt = {
          id: newBugId(now), digest, received: now, phase: "reserved",
          client: await sha256(JSON.stringify([Math.floor(now / HOUR_MS), client])),
        };
      }
      await storage.setAlarm(receipt.received + TTL_MS);
      await storage.put("receipt", receipt);
    }
    if (receipt.digest !== digest) return reply({ status: "conflict" });
    if (receipt.phase === "stored") {
      const replays = await storage.get<number>("replays") ?? 0;
      if (replays >= RATE_LIMIT_PER_HOUR) return reply({ status: "client" });
      await storage.put("replays", replays + 1);
      return reply({ status: "replayed", id: receipt.id });
    }
    if (receipt.phase === "reserved") {
      const status = await chargeReceipt(env, receipt);
      if (status !== "yes") {
        // A refused request has no admission. It may try again in another hour.
        if (status !== "rate_limiter_unavailable") {
          await storage.deleteAll();
          await storage.deleteAlarm();
        }
        return reply({ status });
      }
      receipt = { id: receipt.id, digest, received: receipt.received, phase: "admitted" };
      await storage.put("receipt", receipt);
    }
    await env.BUGS.put("demo:" + receipt.id, JSON.stringify({
      id: receipt.id, receivedAt: new Date(receipt.received).toISOString(), request: form,
    }), { expiration: Math.floor((receipt.received + TTL_MS) / 1000) });
    await storage.put("receipt", { ...receipt, phase: "stored" });
    return reply({ status: "accepted", id: receipt.id });
  } catch {
    return reply({ status: "storage_unavailable" });
  }
}
