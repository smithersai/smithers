import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { loadVcsTag as loadVcsTagEffect } from "./loadVcsTagEffect";
import { rerunAtRevision as rerunAtRevisionEffect } from "./rerunAtRevisionEffect";
import { resolveWorkflowAtRevision as resolveWorkflowAtRevisionEffect } from "./resolveWorkflowAtRevisionEffect";
import { tagSnapshotVcs as tagSnapshotVcsEffect } from "./tagSnapshotVcsEffect";

export type { VcsTag } from "./VcsTag";
export {
  loadVcsTagEffect,
  rerunAtRevisionEffect,
  resolveWorkflowAtRevisionEffect,
  tagSnapshotVcsEffect,
};

export function tagSnapshotVcs(
  ...args: Parameters<typeof tagSnapshotVcsEffect>
) {
  return Effect.runPromise(tagSnapshotVcsEffect(...args).pipe(Effect.provide(BunContext.layer)));
}

export function loadVcsTag(
  ...args: Parameters<typeof loadVcsTagEffect>
) {
  return Effect.runPromise(loadVcsTagEffect(...args));
}

export function resolveWorkflowAtRevision(
  ...args: Parameters<typeof resolveWorkflowAtRevisionEffect>
) {
  return Effect.runPromise(resolveWorkflowAtRevisionEffect(...args).pipe(Effect.provide(BunContext.layer)));
}

export function rerunAtRevision(
  ...args: Parameters<typeof rerunAtRevisionEffect>
) {
  return Effect.runPromise(rerunAtRevisionEffect(...args).pipe(Effect.provide(BunContext.layer)));
}
