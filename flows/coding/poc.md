# Disposable file-level prototypes

`Poc` is a private ordinary flow over existing `AgentAction`, native JJ source export and `WorkspaceSandbox`. Its input is `{ plan, source: Revision }`. The caller supplies the captured head explicitly; source collection refuses a changed head or plan base. When the plan carries `observedHead`, the supplied source must match that exact observation. An amended plan's older base is not silently treated as the current full source tree. The request coordinator uses the existing Jj snapshot and admission checks before dependent stages. POC collection itself never refreshes the working copy: unsnapshotted edits cannot silently become the prototype's source.

## Capture, draft and measure

The steps are visible in the existing graph:

1. `CapturePocSource` exports the immutable native commit into host-owned scoped scratch and captures at most 48 predicted UTF-8 file paths. Each file is at most 64 KiB; total source and proposed output each stay within 512 KiB. Absent predicted output files are recorded as absent, and paths escaping the export are refused.
2. `DraftPoc` uses the explicitly configured `coding/poc` seat to propose full file contents or removals. The proposed values persist in normal durable action output before materialization. The shared `evidenceOnly` composition removes tool and module authority from both POC model steps; this is enforced by the host, not just the prompt.
3. `MaterializePoc` reconstructs an isolated transaction from those captured values, applies the proposals and retains the actual before/after contents and content digests. It never calls `WorkspaceSandbox.materialize`; even the memory host remains unchanged. No JJ workspace, Change or commit is created.
4. `ReviewPoc` receives those actual changes and produces hypotheses and second-plan guidance. `RetainPoc` verifies that the original native operation/head still matches the captured source before returning the saved result.

## Retain a source preview

The result is explicitly `drafted-unvalidated`. It retains an escaped HTML **source preview** as a value, not a deleted temporary path, along with full bounded changed-file contents. Long preview panels are excerpts; complete values remain in the result. The review model receives the measured changed files, not redundant escaped HTML or another full copy of the draft and captured source. The ordinary durable output is sufficient storage for this bounded first slice; there is no extra ledger or artifact service. Its `feedback` can feed the existing `PreparePlan` input, while the complete result remains in the recorded `coding/Poc` child execution. The request coordinator does not duplicate that result into each parent output. Feedback text on its own never proves a POC ran.

## Keep validation claims bounded

This first slice does not run a compiler, test suite, browser or shell and does not claim an executable UI preview. Source changes and their digests are measured evidence; conclusions about behavior remain model hypotheses. Executable preview/build integration is later work. The final production implementation always starts independently of these discarded edits.

## Replay and compose with existing services

Keeping drafting separate from deterministic materialization makes cold replay honest. A fresh transaction does not depend on re-running cached model tool writes. The captured source and proposed values reconstruct the same diff, and completed durable actions replay their recorded values after a host restart. Native capture scratch is cleaned on success and failure; no prototype path survives in the result.

Deployment composes `pocSource({ ...nativeOptions, fs, exporterPath })`, `pocPolicy` and `pocModels` into its existing action table and supplies the same native binding, contained spawner, model seats, authority and runtime. `fs` is the existing trusted host filesystem used only for export scratch/read/cleanup. This is private recipe configuration, not a public API or new runtime primitive. The request coordinator owns first/second planning and later production execution; this flow does not register or launch a second lifecycle.

The embedded run card selects the latest retained prototype or a prototype explicitly selected in the trace. It displays complete before/after values as React text and never executes the retained HTML. The prototype decoder requires its result source to match the child's input source. The shared evidence reader supplies the recorded execution context.

While the enclosing coding run is live, “Give prototype feedback” invokes `runs.steer` with its backend run ID. Queue acknowledgement is distinct from a changed plan. Root request messages are consumed by the coordinator at its recorded safe boundaries; the workflow does not automatically pause for UI feedback. Pure recipe value schemas live in private `poc-schema.ts`, with the prior exports retained by `poc.ts`.
