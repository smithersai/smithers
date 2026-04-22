type InitInstallResult = {
    reason?: string;
    status: "failed" | "ok" | "skipped";
};

export type InitWorkflowPackResult = {
    install: InitInstallResult;
    preservedPaths: string[];
    rootDir: string;
    skippedFiles: string[];
    writtenFiles: string[];
};
