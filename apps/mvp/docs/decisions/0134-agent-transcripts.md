# 0134: Transcripts of external agents

Date: 2026-10-31. Status: accepted. Builds on [0133](0133-external-agents-on-runners.md) (external agents on
runners) and [0026](0026-watching-a-todo-run.md) (watching a TODO's run). Follows rulings TODO-3, DUR-9, OBS-5 and
ARCH-12's one exception, the terminal socket. Design: slice S2 of the G1/G2 design
(`~/Desktop/smithers-sh-parity/design-g1g2/FINAL.md` §2.7), probe S0. Will reviews it with the feature (HOST-3).

## Problem

A TODO on an external agent runs on a runner for minutes to hours. Its run page showed its steps, but not what the agent
was doing, so a person couldn't watch it work (TODO-3). The engine journals the session as one step (DUR-9), and a
Smithers agent's turn-by-turn journal already costs about 1,600 events in 14 minutes; fifty agents streaming into
Postgres would load the engine's writer and the one Electric instance.

## Decision

1. **The runner sends the agent's ACP stream, numbered.** Every `session/update` the agent streams becomes an event
   `{ seq, at, kind, update }`, `seq` counting from 0 within one job generation. The runner drops the agent's slash
   commands and configuration options (`available_commands_update`, `config_option_update`), scrubs every string
   (the profile's secret values, credential shapes and email addresses), and bounds each event to 16 KiB: a long
   message is split into chunks of the same message, any other long string is cut. Updates an agent replays while it
   loads a session (`session/load`) are not sent again. The runner adds `_smithers/turn { stopReason }` after each
   prompt turn and `_smithers/end { outcome }` when the session ends. Only `session/update` is read, so `_auth/*`
   never leaves the runner (S0).
2. **A spool makes it durable.** The runner writes each event to `<stateDir>/spool/<key hash>.jsonl` (`0600`) before
   it sends it. While the agent works it posts the unacknowledged events at most once a second, in requests of at
   most 64 KiB, at once again while a full batch waits. The host answers the generation's lowest `seq` it lacks; the
   runner drops what is below it and sends from there. A restarted runner sends its spool again. When the work ends,
   `runner/Transcript`, a step of the runner's `runner/Job` beside `runner/Settle`, writes the end and drains the
   spool, retried by the engine while the host can't be reached; the settlement never waits for it.
3. **`POST /api/runners/events { key, claim, events }`.** The runner that holds or held the job's claim posts; the
   route scrubs again, refuses a kind the runner should have dropped, and appends to the run's transcript. The job's
   `agent_jobs` row keeps `first_event_at` (set once) and, at most every 30 seconds, `last_event_at`,
   `transcript_events` and `transcript_bytes` (migration 0078), for the fleet view (S5).
4. **One Durable Object per run.** `RunContent`, named by the run's id (`todo:<attempt>`), keeps the events in its own
   SQLite, each `(generation, seq)` once, numbered `n` as stored, with a SHA-256 chain over them. A run keeps at most
   64 MiB; past it, one `_smithers/truncated` event and nothing more. Its alarm forgets the transcript 30 days after
   the last event. Postgres and Electric carry none of it.
5. **A socket to watch it.** `GET /api/remote-runs/<run>/transcript?after=<n>` upgrades for a Member of the run's
   repository from a page of this app (cookie and `Origin`, the terminal's pattern), and the object replays every
   event after `n`, sends `live` with its digest, then sends each event as it is stored. The run page's Transcript
   panel folds ACP kinds generically: messages, tool calls with title and status, a plan as a checklist, usage, turn
   ends and the session's end. A tab whose socket drops dials again from its last event, so it holds every event
   once; a plain `GET` tells it whether it was refused for good.

## Rejected

- **Transcripts in Postgres** (two of the four designs): fifty runs at a post a second would load the engine's writer
  lock and the one `basic` Electric instance for content nobody queries.
- **A one-use ticket for the socket** (FINAL.md §2.7, "the terminal pattern"): the terminal's routes use the session
  cookie and an `Origin` check, so this route does too; a ticket would be a second pattern.
- **A path per job, `/api/runners/jobs/<key>/events`** (FINAL.md): the other runner routes carry the key in the body;
  the events route does too.
- **Prompt events written by the runner**: both published adapters echo the prompt as `user_message_chunk` (S0).

## Consequences

- A runner needs disk for a job's spool, at most 64 MiB, deleted once the host has it.
- The transcript's lag is the runner's batching (at most a second) plus two network hops. FINAL.md's numbers (first
  message within 30 s of the commit, 95% of events within 3 s) are held on a deployment by `e2e/agent-runner.spec.ts`;
  the runner's own ten-job test prints them, because a shared test host's load decides them there.
- The fleet view (S5) reads `agent_jobs`' summary columns and may open the same socket; Stop and steering (S3) mark
  their acts in the transcript as `_smithers/cancel` and `_smithers/steer` through the runner's spool.
- The panel and the object can only be watched end to end on a deployment that signs in through the GitHub App:
  `e2e/agent-runner.spec.ts` proves it there.
