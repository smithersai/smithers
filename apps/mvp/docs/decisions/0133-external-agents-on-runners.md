# 0133: External agents on runner machines, vendor-neutral

Date: 2026-10-31. Status: accepted. Builds on [0016](0016-todos-and-the-stack.md) (the `todo` run) and
[0079](0079-roles-per-repository.md) (per-repository roles). Amends [0033](0033-coding-model-role.md): its "Rejected: an
agent CLI" stays rejected in its vendor-adapter form, and its last consequence ("no seam for that") is superseded.
Follows rulings PROC-23 and its 20:50 addendum, DUR-9 and FLOW-8. Design: slice S1 of the G1/G2 design
(`~/Desktop/smithers-sh-parity/design-g1g2/FINAL.md`), probe S0. Will reviews it with the feature (HOST-3).

## Problem

A repository's TODOs can only be coded by Smithers' own agent. Our factory runs its lanes on Claude Code and Codex
subscriptions on our own machines, and PROC-23's addendum asks for "the bare minimum minimal cleanest seam" that lets us
point the coding role there, with no Claude- or Codex-specific product code. The 2026-10-21 runner stack built that
seam with a `claude-code | codex` enum and vendor output parsers, and was dropped for them.

## Decision

1. **An agent is a name, machine labels and an opaque profile.** `admin/SetAgent` stores `{ name, labels, profile,
   maxHours (4, at most 12), restarts (1, at most 5), coding }` per repository; at most one is the repository's coding
   agent. The product never reads `profile`. The runner's own `runner.json`, our configuration, maps it to an
   `argv` that speaks the Agent Client Protocol (ACP) on stdio, an optional `prestart` hook that picks an account and
   prints its environment, and the secrets to scrub. Vendors, logins and account rotation live there (PROC-23).
2. **ACP is the wire.** `@smthrs/agent`'s `Acp` client drives any ACP agent: `initialize`, `session/new` or
   `session/load`, `session/prompt`, `session/cancel`, and every `session/update` as it arrived. S0 ran Claude Code
   and Codex through their published ACP adapters with no bridge of ours. The product parses no vendor output.
3. **Runners pull.** An Admin registers a runner machine for a repository in person (`admin/AddRunner`, by its token's
   SHA-256, with its labels and capacity); `smthrs runner token` makes the token on the machine. The runner claims over
   `/api/runners/{claim,heartbeat,settle}`: a job whose profile it has and whose labels it carries, within its capacity.
4. **The session is one durable step (DUR-9).** `agent/Session` is an `ExternalAgent`, an `ExternalJob` keyed
   `<execution>#g<n>`. The engine journals its start, probes, generations and result, never the transcript. On the
   runner, `runner/Job` is a `platform-node` flow on its own SQLite journal. The runner stores the ACP session id beside
   the checkout and, after a crash, resumes with `session/load` on the same account. That logic lives in the runner
   module only; the app sees one step that ends with the change.
5. **A runner that stops answering keeps its job.** A missing heartbeat doesn't prove the agent stopped. The job reads
   Running until the runner returns (the claim route hands it back, `reclaimed`) or the agent's hours run out. A
   retryable end (a profile maps an agent's limit or exit to it) starts generation n+1 pinned to the same runner,
   whose checkout holds the work. A runner that comes back without the checkout settles `machine_lost`. Nothing fails
   over across machines.
6. **The change comes back in the settlement.** The runner works in a `jj` workspace of the repository at the attempt's
   base and settles the files the agent changed, within the commit's 50 files and 1 MiB. `todo/Received` checks them as
   `todo/Collect` checks a machine's, and `todo/Publish` is unchanged: one App commit, one pull request, a person
   merges.
7. **Stop kills the process tree.** S0 found that ACP cancel leaves Codex's shell commands running, and both CLIs start
   tools in their own groups, so the runner's cancel ends the agent's whole tree (a cgroup on Linux, a descendant walk
   on macOS) and settles `Cancelled { processTreeGone }`.
8. **Admins only, in person.** `PUT, DELETE /api/repos/<owner>/<name>/{runners,agents}/<name>` need an Admin of the
   repository acting in person (protected acts `runner` and `agent`).

## Rejected

- **A vendor enum or output parser in the product** (the 2026-10-21 stack): PROC-23's addendum.
- **Remote tools only, the agent's native tools off** (the "job tools" of 2026-10-21): the factory's Go builds need the
  host's caches, and Codex's client-served tools are experimental. Kept in history for a later profile option.
- **A durable proxy in front of every model call**: it is the relay 0033 §5 refused, and it couldn't replay answers into
  a CLI's own session. DUR-9 settles it.
- **Failing a job over to another runner when its lease lapses**: a missing heartbeat isn't a dead process; two agents
  could write one change.

## Consequences

- Smithers-agent TODOs are unchanged, except that the `todo` plan gains `todo/Agent` and a branch, so a run parked on
  the old plan stops `plan_changed` at the deploy that ships this.
- A TODO takes the repository's coding agent; choosing one per TODO waits for the independent-lanes migration (S4).
- Transcripts (S2), Stop and steering of external runs (S3), and the fleet view and alerts (S5) build on `agent_jobs`,
  `runners` and the runner's ACP stream.
- The runner has the host's trust level, as today's lanes do: agents run with their native tools and no sandbox. This
  is recorded as debt.
