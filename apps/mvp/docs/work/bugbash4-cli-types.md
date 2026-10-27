---
title: Strict declarations in published CLI dependencies
status: needs-decision
area: sdk
owner: bb4-docs
updated: 2026-10-27
links: []
---

NEEDS-DECISION: se4-npm-4 remains broken for npm consumers with strict declaration checking.

A single root import of Command from @smthrs/cli@1.0.0-rc.16 reaches
incur@0.5.1's out-of-scope _args and _options in toRootDefinition and scalar's
OpenAPI responses index signature. All newer incur releases through 0.7.1
(published October 14) retain the same declaration error. There is no fixing
upgrade to select. Scalar 0.9.8 repairs its index signature but cannot repair
incur. A repository pnpm patch would pass workspace checks while leaving npm
consumers broken, so it is not a release fix.

Options:

- Wait for a corrected incur release, then pin it and verify the strict installed consumer.
- Authorize a published fork or a declaration-bundling change that removes the broken third-party internals from the shipped public declaration graph; validate packed npm and pnpm consumers.

The real installed-consumer test is committed with a broken marker. No
skipLibCheck workaround, ineffective dependency upgrade or GitHub write was made.
