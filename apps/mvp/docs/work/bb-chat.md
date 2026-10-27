---
title: Production chat bug bash
status: in-progress
area: chat
owner: bb-chat
updated: 2026-10-26
links: [../features/chat.md, ../features/conversations.md]
---

Reproduce the reported conversation list, draft, answer conflict, command, status, duplicate view, model toast and implicit repository findings. Use the existing @smthrs/ui, @smthrs/flow and Effect TanStack DB catalog entries.

`/new` reproduced on production: an unnamed repository was inherited and a test branch was created. The slash command now requires `repo`, with an optional branch name; the implicit repository helper was removed. The shared UI form hints supply requiredness, so typing and menu acceptance share the same guard. The red-first command regression failed on the old code. Latitude typecheck, import rules, lint and focused command/conversation suites pass; changed actions, pin and registry files have 100% coverage. Deployment verification remains with the lander.
