import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Transcripts of external agents (decision 0141, docs/features/agent-transcripts.md#postgres). The transcript itself
// lives in the run's `RunContent` Durable Object, never in Postgres; `agent_jobs` keeps only what a list of runs needs
// to say how a job's agent is doing, written by the runner events route (worker/runners/Api.ts) under the job's key:
//
// - `first_event_at`: when the host first stored one of the job's events (the start latency's last hop), set once.
// - `last_event_at`, `transcript_events`, `transcript_bytes`: when the job's run last stored an event, and how many
//   events and bytes the run holds then; written at most once every 30 seconds per job, so a talkative agent costs
//   Postgres about one write a run per 30 seconds.
//
// All four stay null until the job's first event.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE agent_jobs
      ADD COLUMN first_event_at timestamptz,
      ADD COLUMN last_event_at timestamptz,
      ADD COLUMN transcript_events bigint CHECK (transcript_events >= 0),
      ADD COLUMN transcript_bytes bigint CHECK (transcript_bytes >= 0)`
})
