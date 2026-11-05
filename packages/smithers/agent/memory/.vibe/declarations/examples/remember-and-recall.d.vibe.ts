/** Remembers a release note and answers what recall and the store see. */
export declare const rememberAndRecall: () => Promise<{
    readonly recalled: ReadonlyArray<{
        readonly bank: string;
        readonly key: string;
        readonly text: string;
    }>;
    readonly keys: ReadonlyArray<string>;
}>;
