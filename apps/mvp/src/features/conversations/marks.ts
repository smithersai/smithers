import { DEVICE_ADOPTED_EVENT } from "../auth/contract"
import { REFUSAL_MARKS_KEY } from "./contract"
import type { Refused } from "./schema"

// What the browser's Web Storage says of the person's conversations, beside the device's store (owners.ts). It is
// written in the call that hides or shows a conversation, where the device's store (`ConversationRefusalsStore`) is
// written a moment later: a write that store refuses, or a tab that closes first, leaves the next load, offline, this.
//
// Every fact is a key of its own, so no tab reads a value, changes it and writes it back over another tab's:
// - `refused`: one refusal ChatApi gave, by its conversation and its id. Its value is a token as wide every time, new
//   each time the refusal is said, so saying it again takes no more room and is a change every tab can read;
// - `open`: ChatApi's word that the person may read the conversation. A refusal removes it;
// - `route`: the newest refusal of a branch (`routeRefusedKey`), a token new each time it is said, written over in
//   place and never removed by a clear;
// - `route-cleared`: the token of that branch's refusal a clear lifted (`routeClearedKey`). A refusal never writes it.
//   The branch is refused while its `route` token is not its `route-cleared` token: two reads (`hasRouteDenial`), and
//   no write to either key ever leaves a newer refusal unseen, since a clear writes only the token it was fenced on.
//
// A conversation shows on a load only with its `open` key, or once ChatApi answers for it on that load (owners.ts).
// No key means not open: nothing here says a conversation is new to the device, so one whose keys were never
// written, on storage that was full, shows nothing on the next load. Storage that is full refuses a new key and never
// a removal, so a refusal no store could record still takes `open` away; and the `open` key holds as much room as a
// refusal's key takes, so storage that was full takes the refusal once `open` is gone.
//
// A read of the storage is what a tab knows of the others before the browser tells it (`standing`, `later`): a
// `storage` event comes in a later task, and a read answered meanwhile must not undo a refusal another tab has
// written. The storage itself gives no lock over its reads (HTML, Web Storage: "authors are encouraged to assume
// that there is no locking mechanism"), so two more things order the tabs:
// - a turn (`lock`): the Web Lock of the person's refusals, exclusive across every tab, worker and process of the
//   origin. A refusal's key is written, and an answer is weighed and its removals made, only in a turn, so no refusal
//   is said again between an answer's comparison and its removal;
// - a generation (`epoch`): one key, as wide every time, written while there was room. Every refusal moves it, by
//   writing over it, which takes no room; where even that is refused it is removed, which storage always takes. An
//   answer whose read began at another generation, or at none, proves nothing: it removes nothing and writes no
//   `open` (owners.ts `clear`). So a refusal no store could record still stops every older answer.
// The tabs of one process also count their refusals in memory (`memory`), which needs no storage at all.
//
// Each key names the person: the device's stores are one person's too (src/device/identity.ts), and another
// person's keys are nobody's here. A page that holds no person's data (`principal` answers none) keeps nothing on the
// device, so it reads and writes nothing, and what it hears of it may show. Sign-out's wipe removes every key
// (src/wipe.ts).

/**
 * Another tab's change: to refusal `id` of the conversation, to whether any refusal of it is held (`held`), or, with
 * neither, to whether the conversation is open.
 */
export interface MarkChange {
  readonly conversationId: string
  readonly id?: string
  readonly held?: true
}

/** What the storage said at one moment: each refusal's key with its conversation, id and token, and the conversations open. */
export interface Standing {
  readonly refused: ReadonlyMap<string, { readonly conversationId: string; readonly id: string; readonly token: string }>
  readonly open: ReadonlySet<string>
}

const NOTHING: Standing = { refused: new Map(), open: new Set() }

/** The generation of a page that keeps nothing: it never moves, and nothing is written by it. */
const UNKEPT = ""

/** What `clearRoute` did: wrote the clear over `prevCleared`, or wrote nothing, and whether nothing else was refused. */
export type RouteClear =
  | { readonly changed: true; readonly ok: true; readonly prevCleared: string | null }
  | { readonly changed: false; readonly ok: boolean }

/** A clear that wrote nothing, and found no other refusal: nothing was fenced, or nothing is kept. */
export const UNCHANGED: RouteClear = { changed: false, ok: true }
const FAILED: RouteClear = { changed: false, ok: false }

export type Denial =
  | { readonly kind: "refuse"; readonly id: string }
  | { readonly kind: "refuse-route"; readonly route: string }

/** What this device keeps of its conversations outside its store. Nothing here fails: what cannot be done is answered. */
export interface RefusalMarks {
  /** The refusals kept, or none when the storage cannot be read. */
  readonly read: () => ReadonlyArray<Refused>
  /** Keeps `mark`: whether the storage took it. */
  readonly add: (mark: Refused) => boolean
  /**
   * Says `mark` again, as the read it refused was refused again: whether the storage, which still kept it, took it.
   * As wide as it was, so full storage takes it. Every other tab reads the change at once (`later`) and hears it
   * after, and takes the refusal as later than any read it had begun. One no longer kept is not said again: another
   * tab removed it after a read ChatApi answered whole, and a refusal since is a new one.
   */
  readonly restate: (mark: Refused) => boolean
  /** Forgets `marks`. One the storage would not forget stays, and still hides. */
  readonly remove: (marks: ReadonlyArray<Refused>) => void
  /** Whether `mark` is kept now. Storage that cannot be read does not say it is gone. */
  readonly has: (mark: Refused) => boolean
  /**
   * Whether the conversation is open: ChatApi answered for it and no refusal took that away. Unreadable storage says
   * no. A page that keeps nothing also says no.
   */
  readonly granted: (conversationId: string) => boolean
  /** Whether Web Storage holds a refusal of this conversation now. */
  readonly refused: (conversationId: string) => boolean
  /** ChatApi answered for the conversation: it is open, where the storage takes it. */
  readonly grant: (conversationId: string) => void
  /** ChatApi refused a read of the conversation: it is open no longer. A removal, which full storage takes. */
  readonly revoke: (conversationId: string) => void
  /** What the storage says now, of every conversation: what a read takes as it begins. Unreadable storage says nothing. */
  readonly standing: () => Standing
  /**
   * Whether the storage says a refusal of the conversation that it did not at `since`: one written or said again, or
   * its `open` key gone. Read now, so it sees another tab's refusal before that tab's change is heard here. A key
   * `covered` answers for, by its refusal's id and the token it holds now, is not later: the caller wrote it itself,
   * for a refusal it was given before `since`.
   */
  readonly later: (conversationId: string, since: Standing, covered?: (id: string, token: string) => boolean) => boolean
  /** The token refusal `mark`'s key holds now, or none when it is not kept or cannot be read. */
  readonly token: (mark: Refused) => string | null
  /**
   * The generation the storage holds now, or none: it was never written, storage that was full, or a refusal that
   * could not move it removed it. Unreadable storage says none. A page that keeps nothing says one that never moves.
   */
  readonly epoch: () => string | null
  /** Writes a generation where the storage holds none and has room: for the reads that begin from then on. */
  readonly anchor: () => void
  /**
   * A refusal was given: the generation moves. Written over in place, which full storage takes; refused even that,
   * it is removed, which leaves every read begun so far with a generation the storage no longer holds. The count the
   * process's tabs share (`memory`) moves too.
   */
  readonly advance: () => void
  readonly principal: () => string | undefined
  /** Every branch refused now, by the token of its refusal. Unreadable storage says none. */
  readonly routeDenials: () => ReadonlyMap<string, string>
  /** The token of the branch's refusal while it is refused, or none. */
  readonly routeToken: (route: string) => string | null
  /** Whether the branch is refused now: two reads, no matter how many keys the storage holds. */
  readonly hasRouteDenial: (route: string) => boolean
  /** Writes a new refusal of the branch over the last one, in place: whether the storage took it. */
  readonly refuseRoute: (route: string) => boolean
  /**
   * Lifts the branch refusal `fencedToken`, in the person's turn, by writing it as cleared. `changed` only where this
   * call wrote it; `ok` where no refusal but `fencedToken` was found (cleared by this call or a sibling first), or
   * nothing was fenced (`undefined`). A write the storage refused is no clear, and not `ok`.
   */
  readonly clearRoute: (route: string, fencedToken: string | undefined) => RouteClear
  /**
   * Undoes a clear that `changed`, in the same turn: the cleared token goes back to `prevCleared`. Where the storage
   * will not take that write, the cleared key is removed, which needs no room, and the refused token denies the branch
   * again; where it will not remove it either, the branch is refused again. Whether a refusal of the branch is kept.
   */
  readonly restoreRoute: (route: string, prevCleared: string | null) => boolean
  readonly broadcast: (denial: Denial) => void
  readonly listen: (listener: (denial: Denial) => void, adopted?: () => void) => () => void
  /** How many refusals the tabs of this process that share the storage were given: what moves with no storage at all. */
  readonly memory: () => number
  /**
   * Runs `turn` alone among every tab of the person's that keeps refusals here: each waits for the one before it,
   * first come first served. A page that holds nobody's data runs it at once.
   */
  readonly lock: <A>(turn: () => Promise<A>) => Promise<A>
  /**
   * Calls `listener` when another tab changed what is kept, until the function returned is called: with the one
   * change, or with none when route denials or the whole storage changed.
   */
  readonly subscribe: (listener: (change?: MarkChange) => void) => () => void
}

/**
 * A page with no such storage relies on live authority on each load.
 */
export const none: RefusalMarks = {
  read: () => [],
  add: () => false,
  restate: () => false,
  remove: () => {},
  has: () => false,
  granted: () => false,
  refused: () => false,
  grant: () => {},
  revoke: () => {},
  standing: () => NOTHING,
  later: () => false,
  token: () => null,
  epoch: () => UNKEPT,
  anchor: () => {},
  advance: () => {},
  principal: () => undefined,
  routeDenials: () => new Map(),
  routeToken: () => null,
  hasRouteDenial: () => false,
  refuseRoute: () => false,
  clearRoute: () => UNCHANGED,
  restoreRoute: () => false,
  broadcast: () => {},
  listen: () => () => {},
  memory: () => 0,
  lock: (turn) => turn(),
  subscribe: () => () => {},
}

/** One turn at a time under `name`: `turn` runs once every turn asked for before it has ended. */
export type Lock = <A>(name: string, turn: () => Promise<A>) => Promise<A>

/** The turns the tabs of this process take over one storage, by name: each the end of the last one asked for. */
const turns = new WeakMap<object, Map<string, Promise<unknown>>>()

/**
 * A lock among the tabs of this process that share `storage`, first come first served: where the host has no Web
 * Locks. A turn that fails ends like any other, and its failure is its caller's.
 */
export const inProcess = (storage: object): Lock => (name, turn) => {
  const held = turns.get(storage) ?? new Map<string, Promise<unknown>>()
  turns.set(storage, held)
  const taken = (held.get(name) ?? Promise.resolve()).then(turn)
  held.set(name, taken.then(() => undefined, () => undefined))
  return taken
}

/** The host's lock: its Web Locks (`locks`), exclusive across every tab and process of the origin, or `inProcess`. */
export const lockOf = (locks: Pick<LockManager, "request"> | undefined, storage: object): Lock =>
  locks === undefined ? inProcess(storage) : (name, turn) => locks.request(name, { mode: "exclusive" }, turn)

/** The name of the lock over `principal`'s refusals. */
export const lockName = (principal: string): string => `smithers:refusal-lock:${principal}`

/** How many refusals the tabs of this process were given, by the storage they share and the person. */
const given = new WeakMap<object, Map<string, number>>()
const defaultStorageIdentity = {}

/** The browser's part: the storage, who the device's data is of now, and another tab's change to key `key`. */
export interface MarksHost {
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">
  /** The person whose data this page has open, or none while it holds nobody's. */
  readonly principal: () => string | undefined
  /** Hears each change another tab made to the storage, by its key (`null` when it was cleared), until stopped. */
  readonly changes: (listener: (key: string | null) => void) => () => void
  /** One turn at a time by name. Absent: the browser's Web Locks, or, without them, the process's own (`lockOf`). */
  readonly lock?: Lock
  /** A shared identity for wrappers of a storage area. Browser wrappers default to this origin's storage. */
  readonly storageIdentity?: object
  readonly persistOpen?: boolean
  /** Where in-place device adoption is announced. Defaults to the browser window. */
  readonly adoptionEvents?: EventTarget
  /** Opens this page's channel. An injected host can isolate its channel from the origin. */
  readonly channel?: (name: string) => BroadcastChannel | undefined
}

type Kind = "refused" | "open" | "epoch" | "route" | "route-cleared" | "refusal"

/** One fact a key says: a refusal by its id, that a conversation is open, or that some refusal of it is held. */
type Fact =
  | { readonly kind: "refused"; readonly conversationId: string; readonly id: string }
  | { readonly kind: "open" | "refusal"; readonly conversationId: string }

const TOKEN_BYTES = 8
const UUID_LENGTH = 36

/** A refusal's value: sixteen hex digits no tab has seen, as wide every time. */
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)), (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * An `open` key's value: as wide as a refusal's key and token are wider than the `open` key itself (the kind's name,
 * the `:` and the refusal's id, a UUID, and the token), so removing it leaves room for the refusal.
 */
const OPEN = (principal: string, conversationId: string) => "1".repeat(keyOf("refusal", principal, conversationId).length + 1 + "refused".length - "open".length + ":".length + UUID_LENGTH + TOKEN_BYTES * 2)

/** The key of one fact: each part encoded, so no part holds the `:` that parts them. */
export const keyOf = (kind: Kind, principal: string, conversationId?: string, id?: string): string =>
  [REFUSAL_MARKS_KEY, kind, principal, ...(conversationId === undefined ? [] : [conversationId]), ...(id === undefined ? [] : [id])]
    .map(encodeURIComponent).join(":")

/** The key of the branch's newest refusal token: written over by each refusal, never removed by a clear. */
export const routeRefusedKey = (principal: string, route: string): string => keyOf("route", principal, route)

/** The key of the branch refusal token a clear lifted: never written by a refusal. */
export const routeClearedKey = (principal: string, route: string): string => keyOf("route-cleared", principal, route)

/**
 * The branch's refusal token while the branch is refused: two reads, and a failure is the caller's. The clear is read
 * first: a refusal written before the second read is new, so no clear read earlier names it.
 */
const activeRouteToken = (storage: MarksHost["storage"], principal: string, route: string): string | null => {
  const cleared = storage.getItem(routeClearedKey(principal, route))
  const refused = storage.getItem(routeRefusedKey(principal, route))
  return refused === null || refused === cleared ? null : refused
}

/** The branch a route key names, or none where its escape does not decode (`URIError`). */
const decodedRoute = (encoded: string): string | undefined => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    // expected: a malformed key some other code wrote under the same start
    return undefined
  }
}

/** What `key` says, when it is one of `principal`'s facts. */
const factOf = (key: string, principal: string): Fact | undefined => {
  const parts = key.split(":")
  if (parts[0] !== REFUSAL_MARKS_KEY) return undefined
  try {
    const [, kind, who, conversationId, id] = parts.map(decodeURIComponent)
    if (who !== principal) return undefined
    if (kind === "refused" && parts.length === 5) return { kind, conversationId: conversationId!, id: id! }
    return (kind === "open" || kind === "refusal") && parts.length === 4 ? { kind, conversationId: conversationId! } : undefined
  } catch {
    // expected: a key some other code wrote under the same start, which is no fact of ours
    return undefined
  }
}

/** The facts in `host`'s storage, each under a key of its own that starts with {@link REFUSAL_MARKS_KEY}. */
export const make = (host: MarksHost): RefusalMarks => {
  /** What the storage answers, or `otherwise` when it cannot be reached. */
  const reach = <A>(act: (storage: MarksHost["storage"]) => A, otherwise: A): A => {
    try {
      return act(host.storage)
    } catch {
      // recorded: owners.ts logs a refusal neither store took, conversations.refusals unstored
      return otherwise
    }
  }
  const put = (key: string, value: string) => reach((storage) => (storage.setItem(key, value), true), false)
  const browser = typeof window !== "undefined"
  const realm = browser ? window : globalThis
  const identity = host.storageIdentity ?? (browser ? defaultStorageIdentity : host.storage)
  const locks = realm.navigator.locks ?? undefined
  const lock = host.lock ?? lockOf(locks, identity)
  const persistOpen = host.persistOpen ?? (host.lock !== undefined || locks !== undefined)
  const Channel = realm.BroadcastChannel
  const openChannel = host.channel ?? ((name: string) => Channel === undefined ? undefined : new Channel(name))
  const counts = given.get(identity) ?? new Map<string, number>()
  given.set(identity, counts)
  const increment = (principal: string) => counts.set(principal, (counts.get(principal) ?? 0) + 1)
  let channel: BroadcastChannel | undefined
  const keys = (prefix: string) => reach((storage) =>
    Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "").filter((key) => key.startsWith(prefix)), [])
  const forget = (key: string) => reach((storage) => storage.removeItem(key), undefined)
  const holds = (key: string, otherwise: boolean) => reach((storage) => storage.getItem(key) !== null, otherwise)
  const standing = (): Standing => {
    const principal = host.principal()
    if (principal === undefined) return NOTHING
    return reach((storage) => {
      const refused = new Map<string, { readonly conversationId: string; readonly id: string; readonly token: string }>()
      const open = new Set<string>()
      for (let index = 0; index < storage.length; index++) {
        // No key at an index the storage counted, or no value under a key it named: another tab removed one meanwhile.
        const key = storage.key(index) ?? ""
        const fact = factOf(key, principal)
        if (fact?.kind === "refused") refused.set(key, { conversationId: fact.conversationId, id: fact.id, token: storage.getItem(key) ?? "" })
        else if (fact?.kind === "open") open.add(fact.conversationId)
      }
      return { refused, open }
    }, NOTHING)
  }
  const anchor = () => {
    const principal = host.principal()
    if (principal === undefined) return
    const key = keyOf("epoch", principal)
    if (!holds(key, true)) put(key, token())
  }
  const marks: RefusalMarks = {
    read: () => {
      const principal = host.principal()
      if (principal === undefined) return []
      return reach((storage) => {
        const marks: Array<Refused> = []
        for (let index = 0; index < storage.length; index++) {
          // No key at an index the storage counted: another tab removed one meanwhile.
          const fact = factOf(storage.key(index) ?? "", principal)
          if (fact?.kind === "refused") marks.push({ id: fact.id, conversationId: fact.conversationId })
        }
        return marks
      }, [])
    },
    add: (mark) => {
      const principal = host.principal()
      if (principal === undefined) return false
      // The mark before its index: a sibling `remove` that misses this mark rechecks after it drops the index.
      const key = keyOf("refused", principal, mark.conversationId, mark.id)
      if (!put(key, token())) return false
      if (put(keyOf("refusal", principal, mark.conversationId), "1")) return true
      forget(key)
      return false
    },
    restate: (mark) => {
      const principal = host.principal()
      if (principal === undefined) return false
      const key = keyOf("refused", principal, mark.conversationId, mark.id)
      return holds(key, false) && put(key, token())
    },
    remove: (marks) => {
      const principal = host.principal()
      if (principal === undefined) return
      const affected = new Set(marks.map((mark) => mark.conversationId))
      for (const mark of marks) forget(keyOf("refused", principal, mark.conversationId, mark.id))
      for (const conversationId of affected) {
        const index = keyOf("refusal", principal, conversationId)
        const left = () => keys(keyOf("refused", principal, conversationId) + ":").length > 0
        if (!holds(index, false) || left()) continue
        forget(index)
        // A sibling `add` may have written its mark after the check: its index write then lands after this removal.
        if (left()) put(index, "1")
      }
    },
    has: (mark) => {
      const principal = host.principal()
      return principal !== undefined && holds(keyOf("refused", principal, mark.conversationId, mark.id), true)
    },
    granted: (conversationId) => {
      const principal = host.principal()
      return principal !== undefined && persistOpen && holds(keyOf("open", principal, conversationId), false)
    },
    refused: (conversationId) => {
      const principal = host.principal()
      return principal !== undefined && holds(keyOf("refusal", principal, conversationId), false)
    },
    grant: (conversationId) => {
      const principal = host.principal()
      if (principal === undefined) return
      if (!persistOpen) return
      const open = keyOf("open", principal, conversationId)
      if (!holds(open, true)) put(open, OPEN(principal, conversationId))
    },
    revoke: (conversationId) => {
      const principal = host.principal()
      if (principal === undefined) return
      reach((storage) => storage.removeItem(keyOf("open", principal, conversationId)), undefined)
    },
    standing,
    later: (conversationId, since, covered = () => false) => {
      const now = standing()
      for (const [key, said] of now.refused) {
        if (said.conversationId === conversationId && since.refused.get(key)?.token !== said.token && !covered(said.id, said.token)) return true
      }
      return since.open.has(conversationId) && !now.open.has(conversationId)
    },
    token: (mark) => {
      const principal = host.principal()
      return principal === undefined ? null : reach((storage) => storage.getItem(keyOf("refused", principal, mark.conversationId, mark.id)), null)
    },
    epoch: () => {
      const principal = host.principal()
      return principal === undefined ? UNKEPT : reach((storage) => storage.getItem(keyOf("epoch", principal)), null)
    },
    anchor,
    advance: () => {
      const principal = host.principal()
      if (principal === undefined) return
      increment(principal)
      const key = keyOf("epoch", principal)
      if (!put(key, token())) reach((storage) => storage.removeItem(key), undefined)
    },
    principal: host.principal,
    routeDenials: () => {
      const principal = host.principal()
      const denials = new Map<string, string>()
      if (principal === undefined) return denials
      const prefix = keyOf("route", principal) + ":"
      for (const key of keys(prefix)) {
        const route = decodedRoute(key.slice(prefix.length))
        // A key no tab of ours wrote, with an escape that does not decode: no branch, and the scan goes on.
        if (route === undefined) continue
        const live = reach((storage) => activeRouteToken(storage, principal, route), null)
        if (live !== null) denials.set(route, live)
      }
      return denials
    },
    routeToken: (route) => {
      const principal = host.principal()
      return principal === undefined ? null : reach((storage) => activeRouteToken(storage, principal, route), null)
    },
    hasRouteDenial: (route) => {
      const principal = host.principal()
      return principal !== undefined && reach((storage) => activeRouteToken(storage, principal, route) !== null, false)
    },
    refuseRoute: (route) => {
      const principal = host.principal()
      if (principal === undefined) return false
      const key = routeRefusedKey(principal, route)
      // A token neither key holds: the refusal differs from the last one and from any clear of it.
      const seen = reach((storage) => [storage.getItem(key), storage.getItem(routeClearedKey(principal, route))], [])
      let generation: string
      do generation = token()
      while (seen.includes(generation))
      let taken = put(key, generation)
      if (!taken) {
        // Only `open` keys go: this write takes no turn, and a cleared key it removed could be a sibling's clear made
        // a moment before, hiding a branch that tab was told it may read.
        for (const open of keys(keyOf("open", principal) + ":")) forget(open)
        taken = put(key, generation)
      }
      increment(principal)
      // The generation moves once the refusal is written: a read begun at it never sees the branch open.
      const epoch = keyOf("epoch", principal)
      if (!put(epoch, token())) forget(epoch)
      return taken
    },
    clearRoute: (route, fencedToken) => {
      const principal = host.principal()
      if (principal === undefined || fencedToken === undefined) return UNCHANGED
      // The refusal's key is only read: a sibling's newer refusal, written any time, stays unequal to this clear.
      return reach((storage): RouteClear => {
        const live = storage.getItem(routeRefusedKey(principal, route))
        const prevCleared = storage.getItem(routeClearedKey(principal, route))
        if (live !== fencedToken || prevCleared === fencedToken) return { changed: false, ok: live === fencedToken }
        storage.setItem(routeClearedKey(principal, route), fencedToken)
        return { changed: true, ok: true, prevCleared }
      }, FAILED)
    },
    restoreRoute: (route, prevCleared) => {
      const principal = host.principal()
      if (principal === undefined) return false
      const key = routeClearedKey(principal, route)
      const restored = reach((storage) => {
        if (prevCleared !== null && put(key, prevCleared)) return true
        // No cleared token at all: the refused token, unequal to none, denies the branch, and a removal takes no room.
        storage.removeItem(key)
        return true
      }, false)
      return restored || marks.refuseRoute(route)
    },
    broadcast: (denial) => channel?.postMessage(denial),
    listen: (listener, adopted) => {
      const events = host.adoptionEvents ?? (browser ? window : undefined)
      const bind = () => {
        channel?.close()
        const principal = host.principal()
        const opened = principal === undefined ? undefined : openChannel(`smithers:refusal-channel:${principal}`)
        channel = opened
        if (opened !== undefined && principal !== undefined) {
          opened.onmessage = ({ data }: MessageEvent<Denial>) => {
            increment(principal)
            listener(data)
          }
        }
      }
      const changed = () => {
        bind()
        anchor()
        adopted?.()
      }
      events?.addEventListener(DEVICE_ADOPTED_EVENT, changed)
      bind()
      return () => {
        events?.removeEventListener(DEVICE_ADOPTED_EVENT, changed)
        channel?.close()
        channel = undefined
      }
    },
    memory: () => {
      const principal = host.principal()
      return principal === undefined ? 0 : counts.get(principal) ?? 0
    },
    lock: (turn) => {
      const principal = host.principal()
      return principal === undefined ? turn() : lock(lockName(principal), turn)
    },
    subscribe: (listener) => host.changes((key) => {
      if (key === null) return listener()
      const principal = host.principal()
      if (principal !== undefined && (key.startsWith(keyOf("route", principal) + ":") || key.startsWith(keyOf("route-cleared", principal) + ":"))) return listener()
      const fact = principal === undefined ? undefined : factOf(key, principal)
      if (fact?.kind === "refused") listener({ conversationId: fact.conversationId, id: fact.id })
      else if (fact?.kind === "open") listener({ conversationId: fact.conversationId })
      else if (fact?.kind === "refusal") listener({ conversationId: fact.conversationId, held: true })
    }),
  }
  return marks
}
