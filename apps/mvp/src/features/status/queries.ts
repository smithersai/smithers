import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import type { Effect } from "effect"
import type { Message } from "../chat/schema"
import type { Source } from "../repo/gate"
import { QUEUE_ASK_FLOW } from "./contract"
import type { Local, Run } from "./schema"

// What frontends read about the agent's status (decision 0015), each a live query over this device's collections:
// chat's synced `messages`, the synced `runs`, and this tab's own rows about each question (`local`). The answer's own
// settled status always wins over the run's row, so a report that never landed can't leave an answer looking live.

/**
 * Each answer's agent state, with its run's latest question: `done` or `failed` once the answer settled; while it
 * streams, `needs_you` while its question is open and unanswered, `waiting` while its turn waits, else `working`.
 * `focus` and `draft` are this tab's, for the open question only.
 */
export const statusesQuery = (
  messages: Source<Message>,
  runs: Collection.Collection<Run>,
  local: Collection.Collection<Local, string>,
) =>
  LiveQuery.make((q) =>
    q
      .from({ message: messages.tanstack })
      .where(({ message }) => Query.eq(message.role, "assistant"))
      .leftJoin({ run: runs.tanstack }, ({ message, run }) => Query.eq(message.id, run.id))
      .leftJoin({ mine: local.tanstack }, ({ message, mine }) => Query.eq(message.id, mine.id))
      .select(({ message, run, mine }) => ({
        id: message.id,
        flow: run?.flow,
        position: message.position,
        state: Query.caseWhen(
          Query.eq(message.status, "done"),
          "done",
          Query.eq(message.status, "failed"),
          "failed",
          Query.and(Query.eq(run?.status, "needs_you"), Query.isNull(run?.answeredAt)),
          "needs_you",
          Query.eq(run?.status, "waiting"),
          "waiting",
          "working",
        ),
        version: run?.version,
        wait: run?.wait,
        answer: run?.answer,
        sending: Query.caseWhen(Query.and(Query.eq(mine?.version, run?.version), Query.eq(mine?.sending, true)), true, false),
        draft: Query.caseWhen(Query.eq(mine?.version, run?.version), mine?.draft, ""),
        focus: Query.caseWhen(Query.eq(mine?.version, run?.version), mine?.focus, 0),
      }))
      .orderBy(({ $selected }) => $selected.position),
  )

/** Every answer's status. */
export type Statuses = Effect.Success<ReturnType<typeof statusesQuery>>

/**
 * `core/waits` (decision 0017): the open waits addressed to the viewer, in every conversation, oldest first, then by run
 * id. A run's row is synced only to the person who launched it, or the one an agent's `queue/ask` asks, the one
 * `run/answer` lets answer it, so every open row here is theirs, a question on a branch this tab never opened included. An answer in the home conversation that already
 * settled still wins over its run's row, as in `statusesQuery`; ChatApi fails a run's row when it settles its answer
 * itself (worker/flows/Expire.ts, worker/Answers.ts). Each row is `WAITS_ROW` (./contract.ts).
 */
export const waitsQuery = (home: Collection.Collection<Message>, runs: Source<Run>) =>
  LiveQuery.make((q) =>
    q
      .from({ run: runs.tanstack })
      .leftJoin({ message: home.tanstack }, ({ run, message }) => Query.eq(run.id, message.id))
      .where(({ run, message }) =>
        Query.and(
          Query.and(Query.eq(run.status, "needs_you"), Query.isNull(run.answeredAt)),
          Query.and(
            Query.not(Query.isNull(run.wait)),
            Query.or(
              Query.isUndefined(message?.id),
              Query.not(Query.or(Query.eq(message?.status, "done"), Query.eq(message?.status, "failed"))),
            ),
          ),
        )
      )
      .orderBy(({ run }) => run.createdAt)
      .orderBy(({ run }) => run.id)
      // The `where` holds `wait` to a question.
      .select(({ run }) => ({
        runId: run.id,
        version: run.version,
        execution: run.wait!.execution,
        kind: run.wait!.kind,
        prompt: run.wait!.prompt,
        options: run.wait!.options,
        question: Query.caseWhen(Query.eq(run.wait!.kind, "question"), true, false),
        approval: Query.caseWhen(Query.eq(run.wait!.kind, "approval"), true, false),
        createdAt: run.createdAt,
        repoId: Query.coalesce(run.repoId, ""),
      })),
  )

/**
 * The person's runs whose conversation may show (decision 0110): personal home runs, or a conversation whose
 * repository is visible. Addressed questions have no conversation and are not listed on run pages.
 */
export const shownRunsQuery = (
  home: Source<Message>,
  runs: Source<Run>,
  conversations: Source<{ readonly conversationId: string }>,
) =>
  LiveQuery.make(
    (q) =>
      q
        .from({ run: runs.tanstack })
        .leftJoin({ message: home.tanstack }, ({ run, message }) => Query.eq(run.id, message.id))
        .leftJoin({ owner: conversations.tanstack }, ({ run, owner }) => Query.eq(run.conversationId, owner.conversationId))
        .where(({ message, owner }) =>
          Query.or(Query.not(Query.isUndefined(message?.id)), Query.not(Query.isUndefined(owner?.conversationId)))
        )
        .select(({ run }) => run),
    { getKey: (run) => run.id },
  )

/**
 * Runs whose waits may show: conversation runs, plus addressed questions from repositories that may show now.
 * `visibleRuns` is `RepoStore.gate(runs)`: revocation, an unverified session, and pending refusal restoration hide
 * addressed prompts and options in the same change as other repository content (decisions 0031 and 0110).
 */
export const waitRunsQuery = (
  home: Source<Message>,
  runs: Source<Run>,
  conversations: Source<{ readonly conversationId: string }>,
  visibleRuns: Source<Run>,
) =>
  LiveQuery.make(
    (q) =>
      q
        .from({ run: runs.tanstack })
        .leftJoin({ message: home.tanstack }, ({ run, message }) => Query.eq(run.id, message.id))
        .leftJoin({ owner: conversations.tanstack }, ({ run, owner }) => Query.eq(run.conversationId, owner.conversationId))
        .leftJoin({ visible: visibleRuns.tanstack }, ({ run, visible }) => Query.eq(run.id, visible.id))
        .where(({ run, message, owner, visible }) =>
          Query.or(
            Query.not(Query.isUndefined(message?.id)),
            Query.not(Query.isUndefined(owner?.conversationId)),
            Query.and(
              Query.eq(run.flow, QUEUE_ASK_FLOW),
              Query.isNull(run.conversationId),
              Query.not(Query.isUndefined(visible?.id)),
            ),
          )
        )
        .select(({ run }) => run),
    { getKey: (run) => run.id },
  )

/** The open waits addressed to the viewer. */
export type Waits = Effect.Success<ReturnType<typeof waitsQuery>>

/** The latest answer's status in one conversation: what the header shows while it shows that conversation. */
export const latestQuery = (statuses: Statuses) =>
  LiveQuery.make((q) =>
    q
      .from({ status: statuses.tanstack })
      .orderBy(({ status }) => status.position, "desc")
      .limit(1),
  )

/**
 * The answers this device should deliver: answered on some device, while the run hasn't yet reported it working. The
 * device that holds the run delivers each; any other finds nothing to deliver.
 */
export const deliveriesQuery = (runs: Collection.Collection<Run>) =>
  LiveQuery.make((q) =>
    q
      .from({ run: runs.tanstack })
      .where(({ run }) => Query.and(Query.eq(run.status, "needs_you"), Query.not(Query.isNull(run.answeredAt))))
      .select(({ run }) => ({ id: run.id, version: run.version, wait: run.wait, answer: run.answer })),
  )
