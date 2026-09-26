# Saved disposable source prototypes

`coding/Prototype` is an explicit opt-in flow for a disposable experiment. It prepares a plan, admits its source, runs the `Poc` child against the plan's `observedHead`, then admits the source again. It can neither enter correction nor land, and a real fix does not need a prototype first.

## Fix the source

`Poc` takes `{ plan, source: Revision }`. Source collection refuses a changed head or plan base, and when the plan carries `observedHead` the supplied source must match it. POC collection never refreshes the working copy, so unsnapshotted edits cannot become the prototype's source.

## Capture, draft and measure

`CapturePocSource` exports the immutable native commit into host-owned scratch and captures at most 48 predicted file paths, each at most 64 KiB. Paths escaping the export are refused.

`DraftPoc` uses the `coding/poc` seat to propose full file contents or removals. The shared `evidenceOnly` composition removes tool and module authority from both POC model steps.

`MaterializePoc` applies the proposals in an isolated transaction and retains the actual before/after contents and digests. No JJ workspace, Change or commit is created. `ReviewPoc` turns those changes into findings and guidance for a next plan, and `RetainPoc` checks that the original native head still matches the captured source.

## Keep claims bounded

The result status is always `drafted-unvalidated`. It retains an HTML source preview as a value and the bounded changed-file contents, plus findings and `feedback` text. No compiler, test suite, browser or shell runs, and no executable UI preview is claimed; behavioral conclusions remain model hypotheses. Production implementation starts independently of these discarded edits.

## Replay

Drafting is separate from deterministic materialization, so a cold replay reconstructs the same diff from the captured source and proposed values. Capture scratch is cleaned on success and failure, and no prototype path survives in the result.
