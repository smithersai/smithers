import { sameRepoName } from "../sameRepoName.ts";
import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { monthKey } from "../monthKey.ts";
import { authenticateProxyRequest, type ProxyAuth } from "../proxy/authenticateProxyRequest.ts";
import { assertRepoUnderMonthlyCap } from "../assertRepoUnderMonthlyCap.ts";
import { lookupRepo } from "../sessions/lookupRepo.ts";

interface CountRow {
  count: number;
}

export async function handlePlan(request: Request, env: ReviewWorkerEnv, url: URL, now: number): Promise<Response> {
  const credential = await authenticateProxyRequest(request, env, now);
  if (!credential) return jsonError(401, "unauthorized");

  let repo = url.searchParams.get("repo") ?? (credential.kind === "session" ? credential.repo : null);
  if (!repo) return jsonError(400, "repo query parameter is required");
  if (!canAccessRepo(credential, repo)) return jsonError(403, "forbidden");

  const registration = await lookupRepo(env.DB, repo);
  if (!registration) return jsonError(404, "repo not registered");

  repo = registration.repo;
  const budget = await assertRepoUnderMonthlyCap(env.DB, registration, repo, now);
  if (budget instanceof Response) return budget;
  const { monthlyCapUsd, monthSpendUsd: monthlySpendUsd } = budget;
  const month = monthKey(now);
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM reviewed_prs WHERE repo = ? AND month = ?")
    .bind(repo, month)
    .first<CountRow>();
  const prsUsed = Number(countRow?.count ?? 0);

  return Response.json({
    repo,
    plan: {
      mode: registration.mode,
      quiz: registration.quiz,
      prsPerMonth: registration.prs_per_month,
      spendCapUsd: registration.spend_cap_usd,
    },
    quota: {
      month,
      prsUsed,
      prsPerMonth: registration.prs_per_month,
      monthlyCapUsd,
      monthlySpendUsd,
    },
  });
}

function canAccessRepo(credential: ProxyAuth, repo: string): boolean {
  if (credential.kind === "session") return sameRepoName(credential.repo, repo);
  return credential.repos.some((name) => sameRepoName(name, repo));
}
