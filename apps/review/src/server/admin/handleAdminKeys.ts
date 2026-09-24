import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { randomTokenHex } from "../randomTokenHex.ts";
import { sha256Hex } from "../sha256Hex.ts";
import { timingSafeStringEqual } from "../timingSafeStringEqual.ts";

interface MintBody {
  owner?: unknown;
  repos?: unknown;
  spendCapUsd?: unknown;
}

/**
 * POST /api/admin/keys — mint a new srk_ API key. Returns the key plaintext
 * exactly once and stores the SHA-256 hash. We never log the key, never round-
 * trip it through the database, and never allow a list endpoint that could
 * leak it (only hashes are listable, intentionally not exposed here).
 */
export async function handleAdminKeys(request: Request, env: ReviewWorkerEnv, now: number): Promise<Response> {
  const expected = `Bearer ${env.ADMIN_TOKEN ?? ""}`;
  const got = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || !timingSafeStringEqual(got, expected)) {
    return jsonError(401, "unauthorized");
  }
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  const revoke = /^\/api\/admin\/keys\/([a-f0-9]{64})\/revoke$/.exec(new URL(request.url).pathname);
  if (revoke) {
    const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE hash = ?")
      .bind(now, revoke[1]).run();
    return result.meta.changes ? new Response(null, { status: 204 }) : jsonError(404, "key not found");
  }
  let body: MintBody;
  try {
    body = (await request.json()) as MintBody;
  } catch {
    return jsonError(400, "invalid JSON body");
  }
  if (typeof body.owner !== "string" || body.owner.length === 0) return jsonError(400, "owner required");
  const repos = Array.isArray(body.repos) ? body.repos.filter((r): r is string => typeof r === "string") : [];
  if (!Array.isArray(body.repos) || repos.length !== body.repos.length) {
    return jsonError(400, "repos must be a string array");
  }
  const spendCapUsd = body.spendCapUsd === undefined ? null : body.spendCapUsd;
  if (spendCapUsd !== null && (typeof spendCapUsd !== "number" || !Number.isFinite(spendCapUsd) || spendCapUsd <= 0)) {
    return jsonError(400, "spendCapUsd must be > 0");
  }
  const key = `srk_${randomTokenHex(24)}`;
  const hash = await sha256Hex(key);
  await env.DB.prepare(
    "INSERT INTO api_keys (hash, owner, repos_json, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(hash, body.owner, JSON.stringify(repos), spendCapUsd, now)
    .run();
  return Response.json({ key, owner: body.owner, repos, spendCapUsd }, { status: 201 });
}
