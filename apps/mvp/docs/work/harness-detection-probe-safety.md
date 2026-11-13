---
title: Harness detection probe and account safety
status: done
area: agent
owner: codex
updated: 2026-11-11
links:
  - https://github.com/smithersai/smithers/issues/4537
---

A failed version probe or credential read must leave other harness rows available.
Account emails and labels from credential files must be control-free and bounded.

Use the existing harness-detection library and its injected host boundary.
Regression coverage exercises rejected and throwing probes, credential read failures,
hostile text, empty fields, invalid types, length boundaries, provider lists and
RPC validation. The original code failed 15 harness regressions and both RPC length-bound tests.
After the fix and rebase, all 108 harness tests and 4,102 RPC tests pass, with
100% statements, branches, functions and lines in both package coverage reports.
Both package typechecks, ESLint and formatting checks pass; harness circular-import
checking passes. Account tests include bidi controls, Unicode truncation, empty
fields, invalid types and megabyte inputs. Codex Astra and Fable reviewed the fix;
the final correction review has no remaining findings.
