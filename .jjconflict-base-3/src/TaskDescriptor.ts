import type { AgentLike } from "./AgentLike";
import type { CachePolicy } from "./CachePolicy";
import type { RetryPolicy } from "./RetryPolicy";
import type { ScorersMap } from "./scorers/types";
import type { VoiceProvider } from "./voice/types";
import type { TaskMemoryConfig } from "./memory/types";

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
  outputTable: any | null;
  outputTableName: string;
  /** Zod schema reference from the Task output prop (used for schema resolution). */
  outputRef?: import("zod").ZodObject<any>;
  outputSchema?: import("zod").ZodObject<any>;
  parallelGroupId?: string;
  parallelMaxConcurrency?: number;
  needsApproval: boolean;
  approvalMode?: "gate" | "decision";
  approvalOnDeny?: "fail" | "continue" | "skip";
  skipIf: boolean;
  retries: number;
  retryPolicy?: RetryPolicy;
  timeoutMs: number | null;
  continueOnFail: boolean;
  cachePolicy?: CachePolicy;
  /** Agent or array of agents [primary, fallback1, fallback2, ...]. Tries in order until one succeeds. */
  agent?: AgentLike | AgentLike[];
  prompt?: string;
  staticPayload?: unknown;
  computeFn?: () => unknown | Promise<unknown>;
  label?: string;
  meta?: Record<string, unknown>;
  /** Optional scorers map attached to this task. */
  scorers?: ScorersMap;
  /** Voice provider propagated from a <Voice> ancestor. */
  voice?: VoiceProvider;
  /** Default speaker/voice ID propagated from a <Voice> ancestor. */
  voiceSpeaker?: string;
  /** Optional cross-run memory configuration. */
  memoryConfig?: TaskMemoryConfig;
};
