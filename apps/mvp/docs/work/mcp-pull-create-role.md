---
title: Apply repository write roles to MCP pull requests
status: done
area: mcp
owner: codex-artifact-repair
updated: 2026-11-27
links: []
---

Use the MCP authorization service to check the live repository role. Keep pull request creation on the existing GitHub integration.

A repository-scoped HTTP test covers Member, Maintainer, Admin, Guest, missing membership, downgrade, revoked token, read-only scope and a grant for another repository. It checks agent attribution on the local GitHub receipt. Branch names containing the letter s and fork-qualified heads pass validation. Internal spaces are rejected.
