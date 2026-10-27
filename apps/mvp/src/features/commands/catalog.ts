import { formFieldsFor, type SlashCommand } from "@smthrs/ui"
import { type Entry, entryOf, type FlowName, type Minimum, names } from "../../flows/registry"
import type { Viewer } from "../auth/viewer"

export { viewerOf } from "../auth/viewer"
export type { Viewer } from "../auth/viewer"

// The slash commands (docs/features/slash-commands.md): every registered flow with a slash door, in the registry's
// order, and the ones a person may run. A command is its flow's own declaration seen from the composer: its row shows
// short menu copy and its arguments are the flow's payload, so `/theme dark` runs the very `app/theme/set` the
// theme button and the agent run. Roles only hint here (decision 0007 §3); a flow that writes shared state checks
// again on the server.

/** A slash command: its name, row and arguments, the registered flow it runs, and the least a person must be. */
export interface Command extends SlashCommand {
  readonly flow: FlowName
  readonly minimum: Minimum
  /** The payload a plugin's command fixes (decision 0017, `commands`): `/queue` runs `app/navigate` to its view. */
  readonly args?: Readonly<Record<string, unknown>>
}

/** A description's first sentence: what a menu row shows. The rest is for the agent. */
export const summary = (description: string): string => {
  const trimmed = description.trim()
  return /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed)?.[0] ?? trimmed
}

/**
 * The commands of `registered`, registry entries by name, in its order. A slash description overrides the flow's first sentence. A slash
 * door that names its `fields` takes those, in its order; the rest of the payload keeps its defaults.
 */
export const commandsOf = (registered: ReadonlyArray<readonly [FlowName, Entry]>): ReadonlyArray<Command> =>
  registered.flatMap(([name, { flow, slash }]) => {
    if (slash === undefined) return []
    const fields = formFieldsFor(flow.payloadSchema, slash.hints)
    return [{
      name: slash.command,
      flow: name,
      minimum: slash.minimum,
      description: slash.description ?? summary(flow.description ?? ""),
      fields: slash.fields === undefined
        ? fields
        : slash.fields.flatMap((field) => fields.filter((candidate) => candidate.name === field)),
    }]
  })

/**
 * The slash commands plugins contribute (decision 0017, `commands`): each runs a flow of the one catalog with the
 * payload its manifest fixes, and its row shows the command's title. The person types no arguments.
 */
export const pluginCommands = (
  commands: ReadonlyArray<{
    readonly flow: string
    readonly title: string
    readonly minimum: Minimum
    readonly args?: Readonly<Record<string, unknown>> | undefined
    readonly slash?: { readonly name: string } | undefined
  }>,
): ReadonlyArray<Command> =>
  commands.flatMap(({ flow, title, minimum, args, slash }) =>
    slash === undefined
      ? []
      : [{ name: slash.name, flow: flow as FlowName, minimum, description: title, fields: [], ...(args === undefined ? {} : { args }) }]
  )

/** Every slash command the registry declares. */
export const COMMANDS: ReadonlyArray<Command> = commandsOf(names.map((name) => [name, entryOf(name)]))

const RANKS = { anyone: 0, guest: 1, member: 2, maintainer: 3, admin: 4 } as const satisfies Record<Minimum, number>

/** What a viewer counts as: anyone when signed out, a Guest when signed in with no role (decision 0007 §1), else the role. */
export const rankOf = (viewer: Viewer): number => (viewer.signedIn ? RANKS[viewer.role ?? "guest"] : RANKS.anyone)

/** The commands `viewer` may run, of `commands`. */
export const commandsFor = (viewer: Viewer, commands: ReadonlyArray<Command> = COMMANDS): ReadonlyArray<Command> =>
  commands.filter((command) => rankOf(viewer) >= RANKS[command.minimum])

