import { Metric } from "effect"

// Usage metrics for the repository view, exported over OTLP with the rest of the browser's telemetry
// (docs/observability.md#browser). Labels carry kinds and outcomes, never a repository's files or contents.

/** Presses of Clone (`kind` `clone`) and Try again (`kind` `retry`). */
export const cloneClicks = Metric.counter("smithers_web_repo_clone_clicks", {
  description: "Times a person pressed Clone or Try again, by kind",
  incremental: true,
})

/**
 * `repo/clone` requests, by `outcome`: `started` (202), `existing` (200: already cloning or ready), a refusal's reason
 * (`sign_in`, `forbidden`, `limit`, `invalid`, `not_configured`) or `unavailable` (no answer, or RepoApi couldn't take
 * it).
 */
export const clones = Metric.counter("smithers_web_repo_clones", {
  description: "repo/clone requests, by outcome",
  incremental: true,
})

/** Repository views opened, by `kind`: `tree` or `blob`. */
export const opens = Metric.counter("smithers_web_repo_opens", {
  description: "Repository views opened, by kind",
  incremental: true,
})

const loadBoundaries = Metric.exponentialBoundaries({ start: 25, factor: 2, count: 10 })

/** Milliseconds a file list took to load, by `outcome`: `ready` or `failed`. */
export const treeLoadMs = Metric.histogram("smithers_web_repo_tree_load_ms", {
  description: "Milliseconds a repository's file list took to load, by outcome",
  boundaries: loadBoundaries,
})

/** Milliseconds a file took to load, by `outcome`: `text`, `binary`, `too-large` or `failed`. */
export const blobLoadMs = Metric.histogram("smithers_web_repo_blob_load_ms", {
  description: "Milliseconds a file took to load, by outcome",
  boundaries: loadBoundaries,
})

/** Milliseconds a repository's branches and tags took to load, by `outcome`: `ready` or `failed`. */
export const refsLoadMs = Metric.histogram("smithers_web_repo_refs_load_ms", {
  description: "Milliseconds a repository's branches and tags took to load, by outcome",
  boundaries: loadBoundaries,
})

/**
 * Milliseconds RepoApi's refs took to name a repository's ready head before Electric delivered its row, by `outcome`:
 * `ready`, `absent` or `failed`.
 */
export const headLoadMs = Metric.histogram("smithers_web_repo_head_load_ms", {
  description: "Milliseconds a repository's ready head took to load from RepoApi's refs, by outcome",
  boundaries: loadBoundaries,
})

/**
 * Milliseconds from opening a location to knowing where it is (its commit, a missing ref, or a ref that couldn't load),
 * by `source` (`row`: the device's synced row; `refs`: RepoApi's refs before Electric delivered the row) and `outcome`
 * (`located`, `missing` or `failed`).
 */
export const locateMs = Metric.histogram("smithers_web_repo_locate_ms", {
  description: "Milliseconds from opening a repository location to resolving it, by source and outcome",
  boundaries: loadBoundaries,
})

/**
 * Copies `repo/copy` ran, by `what` (`permalink`, `path`, `contents` or `clone-url`), `door` (`button`, `agent`, or
 * `unknown` when the tab that asked is gone) and `outcome` (`copied`, `failed`, `refused`, `unavailable` or `gone`).
 */
export const copies = Metric.counter("smithers_web_repo_copies", {
  description: "Copies to the clipboard, by what, door and outcome",
  incremental: true,
})

/** Milliseconds what GitHub says of a repository took to load, by `outcome`: `ready`, `missing` or `failed`. */
export const aboutLoadMs = Metric.histogram("smithers_web_repo_about_load_ms", {
  description: "Milliseconds what GitHub says of a repository took to load, by outcome",
  boundaries: loadBoundaries,
})
