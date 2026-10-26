---
title: Repository view stays once after Full screen and Back to chat
status: in-progress
area: chat
owner: chat-dup-view
updated: 2026-10-26
links: [../features/views.md, ../decisions/0111-embed-full-screen-revision.md]
---

The production recording ends at “the repository shows small in the chat, with its README”, before Full screen. Its baseline counted a conversation whose views had not finished syncing. An older view plus this command's new view then made two, not one; this did not establish a duplicate caused by navigation.

The e2e identifies this command's view by its successful POST /api/views receipt, checks that exact id once before and after navigation, and checks that only one distinct repository-view id was written. It also runs from a branch locally, matching deployment coverage. No production behavior changes.

The component regression holds Electric with an injected Effect ShapeSource, seeds an existing view through ChatApi, reads the cold zero baseline, submits /repo, and releases sync. The old count assertion fails deterministically (expected 1, got 2); both real rows keep their ids through Full screen and Back to chat, in home and branch conversations. No mocks or request interception.

Catalog: @smthrs/ui, @smthrs/repo-view, @smthrs/effect-tanstack-db and @smthrs/effect-electric. Latitude typecheck/importRules pass; focused navigation and minimization tests pass at 100% coverage on minimize.ts. Final mini validation pending.
