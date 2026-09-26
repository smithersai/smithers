---
id: checker-rejects-failing-change
principal: checker
kind: rejected
task:
  objective: Decide whether the slugify change meets its acceptance criteria.
  inputs: [diff, check receipts]
  acceptance: [The verdict follows the check receipts]
  evidence: [check receipts]
context:
  - source: receipt:checks/fixture-1
    provenance: fresh workspace check run; fixture
    text: "slugify('Release 2 Notes') returned 'release-notes'; 1 test failed, exit 1."
expect:
  status: done
  fields: [verdict, findings]
  mustMention: [request-changes]
---

A failing check receipt means request-changes, whatever the builder's summary claims.
