# The engineering wiki recipe

The catalog is the only repository-specific input inventory. Each page has a small purpose, linked neighbors, an owning Markdown document and exact code inputs. Explicit inclusive line ranges can select bounded reviewer excerpts; complete files are still hashed and archived, so a change outside an excerpt invalidates the page. Reviews are capped at 90 KB of serialized prompt evidence per page; full-file capture is capped separately at 300 KB per page, and the flow accepts at most 30 pages. Prefer a focused page to concatenating package manuals. Read [how generation works](pages/wiki-generation.md) and [runtime portability](../../packages/smithers/flows/docs/concepts/runtime-portability.md).

The catalog follows an overview-to-owner structure. Foundational pages explain flow authoring, runtime portability, durable stores and build dependencies. Focused coding pages cover the configured host, approved native control, wiki-backed planning, the two-pass request, retained source prototypes, immutable checks and bounded owner correction. UI pages distinguish predicted Changes, recorded native evidence and collaborative human documents. The mythical product contract and prior-art interaction study are explicitly `intent`, not claims of delivery.

Keep source excerpts aligned with the current implementation when refreshing the catalog. Successful collection proves only that the declared files and ranges exist within the evidence bounds. It does not establish that an excerpt is relevant or that its prose is correct. Freeze one source revision for the actual semantic run, retain its native receipts, and publish only that verified artifact. A later main-branch change needs a new freshness check and, where input identity changes, a new semantic review. The HTML study should consume the exact verified projection rather than an older preview with a newer report timestamp.

Generate an explicitly unreviewed preview through a real durable flow:

```sh
node --experimental-strip-types flows/wiki/main.ts
node --experimental-strip-types flows/wiki/main.ts --check
```

Generation output must be a dedicated directory inside the source workspace. To publish into a separate wiki repository, copy the immutable snapshot and its pointer as a separate publication step, preserving human-owned files. `--check --output /path/to/export` can verify that copy against this source checkout without opening a runtime or writing outside its boundary.

Run the semantic reviewer and require every section to be supported:

```sh
node --experimental-strip-types flows/wiki/main.ts --verified --model openai:gpt-5.6-sol
node --experimental-strip-types flows/wiki/main.ts --check --verified
```

The host uses the CLI's existing model routing. The reviewer has no tools. Reviews fan out through `Node.all`, with bounded input and frames, a 15-minute admission window and journaled token accounting. No token ceiling is invented: the current Budget primitive reserves a whole cold token allowance per call, which would reject parallel cold calls before spending anything. A host with an explicit user token budget must schedule within that policy rather than silently weakening it. Model selection, the output directory, and an existing engine database can be supplied at the executable boundary. The default database is the ordinary `.flows/engine.db`; no separate wiki ledger is created. `bun flows/wiki/main.ts` chooses the Bun composition. `--run` reuses a durable execution identity; use a new identity after changing source or model policy.

Build labels are `//flows/wiki:preview`, `//flows/wiki:freshness`, and `//flows/wiki:verify`. The preview is a deterministic build target, freshness is a fast check with that build as a dependency, and the model-backed verified run is an explicit slow target. Preview/freshness do not claim semantic correctness. Release or cloud publication must additionally require the verified gate for the current input digest.

Outputs live under `.flows/wiki/snapshots/<artifact-digest>/`; `current.json` is atomically replaced only after a complete immutable snapshot exists. It contains the complete cloud-ingestion payload, page bodies, per-page review evidence, full source digests and the directory of captured source files. Different reviewed outputs may have different artifact digests even with identical source inputs. The source revision is `sha256:<input-digest>`, explicitly a content-addressed working-tree snapshot, not an unverified Git/JJ commit claim.

`digestPolicy: "canonical-json-v2"` uses the existing `@smthrs/core/Digest.canonical` RFC 8785 primitive for source and review identities while preserving array order; schema decoding cannot change a content identity merely by reordering fields. Raw source and rendered Markdown retain byte hashes. Every page includes its complete specification so the input identity can be reproduced from the archived source hashes.

A failed semantic review writes its findings in a `needs-changes` preview and fails the verified flow. All page reviews finish before deterministic citation assessment, so a malformed receipt cannot cancel independent reviews. Quoted fragments must match one visible source line exactly after removing only ASCII spaces and tabs at their edges; interior whitespace, text, paths and line numbers remain exact. Multiline quotes trigger the existing AgentAction schema-correction budget and are also rejected by the assessor. Raw model receipts and original source indentation are preserved. The immutable snapshot names this assessment policy, and each review digest includes its identity. A citation/coverage contract failure fails before publication. Source changes while reviewing reject the write. No mode overwrites canonical human-authored pages: keep them outside the output directory, and preserve it when projecting the generated snapshot into a separate wiki repository. Old snapshots are retained; this recipe does not implement garbage collection or CRDT synchronization. A new verified generation normally reviews every page. To retain supported reviews for exact unchanged inputs, pass `--reuse-run <terminal-run-id>` and the existing `--database` containing that run. The incremental flow reads completed assessor receipts through the journal and attempt-store abstractions; it creates no cache table. It requires the same reviewer ID and captured review-policy sources, checks evidence integrity, and matches the complete page specification, input digest, content digest, and canonical section digest before revalidating citations. Changed or uncertain pages receive a new model review. Incremental output records the origin run and reused attempt when applicable. The existing `SMITHERS_OPENAI_AUTH=chatgpt` seat route is recorded as reviewer `openai-chatgpt:<model>` so its receipts cannot be mistaken for the API-key route's approval. These are trusted engine records, not cryptographic attestations from an untrusted client. Retaining that engine history is necessary for cross-run reuse; compacted or unavailable evidence is never guessed.

Cloud publication reuses Plue's existing wiki CRUD with `expected_revision`. Reserve `generated-<id>` slugs, require `verification === "verified"`, and compare the existing body against the publisher's last accepted `bodyDigest`. A manual edit is a conflict even when the revision is current. `contentDigest` identifies the owning explanation before generated metadata; `bodyDigest` identifies the exact published Markdown. These hashes are provenance, not an authorization or signature scheme. A hostile client must not be trusted merely because it submits a hash.

Never add Smithers-Ops, home-directory globbing, credentials, runtime databases or deployment secrets to this catalog. Only explicitly chosen public engineering files belong here. Repository content is data for the reviewer, not instructions. The recipe is an internal reference configuration, not a new npm package or public gateway API.

Native hosts can pass their existing Effect filesystem explicitly to the private
wiki operations and memory recipes. This retains the host-owned service when
durable action execution restores a different filesystem context. The default
standalone recipe still reads `FileSystem` from Effect; neither mode opens a new
platform or bypasses source, citation, canonical-path or publication checks.
This injection is for deterministic host operations. Model tools retain their
separately approved workspace filesystem.

## Primary design evidence, checked September 8, 2026

[DeepWiki's current documentation](https://docs.devin.ai/work-with-devin/deepwiki) supports an explicit page catalog with titles, focused purposes and hierarchy, and generates source-linked repository explanations. This recipe adopts the small explicit catalog so a large monorepo's important layers cannot disappear behind automatic clustering.

[CodeWiki, ACL Findings July 2026](https://aclanthology.org/2026.findings-acl.288/), describes hierarchical decomposition and synthesis to preserve architecture across large repositories. The inference for this recipe is an overview with linked owning-layer pages rather than concatenating manuals. Its benchmark is evidence about that research system, not a Smithers quality score.

[DocSync, submitted May 4, 2026](https://arxiv.org/abs/2605.02163), studies dependency-aware source context with a critic refinement loop. This supports treating semantic review as a separate operation from freshness. Smithers uses its existing AgentAction and exact source inventory for that purpose; it does not adopt a new AST/RAG service or claim the paper's evaluation results.

## Validation evidence and limits

The recipe tests invalidate pages after either code or prose edits, reject changed source after review, require complete exact citations, refuse unsupported reviews, preserve independent human files, detect altered immutable artifacts and forged verification fields, and exercise real AgentAction/QuickJS correction and engine replay. They also verify that citation assessment waits for independent reviews. A scripted model proves protocol and replay mechanics; it does not certify the repository pages. Live provider review receipts belong to each generated snapshot, not to a permanent claim in this README.

## Required coding backpressure integration

Pre-planning wiki refresh is implemented. Automatic semantic review after every coding change or rebase is still a gap. The intended integration is an ordinary registered slow check that captures the exact immutable implemented revision, runs existing ReviewPage and assessment actions in the current native runtime, and returns the existing coding Receipt with owner findings. It must not start another runtime/database or read the moving edit checkout while later stages work. Verified wiki publication remains a separate source-fenced step. See the accountable-wiki page for this explicit current-versus-required boundary.

Concurrent writers may propose the same immutable artifact. If its installation
races, the losing writer accepts the existing version only after checking every
expected file's canonical path and exact bytes. An unrelated rename failure or
an edited artifact still fails; the final pointer remains an atomic replacement.
