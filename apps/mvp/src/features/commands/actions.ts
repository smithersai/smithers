import { slashMenu, slashSubmit } from "@smthrs/ui"
import { Effect, Metric, Option, Ref } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { AuthStore, SESSION } from "../auth/store"
import { ask, setDraft } from "../chat/actions"
import type { DraftSelection } from "../chat/sharedPrompt"
import { COMPOSER, PLACE } from "../chat/schema"
import { ChatStore } from "../chat/store"
import { pinRepository } from "../conversations/pin"
import { ACTION_FAILED } from "../home/contract"
import { pinConversation } from "../sandbox/actions"
import { openWebPage, refusedPage } from "../web/actions"
import { CANT_OPEN } from "../web/contract"
import { Plugins } from "../../plugins/plugins"
import { COMMANDS as COMMAND_LIST, type Command, commandsFor, pluginCommands, viewerOf } from "./catalog"
import { COMMANDS, invalidArgument, missingArguments, unknownCommand } from "./contract"
import { choices, submits } from "./metrics"
import { MENU, type Menu } from "./schema"
import { CommandsStore } from "./store"

// What a person does in the composer, as Effects that finish synchronously (docs/features/slash-commands.md). Typing
// lists what the draft completes to; the keys and the pointer move, choose and close; submitting runs a command's flow
// through `FlowDispatch`, door `slash`, or asks Smithers. The menu completes and submits from the commands this person
// may run, read at that moment.

/** The commands the person at the composer may run, as sign-in knows them now. */
const offered = Effect.gen(function* () {
  const { session, confirmed } = yield* AuthStore
  const { contributions } = yield* Plugins
  const now = Option.getOrThrow(yield* session.get(SESSION))
  return commandsFor(
    viewerOf(now, Option.getOrUndefined(yield* confirmed.get(SESSION))),
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
export const type = (text: string, selection?: DraftSelection) => Effect.andThen(setDraft(text, selection), list(text))

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
    const { place } = yield* ChatStore
    const conversation = (yield* place.get(PLACE)).pipe(Option.getOrThrow).conversationId
    yield* type("")
    // New typing, dismissal or another command advances the revision even when
    // its row is unchanged, so an older refusal cannot take over the composer.
    const { scope, revision } = yield* CommandsStore
    const cleared = yield* Ref.get(revision)
    const flows = yield* FlowDispatch
    // `/web … tab` opens its tab inside this keypress when the browser allows it (src/features/web/actions.ts).
    if (command.flow === "app/web/open") yield* openWebPage(payload as never, "slash", scope)
    else {
      // A sandbox tool runs on the branch of the conversation this tab shows now (src/features/sandbox/actions.ts), and
      // `/docs`, `/repo` and `/issues` show their views in that conversation. `/new` starts the conversation in the repository of the branch this
      // tab shows (src/features/conversations).
      const pinned = command.flow.startsWith("sandbox/") || PINNED_FLOWS.has(command.flow)
        ? yield* pinConversation(payload)
        : command.flow === "conversation/new"
        ? yield* pinRepository(payload)
        : payload
      const dispatch = flows.dispatch(command.flow, { ...pinned, ...command.args } as never, { door: "slash" })
      yield* Effect.gen(function* () {
        const result = yield* Effect.result(dispatch)
        if (command.flow !== "conversation/new" || (result._tag === "Success" && result.success._tag === "Done")) return
        if ((yield* Ref.get(revision)) !== cleared || (yield* draftNow) !== "" ||
          (yield* place.get(PLACE)).pipe(Option.getOrThrow).conversationId !== conversation) return
        yield* type(draft)
        yield* list(draft, ACTION_FAILED)
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
export const choose = (index: number, how: "accept" | "complete") =>
  Effect.gen(function* () {
    const menu = yield* menuNow
    const item = menu.items[index]
    if (item === undefined || menu.draft !== (yield* draftNow)) return
    yield* Metric.update(Metric.withAttributes(choices, { kind: menu.kind, how }), 1)
    if (how === "accept" && item.runs) return yield* submit(item.draft)
    yield* type(item.draft)
  }).pipe(Effect.annotateLogs({ feature: "commands" }))
