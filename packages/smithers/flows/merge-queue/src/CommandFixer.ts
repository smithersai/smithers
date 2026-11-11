/**
 * Fix agents as commands: one process per change being fixed.
 *
 * For each brief the queue issues, this writes the brief to a file and starts
 * a command with that file's path. The brief file is rewritten when more
 * failures stream in, so a running agent reads the latest by reading the file
 * again. The agent answers by writing an answer file next to it:
 *
 * ```json
 * { "_tag": "fixed", "commit": "<the new revision's commit id>" }
 * { "_tag": "gaveUp", "detail": "<why the change must be redone>" }
 * ```
 *
 * A `fixed` answer registers the commit as the change's next revision before
 * the queue hears of it, so the candidate the queue builds next is the fix.
 * An answer the agent did not write is never invented: a process that exits
 * without an answer file is started again, and a file that is not an answer
 * is ignored.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { Repository } from "./JjRepository.ts"
import type { FixBrief } from "./Policy.ts"
import type { Answer } from "./Services.ts"
import { Fixer, Unavailable } from "./Services.ts"

/**
 * What an agent writes to answer.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AnswerFile = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("fixed"), commit: Schema.String.check(Schema.isNonEmpty()) }),
  Schema.Struct({ _tag: Schema.Literal("gaveUp"), detail: Schema.String.check(Schema.isNonEmpty()) })
])

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(AnswerFile))

/**
 * How fix agents are run.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The repository fixed revisions are registered in. */
  readonly repository: Repository
  /** The directory brief and answer files live in. It must exist. */
  readonly directory: string
  /** The command that fixes a change, given the path of its brief file and of the answer file to write. */
  readonly command: (brief: string, answer: string) => {
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd?: string | undefined
  }
  /** How often `wait` looks for answers. */
  readonly poll: Duration.Input
}

const unavailable = (detail: string) => new Unavailable({ service: "fixer", detail })

/**
 * The `Fixer` over commands.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options): Layer.Layer<Fixer, never, ChildProcessSpawner | FileSystem.FileSystem> =>
  Layer.effect(
    Fixer,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Effect.scope
      const agents = new Map<string, { failures: string; readonly fiber: Fiber.Fiber<void> }>()
      const registered = new Set<string>()

      const name = (id: number, attempt: number): string => `${id}-${attempt}`
      const briefPath = (key: string): string => `${options.directory}/${key}.brief.json`
      const answerPath = (key: string): string => `${options.directory}/${key}.answer.json`

      /** The agent's process. When it exits it is forgotten, so a missing answer starts it again. */
      const agent = (key: string): Effect.Effect<void> =>
        Effect.gen(function*() {
          const { args, command, cwd } = options.command(briefPath(key), answerPath(key))
          yield* Effect.scoped(
            Effect.flatMap(
              spawner.spawn(ChildProcess.make(command, args, cwd === undefined ? {} : { cwd })),
              (handle) => handle.exitCode
            )
          )
        }).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => agents.delete(key))))

      /** The answer the agent wrote, if it wrote one that reads as an answer. */
      const written = (key: string) =>
        Effect.gen(function*() {
          const exists = yield* fs.exists(answerPath(key))
          if (!exists) return undefined
          const decoded = decodeAnswer(yield* fs.readFileString(answerPath(key)))
          return decoded._tag === "None" ? undefined : decoded.value
        })

      const read = (id: number, attempt: number): Effect.Effect<Answer | undefined, Unavailable> =>
        Effect.gen(function*() {
          const key = name(id, attempt)
          const answer = yield* written(key)
          if (answer === undefined || answer._tag === "gaveUp") return answer
          if (!registered.has(key)) {
            const brief = JSON.parse(yield* fs.readFileString(briefPath(key))) as FixBrief
            yield* options.repository.register({ id, rev: brief.rev + 1 }, answer.commit)
            registered.add(key)
          }
          return { _tag: "fixed" } as const
        }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))))

      return Fixer.of({
        reconcile: (briefs) =>
          Effect.gen(function*() {
            for (const [key, running] of agents) {
              if (briefs.some((brief) => name(brief.id, brief.attempt) === key)) continue
              agents.delete(key)
              yield* Fiber.interrupt(running.fiber)
            }
            for (const brief of briefs) {
              const key = name(brief.id, brief.attempt)
              const failures = brief.failures.join("+")
              const running = agents.get(key)
              if (running?.failures === failures) continue
              yield* fs.writeFileString(briefPath(key), JSON.stringify(brief) + "\n")
              if (running !== undefined) {
                running.failures = failures
                continue
              }
              const answered = yield* written(key)
              if (answered !== undefined) continue
              agents.set(key, { failures, fiber: yield* Effect.forkIn(agent(key), scope) })
            }
          }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message)))),
        answer: read,
        wait: (pending) =>
          Effect.forEach(pending, (entry) => written(name(entry.id, entry.attempt))).pipe(
            Effect.map((found) => found.some((answer) => answer !== undefined)),
            Effect.orElseSucceed(() => false),
            Effect.repeat({ until: (news) => news, schedule: Schedule.spaced(options.poll) }),
            Effect.asVoid
          )
      })
    })
  )
