---
title: Package bug bash round 3 flows
status: blocked
area: sdk
owner: codex-bb3-flows
updated: 2026-10-27
links: []
---
Fix confirmed secret echo, TODO argument, capability policy and control documentation findings.
Library catalog entries: @smthrs/secrets, @smthrs/rpc, @smthrs/capability, @smthrs/control and @smthrs/gateway.

All five confirmed findings are fixed, each with a regression demonstrated against the old behavior.
Latitude: changed packages pass typecheck, lint and import rules. Secrets passes 111 tests at 100% coverage;
RPC passes 4,356 tests (its config has no coverage threshold). Control's SQLite/Postgres matrix passes
2,452 tests with two skips and 100% merged coverage. Capability passes 377 tests at 100% coverage when
the repository corpus scan is excluded; the full suite still has four corpus failures, reproduced with
the original matcher: two `net:put` literals, a whitespace-prefixed spawn resource and an empty spawn resource.
The docs site generation ran, but docs:sync and docs:check were stopped after their flow launchers produced
no completion receipts (over six minutes and two minutes respectively). Those gates remain unproven;
the lander must rerun them and regenerate projections. The Mac mini was unavailable, as stated in the brief.
No push, deployment or GitHub write was performed. Delivery bookmark: builder/bb3-flows.
