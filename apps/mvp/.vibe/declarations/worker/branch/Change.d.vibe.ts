import { Effect, Schema } from "effect";
import { Machines } from "./Machines.vibe";
import type { SandboxBranch } from "./Sandboxes.vibe";
/** The change: each changed file base64, as `createCommitOnBranch` takes it, and each deleted path. */
export declare const Change: Schema.Struct<{
    readonly additions: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly contents: Schema.String;
    }>>;
    readonly deletions: Schema.$Array<Schema.String>;
}>;
export type Change = typeof Change.Type;
declare const ChangeRefused_base: Schema.Class<ChangeRefused, Schema.TaggedStruct<"@smthrs/mvp/branch/ChangeRefused", {
    readonly reason: Schema.Literals<readonly ["empty", "too_large", "refused"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * Why a change can't be committed: nothing differs from the base (`empty`), more files or bytes than allowed or a file
 * the tools would only read in part (`too_large`), or the machine refused the call or couldn't check the branch out
 * (`refused`). Not retried.
 */
export declare class ChangeRefused extends ChangeRefused_base {
}
declare const ChangeUnavailable_base: Schema.Class<ChangeUnavailable, Schema.TaggedStruct<"@smthrs/mvp/branch/ChangeUnavailable", {}>, import("effect/Cause").YieldableError>;
/** The machine couldn't answer, or lost the call: a step tries again. */
export declare class ChangeUnavailable extends ChangeUnavailable_base {
}
/** Text as base64 of its UTF-8 bytes, as `createCommitOnBranch` takes a file's contents. */
export declare const base64Of: (text: string) => string;
/** What `collect` reads with: the machine, as whom, the base, the limits, and each tool call's stable id. */
export interface Collecting {
    readonly branch: SandboxBranch;
    /** The person whose own user runs the tools. */
    readonly ownerId: string;
    /** The commit the change is measured from. */
    readonly base: string;
    readonly maxFiles: number;
    readonly maxBytes: number;
    /** The id of the step's call `name` (`status`, `read:<path>`): the same every time the step runs. */
    readonly callId: (name: string) => Effect.Effect<string>;
}
/** Reads the change from the machine as `collecting` says. */
export declare const collect: (collecting: Collecting) => Effect.Effect<{
    additions: {
        readonly path: string;
        readonly contents: string;
    }[];
    deletions: string[];
}, ChangeRefused | ChangeUnavailable, Machines>;
export {};
