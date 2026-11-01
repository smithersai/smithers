# 0139: Route state belongs to the navigating router

2026-10-31. Fix forward for the offline branch regression introduced by d4e58f4e.

Repository reuse and branch workspace cleanup read the navigating router from route context. `createAppRouter` supplies its own instance, including when constructing from another router's context. Route callbacks never read the exported singleton.

A direct branch visit on a second router previously threw while reading the singleton's uninitialized `stores.__store`, before tracking could start. This accounts for all four offline failures: untouched `none` state, an untouched previous repository's `ready` state, and missing offline chrome. Branch state is tab-local; the same-branch `kept` fast path did not cause these failures and remains in place.

The offline tests construct routers through the same app constructor to supply instance context. Their original expectations remain unchanged. A direct-visit regression asserts route errors explicitly; a navigation regression checks tree/file transitions preserve the workspace and reuse the answered role and home, then release presence when leaving for chat.

Library catalog: existing TanStack Router for route state, and `@smthrs/effect-tanstack-db` for tab-local branch state. No new dependency or flow implementation.
