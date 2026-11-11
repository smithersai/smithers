---
"@smthrs/control": minor
---

`ApprovalAuthority.make` refuses a delegation to an `agent` identity with `InvalidInput`: people approve and deny, agents
never do. A host whose configuration delegated approve or deny to a `kind: "agent"` principal now fails to build its
approval policy; delegate a person instead.
