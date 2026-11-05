import * as Source from "../../../src/Source.ts";
/** Seeds a primer note and a fact, then answers the declared snapshot twice. */
export declare const openingContext: () => Promise<{
    readonly memory: Source.Declared;
    readonly rendered: string;
    readonly frozen: boolean;
}>;
