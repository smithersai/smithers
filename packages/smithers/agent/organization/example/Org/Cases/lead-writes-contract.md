---
id: lead-writes-contract
principal: lead
kind: accepted
task:
  objective: Turn the routed slugify request into a task contract for the builder.
  inputs: [routed request, repository checks]
  acceptance: [The contract names the builder and one test-backed acceptance criterion]
  evidence: [the configured check command]
context: []
expect:
  status: done
  fields: [acceptance, owner]
---

The lead writes checkable acceptance criteria and names one accountable builder.
