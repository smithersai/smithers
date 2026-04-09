# Voice subsystem crash and resource leak fixes

## Problem

Multiple issues in `src/voice/realtime.ts`:

### 1. No `ws.on("error")` handler (lines 367-372)

WebSocket `error` events crash the process. The connect promise hangs forever
if neither `open` nor `session.created` fires.

### 2. `speak()` and `listen()` hang forever (lines 234-254, 276-308)

Both create promises that resolve on specific events. If WebSocket disconnects
or server never responds, these promises hang with no timeout.

### 3. `speakerStreams` map leaks (lines 117, 196-198)

Entries added on `response.created` but only removed on `response.done`. If
`response.done` is missed (disconnect), PassThrough streams leak forever.

### 4. Unguarded `JSON.parse` on WS message (line 122)

No try/catch. Malformed message from server crashes the process.

### 5. Zero observability

No metrics, logs, or traces in any voice file.

## Fix

1. Add `ws.on("error", ...)` that rejects connect promise and emits error event
2. Add timeout races to `speak()`/`listen()`, clean up listeners on timeout
3. Clear `speakerStreams` map on WebSocket close/error
4. Wrap `JSON.parse` in try/catch
5. Add connection, latency, and error metrics

## Severity

**HIGH** — process crash on network error, hangs, memory leaks.
