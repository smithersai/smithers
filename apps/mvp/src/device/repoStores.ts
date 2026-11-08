// Which of the device's collection families hold one repository's rows. A refusal on a repository (decision 0110,
// 2026-11-03 amendment) wipes each through `RepoStore.registerCache`; a test holds this list, the registry, the app's
// registrations and the source's collections to each other.

/** Kept on the device: synced families and repository homes. */
export const REPOSITORY_STORES = [
  "issue-summaries",
  "issue-items",
  "issue-comments",
  "issue-sync",
  "issue-triage-settings",
  "issue-work-links",
  "todos",
  "todo-requests",
  "pull-rows",
  "pull-commits",
  "pull-reviews",
  "pull-checks",
  "secrets",
  "repo-runs",
  "homes",
  "curated-homes",
] as const

/** Memory only, in a tab that opened them. */
export const REPOSITORY_MEMORY = [
  "repo-trees",
  "repo-blobs",
  "repo-refs",
  "repo-abouts",
  "repo-heads",
  "repo-embeds",
  "agent-runs",
  "machines",
  "feeds",
  "feed",
  "domains",
  "docs-indexes",
  "docs-pages",
  "docs-searches",
  "pull-files",
  "branch-compare",
  "home-files",
  "issue-searched",
  "repo-runs-shown",
  "run-pages",
  "cloud-runs",
] as const

/**
 * Local collections that hold no repository's content, by why. A new local collection fails the test in
 * repoStores.test.ts until it is wiped or named here.
 */
export const UNSCOPED_LOCAL: Readonly<Record<string, string>> = Object.fromEntries([
  ...[
    "alert-channel-saves", "attention-details", "attention-entries", "attention-launches", "attention-panel",
    "auth-session", "chat-asking", "chat-composer", "chat-connection", "chat-history", "chat-place", "commands-menu",
    "conversation-list", "conversation-search", "first-run", "flow-editor", "flow-round", "flow-shown",
    "personal-model-add", "personal-model-form", "personal-model-link", "personal-model-test", "plugin-shown",
    "plugin-views", "presence-participants", "presence-room", "sandbox-limit-saves", "share-dialog", "share-list",
    "status-local", "terminal-panel", "terminal-tabs", "timeline-notice", "transcript-items", "transcript-panel",
    "views-opened", "views-showing", "effective-pins", "coedit-texts",
  ].map((id) => [id, "the person's own conversations, runs, flows, settings or UI"] as const),
  ...["branch-current", "branch-publication", "branch-publish", "branch-pull-title"]
    .map((id) => [id, "by branch"] as const),
  ...["runs", "run-view", "repo-run-form", "repo-runs-loaded"]
    .map((id) => [id, "the person's own runs, or which repositories loaded (no rows)"] as const),
  ...[
    "docs-current", "home-current", "issue-view", "pull-view", "repo-view", "secrets-view", "todo-view",
    "domains-page", "domain-saves", "domains-list", "secret-forms", "issue-opened", "issue-detail-demand",
    "todo-access", "repo-clones", "repo-roles", "repo-visible", "repo-session-none", "conversation-owners", "views-home",
  ].map((id) => [id, "which page shows, what this tab asked, or authority itself: no repository content"] as const),
  ...[
    "home-no-access", "home-no-items", "home-no-syncs", "home-no-todos", "issue-comments-none", "issue-details-none",
    "issue-items-none", "issue-sync-none", "issue-triage-settings-none", "issue-work-links-none", "pull-checks-none",
    "pull-commits-none", "pull-reviews-none", "pull-rows-none", "secrets-none", "todo-none", "todo-requests-none",
  ].map((id) => [id, "always empty"] as const),
])

/** Named by something else than a repository, which a repository's refusal can't address. */
export const UNWIPED_FAMILIES: Readonly<Record<string, string>> = {
  "chat-messages": "by conversation",
  views: "by conversation",
  "text-updates": "by conversation or run",
  publications: "by branch",
  shares: "by branch",
  terminals: "by branch",
  "remote-run": "by run",
}
