/** Writes and recalls inside the policy, then tries a bank outside it. */
export declare const scopeAFlowTree: () => Promise<{
    readonly recalledKeys: ReadonlyArray<string>;
    readonly provenance: unknown;
    readonly foreignBank: string;
}>;
