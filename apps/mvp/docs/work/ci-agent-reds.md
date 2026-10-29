---
title: Repair assigned CLI, agent, control, gateway and Electric CI targets
status: in-progress
area: sdk
owner: ci-agent
updated: 2026-10-29
links:
  - https://github.com/smithersai/smithers/actions/runs/40929998769
---

Reproduce the seven assigned target failures with the CI runner on Latitude.
Fix each root cause with regression evidence; retain the existing coverage and
timeout gates. Deliver separate commits by root cause for the CI repair batch.

Libraries: the CLI, agent, model-host, control, gateway, and effect-electric
entries in `docs/libraries.md`, plus flow, harness, run-store and engine-store;
existing services remain their public seams.

The CLI runner preserves the configured normal/fault split. Real discovery
checks the two tiers are disjoint and together retain every file. Eight small
remainder groups share the existing four workers and one run-owned VibeLang
compile cache; every report is required before the unchanged coverage merge.
Native recovery probes wait for actual admission refusals before asserting a
park, retaining the explicit-consent and exactly-once execution checks.

The agent target declares its PostgreSQL service and keeps its full 100% gate.
Resume offers carry their durable delegation sequence; a per-run admission
permit checks and acknowledges that sequence around the handoff. Current wait
observations retain their grant tokens over unversioned legacy history.

Scaffold compilation uses VibeLang and exposes portable SDK declarations
without Node ambient types. The SDK host-probe typing fixes preserve runtime
behavior and the existing observable host-access contract.
