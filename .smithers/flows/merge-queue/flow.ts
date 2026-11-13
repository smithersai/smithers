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
 *   MQ_STATE          a directory for the inbox, the ledger, fix briefs and the record of endings
 *   MQ_CHECK_COMMAND  run as `sh -c "$MQ_CHECK_COMMAND" sh <check> <commit>`; exit 0 passes the check
 *   MQ_RUN_COMMAND    instead of MQ_CHECK_COMMAND: one process per CI run, as
 *                     `sh -c "$MQ_RUN_COMMAND" sh <commit> <check>...`, printing `<check> pass|fail [seconds]`
 *                     as each check finishes
 *   MQ_FINISH_COMMAND optional, run as `sh -c "$MQ_FINISH_COMMAND" sh <head> <onto> <conflicted>` on each change
 *                     once it is rebased; prints the commit that stands for the change (regenerated files)
 *   MQ_PARALLEL       how many changes are rebased and finished at once (default 1); above 1 the finish command
 *                     must be safe to run several times at once, each call on its own commits
 *   MQ_JJ             the jj program (default `jj`)
 *   MQ_FIX_COMMAND    run as `sh -c "$MQ_FIX_COMMAND" sh <brief file> <answer file>`
 *   MQ_POLL_MS        how often to look for news (default 2000)
 *
 * Hand a change in by appending a line to `$MQ_STATE/inbox.jsonl`:
 *
 *   {"_tag":"enqueue","id":42,"priority":0,"commit":"<commit id>"}
 *
 * One run is one lineage of the queue: after `lineage` rounds (200 in the start value below) the run ends and
 * leaves `{"done":false,"position":{...}}` in `$MQ_STATE/position.json`. Start the next run with that position
 * (`--data` the `position` object); `"done":true` means the queue has finished. A host loops:
 *
 *   while :; do smthrs flow start merge-queue --data @next.json --wait || break
 *     jq -e '.done' "$MQ_STATE/position.json" >/dev/null && break
 *     jq '.position' "$MQ_STATE/position.json" > next.json; done
 *
 * Read how each change ended from `$MQ_STATE/endings.jsonl`: one line per change, merged (with the run and
 * results that landed it), unmergeable (with the reason for its author) or withdrawn.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Flow, Interpreter } from "@smthrs/flow"
import {
  CommandCi,
  CommandFixer,
  FileEndings,
  FileHandover,
  FileInbox,
  JjRepository,
  QueueFlow
} from "@smthrs/merge-queue"
import { Config, Effect, Layer, Option } from "effect"

const services = Layer.unwrap(
  Effect.gen(function*() {
    const repo = yield* Config.String("MQ_REPO")
    const bookmark = yield* Config.String("MQ_BOOKMARK").pipe(Config.withDefault("main"))
    const state = yield* Config.String("MQ_STATE")
    const run = yield* Config.option(Config.String("MQ_RUN_COMMAND"))
    const check = yield* (Option.isSome(run) ? Config.succeed("") : Config.String("MQ_CHECK_COMMAND"))
    const finish = yield* Config.option(Config.String("MQ_FINISH_COMMAND"))
    const binary = yield* Config.String("MQ_JJ").pipe(Config.withDefault("jj"))
    const fix = yield* Config.String("MQ_FIX_COMMAND")
    const poll = yield* Config.Number("MQ_POLL_MS").pipe(Config.withDefault(2000))
    const parallel = yield* Config.Number("MQ_PARALLEL").pipe(Config.withDefault(1))
    const repository = yield* JjRepository.make({
      path: repo,
      bookmark,
      ledger: `${state}/ledger.json`,
      poll,
      binary,
      parallel,
      finish: Option.match(finish, {
        onNone: () => undefined,
        onSome: (command) => (head: string, onto: string, conflicted: boolean) => ({
          command: "sh",
          args: ["-c", command, "sh", head, onto, String(conflicted)],
          cwd: repo
        })
      })
    })
    return Layer.mergeAll(
      FileInbox.layer({
        path: `${state}/inbox.jsonl`,
        poll,
        register: (id, commit) => repository.register({ id, rev: 0 }, commit)
      }),
      FileEndings.layer({ path: `${state}/endings.jsonl` }),
      FileHandover.layer({ path: `${state}/position.json` }),
      JjRepository.target(repository, poll),
      Option.match(run, {
        onNone: () =>
          CommandCi.layer({
            repository,
            command: (id, commit) => ({ command: "sh", args: ["-c", check, "sh", String(id), commit], cwd: repo }),
            poll
          }),
        onSome: (command) =>
          CommandCi.streamed({
            repository,
            command: (checks, commit) => ({
              command: "sh",
              args: ["-c", command, "sh", commit, ...checks.map(String)],
              cwd: repo
            }),
            poll
          })
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
  success: QueueFlow.End,
  error: QueueFlow.RoundError,
  body: (payload) => QueueFlow.Queue.child(payload)
})
