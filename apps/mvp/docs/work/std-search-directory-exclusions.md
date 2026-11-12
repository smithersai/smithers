---
title: Search directory exclusions and hard-linked files
status: done
area: std
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/4890
---

Directory exclusions match ancestor directories using the shared search
contract. A trailing `/` restricts an exclusion to directories. The tar reader
retains hard-linked names using the captured bytes of their targets.

Regression coverage exercises native and portable search, ordered globs,
directory anchors, tar link-name encodings and remote search through real tar
archives. All 91 package test files passed: 1,685 tests passed and 33
platform-specific cases were skipped, with 100% statements, branches, functions
and lines covered. Package typecheck, lint, formatting, docs generation and
checks for all 52 published package tarballs passed.
