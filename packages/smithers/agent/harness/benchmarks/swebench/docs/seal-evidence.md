# Seal evidence

`breach-scan.mjs` chooses the agent evidence contract from `--journals`:

- With `--journals`, scan the instance's `engine.db` under that root, including
  suffixed instance directories such as `<id>-r98`. The database must contain
  non-empty journal text. Driver logs are diagnostic paths, excluded from the
  agent scan. A missing root never falls back to the driver log.
- Without `--journals`, scan non-empty `<id>.run.log` or `<id>.codex.log`
  transcripts under `--logs`. A `<id>.last.txt` final message is diagnostic.

`compare-codex-lanes.mjs` uses the same transcript evidence reader. Empty and
whitespace-only files leave `missing-agent-evidence` and do not count toward
`transcriptsRead`.

Each instance reports `traceStatus`: `traced`, `missing-agent-evidence` when
artifacts survive without agent evidence, or `no-evidence` when no artifacts
exist. Only `traced` sets `traced: true`. `traceDiagnostics` lists diagnostic
paths. Both missing states belong to `untraced`; `missingAgentEvidence` lists
the instances with surviving artifacts separately.

A lane claiming `none`, or scanned with `--require none`, fails for either
missing state and exits 1. The report identifies missing agent evidence
separately from absent artifacts and cannot print a sealed verdict. Lanes with
no seal assertion retain their descriptive verdict and report the evidence gap.
