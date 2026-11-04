// One declaration per spec, alongside target.ts needs. Empty means only reads or run-owned data.
// A new spec must declare its resources here before production can execute it.
// Model readers coexist; connection editors exclude them for their entire run.
import { basename } from "node:path"
import { ordered, type Resource } from "./resource-locks.ts"

export const SPEC_RESOURCES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "accessibility-chat-log.spec.ts": [],
  "accessibility-composer.spec.ts": [],
  "accessibility-docs.spec.ts": [],
  "accessibility-heading.spec.ts": [],
  "accessibility-landing.spec.ts": [],
  "accessibility-locale.spec.ts": [],
  "accessibility-model-fields.spec.ts": [],
  "accessibility-navigation.spec.ts": [],
  "accessibility-new-issue.spec.ts": [],
  "accessibility-pull-alias.spec.ts": [],
  "accessibility-skip.spec.ts": [],
  "accessibility-todo-name.spec.ts": [],
  "actions.spec.ts": [
    "repo-flows"
  ],
  "agent-deployment.spec.ts": [
    "stack",
    "model:read",
    "account-memory"
  ],
  "agent-runner.spec.ts": [
    "factory"
  ],
  "agent.spec.ts": [
    "model:read"
  ],
  "alert-channels.spec.ts": [
    "notification-settings"
  ],
  "alias-sign-in.spec.ts": [],
  "answer-ordering.spec.ts": [],
  "api-reference.spec.ts": [],
  "background-progress.spec.ts": [
    "issues"
  ],
  "branch-count.spec.ts": [],
  "branch-load.spec.ts": [
    "model:read"
  ],
  "branch-offline.spec.ts": [],
  "branch-publish.spec.ts": [
    "issues"
  ],
  "branch-sharing.spec.ts": ["branch:roninjin10/smithers-github-tests/smithers-e2e-sharing", "model:read"],
  "branch-workspace.spec.ts": [
    "branch:octocat/spoon-knife/test-branch",
    "branch:octocat/spoon-knife/change-the-title",
    "model:read"
  ],
  "branches-list.spec.ts": [],
  "browser-isolation.spec.ts": [],
  "bug-door.spec.ts": [],
  "bug-report-privacy.spec.ts": [],
  "bug-report-validation.spec.ts": [],
  "bug-report.spec.ts": [],
  "byok-first.spec.ts": [
    "model:write"
  ],
  "chat.spec.ts": [
    "model:read"
  ],
  "chrome-install.spec.ts": [],
  "chrome-issues.spec.ts": [],
  "chrome-visitor.spec.ts": [],
  "chrome.spec.ts": [],
  "ci.spec.ts": [
    "repo-flows"
  ],
  "code-anchors.spec.ts": [],
  "code-intel.spec.ts": [],
  "code-offline.spec.ts": [],
  "coedit.spec.ts": [
    "branch:roninjin10/smithers-github-tests/smithers-e2e-coedit",
    "model:read"
  ],
  "cold-issue.spec.ts": [
    "tracking"
  ],
  "cold-path.spec.ts": [
    "tracking"
  ],
  "conversations.spec.ts": [],
  "device-session.spec.ts": [],
  "device-storage-readonly.spec.ts": [],
  "device-upgrade-todos.spec.ts": [
    "stack"
  ],
  "device-upgrade.spec.ts": [],
  "docs-chat-commands.spec.ts": [],
  "docs-cli-reference.spec.ts": [],
  "docs-copy.spec.ts": [],
  "docs-flow-reference.spec.ts": [],
  "docs-operator.spec.ts": [],
  "docs-phone-code.spec.ts": [],
  "docs-phone-tables.spec.ts": [],
  "docs-search-titles.spec.ts": [],
  "docs-settings.spec.ts": [],
  "docs-site.spec.ts": [],
  "docs.spec.ts": [
    "model:read"
  ],
  "dogfood.spec.ts": [],
  "domains.spec.ts": [],
  "electric-awake.spec.ts": [
    "model:read"
  ],
  "factory-plugin.spec.ts": ["feed"],
  "factory.spec.ts": [
    "factory"
  ],
  "files.spec.ts": [
    "model:read"
  ],
  "first-paint.spec.ts": [
    "tracking"
  ],
  "first-run.spec.ts": [
    "model:read"
  ],
  "fleet.spec.ts": [
    "factory",
    "notification-settings"
  ],
  "flow-draft-labels.spec.ts": [],
  "flow-editor-storage.spec.ts": [],
  "flow-usage.spec.ts": [],
  "flows-alias.spec.ts": [],
  "flows-visitor.spec.ts": [],
  "flows.spec.ts": [
    "model:read"
  ],
  "forms.spec.ts": [
    "model:read"
  ],
  "generated-view.spec.ts": [
    "model:read"
  ],
  "health.spec.ts": [],
  "home-effect.spec.ts": [],
  "home.spec.ts": [],
  "issue-commitment-list.spec.ts": [],
  "issue-create-navigation.spec.ts": [
    "issues"
  ],
  "issue-lifecycle.spec.ts": [
    "issues"
  ],
  "issue-list-availability.spec.ts": [],
  "issue-list-feedback.spec.ts": [],
  "issue-progress.spec.ts": [
    "issues"
  ],
  "issue-todo-titles.spec.ts": [],
  "issue-tracking.spec.ts": [
    "vibelang",
    "tracking"
  ],
  "issue-visitor.spec.ts": [],
  "issue-waterfall.spec.ts": [
    "tracking"
  ],
  "issues-another-repository.spec.ts": [
    "issues"
  ],
  "issues-repository.spec.ts": [],
  "issues.spec.ts": [
    "issues"
  ],
  "item-navigation.spec.ts": [],
  "item-shape-payload.spec.ts": [],
  "jev.spec.ts": [
    "model:read"
  ],
  "large-file.spec.ts": [],
  "list-search-sort.spec.ts": [],
  "loading-detector.spec.ts": [],
  "local-first-conflicts.spec.ts": [
    "model:read"
  ],
  "local-first.spec.ts": [
    "model:read"
  ],
  "long-blob-path.spec.ts": [],
  "look.spec.ts": [],
  "machine-token.spec.ts": [
    "issues"
  ],
  "markdown-edit.spec.ts": [],
  "markdown-rendering.spec.ts": [],
  "message-controls.spec.ts": [
    "model:read"
  ],
  "messages.spec.ts": [],
  "minimum-font-settings.spec.ts": [],
  "minimum-font.spec.ts": [],
  "missing-branch.spec.ts": [],
  "missing-file.spec.ts": [],
  "missing-items.spec.ts": [],
  "missing-repository.spec.ts": [],
  "mobile.spec.ts": [
    "stack",
    "model:read"
  ],
  "model-quota.spec.ts": ["model:read"],
  "model-toast.spec.ts": [
    "model:write"
  ],
  "navigate.spec.ts": [
    "model:read"
  ],
  "not-found.spec.ts": [],
  "notification-destinations.spec.ts": ["notification-feed"],
  "notification-overflow.spec.ts": ["notification-feed"],
  "notifications.spec.ts": [
    "model:read"
  ],
  "observability.spec.ts": [
    "model:read"
  ],
  "offline-home.spec.ts": [],
  "offline-queue.spec.ts": [],
  "personal-model.spec.ts": [
    "model:write"
  ],
  "pin-message.spec.ts": [
    "model:read"
  ],
  "private-availability.spec.ts": [],
  "pull-recovery.spec.ts": [],
  "pull-review.spec.ts": ["model:read", "pull-review-fixture"],
  "pwa-update.spec.ts": [],
  "queue.spec.ts": [
    "model:read"
  ],
  "reader-code.spec.ts": [],
  "redirect-sitemap.spec.ts": [],
  "remote-flows.spec.ts": [
    "todo",
    "model:read"
  ],
  "repo-browse.spec.ts": [],
  "repo-clone.spec.ts": [
    "model:read"
  ],
  "repo-extras.spec.ts": [],
  "repo-in-chat.spec.ts": [
    "model:read"
  ],
  "repo.spec.ts": [],
  "request-cancellation.spec.ts": [],
  "route-aliases.spec.ts": [],
  "run-credentials.spec.ts": [],
  "run-graph.spec.ts": [],
  "run-panel-focus.spec.ts": [],
  "run-records.spec.ts": ["repo-flows"],
  "runner-registration.spec.ts": [
    "factory"
  ],
  "runs-visitor.spec.ts": [],
  "sandbox-lifecycle.spec.ts": ["branch:octocat/spoon-knife/test-branch"],
  "sandbox-tools.spec.ts": [
    "model:read"
  ],
  "secrets-egress.spec.ts": ["secrets-branch"],
  "secrets.spec.ts": [],
  "settings-draft.spec.ts": [
    "model:read"
  ],
  "settings-layout.spec.ts": [],
  "settings-secrets-empty.spec.ts": [],
  "shape-demand.spec.ts": [],
  "shape-payload.spec.ts": [],
  "shape-recovery.spec.ts": [],
  "shell-home.spec.ts": [],
  "shell-notifications.spec.ts": [],
  "shell-settings.spec.ts": [],
  "sign-in-return-path.spec.ts": [],
  "sign-in.spec.ts": [
    "model:read"
  ],
  "slash-commands.spec.ts": [],
  "slash-repository-refusal.spec.ts": [],
  "stack-direct-load.spec.ts": [],
  "start-app.spec.ts": [],
  "status.spec.ts": [
    "model:read"
  ],
  "subscriptions.spec.ts": [
    "stack",
    "model:write"
  ],
  "sync.spec.ts": [
    "model:read"
  ],
  "telemetry-path-privacy.spec.ts": [],
  "telemetry-transport.spec.ts": [],
  "theme-system.spec.ts": [],
  "timeline-live.spec.ts": [
    "model:read"
  ],
  "timeline-look.spec.ts": [],
  "timeline-summaries.spec.ts": [],
  "timeline.spec.ts": [],
  "toast-action-clearance.spec.ts": [],
  "toast-layout-shift.spec.ts": [],
  "toast-overlap.spec.ts": [],
  "toast-pin-clearance.spec.ts": [],
  "todo-admission-refusal.spec.ts": [
    "stack"
  ],
  "todo-progress.spec.ts": [
    "stack",
    "issues"
  ],
  "todo-steer.spec.ts": [
    "todo",
    "model:read"
  ],
  "todo-write-admission.spec.ts": [
    "stack"
  ],
  "todos-independent.spec.ts": [
    "stack",
    "factory"
  ],
  "todos.spec.ts": [
    "stack",
    "issues"
  ],
  "tree-click.spec.ts": [],
  "tree-file.spec.ts": [],
  "undispatched-steps.spec.ts": [],
  "vibelang-contributor.spec.ts": [],
  "vibelang-factory.spec.ts": [],
  "vibelang-highlighting.spec.ts": [],
  "vibelang-items.spec.ts": [],
  "vibelang-maintainer.spec.ts": [],
  "vibelang-visitor.spec.ts": [],
  "visitor-credentials.spec.ts": [],
  "visitor-issue-counts.spec.ts": [],
  "visitor-settings.spec.ts": [],
  "web-page-agent.spec.ts": ["model:read"],
  "web-page.spec.ts": [],
  "who-may-ask.spec.ts": [],
  "write-admission.spec.ts": [
    "issues"
  ]
}

export const declarations = (files: ReadonlyArray<string>) => [...new Set(files.flatMap((file) => {
  const name = basename(file)
  if (name.endsWith(".setup.ts")) return []
  const resources = SPEC_RESOURCES[name]
  if (!resources) throw new Error(`Declare ${name} in e2e/resources.ts before running production e2e`)
  return resources
}))]
const repositories: Readonly<Record<string, string>> = {
  stack: "E2E_STACK_REPOSITORY", factory: "E2E_FACTORY_REPOSITORY", issues: "E2E_ISSUES_REPOSITORY",
  "repo-flows": "E2E_REPO_FLOWS_REPOSITORY", todo: "E2E_TODO_REPOSITORY",
  vibelang: "E2E_VIBELANG_REPOSITORY", tracking: "E2E_TRACKING_REPOSITORY", feed: "E2E_FEED_REPOSITORY",
}
export const resourcesFor = (declared: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>): Resource[] => ordered(declared.flatMap((name): Resource[] => {
  if (name === "model:read" || name === "model:write") return [{ name: "account:model-connections", mode: name === "model:read" ? "read" : "write" }]
  if (name === "secrets-branch") {
    const repository = env.E2E_SECRETS_REPOSITORY
    const branch = env.E2E_SECRETS_BRANCH
    if (!repository || !branch) return [] // the declared target need reports the missing fixture
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid E2E_SECRETS_REPOSITORY")
    return [{ name: `branch:${repository.toLowerCase()}/${branch}`, mode: "write" }]
  }
  const variable = repositories[name]
  if (!variable) return [{ name: name.startsWith("branch:") ? name : `account:${name}`, mode: "write" }]
  const repository = env[variable] ?? (name === "todo" ? "roninjin10/smithers-github-tests" : name === "repo-flows" ? env.E2E_FACTORY_REPOSITORY : undefined)
  if (!repository) return [] // unmet target need remains a reported skip/block, never cleanup
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`Invalid ${variable}`)
  return [{ name: `repository:${repository.toLowerCase()}`, mode: "write" }]
}))

/** Unstructured discovery output may contain provider diagnostics; never echo it in a JSON parse error. */
export const parseListReport = (text: string) => {
  try { return JSON.parse(text) }
  catch { throw new Error("Playwright discovery returned invalid JSON; no tests started") }
}

/** Playwright discovery applies its real filters, grep, projects and dependency selection. */
export const filesFromList = (report: { errors?: unknown[]; suites?: ReadonlyArray<ListSuite> }): string[] => {
  if (report.errors?.length) throw new Error("Playwright discovery failed; inspect the discovery report")
  const files = new Set<string>()
  const walk = (suite: ListSuite) => {
    for (const spec of suite.specs ?? []) if (spec.tests?.length && spec.file) files.add(spec.file)
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return [...files].sort()
}
type ListSuite = { readonly suites?: ReadonlyArray<ListSuite>; readonly specs?: ReadonlyArray<{ readonly file?: string; readonly tests?: ReadonlyArray<unknown> }> }
