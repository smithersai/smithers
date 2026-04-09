# Gateway has zero observability

## Problem

The entire 1566-line `src/gateway/index.ts` has zero imports of Metric, log
functions, or withSpan. No console.log either. The gateway is a critical
production component (WebSocket RPC, auth, subscriptions) with absolutely zero
observability.

### Missing metrics

- Connection count gauge (active WebSocket connections)
- Message throughput counter (requests in/out)
- WebSocket error counter
- Auth failure counter (by mode: token/jwt/trusted-proxy)
- RPC latency histogram (per method)
- Run lifecycle counters (started/completed/failed via gateway)
- Heartbeat metric
- Cron trigger fire counter

### Missing logging

- Connection lifecycle (connect, disconnect, auth success/failure)
- RPC method calls (debug level)
- Errors (auth rejected, invalid method, malformed message)
- Run lifecycle (started, completed, failed)
- Cron evaluation (tick, fired, skipped)

### Missing tracing

- `gateway:connect`, `gateway:rpc:<method>`, `gateway:broadcast` spans

## Severity

**HIGH** — Cannot debug, monitor, or alert on gateway issues in production.
