# CLI: `why`, `doctor run`, `repair` + prefix IDs + uniform `--json`

> Target repo: **smithers**
> Source: memo §8 · roadmap Phase 0

## Problem

Operators routinely open SQLite directly and hand-edit JSON to recover
from stuck runs. That's the single clearest sign the CLI is under-designed
for its job. The field report's reset-script workaround is not an
ecosystem problem — it's a missing CLI.

## Goal

Three new top-level commands, prefix ID handling, and stable `--json`
across every inspection command.

## Scope

### `smithers why <runId>`

One-screen diagnostic. Uses `RunStateView` (0015) + heartbeats (0016) +
audit log (0018).

Output:
- Current state + reason (bold).
- Engine heartbeat age, UI viewers.
- Owner: id, epoch, lease status.
- Last 5 transitions from the audit log.
- Last tool call, last output, last file write.
- Suggested next action (`resume`, `approve`, `wait`, `doctor run`).

`--json` emits the same structure as a schema-stable object.

### `smithers doctor run <runId>`

Deep diagnostic — slower, more thorough. Checks:
- DB schema version vs package version.
- Heartbeat table health, lease table health.
- Supervisor policy values currently in effect.
- VCS pointer reachability.
- Sandbox runtime reachability (if a runtime is configured per jjhub/0001).
- Orphaned children / timers / approvals.

Reports issues as `ok | warn | fail` with a repair hint per row.

### `smithers repair <runId>`

Scoped, auditable recovery actions. Each action requires explicit opt-in
flags; dry-run by default.

Actions:
- `--release-lease` — release a stale lease (no takeover).
- `--takeover` — supervisor-style takeover (0017).
- `--clear-stuck-approval <nodeId>` — mark an abandoned approval failed.
- `--rebuild-snapshot` — rebuild DevTools snapshot from events.
- `--migrate-schema` — run pending migrations.

All actions write audit rows with `actor: "repair-cli"`, the user, and
the flag used. No action ever deletes event rows; the event log is
append-only (rewind is a separate command with different semantics).

### Prefix run IDs

Accept any unique prefix of a runId (min 4 chars). If ambiguous, exit 1
and print the matching IDs. Applies to all commands that take a runId.

### Uniform `--json`

Every inspection command (`ps`, `inspect`, `events`, `why`, `doctor run`,
`tree`, `diff`, `output`) emits a documented JSON schema under `--json`.
Schemas live in `packages/cli-schemas` and are shipped as JSON Schema
documents (`docs/cli-schemas/*.json`) for downstream consumers.

### Lineage-aware inspect

`smithers inspect --lineage <runId>` walks `continueAsNew` chains both
directions and prints the chain with state per link.

## Files

- `apps/cli/src/why.ts`, `doctor.ts`, `repair.ts`
- `apps/cli/src/util/resolveRunId.ts` (prefix matching)
- `packages/cli-schemas/` (new) — JSON schemas per command
- `docs/cli-reference/{why,doctor,repair}.mdx`

## Testing

- Unit per command: flags, error codes (match 0014's exit-code table).
- Integration: stuck approval → `why` cites it; `repair --clear-stuck-
  approval` resolves it; audit row written.
- Integration: ambiguous prefix → exit 1, prints matches.
- Contract: every `--json` output parses against its JSON Schema.
- Fault: `repair --takeover` while owner is alive → refused with
  `OwnerAlive` unless `--force`.

## Acceptance

- [ ] Three commands ship with docs + JSON schemas.
- [ ] Prefix resolution works across all runId-accepting commands.
- [ ] No documented recovery path requires opening the DB.
- [ ] Every `--json` output validates against a published schema.

## Blocks

- Depends on 0015, 0016, 0017, 0018.
