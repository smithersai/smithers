import type { AgentLike } from "./AgentLike";
import type { CachePolicy } from "./CachePolicy";
import type { RetryPolicy } from "./RetryPolicy";

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
};
