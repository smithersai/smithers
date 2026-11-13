---
title: Import rule regression coverage
status: done
area: tooling
owner: codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5102, ../../../../packages/repo-targets/README.md]
---

Enforce the existing `effect.boundary-only` rule for runner references and aliases, retain the allowed `runPromiseWith` bridge, and cover import escape forms in TypeScript and VibeLang. Include the shared test bootstrap and tooling declarations in the package typecheck.

Library catalog entry: `@smthrs/repo-targets`. This changes repository checks, without adding a product action.

Validation: 432 runner witnesses and the omitted typecheck roots fail on the unchanged baseline. The 183 focused tests, package typecheck and source lint pass, and measured coverage is 100% for statements, branches, functions and lines. The existing CI shard inventory mismatch also reproduces on the baseline.

Codex Astra passed the revised change. The Fable review then probed bound, called, tagged, constructed and comma-wrapped runner forms and ran the tightened rule over the 15 SDK packages: every form is reported and no package gains a violation. It limited reference analysis to checks whose rules request it.
