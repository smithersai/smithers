// Shared framework-wide constants to avoid drift between components,
// DOM extraction, scheduler, and engine layers.
export const DEFAULT_MERGE_QUEUE_CONCURRENCY = 1;

// Centralized to keep component and extractor error messages in sync.
export const WORKTREE_EMPTY_PATH_ERROR =
  "<Worktree> requires a non-empty path prop";
