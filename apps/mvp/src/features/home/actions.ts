import { Home } from "@smthrs/views"
import { Clock, Effect, FiberHandle, Option, Random, Semaphore } from "effect"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import { aboutOf, isReady, put, ready, shownRepository } from "../repo/actions"
import { RepoClient } from "../repo/api"
import { isRepository, repoId } from "../repo/contract"
import { RepoStore } from "../repo/store"
import { IssuesStore } from "../issues/store"
import { TodosStore } from "../todos/store"
import { HomeClient } from "./api"
import { codeHref, HOME_FILE, NEW_BRANCH } from "./contract"
import { recordAction, recordAnswer, recordFile, recordResolve } from "./metrics"
import { fileRowOf, homeRowOf, homeRowOfText, markdownPaths, type ReadResult } from "./reads"
import { CURRENT, type CuratedRow, type CurrentRow, fileKey, homeKey, type HomeRow } from "./rows"
import { HomeStore } from "./store"
import { homePageOf, liveKindsOf } from "./view"

// What the tab does for a repository's home (decision 0014 §4). Opening a repository asks ChatApi, at once, who the
// person is on it and for Smithers' curated home for it; before a clone, reads its own home from what GitHub says of
// it; and once the repository is ready on this device, reads its own home at the default branch's head, then the files
// its Markdown blocks name, each at the same commit. Reading
// runs no flow and changes nothing: a home at a commit never changes, so it is read once and kept. A live block the
// person may see has its rows synced: a `stack` block opens the repository's stack.

/** Changes the current row. */
const setCurrent = (fields: Partial<Omit<CurrentRow, "id">>) =>
  Effect.flatMap(HomeStore, ({ current }) => Effect.orDie(current.update(CURRENT, (row) => void Object.assign(row, fields))))

/** RepoApi's status on a refused read, when it answered one. */
const statusOf = (result: ReadResult) => (result._tag === "Failure" ? result.failure.status : undefined)

/** The repository's home at `sha`: the one this device has, or `.smithers/home.json` read now. */
const resolve = (repository: { readonly owner: string; readonly name: string }, key: string, sha: string) =>
  Effect.gen(function* () {
    const store = yield* HomeStore
    let gate = store.homeReads.get(key)
    if (gate === undefined) {
      gate = Semaphore.makeUnsafe(1)
      store.homeReads.set(key, gate)
    }
    return yield* gate.withPermits(1)(Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const kept = yield* store.homes.get(key)
      if (Option.isSome(kept) && kept.value.state !== "unreadable") {
        yield* recordResolve(kept.value, "cached", 0, undefined)
        return kept.value
      }
      const result = yield* Effect.result((yield* RepoClient).blob(repository.owner, repository.name, sha, HOME_FILE))
      const row = homeRowOf(key, result)
      yield* put<HomeRow>(store.homes, key, row)
      yield* recordResolve(row, row.state, (yield* Clock.currentTimeMillis) - startedAt, statusOf(result))
      return row
    }))
  }).pipe(Effect.withSpan("home.resolve"))

/** Reads a Markdown block's file at the home's commit, unless this tab has it or is reading it. */
const ensureFile = (repository: { readonly owner: string; readonly name: string }, home: string, sha: string, path: string) =>
  Effect.gen(function* () {
    const store = yield* HomeStore
    const key = fileKey(home, path)
    const found = yield* store.files.get(key)
    if (Option.isSome(found) && found.value.state !== "failed") return
    yield* put(store.files, key, { key, home, path, state: "loading" as const, text: null })
    const startedAt = yield* Clock.currentTimeMillis
    const result = yield* Effect.result((yield* RepoClient).blob(repository.owner, repository.name, sha, path)).pipe(
      Effect.onInterrupt(() => Effect.gen(function* () {
        yield* put(store.files, key, { key, home, path, state: "failed" as const, text: null })
        yield* recordFile("interrupted", (yield* Clock.currentTimeMillis) - startedAt, undefined)
      })),
    )
    const row = fileRowOf(key, home, path, result)
    yield* put(store.files, key, row)
    yield* recordFile(row.state, (yield* Clock.currentTimeMillis) - startedAt, statusOf(result))
  })

/**
 * Syncs the rows of the live blocks this person may see on the shown home: a `stack` block in a section their
 * audience may see opens the repository's stack, and an `issues` block its issues (decision 0079 slice 1b). Run after
 * each part of the home arrives, so the last one sees it all.
 */
const syncLive = (id: string) =>
  Effect.gen(function* () {
    const store = yield* HomeStore
    const todos = yield* Effect.serviceOption(TodosStore)
    const issues = yield* Effect.serviceOption(IssuesStore)
    const current = Option.getOrThrow(yield* store.current.get(CURRENT))
    // What the page shows decides what it reads: the same rows, through the same `homePageOf`.
    const declared = Option.getOrUndefined(yield* store.homes.get(current.key ?? ""))
    const curated = Option.getOrUndefined(yield* store.curated.get(id))
    const kinds = liveKindsOf(homePageOf(current, declared, curated))
    if (Option.isSome(todos) && kinds.has("stack")) {
      yield* todos.value.stackOf(id)
      yield* setCurrent({ stack: id })
    }
    if (Option.isSome(issues) && kinds.has("issues")) {
      yield* issues.value.forRepo(id)
      yield* setCurrent({ issues: id })
    }
  })

/**
 * Asks ChatApi who the person is on the repository and for its curated home: the curated row takes the answer, and the
 * current row the audience. A failed answer keeps the curated row this device had.
 */
const answer = (owner: string, name: string, id: string) =>
  Effect.gen(function* () {
    const store = yield* HomeStore
    const startedAt = yield* Clock.currentTimeMillis
    const result = yield* Effect.result((yield* HomeClient).answer(owner, name))
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt
    if (result._tag === "Failure") {
      yield* setCurrent({ answering: false })
      return yield* recordAnswer("unreadable", undefined, 0, durationMs, result.failure.status)
    }
    const { audience, curated } = result.success
    const row = curatedRowOf(id, curated)
    yield* put<CuratedRow>(store.curated, id, row)
    yield* setCurrent({ audience, answering: false, curatedDocs: curated?.docs ?? null })
    yield* recordAnswer(row.state, audience, row.sections.length, durationMs, undefined)
  }).pipe(Effect.withSpan("home.answer"))

/** The curated row for ChatApi's answer: Smithers' curated home for the repository, or none. */
const curatedRowOf = (
  id: string,
  curated: { readonly defaultBranch: string; readonly sections: CuratedRow["sections"] } | null,
): CuratedRow =>
  curated === null
    ? { key: id, state: "absent", defaultBranch: null, sections: [] }
    : { key: id, state: "declared", defaultBranch: curated.defaultBranch, sections: curated.sections }

/** The repository's own home: once it is ready, its home at the head, then its Markdown blocks' files. */
const declared = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* ready(id)
    const key = homeKey(id, repository.headSha)
    // Ready on this device: its own read wins over what GitHub says.
    yield* setCurrent({ key, defaultBranch: repository.defaultBranch, previewing: false })
    const home = yield* resolve(repository, key, repository.headSha)
    yield* Effect.forEach(
      markdownPaths(home.sections),
      (path) => ensureFile(repository, key, repository.headSha, path),
      { concurrency: "unbounded", discard: true },
    )
  })

/**
 * The docs index the repository's own home names at its newest commit (docs/features/docs.md), from what GitHub says
 * of it, which the page loads anyway: the Docs tab shows from it, cloned or not.
 */
const docsOf = (owner: string, name: string) =>
  Effect.gen(function* () {
    const text = (yield* aboutOf(owner, name)).about?.home ?? null
    const read = text === null ? undefined : Home.read(text)
    // Opening another repository interrupts this read (`open`'s loader), so the row is still this repository's.
    yield* setCurrent({ docs: read?._tag === "Declared" ? read.docs ?? null : null })
  })

/**
 * The repository's own home before a clone: what GitHub says of it carries its `.smithers/home.json` at its newest
 * commit, so a visitor sees the home the clone will have. Only until the repository is ready on this device, whose own
 * read wins, and only a home that shows whole without the clone: one with a Markdown block, whose file needs the
 * clone, an invalid one, or none, leaves the tree's page until then.
 */
const preview = (owner: string, name: string, id: string) =>
  Effect.gen(function* () {
    const store = yield* HomeStore
    if (isReady(yield* (yield* RepoStore).repositories.get(id))) return
    const startedAt = yield* Clock.currentTimeMillis
    const about = (yield* aboutOf(owner, name)).about
    const text = about?.home ?? null
    if (about === null || about.head === null || text === null) return
    const key = homeKey(id, about.head.sha)
    const row = homeRowOfText(key, text)
    if (row.state !== "declared" || markdownPaths(row.sections).length > 0) return
    if (Option.isNone(yield* store.homes.get(key))) yield* put<HomeRow>(store.homes, key, row)
    // Opening another repository interrupts this read; a clone that landed meanwhile wins with its own read.
    let selected = false
    yield* Effect.orDie(store.current.update(CURRENT, (current) => {
      if (current.key !== null) return
      current.key = key
      current.defaultBranch = about.defaultBranch
      selected = true
    }))
    if (selected) yield* recordResolve(row, "preview", (yield* Clock.currentTimeMillis) - startedAt, undefined)
  }).pipe(
    // `open` interrupts this read before it names another repository, so the row is still this one's here.
    Effect.ensuring(Effect.flatMap(HomeStore, ({ current }) =>
      Effect.orDie(current.update(CURRENT, (row) => {
        row.previewing = false
      })))),
    Effect.withSpan("home.preview"),
  )

/**
 * Reads `owner/name`'s homes into this tab without showing them: Smithers' curated one, which ChatApi answers, and,
 * once the repository is ready on this device, its own home and its Markdown blocks' files. Ends once they are read,
 * once the device can tell the repository isn't ready (the page then shows the tree's own state), or after the
 * repository store's `pageWait`, whichever is first. A link's hover or focus runs it (the router's intent preload),
 * and so does every navigation before `open`, which then shows the home at once instead of a skeleton. Who the person
 * is on the repository waits for `open`: it belongs to the shown page.
 */
export const warm = (owner: string, name: string) =>
  Effect.gen(function* () {
    if (!isRepository(owner, name)) return
    const id = repoId(owner, name)
    const curated = Effect.gen(function* () {
      const store = yield* HomeStore
      if (Option.isSome(yield* store.curated.get(id))) return
      // A warm that can't read it leaves it to `open`, which asks again and logs a failure (`home.answer`).
      const result = yield* Effect.result((yield* HomeClient).answer(owner, name))
      if (result._tag === "Success") yield* put<CuratedRow>(store.curated, id, curatedRowOf(id, result.success.curated))
    })
    const own = Effect.gen(function* () {
      const repository = yield* shownRepository(id)
      if (Option.isNone(repository)) return
      const { headSha } = repository.value
      const key = homeKey(id, headSha)
      const home = yield* resolve(repository.value, key, headSha)
      yield* Effect.forEach(markdownPaths(home.sections), (path) => ensureFile(repository.value, key, headSha, path), {
        concurrency: "unbounded",
        discard: true,
      })
    })
    yield* Effect.all([curated, own], { concurrency: "unbounded", discard: true })
  }).pipe(
    (warming) => Effect.flatMap(RepoStore, (repo) => Effect.timeoutOption(warming, repo.pageWait)),
    Effect.asVoid,
    Effect.withSpan("home.warm"),
    Effect.annotateLogs({ feature: "home" }),
  )

/**
 * Opens `owner/name`'s home for the routed page: the current row names it at once, with its home's key when the
 * repository is ready on this device, so a home `warm` read shows at once; and the tab reads what it needs in its
 * scope: who the person is and the curated home at once, the repository's own home once it is ready. Opening another
 * repository interrupts a load still waiting.
 */
export const open = (owner: string, name: string) =>
  Effect.gen(function* () {
    const store = yield* HomeStore
    if (!isRepository(owner, name)) {
      store.actions.clear()
      yield* FiberHandle.clear(store.loader)
      yield* setCurrent({
        owner,
        name,
        repoId: null,
        key: null,
        defaultBranch: null,
        audience: null,
        viewing: null,
        answering: false,
        previewing: false,
        stack: null,
        issues: null,
        failure: null,
        running: [],
      })
      return
    }
    const id = repoId(owner, name)
    // Another page of the same repository keeps the home it shows while its head is read again.
    const shown = Option.getOrThrow(yield* store.current.get(CURRENT))
    const same = shown.repoId === id
    if (!same) store.actions.clear()
    yield* FiberHandle.clear(store.loader)
    const row = yield* (yield* RepoStore).repositories.get(id)
    const head = isReady(row)
      ? { key: homeKey(id, row.value.headSha), defaultBranch: row.value.defaultBranch }
      : { key: null, defaultBranch: null }
    yield* setCurrent({
      owner,
      name,
      repoId: id,
      answering: true,
      ...(same ? {} : { ...head, previewing: head.key === null, docs: null, curatedDocs: null, audience: null, viewing: null, stack: null, issues: null, failure: null, running: [] }),
    })
    const part = <R>(load: Effect.Effect<void, never, R>) => Effect.andThen(load, syncLive(id))
    yield* FiberHandle.run(
      store.loader,
      Effect.all([part(answer(owner, name, id)), part(declared(id)), part(preview(owner, name, id)), part(docsOf(owner, name))], {
        concurrency: "unbounded",
        discard: true,
      }),
      { startImmediately: true },
    )
  }).pipe(Effect.annotateLogs({ feature: "home" }))

/** A new branch's name: the person's login, else `smithers`, and six random letters and digits. */
const branchName = (login: string | null) =>
  Effect.map(
    Random.nextIntBetween(0, 36 ** 6, { halfOpen: true }),
    (n) => `${login ?? "smithers"}/${n.toString(36).padStart(6, "0")}`,
  )

/**
 * Runs an `action` block's flow on the routed repository: `branch.new` makes a new branch at the default branch's head
 * through `branch/create`, the flow `/branch.new` and the agent run, and answers the page to open, its workspace. The
 * action shows running until the flow settles; a failure says why on the current row, and answers nothing. A flow the
 * home doesn't run as an action answers nothing.
 */
export const runAction = (flow: string, login: string | null) =>
  Effect.gen(function* () {
    if (flow !== NEW_BRANCH) return undefined
    const store = yield* HomeStore
    const current = Option.getOrThrow(yield* store.current.get(CURRENT))
    if (current.repoId === null || current.running.includes(flow)) return undefined
    const { owner, name } = current
    const token = Symbol()
    store.actions.set(flow, token)
    yield* setCurrent({ running: [...current.running, flow], failure: null })
    const startedAt = yield* Clock.currentTimeMillis
    const branch = yield* branchName(login)
    const dispatched = yield* Effect.result(
      (yield* FlowDispatch).dispatch("branch/create", { repo: `${owner}/${name}`, branch }, { door: "button" }),
    )
    const done = dispatched._tag === "Success" && dispatched.success._tag === "Done" ? dispatched.success.value : undefined
    const error = dispatched._tag === "Success" && dispatched.success._tag === "Failed" ? dispatched.success.error : undefined
    const reason = done !== undefined
      ? null
      : error?._tag === "@smthrs/mvp/branch/BranchTrackRefused"
      ? error.reason
      : "unavailable"
    const now = Option.getOrThrow(yield* store.current.get(CURRENT))
    yield* recordAction(flow, reason ?? "done", (yield* Clock.currentTimeMillis) - startedAt)
    if (now.repoId !== current.repoId || store.actions.get(flow) !== token) return undefined
    store.actions.delete(flow)
    yield* setCurrent({ running: now.running.filter((each) => each !== flow), failure: reason })
    return done === undefined ? undefined : codeHref(owner, name, done.name)
  }).pipe(Effect.withSpan("home.action"), Effect.annotateLogs({ feature: "home" }))

/**
 * Shows the routed repository's home in the view `audience` (SCOPE-14): the person's own or a lower one that shows
 * something. Any other view, one above their own included, changes nothing: who sees what stays ChatApi's to decide,
 * and a lower view only hides sections the page already has. Opening another repository goes back to their own.
 */
export const view = (audience: Home.Audience) =>
  Effect.gen(function* () {
    const store = yield* HomeStore
    const current = Option.getOrThrow(yield* store.current.get(CURRENT))
    const declared = Option.getOrUndefined(yield* store.homes.get(current.key ?? ""))
    const curated = Option.getOrUndefined(yield* store.curated.get(current.repoId ?? ""))
    const page = homePageOf({ ...current, viewing: null }, declared, curated)
    if (page.kind !== "home" || !page.views.includes(audience)) return
    yield* setCurrent({ viewing: audience === page.audience ? null : audience })
  }).pipe(Effect.annotateLogs({ feature: "home" }))

/** What a button on the page started, settled: a rejection is logged as `home.navigate` by its code, never its message. */
export const watch = (what: "ask" | "action", started: Promise<unknown>) =>
  Effect.tryPromise({ try: () => started, catch: (rejection) => rejection }).pipe(
    Effect.catch((rejection) =>
      Effect.logWarning("home.navigate").pipe(
        Effect.annotateLogs({ feature: "home", what, outcome: "failed", errorCode: codeOf(rejection) }),
      )
    ),
    Effect.asVoid,
  )
