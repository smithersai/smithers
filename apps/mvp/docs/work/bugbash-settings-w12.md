---
title: Settings bug bash W12
status: in-review
area: settings
owner: bb2-settings
updated: 2026-10-26
links: [../../../../docs/libraries.md]
---

Validate Test against the form and require saving changes before testing the saved model. Preserve sealed keys and W11 fallback placeholders. Fix accessible field names, tier purposes, layout, and the read-only Secrets empty state.

Production probes reproduced the saved-model Test behavior with malformed and empty drafts, duplicate credential names,
unexplained tiers, mismatched columns, and the Member Secrets empty state. No forbidden save or destructive action
was used. `/settings` is not a bug: the documented personal settings route is `/app/settings`; no alias is specified.

Decision 0118 preserves the saved-model test contract and keeps draft keys outside durable flows. Library catalog entries:
`@smthrs/flow` for durable execution and `@smthrs/ui` for controls and EmptyState. Credential fields are named by protocol,
because a protocol owns its key while multiple model tiers may share it. Tier purposes read Chat, Code, Plans & reviews.

Latitude passed typecheck, importRules, full lint, and 52 focused tests. Six changed logic files reached 100% statements,
branches, functions and lines; TSX and CSS are outside the configured coverage gate. Five regression assertions failed
against the old implementation; production measured the old credential/model widths at 362/536px. Receipts are
bb2-settings-validation.log, bb2-settings-tests.log and bb2-settings-layout-red.log beside the builder report.

Deployment and browser validation remain with the lander: settings-draft, settings-layout (1280/390/320),
settings-secrets-empty, personal-model, byok-first and mobile specs. Assert invalid drafts show Save's refusal,
valid edits say Save first without a test request, unchanged forms still test, names distinguish protocols,
Default placeholders remain, columns align, and Members see Admins add secrets. No mini run or deployment was attempted.
