---
title: "Engine journal record names"
description: "The shared persisted event types and child-spawn kind used by engine writers and time-travel readers."
---

[src/EventTypes.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/EventTypes.ts)

Import `{ EventTypes }` from `@smthrs/engine-store/EventTypes` or the package
entry point. The object supplies the persisted record names shared by engine
writers and time-travel readers: `runDecision`, `attemptStarted`,
`snapshotIdentified`, `planRecorded`, `subgraphAppended`, `deferredCompleted`,
and `clockScheduled`. `childSpawnKind` identifies the effect inside a child-spawn
boundary. It is an effect kind, not a journal event type. Changing these values
requires migrating stored history.
