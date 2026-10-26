import { Uuid, WebCrypto } from "@smthrs/crypto"
import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Persistence } from "@smthrs/effect-tanstack-db"
import { type PresenceProtocol, PresenceSocket, SharedText } from "@smthrs/sync"
import { Context, Effect, Exit, Layer, Metric, Option, Ref, Scope, Semaphore, Stream } from "effect"
import { Base64 } from "effect/encoding"
import * as Socket from "effect/socket/Socket"
import { scopeOf, scopeParams, TEXT_NAMESPACE, textName, type TextOf, textRoomRoute, TEXTS_SHAPE_ROUTE, type TextScope } from "./contract"
import { opens } from "./metrics"
import { SAVED_MARK, savedMarkOf } from "./saved"
import { type Collaborator, type Selection, Shared, TextUpdate } from "./schema"
import { TextWrites } from "./writes"

// The texts this tab has open (decision 0013 §4, docs/features/coedit.md#the-browser). Each is one `SharedText`
// replica, fed by the text's Electric shape (what ChatApi stored) and by the outbox's rows (what this device typed and
// hasn't sent yet), so a reload or a dropped connection loses nothing. While a text is shown, this tab is in its room:
// it says where its own caret is, and hears everyone else's. A row of `coedit-texts` is what a frontend reads of it.

/** Where texts sync from: ChatApi's origin, for the text routes, the shapes and the rooms. */
export interface CoeditConfig {
  readonly origin: string
}

/** Everyone in a text's room as it last said, and which connection is this tab's. */
interface Roster {
  readonly self: string | undefined
  readonly participants: ReadonlyArray<PresenceProtocol.Participant>
}

/** This tab's selection in a text, as anchors that follow the text through everyone's edits. */
interface Mine {
  readonly anchor: Uint8Array
  readonly head: Uint8Array
}

/** A shown text's room: the scope that closes its socket, and the connection. */
interface Room {
  readonly scope: Scope.Closeable
  readonly connection: PresenceSocket.Connection
}

/** One open text: its replica, its synced updates, and, while it is shown, its room. */
export interface Live {
  readonly id: string
  readonly of: TextOf
  readonly scope: TextScope
  readonly replica: SharedText.SharedText
  readonly updates: ElectricCollection.ElectricCollection<TextUpdate>
  readonly mine: Ref.Ref<Mine | undefined>
  readonly roster: Ref.Ref<Roster>
  /** The room, while the text is shown. */
  readonly room: Ref.Ref<Room | undefined>
  /** Updates this tab made that the outbox didn't take (another tab led it): they go with the next one. */
  readonly unsent: Ref.Ref<ReadonlyArray<Uint8Array>>
  /** Updates the outbox took and is still storing. */
  readonly admitting: Ref.Ref<number>
}

/** Every open text, as frontends read it. */
export const textsQuery = (texts: Collection.Collection<Shared, string>) =>
  LiveQuery.make((q) => q.from({ text: texts.tanstack }))

/** A text's id: the version 5 UUID of what it is, the same on every device. */
export const textIdOf = (of: TextOf) =>
  Uuid.v5(TEXT_NAMESPACE, textName(of)).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)

/** The key a text's row carries: the conversation, `<conversation>/<path>` for a file, or `<run>/<version>`. */
export const keyOf = (of: TextOf) =>
  of.kind === "prompt" ? of.conversation : of.kind === "file" ? `${of.conversation}/${of.path}` : `${of.run}/${of.version}`

export { SAVED_MARK, savedMarkOf } from "./saved"

/** Whether `text` is what the `saved` mark `mark` says a Save wrote. */
const isSaved = (mark: string | undefined, text: string): boolean =>
  mark !== undefined && mark.startsWith(`${text.length}:`) && mark === savedMarkOf(text)

/** A cursor as a room state: the anchors, as base64. */
export const encodeCursor = (mine: Mine): string =>
  JSON.stringify({ a: Base64.encode(mine.anchor), h: Base64.encode(mine.head) })

/** A room state's anchors, or `undefined` for a state that isn't a cursor. */
export const decodeCursor = (state: string | null): Mine | undefined => {
  if (state === null) return undefined
  try {
    const { a, h } = JSON.parse(state) as { readonly a?: unknown; readonly h?: unknown }
    if (typeof a !== "string" || typeof h !== "string") return undefined
    const anchor = Base64.decode(a)
    const head = Base64.decode(h)
    return anchor._tag === "Success" && head._tag === "Success" ? { anchor: anchor.success, head: head.success } : undefined
  } catch {
    return undefined
  }
}

/** Co-editing's state for one tab. */
export class CoeditStore extends Context.Service<
  CoeditStore,
  {
    readonly texts: Collection.Collection<Shared, string>
    readonly textsState: Effect.Success<ReturnType<typeof textsQuery>>
    /** Opens `of`, unless it is open: its replica and updates are kept for as long as the store lives. */
    readonly open: (of: TextOf) => Effect.Effect<Live>
    /** An open text, by id. */
    readonly live: (textId: string) => Live | undefined
    /** Joins an open text's room, unless this tab is in it. */
    readonly show: (live: Live) => Effect.Effect<void>
    /** Leaves an open text's room: nobody sees this tab's caret there, and it sees nobody's. */
    readonly hide: (live: Live) => Effect.Effect<void>
    /** Brings an open text's row up to date: its text, this person's selection and everyone else's carets. */
    readonly refresh: (live: Live) => Effect.Effect<void>
    /** Where background work an action starts runs. */
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/coedit/CoeditStore") {
  /** The store over the outbox's text writes; its texts and rooms close with its scope. */
  static readonly layer = (config: CoeditConfig) => Layer.effect(CoeditStore, make(config))
}

const make = Effect.fnUntraced(function* (config: CoeditConfig) {
  const scope = yield* Effect.scope
  const persistence = yield* Persistence.Persistence
  const { sending } = yield* TextWrites
  const texts = yield* Collection.local<Shared, string>({ id: "coedit-texts", schema: Shared, getKey: (row) => row.id })
  const lives = new Map<string, Live>()
  // One open at a time, so two asks for one text open it once.
  const opening = yield* Semaphore.make(1)
  const roomOrigin = config.origin.replace(/^http/, "ws")
  // The page's own WebSocket, unless a test gives another.
  const sockets = Option.match(yield* Effect.serviceOption(Socket.WebSocketConstructor), {
    onNone: () => Socket.layerWebSocketConstructorGlobal,
    onSome: (construct) => Layer.succeed(Socket.WebSocketConstructor, construct),
  })

  /** Where `cursor` is in `live`'s text now, or none before the text it points into has arrived. */
  const placeOf = (live: Live, cursor: Mine) =>
    Effect.gen(function* () {
      const anchor = yield* live.replica.resolve(cursor.anchor)
      const head = yield* live.replica.resolve(cursor.head)
      return anchor === undefined || head === undefined ? Option.none<Selection>() : Option.some({ anchor, head })
    })

  const refresh = (live: Live) =>
    Effect.gen(function* () {
      const text = yield* live.replica.text
      const mine = yield* Ref.get(live.mine)
      const selection = mine === undefined ? null : Option.getOrNull(yield* placeOf(live, mine))
      const { self, participants } = yield* Ref.get(live.roster)
      const collaborators: Array<Collaborator> = []
      for (const participant of participants) {
        const cursor = participant.id === self ? undefined : decodeCursor(participant.state)
        const at = cursor === undefined ? Option.none<Selection>() : yield* placeOf(live, cursor)
        if (Option.isSome(at)) collaborators.push({ id: participant.id, name: participant.name, ...at.value })
      }
      const row = Option.getOrThrow(yield* texts.get(live.id))
      // Whoever saved, every tab reads it from the mark; a text changed since, by anyone, isn't saved.
      const saved = isSaved((yield* live.replica.marks).get(SAVED_MARK), text)
      const same = row.text === text && row.saved === saved && JSON.stringify(row.selection) === JSON.stringify(selection) &&
        JSON.stringify(row.collaborators) === JSON.stringify(collaborators)
      if (same) return
      yield* Effect.orDie(texts.update(live.id, (draft) => {
        draft.text = text
        draft.saved = saved
        draft.selection = selection
        draft.collaborators = collaborators
      }))
    })

  /** Applies one stored or queued update; bytes that aren't one are logged and skipped. */
  const apply = (live: Live, data: string) =>
    Effect.gen(function* () {
      const bytes = Base64.decode(data)
      const applied = bytes._tag === "Success" ? yield* Effect.exit(live.replica.apply(bytes.success)) : Exit.void
      if (bytes._tag === "Failure" || Exit.isFailure(applied)) {
        yield* Effect.logWarning("coedit.apply").pipe(Effect.annotateLogs({ outcome: "invalid", textId: live.id }))
      }
    })

  const open = (of: TextOf) =>
    Effect.gen(function* () {
      const id = yield* textIdOf(of)
      const known = lives.get(id)
      if (known !== undefined) return known
      const textScope = scopeOf(of)
      const query = new URLSearchParams({ text: id, ...scopeParams(textScope) }).toString()
      const replica = yield* SharedText.make
      const updates = yield* ElectricCollection.make<TextUpdate>({
        id: `text-updates:${id}`,
        schema: TextUpdate,
        getKey: (row) => row.id,
        syncMode: "eager",
        persist: { schemaVersion: 1 },
        shape: { url: `${config.origin}${TEXTS_SHAPE_ROUTE}?${query}` },
      })
      const live: Live = {
        id,
        of,
        scope: textScope,
        replica,
        updates,
        mine: yield* Ref.make<Mine | undefined>(undefined),
        roster: yield* Ref.make<Roster>({ self: undefined, participants: [] }),
        room: yield* Ref.make<Room | undefined>(undefined),
        unsent: yield* Ref.make<ReadonlyArray<Uint8Array>>([]),
        admitting: yield* Ref.make(0),
      }
      lives.set(id, live)
      yield* Effect.orDie(texts.insert({
        id,
        kind: of.kind,
        key: keyOf(of),
        // A file is loading until its first content arrives (actions.ts); a prompt or an answer starts empty.
        status: of.kind === "file" ? "loading" : "ready",
        shown: false,
        stored: true,
        failure: null,
        text: "",
        selection: null,
        collaborators: [],
        saving: false,
        saveFailed: false,
        saved: false,
      }))
      // What ChatApi stored, then what this device typed and the outbox still holds. A file's first content comes only
      // from ChatApi, so every device starts it from the same seed.
      yield* updates.changes({ initial: true }).pipe(
        Stream.runForEach((changes) =>
          Effect.gen(function* () {
            for (const change of changes) if (change.type === "insert") yield* apply(live, change.value.data)
            yield* refresh(live)
            if (of.kind === "file" && changes.some((change) => change.type === "insert")) {
              yield* Effect.orDie(texts.update(id, (draft) => void (draft.status = "ready")))
            }
          })
        ),
        Effect.forkIn(scope),
      )
      yield* sending.changes({ initial: true }).pipe(
        Stream.runForEach((changes) =>
          Effect.gen(function* () {
            const mineToApply = changes.filter((change) =>
              change.type === "insert" && change.value.textId === id && !change.value.seed
            )
            for (const change of mineToApply) yield* apply(live, change.value.data)
            if (mineToApply.length > 0) yield* refresh(live)
          })
        ),
        Effect.forkIn(scope),
      )
      yield* Effect.logInfo("coedit.open").pipe(Effect.annotateLogs({ kind: of.kind, textId: id }))
      yield* Metric.update(Metric.withAttributes(opens, { kind: of.kind }), 1)
      return live
    }).pipe(
      opening.withPermits(1),
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(Persistence.Persistence, persistence),
      Effect.annotateLogs({ feature: "coedit" }),
    )

  const show = (live: Live) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(live.room)) !== undefined) return
      const roomScope = yield* Scope.fork(scope)
      const url = `${roomOrigin}${textRoomRoute(live.id)}?${new URLSearchParams(scopeParams(live.scope)).toString()}`
      const connection = yield* PresenceSocket.connect(url).pipe(
        Effect.provide(sockets),
        Effect.provideService(Scope.Scope, roomScope),
      )
      yield* Ref.set(live.room, { scope: roomScope, connection })
      yield* Effect.orDie(texts.update(live.id, (draft) => void (draft.shown = true)))
      const mine = yield* Ref.get(live.mine)
      if (mine !== undefined) yield* connection.set(encodeCursor(mine))
      yield* connection.roster.pipe(
        Stream.runForEach((participants) =>
          Effect.andThen(Ref.update(live.roster, (roster) => ({ ...roster, participants })), refresh(live))
        ),
        Effect.forkIn(roomScope),
      )
      yield* connection.status.pipe(
        Stream.runForEach((status) =>
          status._tag === "Open"
            ? Effect.andThen(Ref.update(live.roster, (roster) => ({ ...roster, self: status.self })), refresh(live))
            : Effect.void
        ),
        Effect.forkIn(roomScope),
      )
    })

  const hide = (live: Live) =>
    Effect.gen(function* () {
      const room = yield* Ref.getAndSet(live.room, undefined)
      if (room === undefined) return
      yield* Scope.close(room.scope, Exit.void)
      yield* Effect.orDie(texts.update(live.id, (draft) => void (draft.shown = false)))
      yield* Ref.set(live.roster, { self: undefined, participants: [] })
      yield* refresh(live)
    })

  return CoeditStore.of({
    texts,
    textsState: yield* textsQuery(texts),
    open,
    live: (textId) => lives.get(textId),
    show,
    hide,
    refresh,
    scope,
  })
})
