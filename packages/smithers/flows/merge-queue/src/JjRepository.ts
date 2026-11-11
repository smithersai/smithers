/**
 * The target branch as a jj bookmark, and the candidate commits the queue
 * tests and lands.
 *
 * The kernel reasons about trees: lists of change revisions. This module is
 * where a tree becomes commits. A candidate for a tree is built by replaying
 * each change's commit onto the bookmark's tip, in order, so every candidate
 * descends from the tip it is tested on. Landing moves the bookmark forward
 * onto the exact commit that was tested; jj refuses to move it backwards or
 * sideways. There is no side branch.
 *
 * A ledger file records which commit each change revision came from and which
 * commits each candidate made. What is on the bookmark is read from the
 * repository every time, never from memory: a commit the queue did not put
 * there is reported as a part of its own, which the driver turns into a
 * `foreign` event.
 *
 * It runs `jj` through Effect's `ChildProcessSpawner` and keeps the ledger
 * through `FileSystem`, with `--ignore-working-copy`, so it never touches a
 * checkout someone is editing. The bookmark is local; publishing it to a
 * remote is the host's job.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Part, Tree } from "./Basic.ts"
import { samePart, sameTree } from "./Basic.ts"
import { Target, Unavailable } from "./Services.ts"
import { strip } from "./Step.ts"

/**
 * Where the repository, its bookmark and the ledger are.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The jj repository's root directory. */
  readonly path: string
  /** The bookmark the queue lands on. */
  readonly bookmark: string
  /** The ledger file. */
  readonly ledger: string
  /** How often `wait` looks at the bookmark. */
  readonly poll: Duration.Input
}

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Pinned = Schema.Struct({ id: Natural, rev: Natural, commit: Schema.String })

/**
 * What the ledger file holds.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Ledger = Schema.Struct({
  /** The bookmark's commit when the queue started. The queue's tree is what follows it. */
  genesis: Schema.String,
  /** The commit each change revision was handed in as. */
  sources: Schema.Array(Pinned),
  /** The commit each part became in a candidate, and foreign commits. */
  pinned: Schema.Array(Pinned),
  /** The candidates built so far: the tree, and the commit of each part after the tip it was built on. */
  candidates: Schema.Array(Schema.Struct({ tree: Schema.String, commits: Schema.Array(Schema.String) })),
  /** The id the next foreign commit gets. */
  foreign: Natural
})

/**
 * The first id given to a commit someone else put on the bookmark. Changes
 * handed to the queue use ids below it.
 *
 * @category constants
 * @since 0.1.0
 */
export const firstForeign = 1_000_000_000

/**
 * What building a candidate gives: the commit to test, the part that does not
 * apply cleanly on the parts before it, or that the tree no longer starts at
 * the bookmark's tip.
 *
 * @category models
 * @since 0.1.0
 */
export type Candidate =
  | { readonly _tag: "built"; readonly commit: string }
  | { readonly _tag: "conflict"; readonly part: Part }
  | { readonly _tag: "stale" }

/**
 * The repository as the queue uses it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Repository {
  /** Records the commit a change revision was handed in as. */
  readonly register: (part: Part, commit: string) => Effect.Effect<void, Unavailable>
  /** The tree on the bookmark now. */
  readonly tip: Effect.Effect<Tree, Unavailable>
  /** Builds, or finds, the candidate commit for a tree that starts at the bookmark's tip. */
  readonly candidate: (tree: Tree) => Effect.Effect<Candidate, Unavailable>
  /** Moves the bookmark from `from` onto the candidate for `to`, only if it is on `from`. */
  readonly advance: (from: Tree, to: Tree) => Effect.Effect<void, Unavailable>
}

const unavailable = (detail: string) => new Unavailable({ service: "target", detail })

const key = (tree: Tree): string => tree.map((part) => `${part.id}.${part.rev}`).join(",")

const decodeLedger = Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger))

/**
 * Opens the repository for the queue.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<Repository, never, FileSystem.FileSystem | ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner

    const jj = (args: ReadonlyArray<string>): Effect.Effect<string, Unavailable> =>
      Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            "jj",
            ["-R", options.path, "--ignore-working-copy", "--no-pager", "--color=never", ...args],
            { cwd: options.path }
          )
        )
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode
          ],
          { concurrency: "unbounded" }
        )
        if (code !== 0) return yield* unavailable(`jj ${args[0]} exited ${code}: ${stderr.trim().split("\n").at(-1)}`)
        return stdout + stderr
      })).pipe(
        Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(`jj could not run: ${error.message}`)))
      )

    const lines = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line !== "")

    const tipCommit = Effect.map(
      jj(["log", "--no-graph", "-r", `bookmarks(exact:"${options.bookmark}")`, "-T", "commit_id ++ \"\\n\""]),
      (text) => lines(text)[0]
    )

    const load: Effect.Effect<typeof Ledger.Type, Unavailable> = Effect.gen(function*() {
      const exists = yield* fs.exists(options.ledger)
      if (exists) return yield* decodeLedger(yield* fs.readFileString(options.ledger))
      const genesis = yield* tipCommit
      if (genesis === undefined) return yield* unavailable(`no bookmark ${options.bookmark}`)
      return { genesis, sources: [], pinned: [], candidates: [], foreign: firstForeign }
    }).pipe(
      Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))),
      Effect.catchTag(
        "SchemaError",
        (error) => Effect.fail(unavailable(`the ledger is not readable: ${error.message}`))
      )
    )

    const save = (ledger: typeof Ledger.Type): Effect.Effect<void, Unavailable> =>
      fs.writeFileString(options.ledger, JSON.stringify(ledger) + "\n").pipe(
        Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message)))
      )

    /** The bookmark's commits after genesis, oldest first, each as its part. New commits are pinned as foreign. */
    const read = Effect.gen(function*() {
      const ledger = yield* load
      const commits = lines(
        yield* jj([
          "log",
          "--no-graph",
          "--reversed",
          "-r",
          `${ledger.genesis}..bookmarks(exact:"${options.bookmark}")`,
          "-T",
          "commit_id ++ \"\\n\""
        ])
      )
      let foreign = ledger.foreign
      const pinned = [...ledger.pinned]
      const parts = commits.map((commit): typeof Pinned.Type => {
        const known = pinned.find((entry) => entry.commit === commit)
        if (known !== undefined) return known
        const added = { id: foreign++, rev: 0, commit }
        pinned.push(added)
        return added
      })
      const next = { ...ledger, pinned, foreign }
      if (foreign !== ledger.foreign) yield* save(next)
      return { ledger: next, parts }
    })

    const tip = Effect.map(read, ({ parts }): Tree => parts.map((part) => ({ id: part.id, rev: part.rev })))

    const build = (tree: Tree) =>
      Effect.gen(function*() {
        const { ledger, parts } = yield* read
        const batch = strip(parts, tree)
        if (batch === undefined) return { _tag: "stale" } as const
        const made = ledger.candidates.find((entry) => entry.tree === key(tree))
        const last = made?.commits.at(-1) ?? parts.at(-1)?.commit ?? ledger.genesis
        if (made !== undefined || batch.length === 0) return { _tag: "built", commit: last, ledger, batch } as const
        const commits: Array<string> = []
        let onto = last
        for (const part of batch) {
          const source = ledger.sources.find((entry) => samePart(entry, part))
          if (source === undefined) return yield* unavailable(`no commit registered for ${part.id}.${part.rev}`)
          const duplicated = yield* jj(["duplicate", "-r", source.commit, "--onto", onto])
          const change = /Duplicated \S+ as (\S+) /.exec(duplicated)?.[1]
          if (change === undefined) {
            return yield* unavailable(`jj duplicate printed no new commit: ${duplicated.trim()}`)
          }
          const [commit, conflict] = lines(
            yield* jj(["log", "--no-graph", "-r", change, "-T", "commit_id ++ \"\\n\" ++ conflict ++ \"\\n\""])
          )
          if (conflict === "true") {
            yield* jj(["abandon", change])
            return { _tag: "conflict", part } as const
          }
          commits.push(commit!)
          onto = commit!
        }
        const next = {
          ...ledger,
          pinned: [...ledger.pinned, ...batch.map((part, index) => ({ ...part, commit: commits[index]! }))],
          candidates: [...ledger.candidates, { tree: key(tree), commits }]
        }
        yield* save(next)
        return { _tag: "built", commit: onto, ledger: next, batch } as const
      })

    return {
      register: (part, commit) =>
        Effect.flatMap(load, (ledger) =>
          save({
            ...ledger,
            sources: [...ledger.sources.filter((entry) => !samePart(entry, part)), { ...part, commit }]
          })),
      tip,
      candidate: (tree) =>
        Effect.map(build(tree), (built): Candidate =>
          built._tag === "built" ? { _tag: "built", commit: built.commit } : built),
      advance: (from, to) =>
        Effect.gen(function*() {
          const current = yield* tip
          if (!sameTree(current, from)) {
            return
          }
          const built = yield* build(to)
          if (built._tag !== "built") {
            return yield* unavailable(`no candidate to land for ${key(to)}`)
          }
          yield* jj(["bookmark", "set", options.bookmark, "-r", built.commit])
        })
    }
  })

/**
 * The `Target` over a repository.
 *
 * @category layers
 * @since 0.1.0
 */
export const target = (repository: Repository, poll: Duration.Input): Layer.Layer<Target> =>
  Layer.succeed(
    Target,
    Target.of({
      tip: repository.tip,
      advance: repository.advance,
      wait: (tree) =>
        repository.tip.pipe(
          Effect.orElseSucceed(() => tree),
          Effect.repeat({ until: (current) => !sameTree(current, tree), schedule: Schedule.spaced(poll) }),
          Effect.asVoid
        )
    })
  )
