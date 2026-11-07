/** Stable nested codes only. Provider and harness messages can contain repository or request text. */
export declare const agentFailureCodes: (error: unknown) => {
    readonly harnessCode: string;
    readonly modelCode: string;
    readonly budgetScope: string;
    readonly causeCode: string;
};
