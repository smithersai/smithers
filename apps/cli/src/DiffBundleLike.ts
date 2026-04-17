export type DiffBundleLike = {
    patches: Array<{
        path?: string;
        diff?: string;
    }>;
};
