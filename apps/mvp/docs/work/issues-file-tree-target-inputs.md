---
title: Package-owned inputs for issues file-tree tests
status: done
area: build
owner: codex-target-index-repair
updated: 2026-11-03
links: [../../../../.smithers/flows/PACKAGE.ts, ../../PACKAGE.ts]
---

Library catalog: declare build, test and lint targets (`@smthrs/targets`).
The app exports `issueFileTreeSources`; the flow suite depends on that label.
Its glob and three explicit files preserve transitive input invalidation.

The requested tracked-only cfbox index command failed before the repair on
`declared_input_crosses_package` and passed generation and lint afterward.
The generated projection confirms all four input declarations, ten tracked
members and the suite's dependency edge. The land tool stores fresh review
receipts for change `lptwtrlx`; this work is not landed or pushed.
