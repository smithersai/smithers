/**
 * Inert, late-bound build stamp references.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
export { token } from "../../../src/Stamp.vibe.platform.js";
/** */
export declare const Value: Schema.TaggedStruct<"Stamp", {
    readonly name: Schema.Literals<readonly ["version", "commit", "commitDate", "buildTime", "versionMeta"]>;
}>;
/** */
export type Value = typeof Value.Type;
/** */
export declare const version: {
    readonly _tag: "Stamp";
    readonly name: "buildTime" | "commit" | "commitDate" | "version" | "versionMeta";
};
/** */
export declare const commit: {
    readonly _tag: "Stamp";
    readonly name: "buildTime" | "commit" | "commitDate" | "version" | "versionMeta";
};
/** */
export declare const commitDate: {
    readonly _tag: "Stamp";
    readonly name: "buildTime" | "commit" | "commitDate" | "version" | "versionMeta";
};
/** */
export declare const buildTime: {
    readonly _tag: "Stamp";
    readonly name: "buildTime" | "commit" | "commitDate" | "version" | "versionMeta";
};
/** */
export declare const versionMeta: {
    readonly _tag: "Stamp";
    readonly name: "buildTime" | "commit" | "commitDate" | "version" | "versionMeta";
};
