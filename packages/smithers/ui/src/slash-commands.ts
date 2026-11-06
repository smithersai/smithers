/** Slash-command completion for a composer: which rows a draft lists, and what a submitted line runs.
 *
 * Renderer-neutral and pure, like `command-line.ts`: no store, no DOM, no
 * React. A command is a flow's name, its description and its payload's fields
 * (`formFieldsFor`), so the menu and the submit read one declaration. The
 * grammar is `command-line.ts`'s `parseSubmit` and `flow-form.ts`'s
 * positional read: `/theme dark` fills the first field with `dark`.
 * @since 1.0.0
 */
import { parseSubmit } from "./command-line"
import { type FormField, positionalRead } from "#vibelang/emitted/src/flow-form"

/** One command a composer offers: its name without the slash, what it does, and its arguments. */
export interface SlashCommand {
  readonly name: string
  readonly description: string
  /** The flow's payload as fields, from `formFieldsFor(payloadSchema)`: its arguments, in schema order. */
  readonly fields: ReadonlyArray<FormField>
}

/** One row of the menu, and what choosing it does to the draft. */
export interface SlashCompletion {
  /** Stable across drafts: `command:<name>`, or `value:<command>:<field>:<value>`. */
  readonly id: string
  /** `/theme`, or an argument's value: `dark`. */
  readonly label: string
  /** A command's description; absent on a value. */
  readonly detail?: string
  /** The draft once this row is chosen. A command with arguments ends in a space, so the next menu lists them. */
  readonly draft: string
  /** Choosing this row with Enter runs the command: its draft then names every required argument. */
  readonly runs: boolean
}

/**
 * What a draft lists:
 * - `commands`: the draft is `/` and part of a name, and these commands match it;
 * - `values`: the draft names a command and is typing an argument whose field has options (`field`);
 * - `none`: nothing to list.
 */
export type SlashMenu =
  | { readonly kind: "commands"; readonly items: ReadonlyArray<SlashCompletion> }
  | { readonly kind: "values"; readonly field: FormField; readonly items: ReadonlyArray<SlashCompletion> }
  | { readonly kind: "none"; readonly items: readonly [] }

const NONE: SlashMenu = { kind: "none", items: [] }

/** The fields a line fills by position: every field but a boolean, which only a `--flag` sets. */
const positional = (command: SlashCommand): ReadonlyArray<FormField> =>
  command.fields.filter((field) => field.kind !== "boolean")

/** Best match first: `rank` answers 0 (best) to 3, or undefined for no match; ties keep the input's order. */
const ranked = <A>(items: ReadonlyArray<A>, rank: (item: A) => number | undefined): Array<A> =>
  items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .filter((entry): entry is { item: A; index: number; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item)

const commandRows = (query: string, commands: ReadonlyArray<SlashCommand>): Array<SlashCompletion> =>
  ranked(commands, (command) => {
    const name = command.name.toLowerCase()
    if (name === query) return 0
    if (name.startsWith(query)) return 1
    if (name.includes(query)) return 2
    return command.description.toLowerCase().includes(query) ? 3 : undefined
  }).map((command) => {
    const takesArguments = positional(command).length > 0
    return {
      id: `command:${command.name}`,
      label: `/${command.name}`,
      detail: command.description,
      draft: takesArguments ? `/${command.name} ` : `/${command.name}`,
      runs: !command.fields.some((field) => field.required && field.kind !== "boolean"),
    }
  })

const valueRows = (draft: string, command: SlashCommand, argumentsText: string): SlashMenu => {
  const tokens = argumentsText.split(/\s+/).filter((token) => token !== "")
  const typing = /\s$/.test(argumentsText) ? "" : tokens.pop()!
  // A `--flag` ends the positional arguments, as the submit reads them.
  if (tokens.some((token) => token.startsWith("--")) || typing.startsWith("--")) return NONE
  const slots = positional(command)
  const field = slots[tokens.length]
  if (field?.options === undefined) return NONE
  const query = typing.toLowerCase()
  const before = draft.slice(0, draft.length - typing.length)
  const more = slots.length > tokens.length + 1
  const runs = !slots.slice(tokens.length + 1).some((later) => later.required)
  const items = ranked(field.options.filter((option) => option.disabled !== true), (option) => {
    const value = option.value.toLowerCase()
    const label = option.label.toLowerCase()
    if (value.startsWith(query) || label.startsWith(query)) return 0
    return value.includes(query) || label.includes(query) ? 1 : undefined
  }).map((option) => ({
    id: `value:${command.name}:${field.name}:${option.value}`,
    label: option.label,
    draft: `${before}${option.value}${more ? " " : ""}`,
    runs,
  }))
  return items.length === 0 ? NONE : { kind: "values", field, items }
}

/**
 * The menu for `draft`, from the commands the person may run:
 * - `/` and the start of a name lists the commands that match, best first: the exact name, then names that start
 *   with it, then names that contain it, then commands whose description contains it;
 * - `/<name> ` and the start of an argument lists that argument's options, when its field has them (a select);
 * - anything else lists nothing.
 *
 * @category completion
 */
export const slashMenu = (draft: string, commands: ReadonlyArray<SlashCommand>): SlashMenu => {
  if (!draft.startsWith("/") || draft.includes("\n")) return NONE
  const body = draft.slice(1)
  const space = body.search(/\s/)
  if (space === -1) {
    const items = commandRows(body.toLowerCase(), commands)
    return items.length === 0 ? NONE : { kind: "commands", items }
  }
  const command = commands.find((candidate) => candidate.name === body.slice(0, space))
  return command === undefined ? NONE : valueRows(draft, command, body.slice(space))
}

/**
 * What submitting `text` does:
 * - `empty`: blank, or a bare `/`;
 * - `prompt`: prose for the agent, including a slash that isn't command syntax (`/etc/hosts`);
 * - `unknown`: command syntax naming no command offered, so the app answers it and the agent never sees it;
 * - `missing`: a command with required arguments the line didn't give, by field name;
 * - `invalid`: an argument that isn't one of its field's options;
 * - `run`: the command and its payload, by field name.
 *
 * @category completion
 */
export type SlashSubmit<C extends SlashCommand = SlashCommand> =
  | { readonly kind: "empty" }
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "unknown"; readonly name: string }
  | { readonly kind: "missing"; readonly command: C; readonly fields: ReadonlyArray<string> }
  | { readonly kind: "invalid"; readonly command: C; readonly field: string }
  | { readonly kind: "run"; readonly command: C; readonly payload: Readonly<Record<string, unknown>> }

/**
 * Reads a submitted line against the commands offered. Arguments fill the command's fields in schema order
 * (`positionalRead`), the last text field takes the rest of the line, and `--name` sets a boolean field, which is
 * otherwise `false` when required and absent when optional. The command answered is the very one offered, so a host's
 * own fields on it (the flow it runs) come back with it.
 *
 * @category completion
 */
export const slashSubmit = <C extends SlashCommand>(text: string, commands: ReadonlyArray<C>): SlashSubmit<C> => {
  const parsed = parseSubmit(
    text,
    commands.map((command) => ({ name: command.name, acceptsArgs: command.fields.length > 0 })),
  )
  switch (parsed.kind) {
    case "empty":
      return parsed
    case "prompt":
      return parsed
    case "unknown-command":
      return { kind: "unknown", name: parsed.name }
    case "command": {
      const command = commands.find((candidate) => candidate.name === parsed.name)!
      const payload: Record<string, unknown> = { ...positionalRead(command.fields, undefined, parsed.args).payload }
      const flags = new Set((parsed.args ?? "").split(/\s+/).filter((token) => token.startsWith("--")))
      for (const field of command.fields) {
        if (field.kind !== "boolean") continue
        if (flags.has(`--${field.name}`)) payload[field.name] = true
        else if (field.required) payload[field.name] = false
      }
      const invalid = command.fields.find((field) =>
        field.options !== undefined &&
        payload[field.name] !== undefined &&
        !field.options.some((option) => option.disabled !== true && option.value === payload[field.name])
      )
      if (invalid !== undefined) return { kind: "invalid", command, field: invalid.name }
      const missing = command.fields.filter((field) => field.required && payload[field.name] === undefined)
      if (missing.length > 0) return { kind: "missing", command, fields: missing.map((field) => field.name) }
      return { kind: "run", command, payload }
    }
  }
}
