import { Effect } from "effect";
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
  return Effect.runPromise(tagSnapshotVcsEffect(...args));
}

export function loadVcsTag(
  ...args: Parameters<typeof loadVcsTagEffect>
) {
  return Effect.runPromise(loadVcsTagEffect(...args));
}

export function resolveWorkflowAtRevision(
  ...args: Parameters<typeof resolveWorkflowAtRevisionEffect>
) {
  return Effect.runPromise(resolveWorkflowAtRevisionEffect(...args));
}

export function rerunAtRevision(
  ...args: Parameters<typeof rerunAtRevisionEffect>
) {
  return Effect.runPromise(rerunAtRevisionEffect(...args));
}
