export type SandboxBundleManifest = {
    outputs: unknown;
    status: "finished" | "failed" | "cancelled";
    runId?: string;
    patches?: string[];
};
