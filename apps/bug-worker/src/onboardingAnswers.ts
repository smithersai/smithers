import { z } from "zod";
import { checkRateLimit } from "./checkRateLimit.ts";
import type { BugWorkerEnv } from "./env.ts";
import { isOperator } from "./isOperator.ts";
import { readBodyBounded } from "./readBodyBounded.ts";

const input = z.object({
  id: z.string().uuid(),
  heard: z.string().max(500),
  project: z.string().max(500),
}).strict();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
});

export async function handleOnboardingAnswers(request: Request, env: BugWorkerEnv, now: number): Promise<Response> {
  if (request.method === "GET") {
    if (!await isOperator(request, env)) return json(404, { error: "not found" });
    if (!env.BUGS.list) return json(503, { error: "Listing unavailable" });
    const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
    const page = await env.BUGS.list({ prefix: "onboarding:", limit: 100, cursor });
    const answers = await Promise.all(page.keys.map(async ({ name }) => {
      const row = await env.BUGS.get(name);
      return row ? JSON.parse(row) : null;
    }));
    return json(200, { answers: answers.filter(Boolean), cursor: page.list_complete ? null : page.cursor });
  }
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const raw = await readBodyBounded(request, 8192);
  if (raw === null) return json(413, { error: "Payload too large" });
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }); }
  const parsed = input.safeParse(value);
  if (!parsed.success) return json(400, { error: "Invalid answers" });
  if (!parsed.data.heard.trim() && !parsed.data.project.trim()) return json(400, { error: "No answers supplied" });
  if (!await checkRateLimit(env, `onboarding:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, now)) return json(429, { error: "Please try again later" });
  try {
    await env.BUGS.put(`onboarding:${parsed.data.id}`, JSON.stringify({ ...parsed.data, receivedAt: new Date(now).toISOString() }));
  } catch { return json(503, { error: "Answers could not be saved" }); }
  return json(200, { saved: true });
}
