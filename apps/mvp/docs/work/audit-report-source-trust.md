---
title: Preserve community audit provenance on import
status: in-progress
area: audit
owner: codex-dogfood
updated: 2026-11-27
links: []
---

Import the existing Smithers CI community report through the repository MCP. Keep the report in the community list when its publisher can also publish trusted reports.

The library catalog’s `@smthrs/rpc` Uphill decoder accepts the category IDs emitted by Smithers CI. The stored report retains its original fields in the report envelope. The existing audit-report object-store authorization owns preview isolation and gate eligibility.

The public snapshot on Smithers CI PR 2 decodes all six categories with an overall score of 82. The worker and RPC typechecks passed, along with 12 worker tests and eight RPC tests. Production publication and UI readback are pending.
