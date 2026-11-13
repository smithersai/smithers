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
 * commit each change became when it was applied on another. A tree is the
 * parts on the bookmark after the ledger's starting commit. The queue moves
 * that commit forward as parts settle (`settle`), and the ledger then forgets
 * what only the settled parts needed, so neither the trees nor the ledger
 * grow with the branch. What is on the bookmark is read from the
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
  /**
   * How many changes may be applied at once (each replayed and finished).
   * Defaults to 1. More than 1 needs a `finish` command that is safe to run
   * several times at once, each call on its own commits.
   */
  readonly parallel?: number | undefined
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
  /**
   * The commit the queue's trees start after: the bookmark's commit when the
   * queue started, moved forward by `settle`.
   */
  genesis: Schema.String,
  /** How many parts have been settled since the queue started: `genesis` is the commit of the last of them. */
  settled: Natural,
  /** The commits each change revision was handed in as: one commit, or a jj revset of a stack. */
  sources: Schema.Array(Pinned),
  /** The commit each part became in a candidate, and foreign commits. */
  pinned: Schema.Array(Pinned),
  /**
   * The commit a part became when it was applied on the commit `onto`. A
   * candidate for a tree is a chain of these, one per part, so two runs that
   * test the same parts in the same order test the same commits.
   */
  candidates: Schema.Array(Schema.Struct({ onto: Schema.String, id: Natural, rev: Natural, commit: Schema.String })),
  /** Parts that could not be applied on the commit `onto`. */
  refused: Schema.Array(Schema.Struct({ onto: Schema.String, id: Natural, rev: Natural })),
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
  /**
   * Moves the starting commit forward so that `count` parts are settled since
   * the queue started, and forgets what only those parts needed. Does nothing
   * when that many are settled already.
   */
  readonly settle: (count: number) => Effect.Effect<void, Unavailable>
  /** The tree on the bookmark now, from the settled parts on. */
  readonly tip: Effect.Effect<Tree, Unavailable>
  /**
   * Builds, or finds, the candidate commit for a tree that starts at the
   * bookmark's tip. `from` is how many parts were settled when the tree was
   * named; parts settled since are dropped from its front.
   */
  readonly candidate: (tree: Tree, from: number) => Effect.Effect<Candidate, Unavailable>
  /** Moves the bookmark from `from` onto the candidate for `to`, only if it is on `from`. */
  readonly advance: (from: Tree, to: Tree) => Effect.Effect<void, Unavailable>
}

const unavailable = (detail: string) => new Unavailable({ service: "target", detail })

const show = (tree: Tree): string => tree.map((part) => `${part.id}.${part.rev}`).join(",")

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

    const exec = (
      args: ReadonlyArray<string>
    ): Effect.Effect<{ readonly stdout: string; readonly stderr: string }, Unavailable> =>
      Effect.gen(function*() {
        const { code, stderr, stdout } = yield* run({
          command: options.binary ?? "jj",
          args: ["-R", options.path, "--ignore-working-copy", "--no-pager", "--color=never", ...args]
        })
        if (code !== 0) return yield* unavailable(`jj ${args[0]} exited ${code}: ${stderr.trim().split("\n").at(-1)}`)
        return { stdout, stderr }
      })

    /** Everything a jj command printed. `duplicate` names its new commits on stderr. */
    const jj = (args: ReadonlyArray<string>): Effect.Effect<string, Unavailable> =>
      Effect.map(exec(args), ({ stderr, stdout }) => stdout + stderr)

    /**
     * What a jj command printed as its answer. Commit ids are read from here
     * only: when two commands ran at once, jj also prints "Concurrent
     * modification detected, resolving automatically." on stderr, and that
     * line is no commit.
     */
    const answer = (args: ReadonlyArray<string>): Effect.Effect<string, Unavailable> =>
      Effect.map(exec(args), ({ stdout }) => stdout)

    const ids = (revset: string): Effect.Effect<ReadonlyArray<string>, Unavailable> =>
      Effect.map(answer(["log", "--no-graph", "-r", revset, "-T", "commit_id ++ \"\\n\""]), lines)

    const lines = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line !== "")

    const tipCommit = Effect.map(
      answer(["log", "--no-graph", "-r", `bookmarks(exact:"${options.bookmark}")`, "-T", "commit_id ++ \"\\n\""]),
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
        settled: 0,
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

    /**
     * The bookmark's commits after the starting commit, oldest first, each as
     * its part. New commits are pinned as foreign. The starting commit must
     * still be behind the bookmark: the queue's trees are what follows it, so
     * a bookmark that no longer descends from it has no tree to speak of.
     */
    const read = Effect.gen(function*() {
      const ledger = yield* load
      const bookmark = `bookmarks(exact:"${options.bookmark}")`
      const behindTip = lines(
        yield* answer([
          "log",
          "--no-graph",
          "--reversed",
          "-r",
          `(${ledger.genesis}..${bookmark}) | (${ledger.genesis} & ::${bookmark})`,
          "-T",
          "commit_id ++ \"\\n\""
        ])
      )
      if (!behindTip.includes(ledger.genesis)) {
        return yield* unavailable(
          `the bookmark ${options.bookmark} no longer descends from the queue's starting commit ${ledger.genesis}: `
            + "its history was rewritten"
        )
      }
      const commits = behindTip.filter((commit) => commit !== ledger.genesis)
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
     * There is one commit per part applied on a commit, shared by every
     * candidate that reaches that commit. So two runs that test the same parts
     * in the same order test the same commit, and a longer candidate descends
     * from a shorter one: landing the shorter never strands the longer. A
     * part that could not be applied on a commit is remembered too, so the
     * other runs that contain it there are answered at once. Entries name
     * commits, never trees, so they stay true when the starting commit moves.
     */
    /**
     * One step towards the candidate for a tree, from the ledger alone: the
     * answer when the ledger already has it, or else the one change that has
     * to be applied next, and the commit to apply it on.
     */
    const nextStep = (parts: ReadonlyArray<typeof Pinned.Type>, batch: Tree) =>
      Effect.gen(function*() {
        const ledger = yield* load
        let onto = parts.at(-1)?.commit ?? ledger.genesis
        for (const part of batch) {
          const here = onto
          if (ledger.refused.some((entry) => entry.onto === here && samePart(entry, part))) {
            return { _tag: "conflict", part } as const
          }
          const made = ledger.candidates.find((entry) => entry.onto === here && samePart(entry, part))
          if (made !== undefined) {
            onto = made.commit
            continue
          }
          const source = ledger.sources.find((entry) => samePart(entry, part))
          if (source === undefined) return yield* unavailable(`no commit registered for ${part.id}.${part.rev}`)
          return { _tag: "apply", part, onto, source: source.commit } as const
        }
        return { _tag: "built", commit: onto } as const
      })

    /** Whether the ledger already says what applying `part` on `onto` gives. */
    const decided = (onto: string, part: Part) =>
      Effect.map(load, (ledger) =>
        ledger.refused.some((entry) => entry.onto === onto && samePart(entry, part))
        || ledger.candidates.some((entry) => entry.onto === onto && samePart(entry, part)))

    /**
     * Records what applying `part` on `onto` gave. One application runs per
     * commit and change (`applyOnce`), so the ledger holds no answer for it yet.
     */
    const recordApplied = (
      onto: string,
      part: Part,
      applied: { readonly commit: string; readonly interior: ReadonlyArray<string> } | undefined
    ) =>
      Effect.gen(function*() {
        const ledger = yield* load
        yield* save(
          applied === undefined
            ? { ...ledger, refused: [...ledger.refused, { onto, id: part.id, rev: part.rev }] }
            : {
              ...ledger,
              candidates: [...ledger.candidates, { onto, id: part.id, rev: part.rev, commit: applied.commit }],
              pinned: [...ledger.pinned, { id: part.id, rev: part.rev, commit: applied.commit }],
              interior: [...ledger.interior, ...applied.interior]
            }
        )
      })

    // The count this process knows the ledger has settled. Only this process moves it.
    let settledHere = 0

    // One ledger operation at a time: each reads the ledger and may write it
    // back, and CI builds candidates for several runs at once.
    const lock = yield* Semaphore.make(1)
    const one = <A>(effect: Effect.Effect<A, Unavailable>): Effect.Effect<A, Unavailable> =>
      Semaphore.withPermit(lock, effect)

    // Applying a change (replaying it and running `finish`) is the slow part,
    // minutes when files are regenerated. It runs outside the ledger's lock,
    // at most `parallel` at a time, and once per commit and change: a second
    // builder that needs the same one waits for the first and reads its answer.
    const applies = yield* Semaphore.make(Math.max(1, options.parallel ?? 1))
    const applying = new Map<string, Semaphore.Semaphore>()
    const applyOnce = (onto: string, part: Part, source: string): Effect.Effect<void, Unavailable> => {
      const key = `${onto} ${part.id}.${part.rev}`
      let mine = applying.get(key)
      if (mine === undefined) {
        mine = Semaphore.makeUnsafe(1)
        applying.set(key, mine)
      }
      return Semaphore.withPermit(
        mine,
        Effect.gen(function*() {
          if (yield* one(decided(onto, part))) return
          const applied = yield* Semaphore.withPermit(applies, apply(source, onto))
          yield* one(recordApplied(onto, part, applied))
        })
      ).pipe(Effect.ensuring(Effect.sync(() => void applying.delete(key))))
    }

    // The ledger's lock is taken for one look at a time, so a short candidate is
    // not kept waiting behind a long one that shares its first changes. The tip is
    // read once: a candidate built while the bookmark moves is merely stale,
    // and a stale commit cannot land, since the bookmark only moves forwards.
    //
    // A tree named when fewer parts were settled starts with the parts settled
    // since: the queue only settles parts every run it holds was built on.
    // They are dropped, which leaves the tree as the ledger speaks of it now.
    const build = (tree: Tree, from: number): Effect.Effect<Candidate, Unavailable> =>
      Effect.flatMap(one(read), ({ ledger, parts }) => {
        const batch = from > ledger.settled ? undefined : strip(parts, tree.slice(ledger.settled - from))
        if (batch === undefined) return Effect.succeed({ _tag: "stale" } as const)
        const next: Effect.Effect<Candidate, Unavailable> = Effect.flatMap(
          one(nextStep(parts, batch)),
          (step) =>
            step._tag === "apply"
              ? Effect.flatMap(applyOnce(step.onto, step.part, step.source), () => next)
              : Effect.succeed(step)
        )
        return next
      })

    /**
     * Settles the first `more` parts on the bookmark: the last of them becomes
     * the starting commit. The ledger keeps only what a commit after it can
     * still need: entries whose commits are on the bookmark after the new
     * start or on a candidate built there, and the sources of changes that
     * have not landed among the settled parts.
     */
    const settleMore = (ledger: typeof Ledger.Type, parts: ReadonlyArray<typeof Pinned.Type>, more: number) =>
      Effect.gen(function*() {
        const gone = parts.slice(0, more)
        const genesis = gone.at(-1)!.commit
        // What can still matter descends from the new start: the commits on
        // the bookmark after it, and the candidates built on those. A
        // candidate built on a tip the bookmark has left does not.
        const heads = [
          `bookmarks(exact:"${options.bookmark}")`,
          ...ledger.candidates.map((entry) => `present(${entry.commit})`)
        ]
        const alive = new Set(yield* ids(`(${genesis}::(${heads.join(" | ")})) ~ ${genesis}`))
        const standing = (commit: string): boolean => commit === genesis || alive.has(commit)
        yield* save({
          ...ledger,
          genesis,
          settled: ledger.settled + more,
          sources: ledger.sources.filter((entry) => !gone.some((part) => part.id === entry.id)),
          pinned: ledger.pinned.filter((entry) => alive.has(entry.commit)),
          candidates: ledger.candidates.filter((entry) => standing(entry.onto) && alive.has(entry.commit)),
          refused: ledger.refused.filter((entry) => standing(entry.onto)),
          interior: ledger.interior.filter((commit) => alive.has(commit))
        })
      })

    return {
      register: (part, commit) =>
        one(Effect.flatMap(load, (ledger) =>
          save({
            ...ledger,
            sources: [...ledger.sources.filter((entry) => !samePart(entry, part)), { ...part, commit }]
          }))),
      settle: (count) =>
        one(Effect.gen(function*() {
          // Asked every round, and nearly always for the count already reached: answer that without reading.
          if (count <= settledHere) return
          const { ledger, parts } = yield* read
          const more = count - ledger.settled
          if (more > parts.length) {
            return yield* unavailable(
              `cannot settle ${count} parts: ${ledger.settled} are settled and the bookmark holds ${parts.length} more`
            )
          }
          if (more > 0) yield* settleMore(ledger, parts, more)
          settledHere = Math.max(count, ledger.settled)
        })),
      tip: one(tip),
      candidate: build,
      advance: (from, to) =>
        Effect.gen(function*() {
          const { ledger, parts } = yield* one(read)
          if (!sameTree(parts.map((part) => ({ id: part.id, rev: part.rev })), from)) {
            return
          }
          const built = yield* build(to, ledger.settled)
          if (built._tag !== "built") {
            return yield* unavailable(`no candidate to land for ${show(to)}`)
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
      settle: repository.settle,
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
