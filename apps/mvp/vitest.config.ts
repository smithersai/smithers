import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

// Unit tests in Node: the browser's framework-free chat layer (src/), ChatApi's handlers (worker/) and the database
// (db/), against the compose Postgres and Electric (`pnpm db:up`). View regressions in tests/ use a DOM environment;
// Playwright covers real browsers. The coverage gate measures logic: every src/**/*.ts but tests and their hosts.
export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../packages/repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../packages/repo-targets/test-utils/test-process-environment.mjs", import.meta.url)),
      // A fresh Electric replication connection for the run (db/ElectricReplication.ts).
      fileURLToPath(new URL("./db/electricReplication.globalSetup.ts", import.meta.url))
    ],
    include: [
      "PACKAGE.test.ts",
      "tests/**/*.test.{ts,vibe}",
      "src/**/*.test.{ts,vibe}",
      // The built-in plugins' tabs (decision 0017, plugins/<id>/src/tab.ts).
      "plugins/**/*.test.{ts,vibe}",
      "worker/**/*.test.{ts,vibe}",
      "db/**/*.test.{ts,vibe}",
      "infra/**/*.test.{ts,vibe}",
      "evals/**/*.test.{ts,vibe}",
      // The e2e media scripts' pure parts (e2e/frames.ts); Playwright runs only e2e/*.spec.ts.
      "e2e/**/*.test.{ts,vibe}",
      // The dev server's HTTPS and HTTP/2 front (dev/https.ts).
      "dev/**/*.test.{ts,vibe}",
      // Dashboards as code (ops/grafana/README.md) against the telemetry contract.
      "ops/**/*.test.{ts,vibe}"
    ],
    environment: "node",
    // A finite budget that survives coverage-instrumented load, so a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      // Keep the coverage gate visible even when a behavioral test fails.
      reportOnFailure: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `mvp-coverage-${process.pid}`),
      include: [
        "src/**/*.{ts,vibe}",
        "plugins/*/src/**/*.ts",
        // Production's hostname and the docs site's routes on it (docs/infrastructure.md#domain).
        "infra/Domain.ts",
        // Remote flows (docs/features/remote-flows.md). worker/Executions.ts, the Alchemy Durable Object declaration,
        // runs only under Alchemy's bundle, so the workerd test proves it through ExecutionHost.ts instead.
        "worker/ExecutionHost.ts",
        "worker/index.ts",
        "worker/ci/*.ts",
        "worker/flows/**/*.{ts,vibe}",
        // The metered model endpoint and admin/SetModel (docs/features/model-endpoint.md).
        "worker/Pins.ts",
        "db/migrations/0054_message_pins.ts",
        // The timeline's summaries, once per message (docs/features/timeline.md#cost).
        "worker/TimelineSummaries.ts",
        "db/migrations/0066_timeline_summaries.ts",
        "worker/Actor.ts",
        "worker/ErrorCode.ts",
        "worker/ModelEndpoint.ts",
        "worker/ModelRefusal.ts",
        "db/migrations/0059_model_quota_failure.ts",
        "worker/ModelRoles.ts",
        "worker/ModelUsage.ts",
        "worker/SetModel.ts",
        "worker/HostedModel.ts",
        "db/migrations/0004_model_roles.ts",
        "db/migrations/0057_model_usage_outcome.ts",
        "db/migrations/0058_hosted_model.ts",
        "db/migrations/0055_branch_ref_namespace.ts",
        // Sign-in (docs/features/sign-in.md).
        "worker/GitHubAuth.ts",
        "worker/SessionKeys.ts",
        "worker/SessionStore.ts",
        "worker/RunCredentials.ts",
        "worker/SignIn.ts",
        "db/migrations/0005_sign_in.ts",
        // Remote flow starts and the browser agent's answer routes (docs/features/remote-flows.md and agent.md).
        "worker/Answers.ts",
        "worker/Body.ts",
        "worker/Flows.ts",
        "db/migrations/0006_answer_parts.ts",
        // ChatApi stops answering: the browser's agent answers (docs/features/agent.md).
        "db/migrations/0008_browser_answering.ts",
        // Repositories: RepoApi, cloning into Code Storage and its spend (docs/features/repo.md).
        "worker/RepoApi.ts",
        "worker/RepoConfig.ts",
        "worker/RepoMetrics.ts",
        "worker/RepoReads.ts",
        "worker/Repos.ts",
        "worker/RepoUpstream.ts",
        "db/migrations/0007_repositories.ts",
        // A clone attempt's own id (docs/features/repo.md#the-clone).
        "db/migrations/0009_clone_ids.ts",
        // What GitHub says of a repository, the clone in its asker's feed, and the reclaim mark (docs/features/repo.md).
        "worker/RepoAbout.ts",
        "worker/about/*.ts",
        "db/migrations/0060_repo_about.ts",
        "worker/CloneFeed.ts",
        "db/migrations/0028_clone_progress.ts",
        // Who asked each question, which the answer routes require (docs/features/agent.md#the-answer-routes).
        "worker/Messages.ts",
        "db/migrations/0011_question_askers.ts",
        // The edge throttle on the open routes (docs/features/chat.md#throttling).
        "worker/Throttle.ts",
        // The conversation's views and web pages (docs/features/web-pages.md).
        "worker/Views.ts",
        "worker/WebPreview.ts",
        "db/migrations/0010_views.ts",
        // A repository's docs and the docs view (docs/features/docs.md).
        "worker/docs/**/*.ts",
        "db/migrations/0043_docs_views.ts",
        // A repository's view and its issues view in the conversation (docs/features/views.md).
        "db/migrations/0063_app_template_views.ts",
        // Budget reservations (docs/features/model-endpoint.md#budget).
        "db/migrations/0012_model_reservations.ts",
        // A person's own flows (docs/features/flows.md#your-own-flows).
        "worker/PersonalFlows.ts",
        "db/migrations/0015_flows.ts",
        // Every stored prompt flow converted to flow source (docs/features/flows.md#your-own-flows).
        "db/migrations/0025_flow_source.ts",
        "db/migrations/0061_flow_placement_machine.ts",
        // Unknown model spend keeps its reservation; reservations expire (docs/features/model-endpoint.md#budget).
        "db/migrations/0017_model_charges.ts",
        // Model spend and its alerts to Admins (docs/features/spend-alerts.md).
        "worker/ModelSpend.ts",
        "worker/SpendAlerts.ts",
        "db/migrations/0019_spend_alerts.ts",
        // Where spend alerts go outside the app, and their receipts (docs/features/spend-alerts.md#channels).
        "worker/AlertChannels.ts",
        "db/migrations/0029_alert_channels.ts",
        // Agent status: the runs routes and table (docs/features/agent-status.md).
        "worker/Runs.ts",
        "db/migrations/0013_runs.ts",
        // Notifications: the feed's fold, routes and shape, and the run index's scope (docs/features/notifications.md).
        "worker/Notifications.ts",
        "db/migrations/0020_notifications.ts",
        // The git loop: GitHub's webhook, the writes route, the issues' shapes and the GitHub flows
        // (docs/features/issues.md). The scripted GitHub and the fixtures are test support.
        "worker/github/*.{ts,vibe}",
        "db/migrations/0016_github_issues.ts",
        "db/migrations/0048_github_projection_fences.ts",
        "db/migrations/0049_triage_write_claims.ts",
        "db/migrations/0050_drop_merge_unknown.ts",
        // Roles on repositories other than the deployment's own (decision 0079).
        "db/migrations/0051_github_repo_roles.ts",
        // Issue triage: its settings, decisions and pins (docs/features/issues.md#triage).
        "db/migrations/0018_triage.ts",
        // Repository secrets: the write routes, the flows, the shape and the sandbox egress (docs/features/secrets.md).
        "worker/secrets/*.ts",
        "db/migrations/0021_secrets.ts",
        // A person's own model: the routes, the flows, the shape, opening it and its ledger (docs/features/personal-model.md).
        "worker/personal/*.ts",
        "db/migrations/0056_personal_models.ts",
        "db/migrations/0065_model_tiers.ts",
        // Custom domains: the provider adapters, the flows, the routes and the shape (docs/features/domains.md).
        "worker/domains/*.ts",
        "db/migrations/0046_domains.ts",
        // TODOs and the stack: its one writer, its route and shapes (docs/features/todos.md).
        "worker/stack/*.ts",
        "db/migrations/0022_todos.ts",
        "db/migrations/0035_todo_report_receipts.ts",
        // A TODO's run, watched from the browser (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare).
        "worker/RemoteRuns.ts",
        // The runs on Cloudflare a person may read, for the Runs page (docs/features/runs.md#runs-on-cloudflare).
        "worker/CloudRuns.ts",
        "db/migrations/0036_todo_run.ts",
        // A repository's runs (docs/features/actions.md).
        "worker/RepoRuns.ts",
        "db/migrations/0053_repo_runs.ts",
        // The branch workspace: branches, their conversations and terminals (docs/features/branch-workspace.md).
        // worker/BranchSandboxes.ts and worker/BranchRooms.ts, the Cloudflare Durable Objects, run only under Alchemy's
        // bundle; e2e/branch-workspace.spec.ts and e2e/branch-sharing.spec.ts drive them, and
        // @smthrs/platform-cloudflare's workerd and @smthrs/sync's presence tests test their parts.
        "worker/branch/*.{ts,vibe}",
        "db/migrations/0014_branch_workspace.ts",
        "db/migrations/0023_branch_sharing.ts",
        // Resync (docs/features/branch-publish.md#resync).
        "db/migrations/0069_branch_resync.ts",
        // Your conversations (docs/features/conversations.md).
        "db/migrations/0047_conversation_people.ts",
        // The sandbox tools: their calls on a branch's machine (docs/features/sandbox-tools.md).
        "db/migrations/0024_sandbox_calls.ts",
        // Sandbox budgets: the limits, the ledger and a terminal's wait (docs/features/sandbox-budgets.md).
        "db/migrations/0062_sandbox_budgets.ts",
        // Bug reports: filing one, the Admins' read and the reports' shape (docs/features/bugs.md).
        "worker/bugs/*.ts",
        "db/migrations/0064_bug_reports.ts",
        "db/migrations/0067_bug_report_errors.ts",
        // Co-editing: the texts people edit together (docs/features/coedit.md).
        "db/migrations/0026_text_updates.ts",
        // What the Electric gateway lets through (docs/infrastructure.md).
        "infra/ElectricAccess.ts",
        // Electric's container kept running between visits (docs/infrastructure.md#electric).
        "infra/ElectricAwake.ts",
        // A shape request the server can't decide is refused, never narrowed (docs/features/chat.md).
        "worker/ShapeAccess.ts",
        // The agent evals' cases, checks, judge and report (docs/features/agent-evals.md). evals/session.ts and
        // evals/agent.eval.ts are the program, which `pnpm eval` runs against the real model.
        "evals/cases.ts",
        "evals/checks.ts",
        "evals/judge.ts",
        "evals/report.ts",
        // How a flow's video and GIF are paced, captioned and checked (e2e/gifs.mjs, e2e/check-gifs.mjs).
        "e2e/frames.ts",
        // The e2e run against a deployment: its summary, spend guard and stored session (docs/infrastructure.md#against-a-deployment).
        "e2e/summary.ts",
        "e2e/spend.ts",
        "e2e/deployment/session.ts",
        // The dev server over HTTPS and HTTP/2, as production serves the app (docs/infrastructure.md#https-and-http2).
        "dev/https.ts"
      ],
      // src/flows/engine.worker.ts is a program boundary, like src/main.tsx: src/flows/engine.test.ts proves what it
      // registers, and a browser proves the rest.
      // src/features/code-intel/language.worker.ts is one too: src/test/languageServer.ts runs the same server in Node.
      exclude: [
        "src/**/*.test.{ts,vibe}",
        "plugins/**/*.test.{ts,vibe}",
        "src/test/**",
        "worker/**/*.test.{ts,vibe}",
        "src/flows/engine.worker.ts",
        "src/features/code-intel/language.worker.ts"
      ],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
