# Agent files have zero direct observability

## Problem

8 of 9 agent implementations have zero metrics, logging, or tracing:
- `AnthropicAgent.ts`
- `OpenAIAgent.ts`
- `CodexAgent.ts`
- `GeminiAgent.ts`
- `AmpAgent.ts`
- `ForgeAgent.ts`
- `KimiAgent.ts`
- `PiAgent.ts`

Only `BaseCliAgent.ts` has minimal instrumentation (1 metric, 1 span, 3 logs).

### Missing
- Per-agent call latency histogram (agent call duration separate from framework)
- Per-agent error counter
- Connection/session lifecycle logging
- Cost metric (dollar cost per call — requires price-per-token)
- Agent session create/resume/failure metrics

### Also missing elsewhere
- `runDuration` not tracked on failure/cancellation paths in engine
- HTTP server has no error rate metric (4xx/5xx counter)
- HTTP server has no per-endpoint tagging

## Severity

**HIGH** — If an SDK agent fails silently, there is no observability trail
except the eventual NodeFailed event. Cannot profile which agent is slow.
