# Gateway input bounds and DoS protection

## Problem

Several unbounded inputs in the gateway.

### 1. No WebSocket message size limit (`gateway/index.ts:712`)

`JSON.parse(String(raw))` without size check. A malicious client can send a
multi-GB payload, exhausting heap and crashing the process.

**Fix:** Configure `maxPayload` on `WebSocketServer` (e.g., 1 MB).

### 2. No connection limit (`gateway/index.ts:442-535`)

`this.connections` is an unbounded Set. Connection flood exhausts memory and
timer handles.

**Fix:** Add `maxConnections` option (default 1000), reject new upgrades at limit.

### 3. No input depth/size limit on RPC params (`gateway/index.ts:1233`)

`params.input` passed directly to `startRun` with no depth or size check.
Deeply nested JSON can cause stack overflow during serialization.

**Fix:** Enforce max input size (1 MB) and max nesting depth (32 levels).

## Severity

**HIGH** — denial of service vectors.
