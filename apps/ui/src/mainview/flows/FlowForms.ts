/*
 * THE FORM LAW (apps/ui/AGENTS.md; docs/workbench-lanes/flow-forms.md): a
 * flow invoked without its required input renders a form for the missing
 * fields, never a usage sentence. The form is DERIVED here from the flow's
 * own input schema (the `Schema.Struct` every declaration in Flows.ts
 * carries), overlaid with the flow's optional `form` hints — labels,
 * placeholders, and the seam that supplies a field's options. No flow writes
 * a second hand-made form.
 *
 * Pure: no store, no DOM, no Effect runtime. The controller half
 * (state/controller/forms.ts) resolves option providers against the seams
 * and holds the draft in the card's payload.
 */
import { splitRunSource } from "./RunCommand"
import type { Schema, SchemaAST } from "effect"

export type FieldKind = "text" | "number" | "boolean" | "select"

/**
 * The seams a select may draw its options from (NO INVENTION: an option is a
 * fact a seam reported, never a guess). Resolved by controller/forms.ts.
 */
export const OPTION_PROVIDERS = [
  /** Installed harnesses with their credential state (the harness table). */
  "harnesses",
  /** The harnesses that can host a custom agent: installed, credentialed, with a verified model flag. */
  "agent-harnesses",
  /** The model ids the draft's harness accepts: its verified suggestions, then its own list command. */
  "harness-models",
  /** Repositories open in the local app. */
  "open-repos",
  /** Smithers Cloud repositories the session has loaded. */
  "cloud-repos",
  /** Bookmarks loaded onto a branches card. */
  "bookmarks",
  /** Cloud workspaces the session has loaded. */
  "workspaces",
  /** The agents (built-in and custom) with their availability here. */
  "agents",
  /** The plugin catalog, with the ones already on this workspace's shelf marked. */
  "plugins"
] as const
export type OptionProvider = (typeof OPTION_PROVIDERS)[number]

export interface FieldOption {
  readonly value: string
  readonly label: string
  /** The human cannot pick it; `reason` says why (not installed, no credential). */
  readonly disabled?: boolean
  readonly reason?: string
}

/** What a flow may say about one of its fields beyond what the schema already says. */
export interface FieldHint {
  readonly label?: string
  readonly placeholder?: string
  readonly optionsFrom?: OptionProvider
  /** Overrides the derived control (a provider-fed field that must stay free text keeps `text` and gets a datalist). */
  readonly kind?: FieldKind
  /** Overrides the schema's requiredness (a schema-required string the grammar accepts blank). */
  readonly required?: boolean
}

/** A flow's `form` declaration: per-field hints, and the two grammar inverses when the positional default is wrong. */
export interface FormHints {
  readonly fields?: Readonly<Record<string, FieldHint>>
  /** The filled payload back to the one slash line the flow's grammar parses. */
  readonly args?: (payload: Readonly<Record<string, unknown>>) => string
  /** What a slash line that failed to parse still gave, by field. */
  readonly partial?: (args: string) => Readonly<Record<string, unknown>>
}

export interface FormField {
  readonly name: string
  readonly label: string
  readonly kind: FieldKind
  readonly required: boolean
  readonly placeholder?: string
  readonly options?: ReadonlyArray<FieldOption>
  readonly optionsFrom?: OptionProvider
}

/** One field's value as the draft holds it. */
export type FieldValue = string | number | boolean
export type FormDraft = Readonly<Record<string, FieldValue>>

/** A payload value as trimmed text for an assembler; undefined when absent or blank. */
export const text = (payload: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = payload[key]
  if (value === undefined || value === null || typeof value === "boolean") return undefined
  const trimmed = String(value).trim()
  return trimmed === "" ? undefined : trimmed
}

/** `--name value` when the value is present, for the flag grammars. */
export const flag = (payload: Readonly<Record<string, unknown>>, key: string, name: string = key): string | undefined => {
  const value = text(payload, key)
  return value === undefined ? undefined : `--${name} ${value}`
}

/** The present parts as one slash line. */
export const line = (...parts: ReadonlyArray<string | undefined>): string =>
  parts.filter((part): part is string => part !== undefined && part !== "").join(" ")

/** "runId" → "Run id", "confirmName" → "Confirm name". */
export const humanize = (name: string): string => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `Schema.optional(S)` is `Union([S, Undefined])` marked optional: the control is S's. */
const unwrapOptional = (ast: SchemaAST.AST): { readonly ast: SchemaAST.AST; readonly optional: boolean } => {
  const optional = ast.context?.isOptional === true
  if (ast._tag === "Union") {
    const rest = ast.types.filter((member) => member._tag !== "Undefined")
    if (rest.length === 1 && rest[0] !== undefined) return { ast: rest[0], optional: optional || rest.length < ast.types.length }
  }
  return { ast, optional }
}

const literalOptions = (ast: SchemaAST.AST): ReadonlyArray<FieldOption> | undefined => {
  if (ast._tag === "Literal") return [{ value: String(ast.literal), label: String(ast.literal) }]
  if (ast._tag === "Union" && ast.types.length > 0 && ast.types.every((member) => member._tag === "Literal")) {
    return ast.types.map((member) => {
      const literal = String((member as SchemaAST.Literal).literal)
      return { value: literal, label: literal }
    })
  }
  return undefined
}

const controlOf = (ast: SchemaAST.AST): Pick<FormField, "kind" | "options"> => {
  switch (ast._tag) {
    case "Number":
      return { kind: "number" }
    case "Boolean":
      return { kind: "boolean" }
    default: {
      const options = literalOptions(ast)
      return options === undefined ? { kind: "text" } : { kind: "select", options }
    }
  }
}

/**
 * The form's fields, one per property of the flow's input struct, in schema
 * order. A schema that is not a struct (nothing in Flows.ts today) derives
 * nothing.
 *
 * @category derivation
 */
export const formFieldsFor = (input: Schema.Top, hints: FormHints | undefined): ReadonlyArray<FormField> => {
  const ast = input.ast
  if (ast._tag !== "Objects") return []
  return ast.propertySignatures.map((signature) => {
    const name = String(signature.name)
    const { ast: inner, optional } = unwrapOptional(signature.type)
    const control = controlOf(inner)
    const hint = hints?.fields?.[name]
    // A provider-fed field is a select unless the flow keeps it free text (a model id with a datalist).
    const kind = hint?.kind ?? (hint?.optionsFrom === undefined ? control.kind : "select")
    return {
      name,
      label: hint?.label ?? humanize(name),
      kind,
      required: hint?.required ?? !optional,
      ...(hint?.placeholder === undefined ? {} : { placeholder: hint.placeholder }),
      ...(control.options === undefined || kind !== "select" ? {} : { options: control.options }),
      ...(hint?.optionsFrom === undefined ? {} : { optionsFrom: hint.optionsFrom })
    }
  })
}

const tokensOf = (args: string | undefined): Array<string> =>
  (args ?? "").trim().split(/\s+/).filter((token) => token !== "")

/**
 * What a slash line that did not parse still gave, by field: the tokens fill
 * the non-boolean fields positionally in schema order, a `--flag` ends the
 * positional read, a token that is not a number ends it at a number field,
 * and whatever is left over rides the last text field filled (the grammars
 * take "the rest of the line" for their last text). A flow whose grammar is
 * not positional supplies its own `partial`.
 *
 * @category derivation
 */
export const partialPayload = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints | undefined,
  args: string | undefined
): Readonly<Record<string, unknown>> => {
  if (hints?.partial !== undefined) return hints.partial(args ?? "")
  const source = fields.some((field) => field.name === "sourceCard") ? splitRunSource(args) : { args, sourceCard: undefined }
  const tokens = tokensOf(source.args)
  const flag = tokens.findIndex((token) => token.startsWith("--"))
  const positional = flag === -1 ? tokens : tokens.slice(0, flag)
  const payload: Record<string, unknown> = source.sourceCard === undefined ? {} : { sourceCard: source.sourceCard }
  const slots = fields.filter((field) => field.kind !== "boolean" && field.name !== "sourceCard")
  let lastText: string | undefined
  let index = 0
  for (const field of slots) {
    const token = positional[index]
    if (token === undefined) break
    if (field.kind === "number") {
      const value = Number(token)
      if (!Number.isFinite(value)) break
      payload[field.name] = value
    } else {
      payload[field.name] = token
      lastText = field.name
    }
    index += 1
  }
  if (index === slots.length && lastText !== undefined && positional.length > index) {
    payload[lastText] = [payload[lastText], ...positional.slice(index)].join(" ")
  }
  return payload
}

/** What the input schema says about one property, past `Schema.optional`. */
interface PropertyShape {
  readonly optional: boolean
  readonly tag: SchemaAST.AST["_tag"]
}

/** The flow's input struct as the submission reads it: one shape per property, in schema order. */
const inputShape = (input: Schema.Top): ReadonlyMap<string, PropertyShape> => {
  const ast = input.ast
  const shape = new Map<string, PropertyShape>()
  if (ast._tag !== "Objects") return shape
  for (const signature of ast.propertySignatures) {
    const { ast: inner, optional } = unwrapOptional(signature.type)
    shape.set(String(signature.name), { optional, tag: inner._tag })
  }
  return shape
}

/**
 * One field's draft value as its property's schema takes it. A structure's
 * control is one line of text, so the inverse of the control is a parse: an
 * object field holds JSON, and a list field holds the space-separated items
 * `assembleArgs` writes and every list grammar reads. Text that is not the
 * JSON an object field needs is the form's refusal, not the flow's problem.
 */
const asProperty = (shape: PropertyShape | undefined, value: FieldValue): { readonly value: unknown } | { readonly invalid: true } => {
  if (typeof value !== "string" || shape === undefined) return { value }
  if (shape.tag === "Arrays") return { value: value.trim() === "" ? [] : value.trim().split(/\s+/) }
  if (shape.tag !== "Objects") return { value }
  try {
    return { value: JSON.parse(value) }
  } catch {
    return { invalid: true }
  }
}

/** A filled form as the flow's named payload, or the honest refusal one of its controls earned. */
export type Submission =
  | { readonly payload: Record<string, unknown> }
  | { readonly error: string }

/**
 * The filled form as the flow's OWN named payload — the record a submission
 * runs with, validated by the declaration's input schema.
 *
 * Field identity survives here, which the positional line cannot promise: a
 * value the human left blank is ABSENT rather than shifting the next field's
 * value into it, a prefilled free-text field the human cleared submits as the
 * clear it shows, a field the schema requires and a `required: false` hint
 * lets stand blank submits as the empty string that hint means, and a
 * structured field parses back out of the text its control holds.
 * `assembleArgs` still writes the slash line, but only as display copy —
 * nothing reparses it into the payload.
 *
 * @category derivation
 */
export const submissionPayload = (
  input: Schema.Top,
  fields: ReadonlyArray<FormField>,
  given: Readonly<Record<string, unknown>>,
  draft: FormDraft
): Submission => {
  const shape = inputShape(input)
  const represented = new Set(fields.map((field) => field.name))
  // What the form could not represent stays exactly as the invocation gave it.
  const payload: Record<string, unknown> = Object.fromEntries(
    Object.entries(given).filter(([name]) => !represented.has(name))
  )
  for (const field of fields) {
    const property = shape.get(field.name)
    const value = draft[field.name]
    if (value !== undefined) {
      const converted = asProperty(property, value)
      if ("invalid" in converted) return { error: `${field.label} is not valid JSON. Fix it before submitting the form.` }
      payload[field.name] = converted.value
      continue
    }
    const blankStands = property !== undefined && !property.optional && property.tag === "String"
    // A field the invocation filled and the human then cleared submits as the clear it shows.
    if (blankStands || (field.kind === "text" && typeof given[field.name] === "string")) payload[field.name] = ""
  }
  return { payload }
}

const coerce = (field: FormField, value: unknown): FieldValue | undefined => {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map(String).join(" ")
  switch (field.kind) {
    case "number": {
      const number = typeof value === "number" ? value : Number(String(value).trim())
      return Number.isFinite(number) && String(value).trim() !== "" ? number : undefined
    }
    case "boolean":
      return typeof value === "boolean" ? value : ["true", "on", "yes", "1"].includes(String(value).trim().toLowerCase())
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value)
  }
}

/**
 * The draft the card starts with: every given field coerced to its control's
 * value. Anything the form cannot represent stays only in `given`.
 *
 * @category derivation
 */
export const draftFrom = (fields: ReadonlyArray<FormField>, given: Readonly<Record<string, unknown>>): FormDraft => {
  const draft: Record<string, FieldValue> = {}
  for (const field of fields) {
    const value = coerce(field, given[field.name])
    if (value !== undefined) draft[field.name] = value
  }
  return draft
}

const blank = (value: FieldValue | undefined): boolean =>
  value === undefined || (typeof value === "string" && value.trim() === "")

/** The required fields the draft has not filled, in schema order. */
export const missingFields = (fields: ReadonlyArray<FormField>, draft: FormDraft): Array<string> =>
  fields.filter((field) => field.required && field.kind !== "boolean" && blank(draft[field.name])).map((field) => field.name)

/**
 * The filled form as the one slash line the flow's grammar parses. The
 * default is positional in schema order — blanks skipped, a true boolean as
 * `--name`, an array space-joined — which is the shape most grammars in
 * SlashPayload.ts take; a flow whose grammar differs supplies `args`.
 *
 * @category derivation
 */
export const assembleArgs = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints | undefined,
  payload: Readonly<Record<string, unknown>>
): string => {
  if (hints?.args !== undefined) return hints.args(payload).trim()
  return [...fields.filter((field) => field.name === "sourceCard"), ...fields.filter((field) => field.name !== "sourceCard")]
    .flatMap((field) => {
      const value = payload[field.name]
      if (value === undefined || value === null) return []
      if (field.kind === "boolean") return value === true || value === "true" ? [`--${field.name}`] : []
      if (Array.isArray(value)) return value.map(String).filter((item) => item.trim() !== "")
      const text = String(value).trim()
      return text === "" ? [] : [field.name === "sourceCard" ? `sourceCard=${text}` : text]
    })
    .join(" ")
}
