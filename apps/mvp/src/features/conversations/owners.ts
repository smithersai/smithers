import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Fiber, Layer, Schema, type Scope, Semaphore, Stream } from "effect"
import { ConversationRefusalsStore } from "../../device/registry"
import { signedInChanges, signedInShapeSource } from "../auth/source.vibe"
import { AuthStore } from "../auth/store.vibe"
import { BranchStore } from "../branch/store.vibe"
import type { Gated, Source } from "../repo/gate"
import { repoId } from "../repo/contract"
import { RepoStore } from "../repo/store.vibe"
import { ConversationAccess } from "./access"
import { MY_CONVERSATIONS_SHAPE_ROUTE } from "./contract"
import * as Marks from "./marks"
import { Mine, type Refused } from "./schema"

// Which repository each of the person's conversations is of (decision 0110, 2026-11-03, the data gate): the person's
// `conversation_people` rows, synced by Electric and kept on the device. A conversation's rows (its messages, its views,
// its runs' waits) name no repository of their own; they show only while the conversation's repository may, through
// `ofShown`. The home conversation is the person's own: it shows by the id the session answer names (auth `Session`
// `homeConversationId`), with or without its row. A verified branch-opening cache also identifies its repository. With neither receipt, a conversation shows nothing. Below
// every store that keeps a conversation's rows, and below the conversations' list (store.ts), which reads `mine`.
//
// A conversation ChatApi refused to let the person read shows nothing either (`refuse`), whatever its repository says:
// a branch can stop being shared while its repository stays the person's. Every row that shows through `ofShown`, its
// messages, its views, the questions this device queued in it, goes with that one answer, and returns with the next
// read ChatApi answers whole. So does every row that joins `shown`: the runs the person's pages list and the waits
// `core/waits` publishes (src/features/status/store.ts). The refusal is kept on the device, which is one person's
// (`ConversationRefusalsStore`), so a reload offline, or another tab, shows nothing of the conversation either; and
// nothing of any conversation shows before the device's refusals are read.
//
// Each refusal is a row of its own. A tab hears the rows the other tabs write as they are stored, so a tab that never
// reads the conversation hides it too. A read answered whole removes only the refusals its tab knew of when the read
// began (`fence`): one recorded since, here or in another tab, stands until a read that began after it is answered.
// A refusal is also written to Web Storage in the call that hides it (marks.ts), so one the device's store did not
// take, or had not yet taken when the tab closed, still hides the conversation on the next load.
//
// Neither store may take it: a full disk refuses the row, and full Web Storage the key. So a conversation shows on a
// load only while Web Storage says it is open (marks.ts `granted`), or once ChatApi answered for it on that load. A
// refusal takes that word away in its call, by a removal, which full storage still does: the next load shows nothing
// of the conversation, whatever became of the refusal itself. No key is never read as a conversation new to the
// device, and a row of the person's list is never ChatApi's word that they may read its conversation: the list is
// their history, which outlives a share taken away. A conversation the list names that nothing says is open is asked
// of ChatApi (`ConversationAccess`), and shows only by its answer, taken as any read's is (`clear`).
//
// Every refusal moves the device's generation (marks.ts `epoch`), in the call and again as it is recorded, and an
// answer is weighed in a turn no other tab shares (marks.ts `lock`): one whose read began at another generation, or
// before this tab came to know any refusal it knows now, removes nothing and opens nothing, here or on the device.
// So a refusal is never said again between an answer's comparison and its removals, and one no store could record
// still stops every older answer. A durable page rejects an answer whose read began with no generation.
//
// A read refused again while its conversation is hidden is a refusal too: the refusal the tab holds of it moves past
// every read that had begun (`fence`), here and, through Web Storage, in every other tab, so the answer to none of
// them removes it. A branch ChatApi refused is refused whatever conversation is its own (`refuseBranch`): one the
// device comes to name for it later, as its rows are restored or arrive, is refused as it is named.

/**
 * A conversation of the person's and its repository (`github/owner/name`). `home` marks the person's home conversation,
 * as the session answer names it: theirs by who they are, so it shows with no repository's say.
 */
export const OwnedRow = Schema.Struct({ conversationId: Schema.String, repoId: Schema.String, home: Schema.Boolean })
export type Owned = typeof OwnedRow.Type

/**
 * Where a tab's knowledge of refusals stood as a read began: its own order over every refusal it knows, the rows of
 * the device's store as it holds them included (`seq`), the device's generation (`epoch`, none where storage never
 * took one), how many refusals the process's tabs were given (`memory`), and what Web Storage said of every
 * conversation then (`standing`), which is the other tabs' word before the browser tells of it.
 */
export interface Fence {
  readonly seq: number
  readonly principal: string | undefined
  readonly epoch: string | null
  readonly routes: ReadonlyMap<string, string>
  readonly memory: number
  readonly standing: Marks.Standing
}

/** A branch as ChatApi's word on it names it: its repository (`github/owner/name`) and its name. */
export interface BranchNamed {
  readonly repository: string
  readonly branch: string
}

/** A conversation this tab holds a refusal of: what every query joins. */
const HiddenRow = Schema.Struct({ conversationId: Schema.String })

/**
 * The home conversation the session answer names; until this load's answer, the one the last confirmed answer named, so
 * a reload offline still shows it. Signed out, or an answer that names none: no home.
 */
export const homeNamed = (auth: AuthStore["Service"]): string | undefined => {
  const session = auth.session.tanstack.get("session")
  if (session?.status === "signed_in" || session?.status === "signed_out") return session.homeConversationId
  return auth.confirmed.tanstack.get("session")?.homeConversationId
}

export class ConversationOwners extends Context.Service<
  ConversationOwners,
  {
    /** The rows as they sync: the conversations feature's own, never shown as they are. */
    readonly mine: ElectricCollection.ElectricCollection<Mine>
    /** The person's conversations whose repository may show now, less each ChatApi refused them a read of. */
    readonly shown: Gated<Owned>
    /**
     * The rows of `rows` whose conversation (`field`) is one of `shown`: what a store exposes of a conversation's rows,
     * never `rows` itself. A row of no known conversation never shows.
     */
    readonly ofShown: <A extends object>(rows: Source<A>, field: keyof A & string) => Effect.Effect<Gated<A>, never, Scope.Scope>
    /**
     * ChatApi refused the person a read of conversation `conversationId`: `ofShown` shows none of the conversation's
     * rows and `shown` has no row of it. Done in the call, so what it hides is hidden before anything the caller does
     * next shows. The device keeps the refusal, for a later load and for every tab, until `clear` removes it.
     */
    readonly refuse: (conversationId: string) => void
    /**
     * ChatApi refused the person branch `branch` of `repository` (not found, no access, signed out): every
     * conversation the device names for it is refused, now and as one comes to be named, by a row restored or
     * delivered later, until ChatApi answers for the branch and that answer is taken (`clear` with `branch`).
     */
    readonly routeDenied: (repository: string, branch: string) => boolean
    readonly refuseBranch: (repository: string, branch: string) => Promise<void>
    /**
     * Where this tab's knowledge of refusals stands now: what a read takes as it begins, before its request is
     * sent, and hands to `clear` once ChatApi answered it whole.
     */
    readonly fence: () => Fence
    /**
     * ChatApi answered whole a read of conversation `conversationId` that began at `fence`, weighed in the device's
     * turn (marks.ts `lock`). Taken (`true`): no refusal was given anywhere since `fence`, so the refusals of the
     * conversation are removed, here and on the device, Web Storage says it is open, and it shows; `branch`, the
     * branch the answer was for, is refused no longer. Not taken: the answer may be older than a refusal, so nothing
     * is removed and nothing opened, and a refusal of the conversation Web Storage shows hides it here at once.
     */
    readonly clear: (conversationId: string, fence: Fence, branch?: BranchNamed) => Effect.Effect<boolean>
    /** Whether this tab holds a refusal of conversation `conversationId` now. */
    readonly refused: (conversationId: string) => boolean
    /** The home conversation, as the session answer names it now (`homeNamed`). */
    readonly home: () => string | undefined
  }
>()("@smthrs/mvp/conversations/ConversationOwners") {
  /** `marks`: the refusals' second record (marks.ts); a host with no Web Storage keeps none. */
  static readonly layer = (config: { readonly origin: string; readonly marks?: Marks.RefusalMarks }) =>
    Layer.effect(
      ConversationOwners,
      Effect.gen(function* () {
        const repos = yield* RepoStore
        const mine = yield* ElectricCollection.make<Mine>({
          id: "my-conversations",
          schema: Mine,
          getKey: (row) => row.conversationId,
          syncMode: "eager",
          persist: { schemaVersion: 1 },
          shape: {
            url: `${config.origin}${MY_CONVERSATIONS_SHAPE_ROUTE}`,
            columnMapper: ElectricCollection.snakeCamelMapper(),
          },
        }).pipe(Effect.provideService(ShapeSource.ShapeSource, signedInShapeSource(yield* ShapeSource.ShapeSource, yield* AuthStore)))
        // Each conversation's repository, kept in the change that syncs its row: a plain collection, so the joins below
        // read collections only, never another live query.
        const owned = yield* Collection.local<Owned, string>({ id: "conversation-owners", schema: OwnedRow, getKey: (row) => row.conversationId })
        // The conversations this tab holds a refusal of: no row of one shows, whatever its repository says. In this
        // tab's memory, which is what every query joins: a refusal no store took still hides here.
        const refusals = yield* Collection.local<typeof HiddenRow.Type, string>({ id: "conversation-refused", schema: HiddenRow, getKey: (row) => row.conversationId })
        // The same refusals as the device keeps them, for the next load and the other tabs.
        const kept = yield* Collection.persisted(ConversationRefusalsStore)
        const mirror = config.marks ?? Marks.none
        const access = yield* ConversationAccess
        const scope = yield* Effect.scope
        const fork = Effect.runForkWith(yield* Effect.context<never>())
        // Closed with the tab: a turn that comes after writes nothing.
        let disposed = false
        yield* Effect.addFinalizer(() => Effect.sync(() => {
          disposed = true
        }))
        /** `act` in the device's turn, alone among its tabs; `otherwise` once this tab has closed. */
        const turn = <A>(otherwise: A, act: () => Promise<A>) => {
          const principal = mirror.principal()
          return mirror.lock(() => disposed || mirror.principal() !== principal ? Promise.resolve(otherwise) : act())
        }
        // Every refusal this tab knows of, by its id, with when the tab came to know it (`seq`): the order `fence` cuts.
        const marks = new Map<string, { readonly conversationId: string; readonly seq: number }>()
        let seq = 0
        // The refusals this tab has yet to see the device's store take: its own, and those only Web Storage held.
        const own = new Set<string>()
        // The refusals this tab removed: one never comes back, whatever the device's store says of it later.
        const dropped = new Set<string>()
        // The refusals Web Storage holds: what a failed write to the device's store still leaves the next load.
        const mirrored = new Set<string>()
        // The refusal of each conversation this tab last recorded itself: a read refused again moves it (`refuse`).
        const minted = new Map<string, string>()
        // This tab's own refusals Web Storage has yet to take: each is written in the device's turn (`record`).
        const unsaid = new Set<string>()
        // What this tab last wrote of each refusal in Web Storage: the token, and where the tab's order stood (`seq`)
        // once the refusal it was written for had been given. A read that began at or after that is later than it.
        const written = new Map<string, { readonly token: string | null; readonly at: number }>()
        // The refusal whose key this tab is writing now, in its turn.
        let saying: string | undefined
        // What this tab heard of another tab's refusal that no store told it of: Web Storage saying a conversation is
        // open no longer. In this tab's memory only, by its conversation.
        const heard = new Map<string, string>()
        // The conversations that may show on this load: Web Storage said so, or ChatApi answered for it.
        const granted = new Set<string>()
        const pendingRefusals = new Map<string, number>()
        // The conversations ChatApi is being asked of now, one request each (`verify`).
        const verifying = new Set<string>()
        // Those it gave no answer for, offline or failing: asked again once it answers the person's list.
        const unanswered = new Set<string>()
        // The branches ChatApi refused on this load, each with the conversations refused for it so far.
        const pendingRouteRefusals = new Map<string, number>()
        let durableRoutes = new Set(mirror.routeDenials().keys())
        const denied = new Map([...durableRoutes].map((route) => [route, new Set<string>()]))
        // The conversations Web Storage was asked of on this load: it is asked once, and told of each change after.
        const asked = new Set<string>()
        // Closed until the device's refusals are read: on a cold load, a conversation's rows restored before them would
        // otherwise show one this person was refused. Each conversation named meanwhile is decided when it opens.
        let known = false
        const waiting = new Set<string>()
        /** Whether conversation `id`, which a receipt names, may show on this load. */
        const admitted = (id: string): boolean => {
          // Asked once, and never while a refusal of it is held: a conversation refused before the device knew it
          // is not opened by its row.
          if (isRefused(id)) return false
          if (!asked.has(id)) {
            asked.add(id)
            if (mirror.granted(id)) granted.add(id)
          }
          return granted.has(id)
        }
        const auth = yield* AuthStore
        // Each conversation's row, as its repository and whether it is home say; none once neither does.
        const branches = (yield* BranchStore).conversations
        // A successful branch/track response already proves the conversation's repository, before Electric catches up.
        // This existing device cache stores only that relation, never an access grant; the same repo gate still applies.
        const branchOwners = new Map<string, Map<string, string>>()
        const branchIds = new Map<string, string>()
        let homeId: string | undefined
        // Web Storage is asked of each row's branch as the row is weighed, one read of the branch's index (marks.ts
        // `hasRouteDenial`): a sibling's refusal written or replaced since the last row is seen, and no batch holds an
        // older read of every branch.
        const deniedRoute = (route: string) =>
          pendingRouteRefusals.has(route) || denied.has(route) || mirror.hasRouteDenial(route)
        const isRefused = (id: string) => {
          if (pendingRefusals.has(id) || refusals.tanstack.has(id) || mirror.refused(id)) return true
          const row = mine.tanstack.get(id)
          return (row !== undefined && deniedRoute(branchKey(row))) ||
            [...(branchOwners.get(id)?.keys() ?? [])].some((route) => deniedRoute(routeKey(route)))
        }
        const keep = (id: string) => {
          if (!known) return void waiting.add(id)
          const synced = mine.tanstack.get(id)
          const cached = new Set(branchOwners.get(id)?.values())
          const repository = synced !== undefined && synced.owner !== "" && synced.repo !== ""
            ? repoId(synced.owner, synced.repo)
            : cached.size === 1 ? [...cached][0]! : ""
          const home = id === homeId
          repos.track(repository)
          // A receipt names it, and something says it is open (`admitted`): else no row, so nothing of it shows.
          // Asked before the row is read: asking may decide this conversation again, where the browser tells a tab of
          // its own write.
          const shows = (synced !== undefined || cached.size > 0 || home) && admitted(id)
          const held = owned.tanstack.get(id)
          if (!shows) {
            if (held !== undefined) owned.tanstack.delete(id)
          } else if (held === undefined) owned.tanstack.insert({ conversationId: id, repoId: repository, home })
          else if (held.repoId !== repository || held.home !== home) {
            owned.tanstack.update(id, (draft) => {
              draft.repoId = repository
              draft.home = home
            })
          }
          // The person's list names it and nothing says it is open: the list is no word that they may read it now,
          // so ChatApi is asked.
          if (synced !== undefined && !granted.has(id) && !isRefused(id)) verify(id)
        }
        /** This tab comes to know refusal `mark`: whether it is new to it. */
        const hold = (mark: Refused): boolean => {
          if (marks.has(mark.id) || dropped.has(mark.id)) return false
          marks.set(mark.id, { conversationId: mark.conversationId, seq: ++seq })
          if (!refusals.tanstack.has(mark.conversationId)) refusals.tanstack.insert({ conversationId: mark.conversationId })
          return true
        }
        /** This tab forgets refusal `id`: its conversation shows again once the tab knows no refusal of it. */
        const release = (id: string) => {
          const mark = marks.get(id)!
          marks.delete(id)
          unsaid.delete(id)
          if ([...marks.values()].some((other) => other.conversationId === mark.conversationId)) return
          refusals.tanstack.delete(mark.conversationId)
          // Whether it may show is decided again: Web Storage is asked of a conversation only while none is held.
          keep(mark.conversationId)
        }
        /** What Web Storage holds that this tab did not know: another tab's refusals, or an earlier load's. */
        const recall = () =>
          mirror.read().filter((mark) => {
            mirrored.add(mark.id)
            return hold(mark)
          })
        // Read before anything shows: a refusal only Web Storage holds hides its conversation from this load's start,
        // and is this tab's to store unless the device's store turns out to hold it.
        for (const mark of recall()) own.add(mark.id)
        // The device's generation, written while there is room: what every read of this load begins at.
        mirror.anchor()
        /** What the device's store holds is no longer this tab's to store. */
        const stored = () => {
          for (const id of own) if (kept.tanstack.has(id)) own.delete(id)
        }
        // One write to the device's store at a time, so each sees what the one before it stored.
        const writing = yield* Semaphore.make(1)
        // The write asked for that has not begun: it writes what stands when it begins, so one covers every change
        // made before then, and a write the store refuses is tried, and said, once.
        let asking: Promise<void> | undefined
        /**
         * Makes the device's rows agree with this tab's refusals, once the device's rows are read: done once that
         * write has ended, taken or refused, or the tab has closed.
         */
        const settle = (): Promise<void> => {
          if (asking !== undefined) return asking
          let end!: () => void
          const ended = new Promise<void>((resolve) => {
            end = resolve
          })
          asking = ended
          // A device whose rows could not be read is still written to: the next load may read them.
          fork(Effect.ignore(kept.restored).pipe(
            Effect.andThen(Effect.suspend(() => {
              asking = undefined
              stored()
              const added = [...own].map((id) => ({ id, conversationId: marks.get(id)!.conversationId }))
              const removed = [...dropped].filter((id) => kept.tanstack.has(id))
              return Effect.andThen(
                added.length === 0 ? Effect.void : Effect.flatMap(kept.insert(added), (written) => written.persisted).pipe(
                  Effect.andThen(Effect.sync(stored)),
                ),
                removed.length === 0 ? Effect.void : Effect.flatMap(kept.delete(removed), (written) => written.persisted),
              )
            })),
            // The tab's own refusal stands in its memory (fail closed). TanStack DB's persisted collection takes no
            // further write on this load once one failed, so Web Storage is what tells the next load and the other
            // tabs (`mirrored`); `unstored` is a refusal no store holds, which the next load still honours: Web
            // Storage says the conversation is open no longer (`revoke`).
            Effect.catch(() => Effect.logError("conversations.refusals").pipe(Effect.annotateLogs({
              feature: "conversations",
              outcome: [...own].every((id) => mirrored.has(id)) ? "mirrored" : "unstored",
            }))),
            writing.withPermits(1),
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.await),
            Effect.ensuring(Effect.sync(end)),
          ))
          return ended
        }
        /** A refusal of its own for the conversation, this tab's: a read that began before it never removes it. */
        const mint = (conversationId: string) => {
          const mark = { id: crypto.randomUUID(), conversationId }
          minted.set(conversationId, mark.id)
          hold(mark)
          own.add(mark.id)
          unsaid.add(mark.id)
        }
        /** This tab's refusal `id` gives way to one it recorded since: it goes from every record, the new one held. */
        const retire = (id: string, conversationId: string) => {
          own.delete(id)
          dropped.add(id)
          mirrored.delete(id)
          release(id)
          mirror.remove([{ id, conversationId }])
        }
        /**
         * Records, in the device's turn, the refusal of the conversation given in the call (`refuse`): `standing`,
         * the refusal it moved, is said again, or, where Web Storage no longer holds that one or will not take it, a
         * new one of this tab's stands in its place (`ours`: the one moved was this tab's own, and goes). `at` is
         * where the tab's order stood once the refusal was given: what is written here is as old as that, so a read
         * of this tab's that began after the call finds nothing in it that is later than itself.
         */
        const record = async (conversationId: string, standing: string | undefined, ours: boolean, at: number) => {
          mirror.revoke(conversationId)
          /**
           * Writes refusal `id`'s key by `write`: what Web Storage then holds of it is this tab's word, as old as
           * the call. A host that tells a tab of its own change tells it nothing new meanwhile (`told`).
           */
          const say = (id: string, write: (mark: Refused) => boolean) => {
            saying = id
            const taken = write({ id, conversationId })
            saying = undefined
            if (taken) written.set(id, { token: mirror.token({ id, conversationId }), at })
            return taken
          }
          if (standing !== undefined && marks.has(standing)) {
            if (!kept.tanstack.has(standing)) own.add(standing)
            if (!say(standing, mirror.restate)) {
              // Web Storage holds no refusal to say again. A new one of this tab's own, which the device's store
              // tells the other tabs of as a row they did not know; the one it replaces, this tab's, goes once the
              // new is held.
              mint(conversationId)
              if (ours) retire(standing, conversationId)
            }
          }
          for (const id of unsaid) {
            if (marks.get(id)!.conversationId === conversationId && say(id, mirror.add)) {
              mirrored.add(id)
              unsaid.delete(id)
            }
          }
          try {
            await settle()
          } finally {
            if (pendingRefusals.get(conversationId) === at) pendingRefusals.delete(conversationId)
          }
        }
        const refuse = (conversationId: string) => {
          // In the call, and before anything else: the generation moves, so no read begun so far is answered over
          // this refusal in any tab; and `open` goes, a removal, which storage that is full still takes. Whatever
          // becomes of the refusal below, the next load shows nothing of the conversation until ChatApi answers.
          mirror.advance()
          mirror.revoke(conversationId)
          const mine = minted.get(conversationId)
          // Refused again while a refusal of it stands, this tab's own or one Web Storage holds: that refusal is now
          // later than every read begun so far, here by its place (`seq`). Else a new one, this tab's.
          const standing = mine !== undefined && marks.has(mine)
            ? mine
            : [...marks].find(([id, mark]) => mark.conversationId === conversationId && mirrored.has(id))?.[0]
          if (standing === undefined) mint(conversationId)
          else marks.set(standing, { conversationId, seq: ++seq })
          const at = seq
          pendingRefusals.set(conversationId, at)
          mirror.broadcast({ kind: "refuse", id: conversationId })
          return turn(undefined, () => record(conversationId, standing, standing === mine, at))
        }
        /** The branch a row of the person's list is of, as a refusal of the branch names it. */
        const branchKey = (row: Mine) => `${repoId(row.owner, row.repo)}\0${row.branch}`
        const routeKey = (route: string) => {
          const end = route.indexOf("/", route.indexOf("/") + 1)
          return `github/${route.slice(0, end)}\0${route.slice(end + 1)}`
        }
        /** The conversations the device names for the branch `key` names now: by its routes, and by the person's list. */
        const namedFor = (key: string) =>
          new Set([...branchIds].filter(([route]) => routeKey(route) === key).map(([, id]) => id)
            .concat(mine.tanstack.toArray.filter((row) => branchKey(row) === key).map((row) => row.conversationId)))
        /** Conversation `id` came to be named for a branch ChatApi refused: refused, once for that refusal. */
        const deny = (key: string, id: string, hide: (id: string) => void | Promise<void> = refuse) => {
          const told = denied.get(key)
          if (told === undefined || told.has(id)) return
          told.add(id)
          return hide(id)
        }
        const refuseBranch = async (repository: string, branch: string) => {
          const key = `${repository}\0${branch}`
          const at = ++seq
          pendingRouteRefusals.set(key, at)
          denied.set(key, new Set())
          const persist = () => {
            if (mirror.refuseRoute(key)) durableRoutes.add(key)
          }
          // Leave durable evidence now, even if the tab closes before its turn.
          persist()
          for (const id of namedFor(key)) {
            mirror.revoke(id)
            keep(id)
          }
          const records = await turn([], async () => {
            // Reassert the denial in the same turn that records its conversations.
            persist()
            mirror.broadcast({ kind: "refuse-route", route: key })
            const records = [...namedFor(key)].map((id) => {
              mirror.revoke(id)
              return deny(key, id)
            })
            if (pendingRouteRefusals.get(key) === at) pendingRouteRefusals.delete(key)
            return records
          })
          // Conversation records take their own turns. Finish them before the caller forgets the route.
          await Promise.all(records)
        }
        /** Another tab removed refusal `id` after a read ChatApi answered whole. */
        const lifted = (id: string) => {
          const mark = marks.get(id)
          if (mark !== undefined && !pendingRefusals.has(mark.conversationId)) release(id)
        }
        /**
         * Web Storage says conversation `conversationId` is open no longer: another tab was refused a read. Its refusal may have reached no store, so this is all this tab knows of
         * it: a refusal in its memory, which a read begun before it never removes.
         */
        const closed = (conversationId: string) => {
          const previous = heard.get(conversationId)
          if (previous !== undefined) marks.delete(previous)
          const mark = { id: crypto.randomUUID(), conversationId }
          heard.set(conversationId, mark.id)
          hold(mark)
        }
        /** Where this tab's knowledge of refusals stands now, what Web Storage holds that it was not yet told included. */
        const stand = (): Fence => {
          recall()
          mirror.anchor()
          return {
            seq, principal: mirror.principal(), epoch: mirror.epoch(), memory: mirror.memory(),
            standing: mirror.standing(), routes: mirror.routeDenials(),
          }
        }
        /** Whether a refusal was given anywhere since `fence`: this tab came to know one, or the device's generation moved. */
        const moved = (fence: Fence) => {
          const principal = mirror.principal()
          const epoch = mirror.epoch()
          return seq !== fence.seq || principal !== fence.principal || epoch !== fence.epoch ||
            (principal !== undefined && epoch === null) || mirror.memory() !== fence.memory
        }
        /** Weighs ChatApi's answer to a read of the conversation that began at `fence`, in the device's turn. */
        const decide = async (conversationId: string, fence: Fence, branch: BranchNamed | undefined): Promise<boolean> => {
          // Read now, before anything is removed: a refusal another tab wrote or said again since the read began, or
          // its taking `open` away, is in Web Storage already, though the browser has yet to tell this tab. The
          // answer may be older than it, so nothing is removed, `open` is not put back, and it hides here from now.
          recall()
          // What this tab wrote itself, for a refusal it was given before the read began, is not later than the read.
          const later = mirror.later(conversationId, fence.standing, (id, token) => {
            const mine = written.get(id)
            return mine !== undefined && mine.token === token && mine.at <= fence.seq
          })
          if (later && !refusals.tanstack.has(conversationId)) closed(conversationId)
          if (later || moved(fence) || pendingRefusals.has(conversationId)) return false
          const route = branch === undefined ? undefined : `${branch.repository}\0${branch.branch}`
          if (route !== undefined) {
            // A branch refusal given since the read began: its token is not the one the fence holds.
            const live = mirror.routeToken(route)
            if (live !== null && live !== fence.routes.get(route)) return false
          }
          // Recheck after writing open: a conversation refusal can move the generation in the call.
          mirror.grant(conversationId)
          if (moved(fence)) {
            mirror.revoke(conversationId)
            return false
          }
          // Read once `open` is written: where the browser tells a tab of its own write, what the tab only heard of
          // the conversation has gone with it.
          const cleared = [...marks].filter(([, mark]) => mark.conversationId === conversationId).map(([id]) => ({ id, conversationId }))
          for (const { id } of cleared) {
            own.delete(id)
            // What this tab only heard was never stored, so no store's later word of it needs refusing.
            if (heard.get(conversationId) === id) heard.delete(conversationId)
            else dropped.add(id)
            release(id)
          }
          mirror.remove(cleared)
          // The generation is checked before the branch refusal is lifted: a refusal given since is one no clear names.
          // Only a clear this call wrote is this call's to undo: one a sibling wrote first, or a write the storage
          // refused, is not, and a refusal it never lifted is not written again.
          const lift = route === undefined ? Marks.UNCHANGED
            : mirror.clearRoute(route, mirror.epoch() === fence.epoch ? fence.routes.get(route) : undefined)
          const accepted = lift.ok && mirror.epoch() === fence.epoch &&
            (route === undefined || !mirror.hasRouteDenial(route)) && !mirror.refused(conversationId)
          asked.add(conversationId)
          if (accepted) {
            granted.add(conversationId)
            if (route !== undefined) denied.delete(route)
          } else {
            mirror.revoke(conversationId)
            granted.delete(conversationId)
            // A refusal given as the branch refusal was lifted: the clear is undone in this turn, so no reload finds
            // the branch open, whatever conversation an older `open` key names for it.
            if (route !== undefined && lift.changed && mirror.restoreRoute(route, lift.prevCleared)) durableRoutes.add(route)
          }
          keep(conversationId)
          if (cleared.length > 0) await settle()
          return accepted
        }
        const clear = (conversationId: string, fence: Fence, branch?: BranchNamed) =>
          Effect.promise(() => turn(false, () => decide(conversationId, fence, branch)))
        // No more than a few questions to ChatApi at a time, on a device whose list is long.
        const asks = yield* Semaphore.make(4)
        const signedIn = signedInChanges(auth).pipe(Stream.filter((signed) => signed), Stream.runHead)
        /**
         * Asks ChatApi whether the person may read conversation `id`, which their list names and nothing says is
         * open: one question at a time for it, its answer taken as any read's is. Allowed, it shows unless a refusal
         * was given since the question went, and is then asked again; refused, it is refused; unanswered, it stays
         * hidden and is asked again once ChatApi answers the person's list.
         */
        const verify = (id: string) => {
          if (verifying.has(id)) return
          verifying.add(id)
          fork(Effect.gen(function* () {
            while (!granted.has(id) && !isRefused(id)) {
              // Nobody signed in asks nothing: ChatApi would refuse, and the device is wiped as they sign out.
              yield* signedIn
              // Taken before the request: a refusal given from here on is not one this answer is later than.
              const fence = stand()
              const answer = yield* asks.withPermits(1)(access.check(id))
              if (answer === "unanswered") return void unanswered.add(id)
              if (answer === "refused") refuse(id)
              else if (!(yield* clear(id, fence)) && fence.epoch === null) {
                unanswered.add(id)
                return
              }
            }
          }).pipe(
            Effect.ensuring(Effect.sync(() => void verifying.delete(id))),
            Effect.forkIn(scope),
          ))
        }
        /** Another tab changed what Web Storage holds: its refusals this tab did not know hide here too. */
        const reconcileRoutes = () => {
          const next = new Set(mirror.routeDenials().keys())
          const changed = new Set([...durableRoutes, ...next])
          for (const route of changed) {
            if (next.has(route)) {
              if (!denied.has(route)) denied.set(route, new Set())
            } else if (!pendingRouteRefusals.has(route)) denied.delete(route)
          }
          durableRoutes = next
          for (const route of changed) {
            for (const id of namedFor(route)) keep(id)
          }
        }
        const told = (change?: Marks.MarkChange) => {
          recall()
          if (change === undefined) return reconcileRoutes()
          const { conversationId, id } = change
          // The last refusal of the conversation went from Web Storage after its marks did: weighed again now.
          if (change.held) return void (mirror.refused(conversationId) || keep(conversationId))
          if (id !== undefined) {
            if (mirror.has({ id, conversationId })) {
              // Written, or said again: a read refused again in another tab. The refusal is later than every read
              // this tab has begun. Told of its own write, as a host that tells a tab of every change does, the tab
              // learns nothing.
              if (marks.has(id) && saying !== id) marks.set(id, { conversationId, seq: ++seq })
              return
            }
            // A refusal only Web Storage held, removed after a read ChatApi answered whole in another tab. One the
            // device's store holds goes when its row does. A row this tab is still writing is not the store holding
            // it: the write may be refused, and the refusal would then stand in this tab with no record anywhere.
            if (pendingRefusals.has(conversationId)) return
            mirrored.delete(id)
            if (kept.tanstack.has(id) && !own.has(id)) return
            // Never this tab's to store from here on: the row of a write under way that the store takes goes after it.
            own.delete(id)
            dropped.add(id)
            void settle()
            return lifted(id)
          }
          const said = heard.get(conversationId)
          if (mirror.granted(conversationId)) {
            // Open again: a read ChatApi answered whole in another tab, which began after that tab heard what this
            // one did. What this tab only heard of the refusal goes, and Web Storage is asked of it again.
            if (said !== undefined) {
              heard.delete(conversationId)
              release(said)
            }
            asked.delete(conversationId)
            keep(conversationId)
          } else if (said === undefined) closed(conversationId)
        }
        const follow = (subscribe: () => { readonly unsubscribe: () => void }) =>
          Effect.acquireRelease(Effect.sync(subscribe), (subscription) => Effect.sync(() => subscription.unsubscribe()))
        yield* follow(() => branches.tanstack.subscribeChanges((changes) => {
          const touched = new Set<string>()
          for (const change of changes) {
            const route = String(change.key)
            const previous = branchIds.get(route)
            if (previous !== undefined) {
              const held = branchOwners.get(previous)!
              held.delete(route)
              if (held.size === 0) branchOwners.delete(previous)
              branchIds.delete(route)
              touched.add(previous)
            }
            const row = branches.tanstack.get(route)
            const [owner, repo, ref] = route.split("/")
            if (row !== undefined && owner && repo && ref) {
              branchIds.set(route, row.conversationId)
              const held = branchOwners.get(row.conversationId) ?? new Map<string, string>()
              held.set(route, repoId(owner, repo))
              branchOwners.set(row.conversationId, held)
              touched.add(row.conversationId)
              // A route of a branch ChatApi refused, restored or saved since: its conversation is refused as it is named.
              deny(routeKey(route), row.conversationId)
            }
          }
          for (const id of touched) keep(id)
        }, { includeInitialState: true }))
        yield* follow(() =>
          mine.tanstack.subscribeChanges((changes) => {
            for (const change of changes) {
              const id = String(change.key)
              const row = mine.tanstack.get(id)
              // A row of a branch ChatApi refused, restored or delivered since: refused before it is kept.
              if (row !== undefined) deny(branchKey(row), id)
              keep(id)
            }
          }, { includeInitialState: true })
        )
        // ChatApi answered the person's list: it is there to ask again of each conversation it gave no answer for.
        yield* mine.sync.pipe(
          Stream.runForEach((event) => Effect.sync(() => {
            if (event._tag !== "Succeeded") return
            for (const id of [...unanswered]) {
              unanswered.delete(id)
              keep(id)
            }
          })),
          Effect.forkScoped,
        )
        const decideHome = () => {
          const next = homeNamed(auth)
          if (next === homeId) return
          const before = homeId
          homeId = next
          if (before !== undefined) keep(before)
          if (next !== undefined) keep(next)
        }
        yield* follow(() => auth.session.tanstack.subscribeChanges(decideHome, { includeInitialState: true }))
        yield* follow(() => auth.confirmed.tanstack.subscribeChanges(decideHome, { includeInitialState: true }))
        // Another tab's refusal the device's store has not taken reaches this tab through Web Storage.
        yield* Effect.acquireRelease(Effect.sync(() => mirror.subscribe(told)), (stop) => Effect.sync(stop))
        yield* Effect.acquireRelease(Effect.sync(() => mirror.listen((event) => {
          if (event.kind === "refuse") closed(event.id)
          else {
            seq++
            denied.set(event.route, new Set())
            for (const id of namedFor(event.route)) deny(event.route, id, closed)
          }
        }, () => {
          seq++
          const ready = known
          known = false
          for (const id of owned.tanstack.keys()) owned.tanstack.delete(id)
          for (const id of marks.keys()) {
            if (!kept.tanstack.has(id)) release(id)
          }
          own.clear()
          heard.clear()
          mirrored.clear()
          minted.clear()
          unsaid.clear()
          written.clear()
          pendingRefusals.clear()
          granted.clear()
          asked.clear()
          denied.clear()
          pendingRouteRefusals.clear()
          durableRoutes = new Set()
          for (const mark of recall()) own.add(mark.id)
          reconcileRoutes()
          known = ready
          for (const id of new Set([...branchOwners.keys(), ...mine.tanstack.keys()])) keep(String(id))
          if (homeId !== undefined) keep(homeId)
          if (known) waiting.clear()
        })), (stop) => Effect.sync(stop))
        reconcileRoutes()
        yield* kept.restored.pipe(
          // The device's rows, then each change to them, another tab's included: a refusal stored anywhere hides here
          // as it is stored, and one a tab removed after a whole answer shows here again.
          Effect.andThen(follow(() => kept.tanstack.subscribeChanges((changes) => {
            // What each row came to in this change: a row the store confirms is told as gone and back at once, and
            // was never gone.
            const last = new Map(changes.map((change) => [String(change.key), change]))
            for (const [id, change] of last) {
              if (change.type !== "delete") hold(change.value)
              // A write of this tab's that the store refused rolls back as a delete: the refusal stands.
              else if (!own.has(id)) lifted(id)
            }
          }, { includeInitialState: true }))),
          Effect.andThen(Effect.sync(() => {
            known = true
            for (const id of waiting) keep(id)
            waiting.clear()
            void settle()
          })),
          // Unread, nothing says which conversations were refused: none shows on this load (fail closed).
          Effect.catch(() => Effect.logError("conversations.refusals").pipe(Effect.annotateLogs({ feature: "conversations", outcome: "unavailable" }))),
          Effect.forkScoped({ startImmediately: true }),
        )
        // One query, as `ofShown` is: a refused conversation has no row here, home or not, visible repository or not.
        // Each repository is tracked as its conversation's row is kept (`keep`).
        const shown = (yield* LiveQuery.make((q) =>
          q
            .from({ owner: owned.tanstack })
            .leftJoin({ visible: repos.visible.tanstack }, ({ owner, visible }) => Query.eq(Query.coalesce(owner.repoId, ""), visible.id))
            .leftJoin({ refused: refusals.tanstack }, ({ owner, refused }) => Query.eq(owner.conversationId, refused.conversationId))
            .where(({ owner, visible, refused }) =>
              Query.and(
                Query.or(Query.eq(owner.home, true), Query.eq(visible?.show, true)),
                Query.isUndefined(refused?.conversationId),
              ))
            .select(({ owner }) => owner),
          { getKey: (row) => row.conversationId },
        ).pipe(Effect.orDie)) as unknown as Gated<Owned>
        const ofShown = <A extends object>(rows: Source<A>, field: keyof A & string) =>
          LiveQuery.make((q) =>
            q
              .from({ row: rows.tanstack as unknown as Source<{ readonly conversation: string }>["tanstack"] })
              .innerJoin({ owner: owned.tanstack }, ({ row, owner }) =>
                // An expression, not the bare field: TanStack DB then never loads `rows` lazily by key, which left rows
                // that arrived before their owner's row joined to nothing (repo/gate.ts).
                Query.eq(Query.coalesce((row as unknown as Record<string, typeof row.conversation>)[field]!, ""), owner.conversationId))
              .leftJoin({ visible: repos.visible.tanstack }, ({ owner, visible }) => Query.eq(owner.repoId, visible.id))
              .leftJoin({ refused: refusals.tanstack }, ({ owner, refused }) => Query.eq(owner.conversationId, refused.conversationId))
              // One query, never a union: a conversation that becomes home, or stops being, moves within it. A
              // conversation ChatApi refused shows nothing, home or not, visible repository or not.
              .where(({ owner, visible, refused }) =>
                Query.and(
                  Query.or(Query.eq(owner.home, true), Query.eq(visible?.show, true)),
                  Query.isUndefined(refused?.conversationId),
                ))
              .select(({ row }) => row),
            // Each row keeps the key its own collection gives it.
            { getKey: (row) => rows.tanstack.getKeyFromItem(row as unknown as A) },
          ).pipe(Effect.orDie, Effect.map((query) => query as unknown as Gated<A>))
        return ConversationOwners.of({ mine, shown, ofShown, refuse, refuseBranch, fence: stand, clear, refused: isRefused, routeDenied: (repository, branch) => deniedRoute(`${repository}\0${branch}`), home: () => homeId })
      }),
    ).pipe(Layer.provide(ConversationAccess.layer({ origin: config.origin })))
}
