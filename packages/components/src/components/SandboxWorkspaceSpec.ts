export type SandboxWorkspaceSpec = {
	name: string;
	snapshotId?: string;
	idleTimeoutSecs?: number;
	persistence?: "ephemeral" | "sticky";
};
