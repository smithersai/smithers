/**
 * The target branch as a jj bookmark, and the candidate commits the queue
 * tests and lands.
 *
 * The kernel reasons about trees: lists of change revisions. This module is
 * where a tree becomes commits. A candidate for a tree is built by replaying
 * each change's commits onto the bookmark's tip, in order, so every candidate
 * descends from the tip it is tested on. A change may be a stack of several
 * commits; the stack is replayed whole and lands whole. Landing moves the bookmark forward
 * onto the exact commit that was tested; jj refuses to move it backwards or
 * sideways. There is no side branch.
 *
 * A ledger file records which commit each change revision came from and which
 * commits each candidate made. What is on the bookmark is read from the
 * repository every time, never from memory: a commit the queue did not put
 * there is reported as a part of its own, which the driver turns into a
 * `foreign` event.
 *
 * A repository whose generated files must be rebuilt after a rebase gives a
 * `finish` command. It runs on each change once it is replayed, may resolve
 * conflicts and add commits on top, and names the commit that stands for the
 * change from then on. That commit is what is tested and what lands.
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
import * as Semaphore from "effect/Semaphore"
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
  /** The `jj` program. Defaults to `jj` on the path. */
  readonly binary?: string | undefined
  /**
   * Finishes a change replayed onto `onto`: `head` is its last commit and
   * `conflicted` says whether any of its commits has a conflict. The command
   * prints the commit that stands for the change (its last line of output)
   * and exits 0, or exits with another status when the change cannot be
   * applied there. Without it, a conflicted change cannot be applied.
   */
  readonly finish?: ((head: string, onto: string, conflicted: boolean) => Command) | undefined
}

/**
 * A command to run.
 *
 * @category models
 * @since 0.1.0
 */
export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
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
  /** The commits each change revision was handed in as: one commit, or a jj revset of a stack. */
  sources: Schema.Array(Pinned),
  /** The commit each part became in a candidate, and foreign commits. */
  pinned: Schema.Array(Pinned),
  /** The candidate commit built for each tree. A tree's prefixes have entries of their own. */
  candidates: Schema.Array(Schema.Struct({ tree: Schema.String, commit: Schema.String })),
  /** Trees whose last change could not be applied on the changes before it. */
  refused: Schema.Array(Schema.String),
  /** Commits of a stack below its last one. On the bookmark they belong to the part that follows them. */
  interior: Schema.Array(Schema.String),
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
  /** Records the commits a change revision was handed in as: a commit id, or a jj revset of a stack. */
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

    const run = (
      command: Command
    ): Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly code: number }, Unavailable> =>
      Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command.command, command.args, { cwd: command.cwd ?? options.path })
        )
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode
          ],
          { concurrency: "unbounded" }
        )
        return { stdout, stderr, code }
      })).pipe(
        Effect.catchTag(
          "PlatformError",
          (error) => Effect.fail(unavailable(`${command.command} could not run: ${error.message}`))
        )
      )

    const jj = (args: ReadonlyArray<string>): Effect.Effect<string, Unavailable> =>
      Effect.gen(function*() {
        const { code, stderr, stdout } = yield* run({
          command: options.binary ?? "jj",
          args: ["-R", options.path, "--ignore-working-copy", "--no-pager", "--color=never", ...args]
        })
        if (code !== 0) return yield* unavailable(`jj ${args[0]} exited ${code}: ${stderr.trim().split("\n").at(-1)}`)
        return stdout + stderr
      })

    const ids = (revset: string): Effect.Effect<ReadonlyArray<string>, Unavailable> =>
      Effect.map(jj(["log", "--no-graph", "-r", revset, "-T", "commit_id ++ \"\\n\""]), lines)

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
      // Written at once: the queue's tree is what follows this commit, for good.
      const created = {
        genesis,
        sources: [],
        pinned: [],
        candidates: [],
        refused: [],
        interior: [],
        foreign: firstForeign
      }
      yield* fs.writeFileString(options.ledger, JSON.stringify(created) + "\n")
      return created
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
      const parts = commits.filter((commit) => !ledger.interior.includes(commit)).map((commit): typeof Pinned.Type => {
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

    /**
     * Replays a change's commits onto `onto`. Gives the commit that stands for
     * the change and the commits below it, or nothing when the change cannot
     * be applied there: it conflicts, it is not one line of commits, or the
     * `finish` command refused it. What it made is then abandoned.
     */
    const apply = (source: string, onto: string) =>
      Effect.gen(function*() {
        const duplicated = yield* jj(["duplicate", "-r", source, "--onto", onto])
        const changes = [...duplicated.matchAll(/Duplicated \S+ as (\S+) /g)].map((match) => match[1]!)
        if (changes.length === 0) {
          return yield* unavailable(`jj duplicate printed no new commit: ${duplicated.trim()}`)
        }
        const made = changes.join(" | ")
        const refuse = Effect.as(jj(["abandon", made]), undefined)
        const heads = yield* ids(`heads(${made})`)
        // A stack with a fork has no last commit, and a commit that still
        // reaches history outside the tip, such as a merge that kept its other
        // parent, would bring that history along: neither can fast-forward.
        const stray = yield* ids(`(${onto}..(${made})) ~ (${made})`)
        if (heads.length !== 1 || stray.length > 0) return yield* refuse
        const conflicted = (yield* ids(`(${made}) & conflicts()`)).length > 0
        let commit = heads[0]!
        if (options.finish === undefined) {
          if (conflicted) return yield* refuse
        } else {
          const finished = yield* run(options.finish(commit, onto, conflicted))
          if (finished.code !== 0) return yield* refuse
          commit = lines(finished.stdout).at(-1)?.trim() ?? ""
          // The finished change must still be a clean line of commits on `onto`.
          const wrong = unavailable(`the finish command gave ${commit || "no commit"}, not a clean line on ${onto}`)
          const line = yield* Effect.orElseSucceed(ids(`${onto}..(${commit})`), () => [])
          if (line.length === 0) return yield* wrong
          const flaws = yield* ids(
            `((${onto}..${commit}) & (conflicts() | merges())) | (roots(${onto}..${commit})- ~ ${onto})`
          )
          if (flaws.length > 0) return yield* wrong
          commit = line[0]!
        }
        const below = yield* ids(`(${onto}..${commit}) ~ ${commit}`)
        return { commit, interior: below }
      })

    /**
     * One step towards the candidate for a tree: the answer when the ledger
     * already has it, or else one more change applied, with `more` to come.
     *
     * There is one commit per prefix of the tree, shared by every candidate
     * that starts with that prefix. So two runs that test the same parts in
     * the same order test the same commit, and a longer candidate descends
     * from a shorter one: landing the shorter never strands the longer. A
     * prefix whose last change could not be applied is remembered too, so the
     * other runs that contain it are answered at once.
     */
    const extend = (parts: ReadonlyArray<typeof Pinned.Type>, batch: Tree, tree: Tree) =>
      Effect.gen(function*() {
        const ledger = yield* load
        let onto = parts.at(-1)?.commit ?? ledger.genesis
        for (const [index, part] of batch.entries()) {
          const prefix = key(tree.slice(0, parts.length + index + 1))
          if (ledger.refused.includes(prefix)) return { _tag: "conflict", part } as const
          const made = ledger.candidates.find((entry) => entry.tree === prefix)
          if (made !== undefined) {
            onto = made.commit
            continue
          }
          const source = ledger.sources.find((entry) => samePart(entry, part))
          if (source === undefined) return yield* unavailable(`no commit registered for ${part.id}.${part.rev}`)
          const applied = yield* apply(source.commit, onto)
          if (applied === undefined) {
            yield* save({ ...ledger, refused: [...ledger.refused, prefix] })
            return { _tag: "conflict", part } as const
          }
          yield* save({
            ...ledger,
            candidates: [...ledger.candidates, { tree: prefix, commit: applied.commit }],
            pinned: [...ledger.pinned, { ...part, commit: applied.commit }],
            interior: [...ledger.interior, ...applied.interior]
          })
          return { _tag: "more" } as const
        }
        return { _tag: "built", commit: onto } as const
      })

    // One operation at a time: each reads the ledger, may run jj, and writes the
    // ledger back, and CI builds candidates for several runs at once.
    const lock = yield* Semaphore.make(1)
    const one = <A>(effect: Effect.Effect<A, Unavailable>): Effect.Effect<A, Unavailable> =>
      Semaphore.withPermit(lock, effect)

    // The lock is taken for one change at a time, so a short candidate is not
    // kept waiting behind a long one that shares its first changes. The tip is
    // read once: a candidate built while the bookmark moves is merely stale,
    // and a stale commit cannot land, since the bookmark only moves forwards.
    const build = (tree: Tree): Effect.Effect<Candidate, Unavailable> =>
      Effect.flatMap(one(read), ({ parts }) => {
        const batch = strip(parts, tree)
        if (batch === undefined) return Effect.succeed({ _tag: "stale" } as const)
        const next: Effect.Effect<Candidate, Unavailable> = Effect.flatMap(
          one(extend(parts, batch, tree)),
          (step) => step._tag === "more" ? next : Effect.succeed(step)
        )
        return next
      })

    return {
      register: (part, commit) =>
        one(Effect.flatMap(load, (ledger) =>
          save({
            ...ledger,
            sources: [...ledger.sources.filter((entry) => !samePart(entry, part)), { ...part, commit }]
          }))),
      tip: one(tip),
      candidate: build,
      advance: (from, to) =>
        Effect.gen(function*() {
          const current = yield* one(tip)
          if (!sameTree(current, from)) {
            return
          }
          const built = yield* build(to)
          if (built._tag !== "built") {
            return yield* unavailable(`no candidate to land for ${key(to)}`)
          }
          // jj moves a bookmark only forwards, and the candidate descends from
          // the tip it was built on: if the bookmark moved meanwhile, this fails.
          yield* one(jj(["bookmark", "set", options.bookmark, "-r", built.commit]))
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
