# ADR-0001: Desktop Daemon Bootstrap Mode

- Status: Accepted
- Date: 2026-03-12

## Context

The ElectroBun desktop distribution must launch the Burns daemon and keep lifecycle behavior consistent with local development and CLI execution.

Two options were considered:

1. Start daemon in-process from the desktop runtime.
2. Launch daemon as a managed subprocess.

## Decision

Use **in-process daemon bootstrap** as the default strategy for desktop and CLI orchestration.

The daemon bootstrap contract is:

- `startDaemon(options?) -> Promise<DaemonRuntimeHandle>`
- `stopDaemon(signal?) -> Promise<void>`
- `DaemonRuntimeHandle.port`
- `DaemonRuntimeHandle.healthUrl`

The in-process daemon runtime is responsible for:

- deterministic startup and readiness signaling
- graceful shutdown for `SIGINT` and `SIGTERM`
- idempotent shutdown behavior

## Rationale

- Reuses one runtime path for dev, desktop, and CLI.
- Avoids cross-process IPC complexity for first release.
- Reduces startup overhead and packaging complexity.

## Consequences

- Desktop and CLI share daemon process memory with orchestrator runtime.
- A future subprocess mode can be added behind the same bootstrap interface if stability data justifies isolation.
