/**
 * The merge queue for one repository, run by `smthrs flow start merge-queue`.
 *
 * The queue's rules, driver and services live in `@smthrs/merge-queue`. This
 * flow is the host: it reads where the repository is and which commands test
 * and fix a change from the environment, and runs one driver round per flow
 * round. The queue's whole position is the round's payload, so a run that is
 * resumed continues where it stopped.
 *
 *   MQ_REPO           the jj repository
 *   MQ_BOOKMARK       the bookmark the queue lands on (default `main`)
 *   MQ_STATE          a directory for the inbox, the ledger and fix briefs
 *   MQ_CHECK_COMMAND  run as `sh -c "$MQ_CHECK_COMMAND" sh <check> <commit>`; exit 0 passes the check
 *   MQ_FIX_COMMAND    run as `sh -c "$MQ_FIX_COMMAND" sh <brief file> <answer file>`
 *   MQ_POLL_MS        how often to look for news (default 2000)
 *
 * Hand a change in by appending a line to `$MQ_STATE/inbox.jsonl`:
 *
 *   {"_tag":"enqueue","id":42,"priority":0,"commit":"<commit id>"}
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Flow, Interpreter } from "@smthrs/flow"
import { CommandCi, CommandFixer, FileInbox, JjRepository, QueueFlow, QueueSchema } from "@smthrs/merge-queue"
import { Config, Effect, Layer } from "effect"

const services = Layer.unwrap(
  Effect.gen(function*() {
    const repo = yield* Config.String("MQ_REPO")
    const bookmark = yield* Config.String("MQ_BOOKMARK").pipe(Config.withDefault("main"))
    const state = yield* Config.String("MQ_STATE")
    const check = yield* Config.String("MQ_CHECK_COMMAND")
    const fix = yield* Config.String("MQ_FIX_COMMAND")
    const poll = yield* Config.Number("MQ_POLL_MS").pipe(Config.withDefault(2000))
    const repository = yield* JjRepository.make({ path: repo, bookmark, ledger: `${state}/ledger.json`, poll })
    return Layer.mergeAll(
      FileInbox.layer({
        path: `${state}/inbox.jsonl`,
        poll,
        register: (id, commit) => repository.register({ id, rev: 0 }, commit)
      }),
      JjRepository.target(repository, poll),
      CommandCi.layer({
        repository,
        command: (id, commit) => ({ command: "sh", args: ["-c", check, "sh", String(id), commit], cwd: repo }),
        poll
      }),
      CommandFixer.layer({
        repository,
        directory: state,
        command: (brief, answer) => ({ command: "sh", args: ["-c", fix, "sh", brief, answer], cwd: repo }),
        poll
      })
    )
  })
).pipe(Layer.provide(NodeServices.layer), Layer.orDie)

// The queue's rounds are their own flow, which opens its next round itself; this flow starts it.
export const layer = Layer.mergeAll(QueueFlow.layer, Interpreter.layer(QueueFlow.Queue)).pipe(Layer.provide(services))

export default Flow.make("merge-queue", {
  description: "Land changes on a branch only as trees whose every required check passed, rebased on its tip.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:jj *", "proc:spawn:sh *"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: QueueFlow.Payload,
  success: QueueSchema.State,
  error: QueueFlow.RoundError,
  body: (payload) => QueueFlow.Queue.child(payload)
})
