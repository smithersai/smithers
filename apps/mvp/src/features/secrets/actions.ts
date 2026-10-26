import { Effect, Option, Redacted } from "effect"
import { repoId } from "../repo/contract"
import { SecretsClient } from "./api"
import { splitHosts, type WriteFailure } from "./contract"
import { record } from "./metrics"
import { type FormKind, formKey, type SecretForm, VIEW } from "./schema"
import { SecretsStore } from "./store"
import { onItsWay } from "./view"

// What a person does on a repository's Secrets page (docs/features/secrets.md#the-secrets-page), as Effects that finish
// synchronously. Opening the page sets what the route shows and syncs the repository's names. Add, Rotate and Delete
// send their write at once, in the person's own session, straight to ChatApi (`SecretsClient`), never through the
// device's outbox or a browser flow, either of which would keep the value on the device. The value is `Redacted` from
// the moment it reaches an action and lives only in the one request.
//
// ChatApi's 202 means the write's flow started, not that it landed: the form clears its fields at once and says Saving
// until the list shows the write (store.ts's follower), or that it hasn't shown up after `confirmWithin`. No whole
// answer is an unknown outcome, never a failure: the list may still show it landed. Every form's row is keyed by its
// repository, so an answer that comes after the page moved on changes only its own repository's form.

/** What the secrets route calls on a link's hover or focus: starts syncing the repository's names without showing them. */
export const warm = (owner: string, name: string) =>
  Effect.flatMap(SecretsStore, (store) => Effect.asVoid(store.listOf(repoId(owner, name))))

/** What the route calls on a navigation: shows `owner/name`'s secrets, and syncs them. */
export const open = (owner: string, name: string) =>
  Effect.gen(function* () {
    const store = yield* SecretsStore
    const id = repoId(owner, name)
    yield* store.view.update(VIEW, (row) => {
      if (row.repoId !== id) {
        row.rotating = null
        row.deleting = null
      }
      row.owner = owner
      row.name = name
      row.repoId = id
    })
    yield* store.listOf(id)
  }).pipe(Effect.orDie)

/** The routed repository: its owner, name and id. The view's one row is there from the store's start. */
const routed = Effect.flatMap(SecretsStore, (store) => Effect.map(store.view.toArray, (rows) => rows[0]!))

/** Forgets a form's last write, unless it is on its way. */
const forget = (key: string) =>
  Effect.gen(function* () {
    const { forms } = yield* SecretsStore
    const held = yield* forms.get(key)
    if (Option.isSome(held) && !onItsWay(held.value)) yield* forms.delete(key)
  })

/** Rotate on `secret`'s row: shows its form for a new value, and closes any other row's. */
export const startRotate = (secret: string) =>
  Effect.gen(function* () {
    yield* forget(formKey((yield* routed).repoId, "rotate", secret))
    yield* (yield* SecretsStore).view.update(VIEW, (row) => {
      row.rotating = secret
      row.deleting = null
    })
  }).pipe(Effect.orDie)

/** Delete on `secret`'s row: asks to confirm, and closes any other row's form. */
export const startDelete = (secret: string) =>
  Effect.gen(function* () {
    yield* forget(formKey((yield* routed).repoId, "delete", secret))
    yield* (yield* SecretsStore).view.update(VIEW, (row) => {
      row.deleting = secret
      row.rotating = null
    })
  }).pipe(Effect.orDie)

/** Cancel on a row's Rotate or Delete. */
export const cancel = Effect.flatMap(SecretsStore, (store) =>
  store.view.update(VIEW, (row) => {
    row.rotating = null
    row.deleting = null
  })).pipe(Effect.orDie)

/**
 * Marks a form's write `sending`, remembering the row's `updatedAt` now (`before`), so the list can tell when the write
 * landed. Answers the form's row, or none while its last write is on its way.
 */
const begin = (repo: string, kind: FormKind, secret: string) =>
  Effect.gen(function* () {
    const store = yield* SecretsStore
    const key = formKey(repo, kind, secret)
    const held = yield* store.forms.get(key)
    if (Option.isSome(held) && onItsWay(held.value)) return Option.none<SecretForm>()
    const before = Option.getOrNull(Option.map(yield* store.rowOf(repo, secret), (row) => row.updatedAt))
    const form: SecretForm = {
      id: key,
      repoId: repo,
      kind,
      secret,
      state: "sending",
      failure: null,
      before,
      saved: Option.isSome(held) ? held.value.saved : 0,
    }
    if (Option.isSome(held)) yield* store.forms.update(key, (row) => void Object.assign(row, form))
    else yield* store.forms.insert(form)
    return Option.some(form)
  })

/** The form's write was refused: it says why, and may be sent again. */
const refuse = (key: string, failure: WriteFailure) =>
  Effect.flatMap(SecretsStore, ({ forms }) =>
    forms.update(key, (row) => {
      row.state = "failed"
      row.failure = failure
    }))

/**
 * Sends a form's write through `send`, then: on 202, clears the form (`saved`) and waits for the list, saying it
 * hasn't shown up after `confirmWithin`; on a refusal, says why; on no whole answer, says the outcome is unknown.
 */
const sendFrom = (
  form: SecretForm,
  send: Effect.Effect<void, { readonly code?: WriteFailure | undefined }>,
  hosts?: number,
) =>
  Effect.gen(function* () {
    const store = yield* SecretsStore
    const op = form.kind === "delete" ? "delete" : "put"
    const counted = hosts === undefined ? {} : { hosts }
    yield* send.pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.gen(function* () {
            const saved = form.saved + 1
            yield* store.forms.update(form.id, (row) => {
              row.state = "confirming"
              row.saved = saved
            })
            yield* record(op, form.secret, "started", counted)
            yield* Effect.sleep(store.confirmWithin)
            const now = yield* store.forms.get(form.id)
            // Landed meanwhile (Add's form is `done`; Rotate's and Delete's are gone), or the form sent a later write.
            if (Option.isNone(now) || now.value.state !== "confirming" || now.value.saved !== saved) return
            yield* store.forms.update(form.id, (row) => void (row.state = "late"))
            yield* record(op, form.secret, "late")
          }),
        onFailure: (error) =>
          error.code === undefined
            ? Effect.andThen(
              store.forms.update(form.id, (row) => void (row.state = "unknown")),
              record(op, form.secret, "unknown", counted),
            )
            : Effect.andThen(refuse(form.id, error.code), record(op, form.secret, "refused", { ...counted, code: error.code })),
      }),
      // expected: the list can show Rotate's or Delete's write before its 202, and settling closes the form first
      Effect.ignore,
      Effect.forkIn(store.scope),
    )
  })

/**
 * Add, or Save on a row's Rotate: sets `secret` to `value`, bound to the hosts typed (`hostsText`, comma or line
 * separated). Add refuses a name the list already has: only Rotate replaces a secret, and it keeps the methods the secret
 * is bound to. The value goes into one `PUT`, `Redacted` until its body is made, and nowhere else. Answers whether the
 * write was sent: not while the form's last one is on its way, nor when the page refused it.
 */
export const put = (kind: "add" | "rotate", secret: string, value: string, hostsText: string) => {
  const sealed = Redacted.make(value)
  return Effect.gen(function* () {
    const store = yield* SecretsStore
    const view = yield* routed
    const begun = yield* begin(view.repoId, kind, secret)
    if (Option.isNone(begun)) return false
    const form = begun.value
    const hosts = splitHosts(hostsText)
    const local: WriteFailure | undefined = secret === "" ? "invalid_name" : kind === "add" && form.before !== null ? "exists" : undefined
    if (local !== undefined) {
      yield* refuse(form.id, local)
      yield* record("put", secret, "refused", { code: local, hosts: hosts.length })
      return false
    }
    // Rotate keeps the methods the secret is bound to; Add binds every method.
    const row = kind === "rotate" ? yield* store.rowOf(view.repoId, secret) : Option.none()
    const methods = Option.isSome(row) ? row.value.methods : null
    const send = (yield* SecretsClient).put(view.owner, view.name, secret, {
      value: sealed,
      hosts,
      ...(methods === null ? {} : { methods }),
    })
    yield* sendFrom(form, send, hosts.length)
    return true
  }).pipe(Effect.orDie)
}

/** Delete secret on a row's confirmation: deletes `secret`; its row leaves through the shape. Answers whether it was sent. */
export const remove = (secret: string) =>
  Effect.gen(function* () {
    const view = yield* routed
    const begun = yield* begin(view.repoId, "delete", secret)
    if (Option.isNone(begun)) return false
    yield* sendFrom(begun.value, (yield* SecretsClient).remove(view.owner, view.name, secret))
    return true
  }).pipe(Effect.orDie)
