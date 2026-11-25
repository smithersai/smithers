/**
 * The catalog as a command line: one command per entry, one flag per payload
 * field, an `argv` executor with JSON or Markdown output, and the skill file
 * that teaches an agent the commands.
 *
 * Every payload a flow accepts is reachable. `--arg.<field>` names a field by
 * its exact name, and `--input-json` takes the whole payload. A field gets a
 * short flag (`planNodeId` is `--plan-node-id`) only when that flag is its
 * alone: a field whose short flag is one of the CLI's own options
 * (`--format`, `--out-format`, `--input-json`) or another field's has only
 * its `--arg.<field>` flag.
 *
 * A command descriptor is `incur`'s shape (`name`, `description`, an options
 * schema, `run`), so a host registers every one with the same loop. The
 * principal is always an agent: a terminal is not a person's door.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Cause from "./CauseReceipt.ts"
import * as Core from "./Core.ts"
import type * as Principal from "./Principal.ts"

/**
 * One flag of a command: the payload field it fills and how its text is read.
 *
 * @category models
 * @since 1.0.0
 */
export interface Flag {
  readonly flag: string
  readonly field: string
  readonly type: "string" | "integer" | "number" | "boolean" | "json"
  readonly required: boolean
  readonly description?: string
}

/**
 * One command: a catalog entry a delegate may run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Command {
  readonly name: string
  readonly description: string
  /** The payload's JSON Schema, for a host that builds its own option parser. */
  readonly options: Core.Entry["payload"]
  readonly flags: ReadonlyArray<Flag>
  readonly readOnly: boolean
  readonly run: (options: unknown) => Effect.Effect<Core.Requested | Core.Page, Core.CoreError>
}

/**
 * What a command wrote and how it exited: 0 done, 1 refused by the core, 2 bad usage.
 *
 * @category models
 * @since 1.0.0
 */
export interface Exit {
  readonly exitCode: 0 | 1 | 2
  readonly stdout: string
  readonly stderr: string
}

/**
 * The command line over one session.
 *
 * @category models
 * @since 1.0.0
 */
export interface Cli {
  readonly commands: Effect.Effect<ReadonlyArray<Command>, Core.CoreError>
  /** Runs `<tag> [--field value | --arg.<field> value]... [--input-json object] [--out-format json|md]`. */
  readonly run: (argv: ReadonlyArray<string>) => Effect.Effect<Exit>
  /** The skill file, generated from the catalog. */
  readonly skill: Effect.Effect<string, Core.CoreError>
}

/**
 * A payload field as a flag: `planNodeId` is `--plan-node-id`.
 *
 * @category encoding
 * @since 1.0.0
 */
export const flagOf = (field: string): string =>
  `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replaceAll("_", "-")}`

/**
 * The CLI's own options. `--out-format` (and its older name `--format`)
 * picks the output; `--input-json` takes the whole payload as one JSON
 * object. No payload field is given one of these as its flag.
 *
 * @category encoding
 * @since 1.0.0
 */
export const reservedFlags: ReadonlyArray<string> = ["--out-format", "--format", "--input-json"]

const argPrefix = "--arg."

/**
 * A payload field by its exact name: `format` is `--arg.format`. Every field
 * has this flag, whatever its name.
 *
 * @category encoding
 * @since 1.0.0
 */
export const argFlagOf = (field: string): string => `${argPrefix}${field}`

/**
 * The flags of an entry's payload fields. A field's flag is its short flag
 * when no option and no other field shares it, and `--arg.<field>` otherwise.
 *
 * @category encoding
 * @since 1.0.0
 */
export const flagsOf = (entry: Core.Entry): ReadonlyArray<Flag> => {
  const fields = Object.entries(entry.payload.properties ?? {})
  const short = fields.map(([field]) => flagOf(field))
  return fields.map(([field, schema], at): Flag => {
    const own = short[at] as string
    const shared = reservedFlags.includes(own) || own.startsWith(argPrefix) ||
      short.indexOf(own) !== short.lastIndexOf(own)
    const type = schema.type
    return {
      flag: shared ? argFlagOf(field) : own,
      field,
      type: type === "string" || type === "integer" || type === "number" || type === "boolean" ? type : "json",
      required: (entry.payload.required ?? []).includes(field),
      ...(schema.description === undefined ? {} : { description: schema.description })
    }
  })
}

// A flag's text as the JSON its field takes, or `undefined` when it is not that.
const valueOf = (flag: Flag, text: string): Core.Json | undefined => {
  switch (flag.type) {
    case "string":
      return text
    case "integer":
    case "number":
      return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : undefined
    case "boolean":
      return text === "true" ? true : text === "false" ? false : undefined
    case "json":
      try {
        return JSON.parse(text) as Core.Json
      } catch {
        return undefined
      }
  }
}

const pretty = (value: Core.Json): string => JSON.stringify(JSON.parse(Cause.canonical(value)), null, 2)

/**
 * Builds the command line for one CLI or skill session.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly engine: Core.Engine
  readonly evidence: Principal.IncurEvidence
  readonly name?: string
}): Effect.Effect<Cli, Principal.AuthRefused> =>
  Effect.map(options.engine.openIncur(options.evidence), (core): Cli => {
    const binary = options.name ?? "smithers"
    const commandOf = (entry: Core.Entry): Command => ({
      name: entry.tag,
      description: entry.description,
      options: entry.payload,
      flags: flagsOf(entry),
      readOnly: entry.readOnly,
      run: (payload) => Core.call(core, entry.tag, payload)
    })
    const commands = Effect.map(Core.entries(core), (all) => all.filter(Core.delegable).map(commandOf))
    const usage = (message: string): Exit => ({
      exitCode: 2,
      stdout: "",
      stderr: `${Cause.canonical({ code: "usage", detail: message })}\n`
    })
    const refused = (error: Core.CoreError): Exit => ({
      exitCode: 1,
      stdout: "",
      stderr: `${
        Cause.canonical({
          code: error.reason,
          operation: error.target,
          detail: error.detail,
          ...(error.code === undefined ? {} : { cause: error.code }),
          ...(error.missingFields === undefined ? {} : { missingFields: [...error.missingFields] })
        })
      }\n`
    })

    return {
      commands,
      run: (argv) =>
        Effect.gen(function*() {
          const [name, ...rest] = argv
          if (name === undefined || name.startsWith("--")) return usage(`usage: ${binary} <command> [--field value]...`)
          const catalog = yield* Effect.result(Core.entries(core))
          if (catalog._tag === "Failure") return refused(catalog.failure)
          // Flags come from the entry when the catalog has one. An unknown tag
          // still reaches the core, which answers for it.
          const entry = catalog.success.find((candidate) => candidate.tag === name)
          const flags = entry === undefined ? [] : flagsOf(entry)
          const given = new Map<string, Core.Json>()
          let whole: { readonly [field: string]: Core.Json } | undefined
          let format = "json"
          for (let at = 0; at < rest.length; at += 2) {
            const flag = rest[at] as string
            const text = rest[at + 1]
            if (text === undefined) return usage(`${flag} needs a value`)
            if (flag === "--out-format" || flag === "--format") {
              if (text !== "json" && text !== "md") {
                const field = flags.find((candidate) => flagOf(candidate.field) === flag)
                return usage(
                  `${flag} is the output format, json or md${
                    field === undefined ? "" : `; the payload field ${field.field} is ${field.flag}`
                  }`
                )
              }
              format = text
              continue
            }
            if (flag === "--input-json") {
              if (whole !== undefined) return usage("--input-json is given twice")
              let parsed: unknown
              try {
                parsed = JSON.parse(text)
              } catch {
                return usage("--input-json takes a JSON object")
              }
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                return usage("--input-json takes a JSON object")
              }
              whole = parsed as { readonly [field: string]: Core.Json }
              continue
            }
            // `--arg.<field>` is the field's exact name. Any other flag is a short flag.
            const known = flag.startsWith(argPrefix)
              ? flags.find((candidate) => candidate.field === flag.slice(argPrefix.length))
              : flags.find((candidate) => candidate.flag === flag)
            if (known === undefined) return usage(`${name} has no flag ${flag}`)
            if (given.has(known.field)) return usage(`${known.field} is given twice`)
            const value = valueOf(known, text)
            if (value === undefined) return usage(`${flag} takes ${known.type}`)
            given.set(known.field, value)
          }
          for (const [field, value] of Object.entries(whole ?? {})) {
            if (given.has(field)) return usage(`${field} is given twice`)
            given.set(field, value)
          }
          // Own data properties, whatever the field is called.
          const payload: { readonly [field: string]: Core.Json } = Object.fromEntries(given)
          const outcome = yield* Effect.result(Core.call(core, name, payload))
          if (outcome._tag === "Failure") return refused(outcome.failure)
          const value: Core.Json = { ...outcome.success }
          return {
            exitCode: 0,
            stdout: format === "md"
              ? `# ${name}\n\n\`\`\`json\n${pretty(value)}\n\`\`\`\n`
              : `${Cause.canonical(value)}\n`,
            stderr: ""
          }
        }),
      skill: Effect.map(Core.entries(core), (all) => {
        const lines = [
          "---",
          `name: ${binary}`,
          `description: Run ${binary} flows and read ${binary} queries from the command line.`,
          "---",
          "",
          `# ${binary}`,
          "",
          "Every command acts as your agent. Add `--out-format md` for Markdown; the default is one line of JSON.",
          "Name any payload field exactly with `--arg.<field> <value>`, or pass the whole payload with `--input-json '<object>'`.",
          "A flow's output carries `cause`, its provenance. Read any output's provenance with `ref/cause --ref <outputRef>`.",
          "",
          "## Commands",
          ""
        ]
        for (const entry of all.filter(Core.delegable)) {
          lines.push(`### \`${binary} ${entry.tag}\``, "", `${entry.title}. ${entry.description}`, "")
          for (const flag of flagsOf(entry)) {
            lines.push(`- \`${flag.flag} <${flag.type}>\`${flag.required ? " (required)" : ""}`)
          }
          lines.push("")
        }
        const personOnly = all.filter((entry) => !Core.delegable(entry))
        if (personOnly.length > 0) {
          lines.push("## Person-only", "", "The person runs these in the app. No command runs them.", "")
          for (const entry of personOnly) lines.push(`- \`${entry.tag}\`: ${entry.personOnly ?? entry.title}`)
          lines.push("")
        }
        return lines.join("\n")
      })
    }
  })
