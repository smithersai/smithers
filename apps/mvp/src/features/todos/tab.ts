import type { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Layer } from "effect"
import { codeOf } from "../../errorCode"
import { answerAskingTab } from "../../flows/askingTab"
import { IssuesStore } from "../issues/store"
import { draftFromIssue, todosChannel } from "./contract"
import { type Draft, TodosCall } from "./schema"
import { TodosStore } from "./store"

// The tab's side of the TODO steps (docs/features/todos.md#flows): every tab listens on the engine's todos channel, and
// only the tab that started a call's request answers it (src/flows/askingTab.ts), keeping a draft on the device or
// putting a change in the device's outbox. Every other tab, and every other device, leaves it alone. Calls are answered
// one at a time, so a step asking again for a draft or change still being kept finds it kept. A draft made from an
// issue takes the title and prompt it left out from that issue, as this device has it (docs/features/todos.md#from-an-issue).

/** How long a draft from an issue waits for the issues' first answer when the device holds none of them yet. */
const ISSUES_WITHIN = "5 seconds"

/**
 * Waits up to `ISSUES_WITHIN` for the issues' first sync (`preload`). One that fails leaves a draft's issue missing,
 * which the step reports as `issue_not_found`, so the failure is logged as `todos.issue.load`.
 */
export const issuesSynced = (preload: Effect.Effect<void, Collection.LoadFailed>) =>
  Effect.gen(function* () {
    const loaded = yield* Effect.result(Effect.timeoutOption(preload, ISSUES_WITHIN))
    if (loaded._tag === "Failure") {
      yield* Effect.logWarning("todos.issue.load").pipe(
        Effect.annotateLogs({ feature: "todos", outcome: "failed", errorCode: codeOf(loaded.failure) }),
      )
    }
  })

/** Answers the todos channel of engine `name` for this tab's requests until its scope closes. */
export const tabTodos = (host: { readonly name: string }) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* TodosStore
      const issues = yield* IssuesStore
      /**
       * The issue a draft is made from, as this device has it: kept on the device, else the network's first answer, from
       * its repository's issues (decision 0079 slice 1b).
       */
      const issueOf = (draft: Draft) =>
        Effect.gen(function* () {
          const repo = yield* issues.forRepo(draft.repoId)
          yield* repo.requestDetails
          const items = repo.details
          const find = Effect.map(
            items.toArray,
            (rows) => rows.find((row) => row.repoId === draft.repoId && row.number === draft.issue && row.kind === "issue"),
          )
          // expected: restore failures are logged by Collection
          yield* Effect.ignore(items.restored)
          const kept = yield* find
          if (kept !== undefined) return kept
          yield* issuesSynced(items.preload)
          return yield* find
        })
      const keep = (draft: Draft) =>
        Effect.gen(function* () {
          if (draft.issue === undefined || (draft.title !== "" && draft.prompt !== "")) return yield* store.keepDraft(draft)
          const item = yield* issueOf(draft)
          if (item === undefined) return { kept: false, issue: "missing" as const }
          return yield* store.keepDraft(draftFromIssue(draft, item))
        })
      yield* answerAskingTab({
        channel: todosChannel(host.name),
        input: TodosCall,
        answer: (call) => (call.kind === "draft" ? keep(call.draft) : store.queue(call.op)),
      })
    }),
  )
