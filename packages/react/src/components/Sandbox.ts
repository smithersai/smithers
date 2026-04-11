import React from "react";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";

/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type SandboxRuntime = "bubblewrap" | "docker" | "codeplane";

export type SandboxVolumeMount = {
  host: string;
  container: string;
  readonly?: boolean;
};

export type SandboxWorkspaceSpec = {
  name: string;
  snapshotId?: string;
  idleTimeoutSecs?: number;
  persistence?: "ephemeral" | "sticky";
};

export type SandboxProps = {
  id: string;
  /** Child workflow definition. If omitted, createSmithers-bound Sandbox wrappers may provide one. */
  workflow?: (...args: any[]) => any;
  /** Input passed to the child workflow. */
  input?: unknown;
  output: OutputTarget;
  runtime?: SandboxRuntime;
  allowNetwork?: boolean;
  reviewDiffs?: boolean;
  autoAcceptDiffs?: boolean;

  // Docker-compatible runtime config
  image?: string;
  env?: Record<string, string>;
  ports?: Array<{ host: number; container: number }>;
  volumes?: SandboxVolumeMount[];
  memoryLimit?: string;
  cpuLimit?: string;
  command?: string;

  // Codeplane-compatible workspace config
  workspace?: SandboxWorkspaceSpec;

  skipIf?: boolean;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatTimeout?: number;
  retries?: number;
  retryPolicy?: RetryPolicy;
  continueOnFail?: boolean;
  cache?: CachePolicy;
  dependsOn?: string[];
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: React.ReactNode;
};

export function Sandbox(props: SandboxProps) {
  if (props.skipIf) return null;

  return React.createElement("smithers:sandbox", {
    id: props.id,
    key: props.key,
    output: props.output,
    runtime: props.runtime ?? "bubblewrap",
    allowNetwork: props.allowNetwork,
    reviewDiffs: props.reviewDiffs,
    autoAcceptDiffs: props.autoAcceptDiffs,
    image: props.image,
    env: props.env,
    ports: props.ports,
    volumes: props.volumes,
    memoryLimit: props.memoryLimit,
    cpuLimit: props.cpuLimit,
    command: props.command,
    workspace: props.workspace,
    timeoutMs: props.timeoutMs,
    heartbeatTimeoutMs: props.heartbeatTimeoutMs,
    heartbeatTimeout: props.heartbeatTimeout,
    retries: props.retries,
    retryPolicy: props.retryPolicy,
    continueOnFail: props.continueOnFail,
    cache: props.cache,
    dependsOn: props.dependsOn,
    needs: props.needs,
    label: props.label ?? props.id,
    meta: props.meta,
    __smithersSandboxWorkflow: props.workflow,
    __smithersSandboxInput: props.input,
    __smithersSandboxRuntime: props.runtime ?? "bubblewrap",
    __smithersSandboxChildren: props.children,
  });
}
