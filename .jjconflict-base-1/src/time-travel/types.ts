/**
 * Serialized snapshot of workflow state at a specific frame.
 */
export type Snapshot = {
  runId: string;
  frameNo: number;
  nodesJson: string;
  outputsJson: string;
  ralphJson: string;
  inputJson: string;
  vcsPointer: string | null;
  workflowHash: string | null;
  contentHash: string;
  createdAtMs: number;
};

/**
 * Parsed snapshot data for diffing and display.
 */
export type ParsedSnapshot = {
  runId: string;
  frameNo: number;
  nodes: Record<string, NodeSnapshot>;
  outputs: Record<string, unknown>;
  ralph: Record<string, RalphSnapshot>;
  input: Record<string, unknown>;
  vcsPointer: string | null;
  workflowHash: string | null;
  contentHash: string;
  createdAtMs: number;
};

export type NodeSnapshot = {
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt: number | null;
  outputTable: string;
  label: string | null;
};

export type RalphSnapshot = {
  ralphId: string;
  iteration: number;
  done: boolean;
};

/**
 * Structured diff between two snapshots.
 */
export type SnapshotDiff = {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: NodeChange[];
  outputsAdded: string[];
  outputsRemoved: string[];
  outputsChanged: OutputChange[];
  ralphChanged: RalphChange[];
  inputChanged: boolean;
  vcsPointerChanged: boolean;
};

export type NodeChange = {
  nodeId: string;
  from: NodeSnapshot;
  to: NodeSnapshot;
};

export type OutputChange = {
  key: string;
  from: unknown;
  to: unknown;
};

export type RalphChange = {
  ralphId: string;
  from: RalphSnapshot;
  to: RalphSnapshot;
};

/**
 * Parameters for forking a run.
 */
export type ForkParams = {
  parentRunId: string;
  frameNo: number;
  inputOverrides?: Record<string, unknown>;
  resetNodes?: string[];
  branchLabel?: string;
  forkDescription?: string;
};

/**
 * Parameters for replaying from a checkpoint.
 */
export type ReplayParams = {
  parentRunId: string;
  frameNo: number;
  inputOverrides?: Record<string, unknown>;
  resetNodes?: string[];
  branchLabel?: string;
  restoreVcs?: boolean;
  cwd?: string;
};

/**
 * Branch metadata.
 */
export type BranchInfo = {
  runId: string;
  parentRunId: string;
  parentFrameNo: number;
  branchLabel: string | null;
  forkDescription: string | null;
  createdAtMs: number;
};

/**
 * Timeline entry for a single frame in a run.
 */
export type TimelineFrame = {
  frameNo: number;
  createdAtMs: number;
  contentHash: string;
  forkPoints: BranchInfo[];
};

/**
 * Timeline for a single run.
 */
export type RunTimeline = {
  runId: string;
  frames: TimelineFrame[];
  branch: BranchInfo | null;
};

/**
 * Recursive timeline tree including forks.
 */
export type TimelineTree = {
  timeline: RunTimeline;
  children: TimelineTree[];
};
