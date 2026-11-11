---
"@smthrs/merge-queue": minor
---

`CommandCi`: CI as one process per check on the candidate commit, with results streamed as each process exits.
`JjRepository` now builds one commit per tree prefix, so runs that share a prefix share commits and landing one
never strands another; it serializes its ledger operations and records where the queue started on first use.
