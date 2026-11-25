# 0171: One core serves four clients, and repository workflows live in `.smithers/workflows/`

Date: 2026-11-24. Status: accepted (Gate 2, approved by Will 2026-11-24, recommended options 1A and 2A).
Nothing in this record is built yet.

## Context

The MCP server, the `incur` CLI and skill, the SDK and the React GUI each reach the engine through their own lists:
78 entries in `registry.ts`, 25 providers in `main.tsx` and 14 fields in `RouterContext`. Hand-kept person-only lists
already missed four flows. POC-2 ran one five-step workflow through all four clients and got the same snapshot digest
from each.

The Gate 2 audit also found three release blockers, listed under Consequences.

## Decision

1. `@smthrs/app-core` exposes four operations: `catalog`, `submit`, `read` and `changes`. A new workflow needs zero
   adapter edits.
2. Each client passes `DoorEvidence`, which says how a call arrived and never who made it. Only the core resolves a
   principal.
3. MCP, the local CLI and the skill always act as `act: "agent"`. A person-only act from them raises a Queue item that
   the person approves in host-drawn UI, never at a TTY prompt.
4. Repository workflows live at `.smithers/workflows/<name>.vibe`. A compatibility reader keeps loading
   `.smithers/flows/**/flow.ts` until every flow moves.
5. Decision 0017 gains two fields: `plugin.json` declares a static `egress: { secrets, origins }`, and door metadata
   (`acts`, `changes`, `confirm`, `minimum`) moves onto `Flow.make`.
6. QuickJS realms exchange primitive JSON strings only.

## Consequences

Three blockers ship before launch:

- `PresentationRealm.ts` and `worker/ci/Realm.ts` call `context.dump`, which runs guest getters outside the interrupt
  budget. Both move to string-only exchange.
- `worker/secrets/SandboxEgress.ts` binds every secret in a repository. It narrows to per-installation Admin grants.
- `Cli.ts` serves `--mcp` and `--http` through shared serve. Both downgrade to `act: "agent"`.

## Rejected

- A REST API for the GUI beside MCP: two catalogs drift.
- A method per operation: every workflow edits four clients.
- One generic `run(tag, payload)` MCP tool: allowing reads would allow sandbox execution.
- Host-realm npm plugins: they cannot be confined.
- TTY approvals on self-hosted nodes: in BYOA the person's own agent drives the TTY.
