import type React from "react";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
import type { OutputTarget } from "./OutputTarget.ts";
import type { SandboxRuntime } from "./SandboxRuntime.ts";
import type { SandboxVolumeMount } from "./SandboxVolumeMount.ts";
import type { SandboxWorkspaceSpec } from "./SandboxWorkspaceSpec.ts";

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
	image?: string;
	env?: Record<string, string>;
	ports?: Array<{
		host: number;
		container: number;
	}>;
	volumes?: SandboxVolumeMount[];
	memoryLimit?: string;
	cpuLimit?: string;
	command?: string;
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
