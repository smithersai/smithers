---
title: Attribute production shape 503 responses
status: done
area: infra
owner: w22-503
updated: 2026-10-29
links: [../infrastructure.md, ../observability.md]
---

Compare deployment windows without production mutations or load. Preserve a content-free request correlation between the shape proxy and private Electric gateway so an upstream 503 can be attributed to a gateway overload or Electric's response. Catalog: @smthrs/effect-electric ShapeProxy and @smthrs/observability structured logs. No push or deploy.

Added generated upstream correlation, validated gateway records, and coverage through the actual private-binding handler with an injected overloaded Effect service. That regression exposed a pre-existing SDK bug: bodyless upstream replies failed while streaming. The proxy now preserves empty replies and body-forbidden HTTP statuses while retaining real stream errors and cancellation. This does not establish the cause of the reported production incident; deployment-specific evidence stays in the private investigation report.

Latitude validation: app typecheck, app/SDK importRules, app/SDK lint and SDK typecheck passed. All 25 focused app tests and all 221 SDK tests passed; changed production files reached 100% statements, branches, functions and lines. Old-code app correlation, SDK correlation and bodyless-response regressions failed before their fixes. Read-only Astra reviews cleared the correlation and subsequent bodyless-response changes. No production browser run, push or deployment was performed.
