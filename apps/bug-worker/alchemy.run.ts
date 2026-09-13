/**
 * Alchemy 2 stack for bug.smithers.sh. Importing it deploys nothing.
 *
 * One Cloudflare Worker (entry: src/worker.ts), a repository completion Durable
 * Object, and one KV namespace for bug reports and per-IP rate-limit counters.
 * The smithers.sh zone lives on
 * this Cloudflare account (migrated from Vercel DNS 2026-06-25), so the
 * Worker serves bug.smithers.sh as a custom domain directly.
 *
 * Deploy:   BUG_ADMIN_TOKEN=... bun x alchemy deploy
 *           (equivalently: BUG_ADMIN_TOKEN=... pnpm -C apps/bug-worker deploy)
 * Destroy:  bun x alchemy destroy
 * Review existing resource names and Alchemy 2 state/adoption before the
 * first deployment; importing old Alchemy 1 state is not automatic.
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD, BUG_ADMIN_TOKEN.
 * Optional env: GITHUB_FORK_TOKEN forks nominated repositories into the
 * smithers-community organization; without it forks are recorded as skipped.
 * Optional env: CLOUDFLARE_SMITHERS_ZONE_ID (alchemy resolves the zone from
 * the domain when omitted, same convention as apps/telegram-summary).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

const adminToken = Config.schema(
  Schema.Redacted(Schema.Trim.check(Schema.isNonEmpty())),
  "BUG_ADMIN_TOKEN",
).pipe(Config.map((value) => Redacted.make(Redacted.value(value).trim())));
const bugs = Cloudflare.KV.Namespace("bug-reports", { title: "bug-reports" });

export const workerProps = {
  name: "smithers-bug-worker",
  main: "src/worker.ts",
  compatibility: { date: "2025-05-01" },
  workersDev: true,
  crons: ["*/10 * * * *"],
  env: {
    BUGS: bugs,
    REPO_COMPLETIONS: Cloudflare.DurableObject("RepoCompletion"),
    ...(process.env.RESEND_API_KEY ? { RESEND_API_KEY: Config.Redacted("RESEND_API_KEY") } : {}),
    ...(process.env.NOTIFICATION_FROM ? { NOTIFICATION_FROM: process.env.NOTIFICATION_FROM } : {}),
    ...(process.env.GITHUB_FORK_TOKEN ? { GITHUB_FORK_TOKEN: Config.Redacted("GITHUB_FORK_TOKEN") } : {}),
    BUG_ADMIN_TOKEN: adminToken,
    PUBLIC_BASE_URL: process.env.BUG_PUBLIC_BASE_URL?.trim() || "https://bug.smithers.sh",
  },
  domain: { name: "bug.smithers.sh", ...(zoneId ? { zoneId } : {}) },
} satisfies Cloudflare.WorkerProps;

export const worker = Cloudflare.Worker("smithers-bug-worker", workerProps);

export default Alchemy.Stack(
  "smithers-bug-worker",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  worker,
);
