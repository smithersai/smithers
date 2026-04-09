# Gateway does not cancel runs on shutdown

## Problem

`src/gateway/index.ts` `close()` method (lines 517-519) closes WebSocket
connections but does NOT cancel active workflow runs. The abort controllers are
stored in `activeRuns` but the map is not iterated during `close()`.

When the gateway shuts down, workflow runs started via the gateway continue
executing in the background with no way to reach them.

Additionally, `startRun` (lines 635-664) uses `void runWorkflow(...)` which
swallows synchronous exceptions before the promise is returned.

## Fix

1. In `close()`, iterate `activeRuns` and call `abort.abort()` on each
2. Add `.catch()` to `runWorkflow()` that broadcasts `run.completed` with
   status `"failed"` for unexpected rejections

## Severity

**MEDIUM** — orphaned runs on gateway shutdown, silent failures.
