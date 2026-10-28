import { clearComposerSource } from "../../admissionSource"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { admissionReceipt, beginAdmission, executionOf, finishAdmission, identifyAdmission } from "../../writeAdmission"
import { slashMenu, slashSubmit } from "@smthrs/ui"
import { Effect, Exit, Metric, Option, Ref, Schema } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { AuthStore, SESSION } from "../auth/store"
import { ask, setDraft } from "../chat/actions"
import { MAX_QUESTION_LENGTH } from "../chat/contract"
import type { DraftSelection } from "../chat/sharedPrompt"
import { COMPOSER, PLACE } from "../chat/schema"
import { ChatStore } from "../chat/store"
import { pinBranch } from "../conversations/pin"
import { ACTION_FAILED } from "../home/contract"
import { RepoName } from "../repo/flows"
import { pinConversation } from "../sandbox/actions"
import { openWebPage, refusedPage } from "../web/actions"
import { CANT_OPEN } from "../web/contract"
import { Plugins } from "../../plugins/plugins"
import { COMMANDS as COMMAND_LIST, type Command, commandsFor, pluginCommands, viewerOf } from "./catalog"
import { COMMANDS, invalidArgument, missingArguments, unknownCommand } from "./contract"
import { choices, submits } from "./metrics"
import { MENU, type Menu } from "./schema"
import { CommandsStore } from "./store"
import { admissionNamespace, admitCommand, hasOutboxAdmission } from "./admission"
import { BranchStore } from "../branch/store"
import { CURRENT } from "../branch/schema"
import { RepoStore } from "../repo/store"
import { repoId } from "../repo/contract"
import { WRITE_ID_NAMESPACE } from "../issues/contract"

// Composer actions await local write admission (docs/features/slash-commands.md). Typing
// lists what the draft completes to; the keys and the pointer move, choose and close; submitting runs a command's flow
// through `FlowDispatch`, door `slash`, or asks Smithers. The menu completes and submits from the commands this person
// may run, read at that moment.

/** The commands the person at the composer may run, as sign-in knows them now. */
const offered = Effect.gen(function* () {
  const { session, confirmed } = yield* AuthStore
  const { contributions } = yield* Plugins
  const now = Option.getOrThrow(yield* session.get(SESSION))
  let viewer = viewerOf(now, Option.getOrUndefined(yield* confirmed.get(SESSION)))
  const { place } = yield* ChatStore
  const conversation = Option.getOrThrow(yield* place.get(PLACE)).conversationId
  if (conversation !== null) {
    const branch = yield* BranchStore
    const repos = yield* RepoStore
    const current = Option.getOrThrow(yield* branch.current.get(CURRENT))
    const role = current.status === "ready" && current.conversationId === conversation
      ? Option.getOrUndefined(yield* repos.roles.get(repoId(current.owner, current.repo)))
      : undefined
    if (current.status !== "none") viewer = { signedIn: viewer.signedIn, role: viewer.signedIn && role?.failure === undefined ? (role?.workspaceRole === undefined ? role?.role ?? null : role.workspaceRole) : null }
  }
  return commandsFor(
    viewer,
    [...COMMAND_LIST, ...pluginCommands(contributions.commands)],
  )
})

const draftNow = Effect.gen(function* () {
  const { composer } = yield* ChatStore
  return Option.getOrThrow(yield* composer.get(COMPOSER)).draft
})

const menuNow = Effect.gen(function* () {
  const { menu } = yield* CommandsStore
  return Option.getOrThrow(yield* menu.get(MENU))
})

const write = (fields: Partial<Omit<Menu, "id">>) =>
  Effect.gen(function* () {
    const { menu, revision } = yield* CommandsStore
    yield* Ref.update(revision, n => n + 1)
    yield* menu.update(MENU, (row) => void Object.assign(row, fields))
  }).pipe(Effect.orDie)

/** Lists what `draft` completes to, highlighting the first row, with `refusal` on the status line. */
const list = (draft: string, refusal: string | null = null) =>
  Effect.gen(function* () {
    const found = slashMenu(draft, yield* offered)
    yield* write({
      draft,
      kind: found.kind,
      label: found.kind === "values" ? found.field.label : COMMANDS,
      items: found.items.map(({ id, label, detail, draft, runs }) => ({ id, label, detail: detail ?? null, draft, runs })),
      highlighted: 0,
      refusal,
    })
  })

/** Typing: the composer's draft becomes `text`, with `selection` after, and the menu lists what it completes to. */
export const type = (text: string, selection?: DraftSelection) => Effect.andThen(list(text, text.trim().length > MAX_QUESTION_LENGTH ? "8,000 characters max" : null), setDraft(text, selection))

/** The arrows or the pointer moved the highlight to row `index`. */
export const highlight = (index: number) => write({ highlighted: index })

/** Escape: the menu closes and the draft stays. Typing lists again. */
export const dismiss = write({ items: [], highlighted: 0 })

/** Keeps the line in the composer, lists what it completes to, and says why it didn't run. */
const refuse = (outcome: "unknown" | "missing" | "invalid", copy: string, command?: Command) =>
  Effect.gen(function* () {
    yield* list(yield* draftNow, copy)
    const fields: Record<string, string> = command === undefined ? { outcome } : { outcome, command: command.name }
    yield* Metric.update(Metric.withAttributes(submits, fields), 1)
    yield* Effect.logWarning("slash.refused").pipe(Effect.annotateLogs(fields))
  })

/** The flows that add views to the conversation the tab shows, which a slash command pins into their payload. */
const PINNED_FLOWS: ReadonlySet<string> = new Set(["app/docs/search", "ui/repo", "ui/issues"])

/** Runs `command`'s flow with `payload` through dispatch, door `slash`, in the background; the composer clears at once. */
const run = (command: Command, payload: Readonly<Record<string, unknown>>, draft: string) =>
  Effect.gen(function* () {
    // `/web` names a page the app won't open: the line stays, saying why, and nothing runs (src/features/web/actions.ts).
    if (command.flow === "app/web/open") {
      const refused = yield* refusedPage(payload as never, "slash")
      if (Option.isSome(refused)) return yield* refuse("invalid", CANT_OPEN[refused.value], command)
    }
    if (payload.repo !== undefined && !Schema.is(RepoName)(payload.repo)) {
      return yield* refuse("invalid", `/${command.name} needs owner/name`, command)
    }
    const { place, composer } = yield* ChatStore
    const conversation = (yield* place.get(PLACE)).pipe(Option.getOrThrow).conversationId
    const pinned = command.flow.startsWith("sandbox/") || PINNED_FLOWS.has(command.flow)
      ? yield* pinConversation(payload)
      : command.flow === "branch/publish" || command.flow === "branch/update" || command.flow === "branch/resync"
      ? yield* pinBranch(payload)
      : payload
    const { scope, revision, requestNamespace } = yield* CommandsStore
    const before = yield* draftNow
    const generation = Option.getOrThrow(yield* composer.get(COMPOSER)).generation
    const input = { ...pinned, ...command.args }
    const staged = hasOutboxAdmission(command.flow)
      ? yield* beginAdmission(command.flow, input, { namespace: WRITE_ID_NAMESPACE, value: JSON.stringify([requestNamespace, yield* Ref.get(revision), conversation, command.flow, pinned]) }, undefined, { conversationId: conversation, text: before, generation })
      : Option.none()
    if (hasOutboxAdmission(command.flow) && Option.isNone(staged)) return yield* refuse("invalid", "Not sent", command)
    const executionId = Option.isSome(staged) ? yield* executionOf(staged.value) : crypto.randomUUID()
    if (Option.isSome(staged)) {
      const writeId = yield* Uuid.v5(admissionNamespace(command.flow), executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
      yield* identifyAdmission(staged.value, executionId, writeId)
    }
    const admission = yield* admitCommand(command.flow, input, executionId)
    if (Option.isSome(admission) && admission.value === "not_admitted") {
      // Only an outbox command can return not_admitted, so its input was staged above.
      yield* finishAdmission(Option.getOrThrow(staged), false)
      if ((yield* draftNow) === before && Option.getOrThrow(yield* composer.get(COMPOSER)).generation === generation && (yield* place.get(PLACE)).pipe(Option.getOrThrow).conversationId === conversation) yield* refuse("invalid", "Not sent", command)
      return
    }
    // A new tab must open while this keypress still owns browser activation, before shared-text admission waits.
    if (command.flow === "app/web/open") yield* openWebPage(payload as never, "slash", scope, conversation)
    let cleaned = true
    if (Option.isSome(staged)) {
      cleaned = Exit.isSuccess(yield* admissionReceipt(clearComposerSource(staged.value.composer!).pipe(
        Effect.flatMap(confirmed => confirmed ? Effect.void : Effect.fail("unconfirmed")),
      ), staged.value.commandId, command.flow, "source").pipe(Effect.exit))
      if ((yield* draftNow) === "" && (yield* place.get(PLACE)).pipe(Option.getOrThrow).conversationId === conversation) yield* list("")
      yield* finishAdmission(staged.value, Option.isSome(admission) && admission.value !== "not_admitted", cleaned)
    } else if ((yield* draftNow) === before && Option.getOrThrow(yield* composer.get(COMPOSER)).generation === generation && (yield* place.get(PLACE)).pipe(Option.getOrThrow).conversationId === conversation) yield* type("")
    // New typing, dismissal or another command advances the revision even when
    // its row is unchanged, so an older refusal cannot take over the composer.
    const cleared = yield* Ref.get(revision)
    const flows = yield* FlowDispatch
    if (command.flow !== "app/web/open" && (Option.isNone(admission) || admission.value === "queued")) {
      // A sandbox tool runs on the branch of the conversation this tab shows now (src/features/sandbox/actions.ts), and
      // `/docs`, `/repo` and `/issues` show their views in that conversation. `/new` names its repository explicitly; `/publish`, `/branch.update` and `/branch.resync` act on that branch.
      const dispatch = flows.dispatch(command.flow, { ...pinned, ...command.args } as never, { door: "slash", executionId })
      yield* Effect.gen(function* () {
        const result = yield* Effect.result(dispatch)
        const navigationFailed = command.flow === "app/navigate" &&
          (result._tag === "Failure" || result.success._tag === "Failed" ||
            !(result.success.value as { readonly moved: boolean }).moved)
        if (!navigationFailed && result._tag === "Success" && result.success._tag === "Done") return
        if ((yield* Ref.get(revision)) !== cleared || (yield* draftNow) !== "" ||
          (yield* place.get(PLACE)).pipe(Option.getOrThrow).conversationId !== conversation) return
        yield* type(draft)
        yield* list(draft, navigationFailed ? "Couldn’t open page" : ACTION_FAILED)
      }).pipe(Effect.forkIn(scope))
    }
    yield* Metric.update(Metric.withAttributes(submits, { outcome: "run", command: command.name }), 1)
    yield* Effect.logInfo("slash.run").pipe(Effect.annotateLogs({ command: command.name, flow: command.flow }))
  })

/**
 * Sends `text`, the composer's line: a command the person may run, with its arguments, runs its flow; a line naming no
 * such command, or one missing or misusing an argument, stays in the composer with one line saying why, so the agent
 * never improvises on it; anything else asks Smithers.
 */
export const submit = (text: string) =>
  Effect.gen(function* () {
    if (text.trim().length > MAX_QUESTION_LENGTH) return yield* refuse("invalid", "8,000 characters max")
    const submitted = slashSubmit(text, yield* offered)
    switch (submitted.kind) {
      case "empty":
        return
      case "prompt":
        yield* ask(submitted.text)
        return
      case "unknown":
        return yield* refuse("unknown", unknownCommand(submitted.name))
      case "missing": {
        const { command } = submitted
        const labels = command.fields.filter(({ name }) => submitted.fields.includes(name)).map(({ label }) => label)
        return yield* refuse("missing", missingArguments(command.name, labels.map(lower)), command)
      }
      case "invalid": {
        const { command } = submitted
        const field = command.fields.find(({ name }) => name === submitted.field)!
        return yield* refuse("invalid", invalidArgument(command.name, field.options!.map(({ value }) => value)), command)
      }
      case "run":
        return yield* run(submitted.command, submitted.payload, text)
    }
  }).pipe(Effect.annotateLogs({ feature: "commands" }))

const lower = (label: string) => label.toLowerCase()

/**
 * Enter or a click (`accept`) or Tab (`complete`) on row `index`: the composer takes the row's draft, and the menu
 * lists what follows, such as a command's argument values. Accepting a row whose draft names every required argument
 * runs it. A row of a menu for an older draft does nothing.
 */
export const choose = (index: number, how: "accept" | "complete", keyboard = false) =>
  Effect.gen(function* () {
    const menu = yield* menuNow
    if (menu.draft !== (yield* draftNow)) return
    let item: { readonly label: string; readonly draft: string; readonly runs: boolean } | undefined = menu.items[index]
    let match = "row"
    // React's menu query and the highlighted index may come from different renders. On Enter the typed command
    // is authoritative; a pointer click still selects the row the person explicitly chose.
    if (keyboard && menu.kind === "commands") {
      const current = slashMenu(menu.draft, yield* offered)
      const query = menu.draft.toLowerCase()
      const exact = current.items.find(candidate => candidate.label.toLowerCase() === query)
      const prefix = current.items.find(candidate => candidate.label.toLowerCase().startsWith(query))
      item = exact ?? (item?.label.toLowerCase().startsWith(query) ? item : prefix) ?? item
      match = exact !== undefined ? "exact" : prefix !== undefined ? "prefix" : "row"
    }
    if (item === undefined) return
    yield* Metric.update(Metric.withAttributes(choices, { kind: menu.kind, how }), 1)
    yield* Effect.logInfo("slash.choose").pipe(Effect.annotateLogs({ kind: menu.kind, how,
      via: keyboard ? "keyboard" : "selection", match, index }))
    if (how === "accept" && (item.runs || menu.draft.trim() === item.label)) {
      return yield* submit(item.runs ? item.draft : menu.draft)
    }
    yield* type(item.draft)
  }).pipe(Effect.annotateLogs({ feature: "commands" }))
