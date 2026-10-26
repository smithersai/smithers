---
title: Publish as the person
status: in-review
area: github
owner: codex-publish-as-person
updated: 2026-10-26
links: [../features/branch-publish.md]
---

Cause: the old credential guard admitted only immediate Publish/Update children. `OperationStart.to(OperationProgram)` records the preceding round as parent. Program consequently minted a flow credential, and ChatApi stored the person's write as `via: agent` with no session. Latitude reproduces this on the app's real Publish dispatch, repository-selected flow and write handler, as well as the durable-engine lineage tests. Instrumented old-policy records show Publish=person, Start=person, Program=app.

Fix: preserve an already-proven session throughout the compiled operation chain; never promote a bearer parent. Recover a resumed root's persisted person dispatch door when its tab is gone. Log `branch.write.identity` with run, parent, flow, principal kind and identity; the telemetry relay preserves those fields. Server attempts still count actual person/App writes, with no token or login. Existing GitHub user-token validation, missing/expired/refused token refusal and durable refresh remain in force. Catalog: @smthrs/flow durable workflows and @smthrs/integrations GitHub writes.

Regressions: direct implementation child, repeated real `Flow.to` continuations, `retryFrom`, durable timer park/resume without an answering tab, and bearer/unrelated-parent refusal to inherit a session. The app's real Publish path additionally checks `via: person` and the person's session id. Old code fails the continuation, missing-tab and real Publish path assertions. The relay test proves the lineage fields survive export. Existing Publish tests prove token identity validation and missing/expired/refused credentials make no App write.

Validation receipts are in the builder report. No production requests, push or deployment. Production E2E and final Astra/Fable review remain with the lander.
