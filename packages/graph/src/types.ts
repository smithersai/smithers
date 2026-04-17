import type { z } from "zod";
import type { AgentCapabilityRegistry } from "@smithers/agents/capability-registry";

export type XmlNode = XmlElement | XmlText;

export type XmlElement = {
  readonly kind: "element";
  readonly tag: string;
  readonly props: Record<string, string>;
  readonly children: readonly XmlNode[];
};

export type XmlText = {
  readonly kind: "text";
  readonly text: string;
};

export type HostNode = HostElement | HostText;

export type HostElement = {
  readonly kind: "element";
  readonly tag: string;
  readonly props: Record<string, string>;
  readonly rawProps: Record<string, unknown>;
  readonly children: readonly HostNode[];
};

export type HostText = {
  readonly kind: "text";
  readonly text: string;
};

export type RetryPolicy = {
  backoff?: "fixed" | "linear" | "exponential";
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitter?: boolean;
};

export type CachePolicy<Ctx = unknown> = {
  by?: (ctx: Ctx) => unknown;
  version?: string;
  key?: string;
  ttlMs?: number;
  scope?: "run" | "workflow" | "global";
  [key: string]: unknown;
};


export type AgentLike = {
  id?: string;
  tools?: Record<string, unknown>;
  capabilities?: AgentCapabilityRegistry;
  generate: (args: unknown) => Promise<unknown>;
};

export type ScoreResult = {
  score: number;
  reason?: string;
  meta?: Record<string, unknown>;
};

export type ScorerInput = {
  input: unknown;
  output: unknown;
  groundTruth?: unknown;
  context?: unknown;
  latencyMs?: number;
  outputSchema?: z.ZodObject;
};

export type ScorerFn = (input: ScorerInput) => Promise<ScoreResult>;

export type Scorer = {
  id: string;
  name: string;
  description: string;
  score: ScorerFn;
};

export type SamplingConfig =
  | { type: "all" }
  | { type: "ratio"; rate: number }
  | { type: "none" };

export type ScorerBinding = {
  scorer: Scorer;
  sampling?: SamplingConfig;
};

export type ScorersMap = Record<string, unknown>;

export type MemoryNamespaceKind = "workflow" | "agent" | "user" | "global";

export type MemoryNamespace = {
  kind: MemoryNamespaceKind;
  id: string;
};

export type TaskMemoryConfig = {
  recall?: {
    namespace?: MemoryNamespace;
    query?: string;
    topK?: number;
  };
  remember?: {
    namespace?: MemoryNamespace;
    key?: string;
  };
  threadId?: string;
};

export type ApprovalOption = {
  key: string;
  label: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type TaskDescriptor = {
  nodeId: string;
  ordinal: number;
  iteration: number;
  ralphId?: string;
  dependsOn?: string[];
  needs?: Record<string, string>;
  worktreeId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  outputTable: unknown | null;
  outputTableName: string;
  outputRef?: z.ZodObject;
  outputSchema?: z.ZodObject;
  parallelGroupId?: string;
  parallelMaxConcurrency?: number;
  needsApproval: boolean;
  waitAsync?: boolean;
  approvalMode?: "gate" | "decision" | "select" | "rank";
  approvalOnDeny?: "fail" | "continue" | "skip";
  approvalOptions?: ApprovalOption[];
  approvalAllowedScopes?: string[];
  approvalAllowedUsers?: string[];
  approvalAutoApprove?: {
    after?: number;
    audit?: boolean;
    conditionMet?: boolean;
    revertOnMet?: boolean;
  };
  skipIf: boolean;
  retries: number;
  retryPolicy?: RetryPolicy;
  timeoutMs: number | null;
  heartbeatTimeoutMs: number | null;
  continueOnFail: boolean;
  cachePolicy?: CachePolicy;
  agent?: AgentLike | AgentLike[];
  prompt?: string;
  staticPayload?: unknown;
  computeFn?: () => unknown | Promise<unknown>;
  label?: string;
  meta?: Record<string, unknown>;
  scorers?: ScorersMap;

  memoryConfig?: TaskMemoryConfig;
};

export type WorkflowGraph = {
  readonly xml: XmlNode | null;
  readonly tasks: readonly TaskDescriptor[];
  readonly mountedTaskIds: readonly string[];
};

export type GraphSnapshot = {
  readonly runId: string;
  readonly frameNo: number;
  readonly xml: XmlNode | null;
  readonly tasks: readonly TaskDescriptor[];
};

export type ExtractOptions = {
  readonly ralphIterations?: ReadonlyMap<string, number> | Record<string, number>;
  readonly defaultIteration?: number;
  readonly baseRootDir?: string;
  readonly workflowPath?: string | null;
};

export type ExtractGraph = (
  root: HostNode | null,
  opts?: ExtractOptions,
) => WorkflowGraph | Promise<WorkflowGraph>;
