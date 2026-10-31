// A run's transcript (decision 0134, docs/features/agent-transcripts.md): the one home of the values the tab, ChatApi,
// the run's `RunContent` Durable Object and the tests share. Nothing here imports a library, so every side can.

import { remoteRunRoute } from "../runs/contract"

/**
 * `GET <route>?after=<n>` with `Upgrade: websocket`: a run's transcript, every event after `n` (`-1` for all) and then
 * each one as it is stored, for a person who may read the run.
 */
export const transcriptRoute = (runId: string): string => `${remoteRunRoute(runId)}/transcript`

/** The most events one replay frame carries. */
export const PAGE_EVENTS = 500

/** The most bytes of events one replay frame carries, under a WebSocket message's 1 MiB. */
export const PAGE_BYTES = 512 * 1024

/** How long a run's transcript is kept after its last event: 30 days. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** How often at most a job's summary in Postgres is written: `agent_jobs.last_event_at` and its counts. */
export const SUMMARY_EVERY_SECONDS = 30

/** What the digest chain starts from: a run with no events. */
export const GENESIS = ""

/** The step whose agent writes a run's transcript: an external agent's session (decision 0133). */
export const TRANSCRIBED_ACTION = "agent/Session"

/** Whether a run's steps include an external agent's session, so its page shows the Transcript panel. */
export const transcribed = (steps: ReadonlyArray<{ readonly action?: string | null }>): boolean =>
  steps.some((step) => step.action === TRANSCRIBED_ACTION)
