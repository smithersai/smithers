export declare const SANDBOX_MAX_BUNDLE_BYTES: number;
export declare const SANDBOX_MAX_README_BYTES: number;
export declare const SANDBOX_MAX_PATCH_FILES = 1000;
export declare const SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH = 256;
export declare const SANDBOX_BUNDLE_PATH_MAX_LENGTH = 1024;
export declare const SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH = 16;
export declare const SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH = 512;
export declare const SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH: number;
export type SandboxBundleManifest = {
    outputs: unknown;
    status: "finished" | "failed" | "cancelled";
    runId?: string;
    patches?: string[];
};
export type ValidatedSandboxBundle = {
    manifest: SandboxBundleManifest;
    bundleSizeBytes: number;
    patchFiles: string[];
    logsPath: string | null;
    bundlePath: string;
};
export declare function validateSandboxBundle(bundlePath: string): Promise<ValidatedSandboxBundle>;
export declare function writeSandboxBundle(params: {
    bundlePath: string;
    output: unknown;
    status: "finished" | "failed" | "cancelled";
    runId?: string;
    streamLogPath?: string | null;
    patches?: Array<{
        path: string;
        content: string;
    }>;
    artifacts?: Array<{
        path: string;
        content: string;
    }>;
}): Promise<void>;
