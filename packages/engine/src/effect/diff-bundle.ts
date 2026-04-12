export type FilePatch = {
    path: string;
    operation: "add" | "modify" | "delete";
    diff: string;
    binaryContent?: string;
};
export type DiffBundle = {
    seq: number;
    baseRef: string;
    patches: FilePatch[];
};
export declare function computeDiffBundle(baseRef: string, currentDir: string, seq?: number): Promise<DiffBundle>;
export declare function applyDiffBundle(bundle: DiffBundle, targetDir: string): Promise<void>;
