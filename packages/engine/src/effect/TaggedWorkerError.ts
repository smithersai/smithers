export type TaggedWorkerError =
	| {
			_tag: "TaskAborted";
			message: string;
			details?: Record<string, unknown>;
			name?: string;
	  }
	| {
			_tag: "TaskTimeout";
			message: string;
			nodeId: string;
			attempt: number;
			timeoutMs: number;
	  }
	| {
			_tag: "TaskHeartbeatTimeout";
			message: string;
			nodeId: string;
			iteration: number;
			attempt: number;
			timeoutMs: number;
			staleForMs: number;
			lastHeartbeatAtMs: number;
	  }
	| { _tag: "RunNotFound"; message: string; runId: string }
	| {
			_tag: "InvalidInput";
			message: string;
			details?: Record<string, unknown>;
	  }
	| {
			_tag: "DbWriteFailed";
			message: string;
			details?: Record<string, unknown>;
	  }
	| {
			_tag: "AgentCliError";
			message: string;
			details?: Record<string, unknown>;
	  }
	| {
			_tag: "WorkflowFailed";
			message: string;
			details?: Record<string, unknown>;
			status?: number;
	  };
