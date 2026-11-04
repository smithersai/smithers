---
title: Held cold issue stack fixture and pending-screen coverage
status: in-review
area: app
owner: Codex GPT-6.1 Sol
updated: 2026-11-04
links:
  - ../features/issues.md
  - ../decisions/0152-first-paint-before-boot.md
---

One follow-up above the unchanged held commits yuvynwqp and rmmrrspn restores
the navigation fixtures' current issue actions and validated search. Every
assertion remains; the cold route also must resolve successfully. The timing
check recognizes IssuePendingScreen as a nonloading screen, like the list's.
The issue regression renders the registered IssuePendingScreen with a real,
empty local searched collection (`@smthrs/effect-tanstack-db`, library catalog:
"Keep app state in TanStack DB collections and live queries, through Effect").
RepoPendingScreen is no longer assigned to any route, so this issue regression
test follows its replacement.

All eight focused tests pass. Inserting a skeleton element into
IssuePendingScreen fails the cold-issue test at its no-skeleton assertion;
the component was then restored byte-for-byte. No product fix was needed.

Full validation covers every feature, device, screen and plugin suite plus
SignIn and Runs in cfbox, a failing-name comparison against refreshed main,
and all four app typecheck projects. Receipts and the default Astra review
stay in the private operations directories. The stack remains held for Will:
no landing, push, Mac installs/builds, or new workspaces.
