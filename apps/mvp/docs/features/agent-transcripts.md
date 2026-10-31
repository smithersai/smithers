# Transcripts of external agents

A TODO coded by an [external agent](agent-runners.md) shows what that agent was asked, said and did on the TODO's run
page, live ([decision 0141](../decisions/0141-agent-transcripts.md)). Smithers names no agent vendor: the transcript is
the agent's own Agent Client Protocol (ACP) stream, read generically.

```
runner (smthrs runner serve)                       smithers.sh                                     browser
ACP agent ─ session/update ─▶ scrub, bound, number
          ─▶ spool <stateDir>/spool/<key>.jsonl
          ─ POST /api/runners/events ≤ 1/s ─▶ events route ─▶ RunContent(todo:<attempt>) ◀─ socket ─ Transcript panel
          ◀─ { next } ───────────────────────            │ SQLite, digest chain            replay, then live
                                                          └▶ agent_jobs first/last_event_at, totals (≤ every 30 s)
```

## On the runner

- **What leaves.** Every `session/update` the agent streams, as `{ seq, at, kind, update }`: `seq` counts from 0 within
  the job's generation, `at` is when the runner received it, `kind` is the update's `sessionUpdate`. The agent's slash
  commands and configuration options (`available_commands_update`, `config_option_update`) are dropped. The runner adds
  `_smithers/turn { stopReason }` when a prompt turn ends and `_smithers/end { outcome }` when the session ends.
  Nothing but `session/update` is read, so an adapter's `_auth/*` notices, which carry the account, never leave.
- **Scrubbed.** Every string is scrubbed before it is spooled: the profile's `secretEnv` values and its `prestart`
  environment, then `sk-` and `sess-` keys, `Bearer` credentials, GitHub tokens, three-part JWTs and email addresses.
- **Bounded.** An event is at most 16 KiB as JSON. A longer message is split into several chunks of the same message;
  any other long string is cut, ending `…[cut]`. A job's spool holds at most 64 MiB; past it, one
  `_smithers/truncated` event.
- **Spooled.** Each event is written to `<stateDir>/spool/<key hash>.jsonl` (`0600`) before it is sent. While the agent
  works, the runner posts what the host hasn't acknowledged: at most once a second, at most 64 KiB a request, and at
  once again while a full batch waits, so a backlog catches up quickly. The host answers the lowest `seq` it lacks; the
  runner drops everything below it and sends from there. A host that can't be reached is asked again after 1 s
  doubling to 8 s.
- **Durable.** A runner that restarts reads its spool and sends again what the host doesn't have; its resumed session
  numbers new events after the last one written. An agent replays its history when it loads a session; the runner
  doesn't send that again. When the work ends, `runner/Transcript` writes the end and sends the rest, retried by the
  engine (1 s doubling to 30 s, for a day), then deletes the spool. The settlement (`runner/Settle`) runs beside it and
  never waits for it.

## The events route

`POST /api/runners/events { key, claim, events }` with the runner's token, as the other [runner
routes](agent-runners.md#the-runner-protocol). The runner that holds the job's claim, or held it before it settled,
may post. Answers:

| Status | Body | When |
|---|---|---|
| 200 | `{ next }` | stored; `next` is the generation's lowest `seq` the run doesn't have |
| 400 | `{ code: "invalid" }` | not events, or an event the runner should have dropped or split |
| 401 | `{ code: "authentication" }` | no runner has that token |
| 409 | `{ code: "not_held" }` | the runner never held the job |
| 409 | `{ code: "no_transcript" }` | the job's task names no run (only a TODO's job has one) |
| 413 | `{ code: "invalid" }` | a body over 2 MiB |
| 503 | `{ code: "unavailable" }` | Postgres or the run's transcript couldn't answer; the runner keeps its spool |

The route scrubs every string again and appends the events to the run's `RunContent`. On the job's `agent_jobs` row it
sets `first_event_at` once, and `last_event_at`, `transcript_events` and `transcript_bytes` at most every 30 seconds.

## The store

`RunContent` (`worker/RunContent.ts`) is one Durable Object per run, named by the run's id, `todo:<attempt>`. Its
SQLite (`worker/runners/RunContent.ts`) keeps:

- `events`: each `(generation, seq)` once, numbered `n` in the order stored, with when it was received and its update.
- `generations`: per generation, the lowest `seq` not stored yet.
- `meta`: the run's events, bytes, last `n`, whether it was truncated, and a SHA-256 chain over its events in order
  (`src/features/transcript/digest.ts`), which a tab computes too.

A run keeps at most 64 MiB of events. The object's alarm forgets the transcript 30 days after its last event. Postgres
and Electric hold none of it.

## The socket

`GET /api/remote-runs/<run>/transcript?after=<n>` with `Upgrade: websocket`, from a page of this app (its `Origin` is
the request's), for a signed-in Member or above of the TODO's repository, as the [run's
page](runs.md#a-run-on-cloudflare). ChatApi hands the socket to the run's `RunContent`, which sends text frames:

- `{ type: "events", events: [{ n, generation, seq, at, kind, update }] }`: every event after `n` (`-1` for all), at
  most 500 events or 512 KiB a frame, then each event as it is stored.
- `{ type: "live", n, digest }`, once, after the replay: the last event's `n` and the run's digest there.

The same request without `Upgrade` answers `426 { code: "upgrade" }` to a Member, or the refusal a socket would get:
`401 authentication`, `403 forbidden` (not a Member, or another site's page as `origin`), `404 not_found` (no TODO's
attempt started that run), `503 unavailable`.

## The panel

A run whose steps include `agent/Session` shows the Transcript panel on its page (`src/features/transcript/`). It
replays the run from the start, checks its own digest against the run's (`data-verified`), then follows live. It reads
ACP kinds generically: chunks of one message join into one message (by `messageId`), a tool call is one row whose
title and status its updates change, a plan is a checklist, usage shows the latest figures (cost only when the agent
reports it), and the runner's turn ends and session end read in words. Every event is text; nothing renders as markup.

A socket that drops dials again after 1 s doubling to 30 s, from the last event the panel holds, so it holds each event
once; after 30 minutes without the run it closes, saying the transcript couldn't be reached. Before dialing again it
asks the route over plain HTTP; a refusal closes the panel with why. The panel's phases:
Connecting, Replaying, Live, Reconnecting, Closed. Nothing is kept on the device: a reload replays.

## Observability

- Runner: `runner.events` (warn: a post the host didn't take, with its code), `runner.transcript` (the drain's outcome).
- ChatApi: `runner.events` (each post: runner, key, events, `next`, outcome); `smithers_runner_requests{route=events}`;
  `smithers_agent_event_lag_ms`, from the runner receiving an event to the host storing it; `run.transcript` (each
  socket request) and `smithers_run_transcript_connects{outcome}`; `run_content.append` (span), `run_content.join`
  and `run_content.forget` (logs) in the object.
- Browser: `transcript_event_lag_ms` (runner to tab), `transcript_dials{outcome}`, `transcript_replays{verified}`,
  `transcript.live` and `transcript.closed` logs.
- Nothing logs, traces or counts an event's content, a prompt, a token or an account.

## Code and tests

- `@smthrs/agent`'s `Transcript`: the event and request schemas, `scrubber`, `prepare`.
- `smthrs runner`: `packages/smithers/src/runner/Spool.ts`, `Session.ts` (what is spooled), `Job.ts`
  (`runner/Transcript`).
- `worker/runners/Api.ts` (the events route), `worker/runners/RunContent.ts` (the store), `worker/RunContent.ts` (the
  object), `worker/RemoteRuns.ts` (the socket route), `src/features/transcript/` (the panel).
- Tests: `packages/smithers/agent/test/Transcript.test.ts`; `packages/smithers/test/Runner.test.ts` (a real runner and
  test agent against a loopback host: order, scrubbing, bounds, a host that refuses events for a minute, a runner
  killed mid-job, and ten jobs at once, each transcript whole and live, with its lag printed);
  `worker/runners/RunContent.test.ts` (the store on SQLite), `worker/runners/Runners.test.ts` (the route on Postgres),
  `worker/runners/TodoRunner.test.ts` (a TODO's transcript through a real runner), `worker/RemoteRuns.test.ts` (the
  socket route), `src/features/transcript/fold.test.ts`; `e2e/agent-runner.spec.ts` (the panel on a deployment: first
  message within 30 s of the commit, a blocked minute caught up in order, lag p95 within 3 s, a fresh replay with the
  run's digest).
