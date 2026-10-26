---
title: Private Worker connection for Electric sync
status: done
area: infra
owner: deploy owner; private binding queued by lead
updated: 2026-10-26
links: [land-and-deploy-mvp.md, infrastructure-as-code.md, local-dev-sync-connections.md]
---

**What:** Replace the public workers.dev hop between app and Electric Workers with a private service binding injected through the SDK host boundary.

**Why:** The first live deployment could not sync because Cloudflare blocked the Worker-to-Worker public-address fetch.

**Current state:** At 18:37 the lead reports a one-line workaround landed as 7b96f878 and redeploy/sync verification running. The cleaner direct connection is queued, with no implementation receipt.

**Next step:** Landed 2026-10-26: ChatApi binds the gateway as `ELECTRIC_GATEWAY` (infra/Electric.ts) and calls it through `ShapeProxy.Upstream` (infra/ElectricUpstream.ts); the gateway's `workers.dev` URL and `ElectricSecret` are gone. Production sync, recovery and the 8-browser health check run after the next deploy.

**Open questions for Will:** None.

Evidence: user-typed text and lead replies extracted by script from session 6253ecf2 for 23:45–01:44 UTC (16:45–18:44 PDT); queue answers through 18:30 PDT; current rulings, decisions, proposals, TODOs, rules and shared feature/host/panel briefs and designs. Latest words and queue answers supersede older plans. Product receipts are reported by the lead; this tracker verifies only the maintainer-site build.
