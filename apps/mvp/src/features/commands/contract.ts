// Slash commands' contract (docs/features/slash-commands.md): the menu's copy and the telemetry names the browser, the
// relay and the tests share. Nothing here imports a library, so every side can.

/** The list's accessible name while it lists commands; while it lists an argument's values, the field's label. */
export const COMMANDS = "Commands"

/** The status line after `/<name>` named no command this person may run. */
export const unknownCommand = (name: string) => `/${name} isn't a command`

/** The status line after `/<command>` left out required arguments, by field label. */
export const missingArguments = (command: string, fields: ReadonlyArray<string>) => {
  if (command === "repo" || command === "issues") return `/${command} owner/name`
  if (command === "docs") return "/docs owner/name query"
  return `/${command} needs ${fields.join(" and ")}`
}

/** The status line after an argument that isn't one of its field's options. */
export const invalidArgument = (command: string, options: ReadonlyArray<string>) =>
  `/${command} takes ${options.join(" or ")}`

/**
 * What slash commands record in the browser (docs/observability.md#browser), by name, and the attributes they carry.
 * A command runs a flow, recorded with every dispatch (`flow.dispatch`, door `slash`). `command` is the name of a
 * command the app offers, never what someone typed: a line naming no command is counted without it.
 */
export const COMMANDS_TELEMETRY = {
  records: ["slash.choose", "slash.run", "slash.refused", "smithers_slash_choices", "smithers_slash_submits"],
  fields: ["command", "outcome", "kind", "how", "via", "match", "index"],
} as const
