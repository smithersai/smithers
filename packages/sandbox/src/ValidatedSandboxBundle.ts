import type { SandboxBundleManifest } from "./SandboxBundleManifest.ts";

export type ValidatedSandboxBundle = {
    manifest: SandboxBundleManifest;
    bundleSizeBytes: number;
    patchFiles: string[];
    logsPath: string | null;
    bundlePath: string;
};
