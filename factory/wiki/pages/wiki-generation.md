# How this wiki stays accountable

This wiki is a repository recipe over ordinary Smithers flows. It adds no wiki database, queue, lease service or generic gateway. The catalog is the repository-specific part; source capture, per-page review and snapshot writing use existing Effect and Flow primitives.

## Capture exact public inputs

Each catalog page names its owning Markdown and explicit supporting source files. The collector only reads repository-relative text files, rejects paths outside the source root and refuses common private/runtime paths. Symlink resolution cannot escape that root. Catalog contributors must select only public engineering source. The collector rejects Smithers-Ops paths; the private vault must never become generation input.

Full-file digests and the page specification define each input identity. The snapshot stores complete source files, not just links to a moving branch. Its source revision is a content-addressed working-tree snapshot; it does not claim that the tree matched a Git or JJ commit. Evidence is bounded per file and page. Explicit catalog excerpts reduce reviewer context while preserving original line numbers; edits outside those excerpts still invalidate the whole source identity.

## Review meaning, not hashes

The preview mode produces an explicitly unreviewed artifact. Verified mode invokes a real `AgentAction` reviewer with the page and its exact source evidence. With `--reuse-run`, compatible supported reviews may instead come from a terminal run in the same existing engine database. The lookup uses the journal and attempt store, validates the policy identity and reviewer ID, and requires identical page, source, content, and section identities. Current citation checks still run; a changed page or policy requires a new model review. Each incremental page records its origin run and the reused attempt identity, when applicable. Every section requires a supported result, an explanation and exact source citations. Quoted fragments match one visible source line exactly after trimming ASCII spaces and tabs only at their edges. Interior whitespace, text, paths and line numbers must still match. Raw model receipts and original source indentation remain available; the immutable artifact and review digests identify this assessment policy. Multiline output uses the agent's existing bounded schema-correction path and cannot pass the assessor. The full generation flow collects independent page reviews before deterministic steps check section coverage and citation integrity. A structurally decoded review that fails exact assessment receives one additional call to the same reviewer, carrying the prior review, a bounded list of detected invalid citations and unchanged captured evidence. The replacement must pass the same validator; a second failure is terminal. This does not automatically move citation lines or retry valid unsupported claims. Incremental generation validates each page before recording its bound provenance.

The writer checks the source again after review. Changed inputs invalidate the attempt. Unsupported or uncertain sections leave a reviewable artifact and fail the verified flow. A passing model review is recorded evidence, not a formal proof, a passing test suite or a deployment receipt.

## Preserve intent and atomic publication

Generated pages use this recipe's `generated-` slug convention. Their front matter records source, content and review digests. Configure a dedicated output directory separate from canonical human-authored pages. The catalog can include an intent page whose generated copy and source evidence become part of the snapshot. The local writer installs an immutable snapshot directory before atomically updating one current pointer; it does not rewrite the canonical human pages.

The local generation flow does not implement cloud publication or CRDT synchronization. Its output defines an integration policy for a future publisher: accept only a verified snapshot, compare the existing page to its last accepted generated body digest, and use the destination's revision precondition. A manually changed generated page must be treated as a conflict to resolve, not permission to overwrite human edits. This policy does not assert that a cloud publisher already enforces it.

## Keep coding edits under semantic backpressure

The configured request refreshes verified wiki evidence before planning. An operator can also register `checks/wiki` as a required slow check; this repository's default coding configuration includes it. Plan finalization appends every omitted operator-required check to each Change, retaining the configured check objects.

`coding/WikiCheck` uses the same immutable-source helper as command checks. It captures the configured pages from the exact exported implementation revision before the scoped export closes. Existing selection, semantic review and citation assessment run in the same native flow runtime over those recorded values. Supported unchanged pages can reuse compatible native review evidence. Valid unsupported or uncertain prose becomes an ordinary failed Receipt with its owning Change, exact source commit and Markdown path. Malformed citations get the same bounded reviewer correction against the captured immutable evidence. If the replacement still fails exact assessment, the check refuses; this is not a claim that the source is wrong.

The slow check never publishes a current pointer. Verified publication remains a separate source-fenced refresh: an intermediate passing receipt cannot make an older wiki snapshot current. This closes the source-validation part of continuous backpressure when the check is configured; final publication must still run against the final source.
