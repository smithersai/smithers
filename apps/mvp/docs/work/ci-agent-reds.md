---
title: Repair assigned CLI, agent, control, gateway and Electric CI targets
status: in-progress
area: sdk
owner: ci-agent
updated: 2026-10-30
links:
  - https://github.com/smithersai/smithers/actions/runs/40929998769
---

Reproduce the seven assigned target failures with the CI runner on Latitude.
Fix each root cause with regression evidence; retain the existing coverage and
timeout gates. Deliver separate commits by root cause for the CI repair batch.

Libraries: the CLI, agent, model-host, control, gateway, and effect-electric
entries in `docs/libraries.md`, plus flow, harness, journal, run-store and engine-store;
existing services remain their public seams.

The CLI runner preserves the configured normal/fault split. Real discovery
checks the two tiers are disjoint and together retain every file. Eight small
remainder groups and six bounded process-heavy groups share the existing four
workers and one run-owned VibeLang compile cache. Every one of the fourteen
reports is required before the unchanged coverage merge. The real discovery
regression rejects the former oversized fixed groups and retains each default
file exactly once, separate from the fault tier.
Native recovery probes wait for actual admission refusals before asserting a
park, retaining the explicit-consent and exactly-once execution checks.

The agent target declares its PostgreSQL service and keeps its full 100% gate.
Resume offers carry their durable delegation sequence; a per-run admission
permit checks and acknowledges that sequence around the handoff. Current wait
observations retain their grant tokens over unversioned legacy history.

Scaffold compilation uses VibeLang and exposes portable SDK declarations
without Node ambient types. The SDK host-probe typing fixes preserve runtime
behavior and the existing observable host-access contract.

The canonical spelling scan filters ordinary package imports before parsing,
keeps compiler decoding for escaped source, and resolves lines only for
relevant decoded text in an AST without parent links. Discovery includes
VibeLang. Real parser cases retain escaped commands, newline boundaries,
templates, shell arguments and migration warnings. Four concurrent instrumented
probes pass the unchanged deadline; old record behavior and TypeScript-only
discovery each fail the parser regression.

The native human-wait budget fixture uses the public Clock service for
provider time and parked time, retaining real scheduling. Replacement-host
adoption ages the persisted delegation by the public ownership grace. A
negative control charging the parked span still exceeds the unchanged ceiling.
External-worker lease checks retain every scenario execution while excluding
the observer's unrelated health-discovery release.

Metadata cancellation waits for the engine's fenced terminal transition,
retaining the no-import, no-replay and idempotency checks. An observing control
port does not disable the engine's metadata-only cancellation guard.

Native planning timeout injection follows catalog construction rather than
loader invocation count. The catalog deadline can expire during source
verification; its direct retry intentionally has no catalog deadline. Four
loaded coverage probes retain real timeout refusals, schema validation and
planning, including an initial load never reaching its loader.

The approval-gated image push passes with a real Docker registry and buildx.
Electric also passes its full coverage target after provisioning fresh real
Docker Compose services. Neither check relies on a simulated dependency.

Safe adoption diagnostics preserve strict response decoding and record bounded
process and status metadata. The earlier empty-document failure has not recurred
in the instrumented probes or the latest complete source-snapshot group; the
diagnostics remain evidence collection, not a claimed correction of its cause.
