---
title: Real-model production agent proof
status: blocked
area: agent
owner: e2e-model (Codex GPT-6 Astra)
updated: 2026-11-04
links: []
---

Run production consumers of personalModel/liveModel and agent evals with the real test account, under the shared production lock. Diagnose failures against deployed source and current main, fix new product failures with regressions, and retain per-spec receipts. Private deployment details and evidence remain in the lane operations status. No deployment from this lane.

The first production batch could sign in and save its supplied model, but its Test failed before any feature case ran. Real agent and flow evals independently received provider quota refusals. These are blocked proofs, not model-quality failures or feature passes. Continuing needs an authorized test credential with usable provider quota.

Setup diagnostics now retain the known refusal reason and numeric HTTP status while withholding provider messages, hosts, unknown codes and other response content. Pure regression checks cover quota, authentication, transport, malformed replies and credential-bearing fields. This uses the existing personal-model copy contract; no new library or model-call path.
