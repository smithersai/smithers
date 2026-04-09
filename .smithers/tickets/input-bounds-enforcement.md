# Add input bounds enforcement and tests

## Problem

Many public APIs accept unbounded inputs with no validation.

### Missing bounds (no enforcement, no test)
- Workflow input max size
- JSON payload max depth
- Max concurrent runs
- Max event queue depth
- Max loop iterations at engine level
- Agent prompt/output max size (maxOutputBytes exists, untested)
- Continue-as-new state size limit
- Database row/column sizes
- Max number of frames per run
- Max snapshot size
- `maxIterations` accepts Infinity (unbounded DB growth) and negative (silent skip)
- `heartbeatTimeoutMs` of 1ms causes instant timeout → infinite retry loop

### Existing bounds (have enforcement, need tests)
- Server max body bytes (1MB) — tested
- Sandbox max README bytes (5MB) — tested
- Sandbox max patch files (1000) — tested
- Timer ID max length (256) — tested
- Heartbeat payload max size — tested
- Tool max output bytes (200KB) — NOT tested

## Proposed solution

For each unbounded input:
1. Add a reasonable max constant to the source
2. Validate at the API boundary and throw `SmithersError` with clear message
3. Add a test verifying the bound is enforced

## Severity

**HIGH** — Unbounded inputs are DoS vectors and can cause OOM/hang.
