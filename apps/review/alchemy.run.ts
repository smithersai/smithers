/**
 * Alchemy 2 stack for the smithers review service.
 *
 * One Cloudflare Worker (entry: src/server/worker.ts), one R2 bucket for
 * walkthroughs, one D1 database for sessions / api keys / usage / quota.
 * The Worker keeps its workers.dev URL and serves review.jjhub.tech as a
 * custom domain (the jjhub.tech zone is on this Cloudflare account).
 *
 * REVIEW_ENABLE_SMITHERS_SH_ROUTE=1 additionally declares the existing
 * review.smithers.sh/* route. Review its DNS and zone configuration before
 * enabling it. Importing this module declares the stack without deploying.
 *
 * Deploy:   REVIEW_PUBLISH_TOKEN=... REVIEW_ADMIN_TOKEN=... REVIEW_METRICS_TOKEN=... \
 *           REVIEW_ANTHROPIC_API_KEY=... bun x alchemy deploy
 * Destroy:  bun x alchemy destroy
 * Existing resources require a reviewed Alchemy 2 state/adoption plan before
 * the first deployment; importing the old Alchemy 1 state is not automatic.
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD, REVIEW_PUBLISH_TOKEN,
 *               REVIEW_ADMIN_TOKEN, REVIEW_METRICS_TOKEN, REVIEW_ANTHROPIC_API_KEY.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const JJHUB_ZONE_ID = "72854846f57d9e46794e7e6aae7e3328";
const SMITHERS_ZONE_ID = "8ebd98d2f0dc7d8db2e61f31ebc19c14";

const requireSecret = (name: string) =>
  Config.schema(Schema.Redacted(Schema.Trim.check(Schema.isNonEmpty())), name).pipe(
    Config.map((value) => Redacted.make(Redacted.value(value).trim())),
  );

const bucket = Cloudflare.R2.Bucket("walkthroughs", { name: "walkthroughs" });
const db = Cloudflare.D1.Database("review-db", { name: "review-db" });

const smithersShRoutes =
  process.env.REVIEW_ENABLE_SMITHERS_SH_ROUTE === "1"
    ? [{ pattern: "review.smithers.sh/*", zoneId: SMITHERS_ZONE_ID }]
    : [];

export const workerProps = {
  name: "smithers-review",
  main: "src/server/worker.ts",
  compatibility: { date: "2025-05-01" },
  workersDev: true,
  env: {
    WALKTHROUGHS: bucket,
    DB: db,
    REVIEW_PUBLISH_TOKEN: requireSecret("REVIEW_PUBLISH_TOKEN"),
    ADMIN_TOKEN: requireSecret("REVIEW_ADMIN_TOKEN"),
    METRICS_TOKEN: requireSecret("REVIEW_METRICS_TOKEN"),
    ANTHROPIC_API_KEY: requireSecret("REVIEW_ANTHROPIC_API_KEY"),
    PUBLIC_BASE_URL: process.env.REVIEW_PUBLIC_BASE_URL?.trim() || "https://review.jjhub.tech",
  },
  domain: { name: "review.jjhub.tech", zoneId: JJHUB_ZONE_ID },
  routes: smithersShRoutes,
} satisfies Cloudflare.WorkerProps;

export const worker = Cloudflare.Worker("smithers-review", workerProps);

export default Alchemy.Stack(
  "smithers-review",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  worker,
);
