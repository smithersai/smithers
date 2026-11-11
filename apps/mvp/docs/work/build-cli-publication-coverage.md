---
title: Build CLI publication tests and coverage gate
status: in-progress
area: build-cli
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5128
---

[#5128](https://github.com/smithersai/smithers/issues/5128) tracks approved
image publication and missing behavioral coverage.

Granted publication now uses real buildx output, Docker load/tag/push, and an
isolated registry. Each pushed tag's config digest is checked against the
built image. OCI fixtures contain unpackable filesystem layers.

The coverage gate retains all implementation files and raises its aggregate
floors to statements `95.57%`, branches `91.16%`, functions `96.61%`, and lines
`96.84%`. Lower file overrides are removed. Conformance and a real nested
Vitest run guard the floor; meaningful behavioral cases cover ANSI handling,
output limits, workspace discovery, attributes, text utilities, and audience
argument precedence, saved-index clearing, and conditional package exports.

Coverage remains below `100%`; the issue stays open while missing cases are
added and measured floors rise. The loader-transformed CLI entry's subprocess
coverage and the service-supervisor child loader are separate tooling gaps;
the latter is related to [#4967](https://github.com/smithersai/smithers/issues/4967).
