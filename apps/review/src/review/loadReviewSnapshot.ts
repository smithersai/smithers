import { normalizeOpenCodeReviewInput } from "../workflow/normalizeOpenCodeReviewInput.ts";
import { resolveReviewTarget } from "./resolveReviewTarget.ts";
import { runGit } from "../git/runGit.ts";
import { reviewMode } from "./reviewMode.ts";
import { buildFileFilter } from "./buildFileFilter.ts";
import { loadDiffs } from "../git/loadDiffs.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { ReviewSnapshot } from "./reviewSnapshot.ts";

// A branch name read twice can name two commits. Pinning the endpoints once
// keeps merge-base, the diff itself and any later read on the same revisions.
async function pinRevisions(repoDir: string, input: OpenCodeReviewInput): Promise<OpenCodeReviewInput> {
  // `--verify` keeps rev-parse strict: without it, an option it does not
  // recognize is echoed into the output instead of rejected.
  const pin = async (rev: string) =>
    (await runGit(repoDir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], 30_000)).trim();
  const mode = reviewMode(input);
  if (mode === "commit") return { ...input, commit: await pin(input.commit.trim()) };
  if (mode === "range") return { ...input, from: await pin(input.from.trim()), to: await pin(input.to.trim()) };
  return input;
}

/**
 * Resolves the target, pins its revisions, and reads every diff once.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function loadReviewSnapshot(input: OpenCodeReviewInput): Promise<ReviewSnapshot> {
  const normalized = normalizeOpenCodeReviewInput(input);
  const target = await resolveReviewTarget(normalized);
  const pinned = await pinRevisions(target.repoDir, normalized);
  return {
    input: pinned,
    target,
    filter: buildFileFilter(target.repoDir, pinned.rule.trim()),
    diffs: await loadDiffs(target.repoDir, pinned),
  };
}
