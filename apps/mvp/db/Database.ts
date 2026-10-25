import modelQuotaFailure from "./migrations/0059_model_quota_failure.ts"
import branchRefNamespace from "./migrations/0055_branch_ref_namespace.ts"
import personalModels from "./migrations/0056_personal_models.ts"
import modelUsageOutcome from "./migrations/0057_model_usage_outcome.ts"
import hostedModel from "./migrations/0058_hosted_model.ts"
import messagePins from "./migrations/0054_message_pins.ts"
import conversationPeople from "./migrations/0047_conversation_people.ts"
import dropMergeUnknown from "./migrations/0050_drop_merge_unknown.ts"
import triageWriteClaims from "./migrations/0049_triage_write_claims.ts"
import githubProjectionFences from "./migrations/0048_github_projection_fences.ts"
import timelineSummaryRole from "./migrations/0030_timeline_summary_role.ts"
import pulls from "./migrations/0031_pulls.ts"
import pullWrites from "./migrations/0033_pull_writes.ts"
import todoReportReceipts from "./migrations/0035_todo_report_receipts.ts"
import todoRun from "./migrations/0036_todo_run.ts"
import issueCommitment from "./migrations/0032_issue_commitment.ts"
import pullDefaultBranch from "./migrations/0037_pull_default_branch.ts"
import sandboxCallStartTimeout from "./migrations/0038_sandbox_call_start_timeout.ts"
import stackedTodos from "./migrations/0039_stacked_todos.ts"
import flowDraftDeleted from "./migrations/0040_flow_draft_deleted.ts"
import refsChangedAt from "./migrations/0041_refs_changed_at.ts"
import codingModelRole from "./migrations/0042_coding_model_role.ts"
import docsViews from "./migrations/0043_docs_views.ts"
import todoBaseAncestry from "./migrations/0045_todo_base_ancestry.ts"
import todoRetry from "./migrations/0044_todo_retry.ts"
import domains from "./migrations/0046_domains.ts"
import githubRepoRoles from "./migrations/0051_github_repo_roles.ts"
import agentViews from "./migrations/0052_agent_views.ts"
import repoRuns from "./migrations/0053_repo_runs.ts"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer, Redacted } from "effect"
import { Migrator } from "effect/sql"
import messages from "./migrations/0001_messages.ts"
import answerAttempts from "./migrations/0002_answer_attempts.ts"
import pairedPositions from "./migrations/0003_paired_positions.ts"
import modelRoles from "./migrations/0004_model_roles.ts"
import signIn from "./migrations/0005_sign_in.ts"
import answerParts from "./migrations/0006_answer_parts.ts"
import repositories from "./migrations/0007_repositories.ts"
import browserAnswering from "./migrations/0008_browser_answering.ts"
import cloneIds from "./migrations/0009_clone_ids.ts"
import views from "./migrations/0010_views.ts"
import questionAskers from "./migrations/0011_question_askers.ts"
import modelReservations from "./migrations/0012_model_reservations.ts"
import runs from "./migrations/0013_runs.ts"
import branchWorkspace from "./migrations/0014_branch_workspace.ts"
import flows from "./migrations/0015_flows.ts"
import githubIssues from "./migrations/0016_github_issues.ts"
import modelCharges from "./migrations/0017_model_charges.ts"
import triage from "./migrations/0018_triage.ts"
import spendAlerts from "./migrations/0019_spend_alerts.ts"
import notifications from "./migrations/0020_notifications.ts"
import secrets from "./migrations/0021_secrets.ts"
import todos from "./migrations/0022_todos.ts"
import branchSharing from "./migrations/0023_branch_sharing.ts"
import sandboxCalls from "./migrations/0024_sandbox_calls.ts"
import flowSource from "./migrations/0025_flow_source.ts"
import textUpdates from "./migrations/0026_text_updates.ts"
import todoIssue from "./migrations/0027_todo_issue.ts"
import cloneProgress from "./migrations/0028_clone_progress.ts"
import alertChannels from "./migrations/0029_alert_channels.ts"

/** The compose Postgres (`docker-compose.yml`): what `DATABASE_URL` defaults to, and the only one tests use. */
export const LOCAL_URL = "postgresql://smithers:smithers@localhost:54321/smithers"

/** `DATABASE_URL`: the migrations, the tests, and the origin Hyperdrive fronts for ChatApi. */
export const url = Config.Redacted("DATABASE_URL").pipe(Config.withDefault(Redacted.make(LOCAL_URL)))

/**
 * `DATABASE_URL` in the parts Hyperdrive takes: the `origin` (host; port, 5432 when the URL names none; database,
 * user and password, URL-decoded), and the `sslmode` `alchemy dev` reaches it with: `require` when the URL asks for
 * it, otherwise `disable`.
 */
export const hyperdrive = (url: Redacted.Redacted<string>) => {
  const parsed = new URL(Redacted.value(url))
  return {
    origin: {
      scheme: "postgres" as const,
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.slice(1)),
      user: decodeURIComponent(parsed.username),
      password: Redacted.make(decodeURIComponent(parsed.password)),
    },
    sslmode: parsed.searchParams.get("sslmode") === "require" ? ("require" as const) : ("disable" as const),
  }
}

/**
 * A Postgres client as `PgClient` and `SqlClient`, connected for as long as the scope that builds the layer.
 * A Worker builds one per request, because workerd ties a socket to the request that opened it. Statements go out
 * unnamed: past 100 named statements on a connection the driver closes the oldest, and Hyperdrive drops the
 * connection when it does (`@smthrs/database` `PostgresDatabase`).
 */
export const layer = <E, R>(connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>) =>
  Layer.unwrap(Effect.map(connectionString, (url) => PgClient.layer({ url, maxConnections: 1, prepare: false })))

/** Every migration in `db/migrations`, by `<id>_<name>`. */
export const migrations = {
  "0032_issue_commitment": issueCommitment,
  "0001_messages": messages,
  "0002_answer_attempts": answerAttempts,
  "0003_paired_positions": pairedPositions,
  "0004_model_roles": modelRoles,
  "0005_sign_in": signIn,
  "0006_answer_parts": answerParts,
  "0007_repositories": repositories,
  "0008_browser_answering": browserAnswering,
  "0009_clone_ids": cloneIds,
  "0010_views": views,
  "0011_question_askers": questionAskers,
  "0012_model_reservations": modelReservations,
  "0013_runs": runs,
  "0014_branch_workspace": branchWorkspace,
  "0015_flows": flows,
  "0016_github_issues": githubIssues,
  "0017_model_charges": modelCharges,
  "0018_triage": triage,
  "0019_spend_alerts": spendAlerts,
  "0020_notifications": notifications,
  "0021_secrets": secrets,
  "0022_todos": todos,
  "0023_branch_sharing": branchSharing,
  "0024_sandbox_calls": sandboxCalls,
  "0025_flow_source": flowSource,
  "0026_text_updates": textUpdates,
  "0027_todo_issue": todoIssue,
  "0028_clone_progress": cloneProgress,
  "0029_alert_channels": alertChannels,
  "0030_timeline_summary_role": timelineSummaryRole,
  "0031_pulls": pulls,
  "0033_pull_writes": pullWrites,
  "0035_todo_report_receipts": todoReportReceipts,
  "0036_todo_run": todoRun,
  "0037_pull_default_branch": pullDefaultBranch,
  "0038_sandbox_call_start_timeout": sandboxCallStartTimeout,
  "0039_stacked_todos": stackedTodos,
  "0040_flow_draft_deleted": flowDraftDeleted,
  "0041_refs_changed_at": refsChangedAt,
  "0042_coding_model_role": codingModelRole,
  "0043_docs_views": docsViews,
  "0044_todo_retry": todoRetry,
  "0045_todo_base_ancestry": todoBaseAncestry,
  "0046_domains": domains,
  "0047_conversation_people": conversationPeople,
  "0048_github_projection_fences": githubProjectionFences,
  "0049_triage_write_claims": triageWriteClaims,
  "0050_drop_merge_unknown": dropMergeUnknown,
  "0051_github_repo_roles": githubRepoRoles,
  "0052_agent_views": agentViews,
  "0053_repo_runs": repoRuns,
  "0054_message_pins": messagePins,
  "0055_branch_ref_namespace": branchRefNamespace,
  "0056_personal_models": personalModels,
  "0057_model_usage_outcome": modelUsageOutcome,
  "0058_hosted_model": hostedModel,
  "0059_model_quota_failure": modelQuotaFailure,
}

/** Applies every migration in `db/migrations` that hasn't run, in order; returns the ones it applied. */
export const migrate = Migrator.make({})({ loader: Migrator.fromRecord(migrations) })

/**
 * `pnpm db:migrate`: `migrate`, then one log line, `db:migrate: applied` with the migrations it applied as `applied`
 * (`<id>_<name>`, comma-separated), or `db:migrate: up to date`.
 */
export const migrateAndReport = Effect.gen(function* () {
  const applied = yield* migrate
  yield* Effect.logInfo(applied.length === 0 ? "db:migrate: up to date" : "db:migrate: applied").pipe(
    Effect.annotateLogs({ applied: applied.map(([id, name]) => `${id}_${name}`).join(", ") }),
  )
})
