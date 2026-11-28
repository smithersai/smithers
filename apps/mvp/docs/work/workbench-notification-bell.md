---
title: Show one notification bell on Workbench
status: in-progress
area: notifications
owner: codex-dogfood
updated: 2026-11-27
links: [../features/notifications.md]
---

The signed-in Voltaire Workbench rendered a notification bell in the repository header and another in the top-right corner. Both opened the same panel. Workbench renders the existing repository header, while the root classified the route as needing a floating bell and a second toast stack. The library catalog assigns the existing bell to `@smthrs/ui`.

The recovery browser regression removes the built Workbench module and exercises the controls on the resulting error page. Its recovery screen supplies the same floating controls as the root when the missing header normally owns them.

A fresh production visitor also saw two notification buttons on a run URL for an unavailable repository. Both the readable run and its access screen now place the controls in their own header. The Work Queue keeps its floating controls.
