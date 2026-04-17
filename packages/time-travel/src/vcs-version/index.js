// @smithers-type-exports-begin
/** @typedef {import("./VcsTag.ts").VcsTag} VcsTag */
// @smithers-type-exports-end

import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { loadVcsTag as loadVcsTagEffect } from "./loadVcsTagEffect.js";
import { rerunAtRevision as rerunAtRevisionEffect } from "./rerunAtRevisionEffect.js";
import { resolveWorkflowAtRevision as resolveWorkflowAtRevisionEffect } from "./resolveWorkflowAtRevisionEffect.js";
import { tagSnapshotVcs as tagSnapshotVcsEffect } from "./tagSnapshotVcsEffect.js";
export { loadVcsTagEffect, rerunAtRevisionEffect, resolveWorkflowAtRevisionEffect, tagSnapshotVcsEffect, };
/**
 * @param {Parameters<typeof tagSnapshotVcsEffect>} ...args
 */
export function tagSnapshotVcs(...args) {
    return Effect.runPromise(tagSnapshotVcsEffect(...args).pipe(Effect.provide(BunContext.layer)));
}
/**
 * @param {Parameters<typeof loadVcsTagEffect>} ...args
 */
export function loadVcsTag(...args) {
    return Effect.runPromise(loadVcsTagEffect(...args));
}
/**
 * @param {Parameters<typeof resolveWorkflowAtRevisionEffect>} ...args
 */
export function resolveWorkflowAtRevision(...args) {
    return Effect.runPromise(resolveWorkflowAtRevisionEffect(...args).pipe(Effect.provide(BunContext.layer)));
}
/**
 * @param {Parameters<typeof rerunAtRevisionEffect>} ...args
 */
export function rerunAtRevision(...args) {
    return Effect.runPromise(rerunAtRevisionEffect(...args).pipe(Effect.provide(BunContext.layer)));
}
