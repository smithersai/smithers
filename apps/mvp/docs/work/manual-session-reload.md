---
title: Serialize manual session reloads
status: done
area: auth
owner: claude
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5265
---

Manual reload bypassed the session-check permit, allowing an older response to replace a newer role in the live and saved session. Route the public action through `check("retry")`, preserving its durable refresh trigger and adding the existing retry metrics and logs.

Library catalog: app state through `@smthrs/effect-tanstack-db` and durable refresh through `@smthrs/flow`; reuse the existing Effect semaphore.

Regression coverage holds a real Member response behind an injected `AuthClient` delay, demotes the real server session to Guest, and presses reload. Startup, online and repeated manual reloads must serialize and keep Guest access after reopening the device.
