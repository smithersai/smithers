---
title: Notification reference accuracy
status: done
area: sdk
owner: codex
updated: 2026-11-12
links: ["https://github.com/smithersai/smithers/issues/4636"]
---

Align the notifications package's inbox concept, journal record concept and API
reference with its existing implementation. Cover launcher access checks,
admission receipts and errors, provenance attribution, journal metadata, delivery
evidence and sanitized provider diagnostics. Preserve the public schemas and
runtime behavior.

Validation uses the existing notification routing, channel delivery and queue
regression suites, package typecheck and lint, and generated documentation checks.

Validation passed: all 376 notification tests with 100% coverage, package
typecheck and lint, `pnpm docs:sync`, `pnpm docs:check` (52 published package
tarballs), generated API and LLM drift checks, and the site build (119 pages,
850 required URLs). The source change is comment-only; the nullable public
receipt schema and executable code match the parent.

The broader site `check:docs` suite has the same four failures on unmodified
`main`: flow quickstart release pins, the build-input typecheck, the published
quickstart's native helper compatibility, and the support matrix package count.
No notification runtime behavior changed, and the docs-only fix uses the
existing behavioral regression coverage.
