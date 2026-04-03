// ---------------------------------------------------------------------------
// Time Travel — barrel exports
// ---------------------------------------------------------------------------

export type {
  Snapshot,
  ParsedSnapshot,
  NodeSnapshot,
  RalphSnapshot,
  SnapshotDiff,
  NodeChange,
  OutputChange,
  RalphChange,
  ForkParams,
  ReplayParams,
  BranchInfo,
  TimelineFrame,
  RunTimeline,
  TimelineTree,
} from "./types";

export {
  captureSnapshot,
  captureSnapshotEffect,
  loadSnapshot,
  loadSnapshotEffect,
  loadLatestSnapshot,
  loadLatestSnapshotEffect,
  listSnapshots,
  listSnapshotsEffect,
  parseSnapshot,
} from "./snapshot";
export type { SnapshotData } from "./snapshot";

export {
  diffSnapshots,
  diffRawSnapshots,
  formatDiffForTui,
  formatDiffAsJson,
} from "./diff";

export {
  forkRun,
  forkRunEffect,
  listBranches,
  listBranchesEffect,
  getBranchInfo,
  getBranchInfoEffect,
} from "./fork";

export {
  replayFromCheckpoint,
  replayFromCheckpointEffect,
} from "./replay";
export type { ReplayResult } from "./replay";

export {
  tagSnapshotVcs,
  tagSnapshotVcsEffect,
  loadVcsTag,
  loadVcsTagEffect,
  resolveWorkflowAtRevision,
  resolveWorkflowAtRevisionEffect,
  rerunAtRevision,
  rerunAtRevisionEffect,
} from "./vcs-version";
export type { VcsTag } from "./vcs-version";

export {
  buildTimeline,
  buildTimelineEffect,
  buildTimelineTree,
  buildTimelineTreeEffect,
  formatTimelineForTui,
  formatTimelineAsJson,
} from "./timeline";

export {
  smithersSnapshots,
  smithersBranches,
  smithersVcsTags,
} from "./schema";

export {
  snapshotsCaptured,
  runForksCreated,
  replaysStarted,
  snapshotDuration,
} from "./metrics";
