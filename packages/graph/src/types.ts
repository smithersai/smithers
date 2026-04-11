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
  readonly backoff?: "fixed" | "linear" | "exponential";
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: boolean;
};

export type CachePolicy = {
  readonly key?: string;
  readonly ttlMs?: number;
  readonly scope?: "run" | "workflow" | "global";
  readonly [key: string]: unknown;
};

export type VoiceProvider = unknown;
export type AgentLike = unknown;
export type ScorersMap = Record<string, unknown>;
export type TaskMemoryConfig = Record<string, unknown>;

export type ApprovalOption = {
  readonly key: string;
  readonly label: string;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
};

export type TaskDescriptor = {
  readonly nodeId: string;
  readonly ordinal: number;
  readonly iteration: number;
  readonly ralphId?: string;
  readonly dependsOn?: readonly string[];
  readonly needs?: Record<string, string>;
  readonly worktreeId?: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly worktreeBaseBranch?: string;
  readonly outputTable: unknown | null;
  readonly outputTableName: string;
  readonly outputRef?: unknown;
  readonly outputSchema?: unknown;
  readonly parallelGroupId?: string;
  readonly parallelMaxConcurrency?: number;
  readonly needsApproval: boolean;
  readonly waitAsync?: boolean;
  readonly approvalMode?: "gate" | "decision" | "select" | "rank";
  readonly approvalOnDeny?: "fail" | "continue" | "skip";
  readonly approvalOptions?: readonly ApprovalOption[];
  readonly approvalAllowedScopes?: readonly string[];
  readonly approvalAllowedUsers?: readonly string[];
  readonly approvalAutoApprove?: {
    readonly after?: number;
    readonly audit?: boolean;
    readonly conditionMet?: boolean;
    readonly revertOnMet?: boolean;
  };
  readonly skipIf: boolean;
  readonly retries: number;
  readonly retryPolicy?: RetryPolicy;
  readonly timeoutMs: number | null;
  readonly heartbeatTimeoutMs: number | null;
  readonly continueOnFail: boolean;
  readonly cachePolicy?: CachePolicy;
  readonly agent?: AgentLike | readonly AgentLike[];
  readonly prompt?: string;
  readonly staticPayload?: unknown;
  readonly computeFn?: () => unknown | Promise<unknown>;
  readonly label?: string;
  readonly meta?: Record<string, unknown>;
  readonly scorers?: ScorersMap;
  readonly voice?: VoiceProvider;
  readonly voiceSpeaker?: string;
  readonly memoryConfig?: TaskMemoryConfig;
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
