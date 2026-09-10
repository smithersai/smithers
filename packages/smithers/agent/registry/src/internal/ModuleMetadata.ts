/**
 * Metadata extraction from a discovered flow module: its description, its
 * declared schemas, and the effect envelope inferred from what it calls.
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option"
import type { EffectDeclaration, Placement } from "../Descriptor.ts"
import { conservativeEffects, projectEffects, unprojectableDelegation } from "./Authority.ts"

/**
 * @since 0.1.0
 * @private
 */
export interface MetadataWarning {
  readonly message: string
}

/**
 * @since 0.1.0
 * @private
 */
export interface Metadata {
  readonly description: string | undefined
  readonly hasInput: boolean
  readonly hasOutput: boolean
  readonly model: Option.Option<string>
  readonly flows: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: EffectDeclaration
  readonly placement: Option.Option<Placement>
  readonly modelInvocable: boolean
  readonly declaresName: boolean
  readonly warnings: ReadonlyArray<MetadataWarning>
}

interface FlowObject {
  readonly start: number
  readonly end: number
  readonly constructor: "agent" | "make"
}

interface Token {
  readonly kind: "identifier" | "number" | "punctuation" | "regex" | "string"
  readonly value: string
  readonly start: number
  readonly end: number
}

const skipQuoted = (source: string, start: number): number => {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++
      continue
    }
    if (source[index] === quote) {
      return index
    }
  }
  return source.length - 1
}

const skipLineComment = (source: string, start: number): number => {
  const end = source.indexOf("\n", start + 2)
  return end === -1 ? source.length - 1 : end
}

const skipBlockComment = (source: string, start: number): number => {
  const end = source.indexOf("*/", start + 2)
  return end === -1 ? source.length - 1 : end + 1
}

const skipTrivia = (source: string, start: number): number => {
  let index = start
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (character === "\uFEFF" || /\s/.test(character ?? "")) {
      index++
      continue
    }
    if (character === "/" && next === "/") {
      index = skipLineComment(source, index) + 1
      continue
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(source, index) + 1
      continue
    }
    return index
  }
  return index
}

/** The keywords a regular expression may follow, rather than a division. */
const regexPrecedingKeywords = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield"
])

/** The punctuation a regular expression may follow, rather than a division. */
const regexPrecedingPunctuation = new Set(
  ["(", "[", "{", ",", ":", ";", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">"]
)

const canStartRegex = (previous: Token | undefined): boolean => {
  if (previous === undefined) {
    return true
  }
  if (previous.kind === "identifier") {
    return regexPrecedingKeywords.has(previous.value)
  }
  if (previous.kind !== "punctuation") {
    return false
  }
  return regexPrecedingPunctuation.has(previous.value)
}

const skipRegex = (source: string, start: number): number => {
  let inCharacterClass = false
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]
    if (character === "\\") {
      index++
      continue
    }
    if (character === "[") {
      inCharacterClass = true
      continue
    }
    if (character === "]") {
      inCharacterClass = false
      continue
    }
    if (character === "/" && !inCharacterClass) {
      while (/[A-Za-z]/.test(source[index + 1] ?? "")) {
        index++
      }
      return index
    }
  }
  return source.length - 1
}

const nextToken = (source: string, start: number, previous: Token | undefined): Token | undefined => {
  const index = skipTrivia(source, start)
  if (index >= source.length) {
    return undefined
  }

  const character = source[index] ?? ""
  if (/[A-Za-z_$]/.test(character)) {
    let end = index + 1
    while (/[A-Za-z0-9_$]/.test(source[end] ?? "")) {
      end++
    }
    return { kind: "identifier", value: source.slice(index, end), start: index, end }
  }
  if (/[0-9]/.test(character)) {
    let end = index + 1
    while (/[A-Za-z0-9_.]/.test(source[end] ?? "")) {
      end++
    }
    return { kind: "number", value: source.slice(index, end), start: index, end }
  }
  if (character === "\"" || character === "'" || character === "`") {
    const end = skipQuoted(source, index) + 1
    return { kind: "string", value: source.slice(index, end), start: index, end }
  }
  if (character === "/" && canStartRegex(previous)) {
    const end = skipRegex(source, index) + 1
    return { kind: "regex", value: source.slice(index, end), start: index, end }
  }

  return { kind: "punctuation", value: character, start: index, end: index + 1 }
}

const tokenize = (source: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  let previous: Token | undefined
  let offset = 0
  while (offset < source.length) {
    const token = nextToken(source, offset, previous)
    if (token === undefined) {
      break
    }
    tokens.push(token)
    previous = token
    offset = token.end
  }
  return tokens
}

const findFlowObject = (source: string): FlowObject | undefined => {
  const tokens = tokenize(source)
  for (let index = 0; index <= tokens.length - 6; index++) {
    const constructor = tokens[index + 4]?.value
    if (
      tokens[index]?.value !== "export" ||
      tokens[index + 1]?.value !== "default" ||
      tokens[index + 2]?.value !== "Flow" ||
      tokens[index + 3]?.value !== "." ||
      (constructor !== "agent" && constructor !== "make") ||
      tokens[index + 5]?.value !== "("
    ) {
      continue
    }

    let parentheses = 1
    for (let argumentIndex = index + 6; argumentIndex < tokens.length; argumentIndex++) {
      const token = tokens[argumentIndex]
      if (token?.value === "(") {
        parentheses++
        continue
      }
      if (token?.value === ")") {
        parentheses--
        if (parentheses === 0) {
          break
        }
        continue
      }
      if (token?.value !== "{" || parentheses !== 1) {
        continue
      }

      let braces = 1
      for (let objectIndex = argumentIndex + 1; objectIndex < tokens.length; objectIndex++) {
        const objectToken = tokens[objectIndex]
        if (objectToken?.value === "{") {
          braces++
        } else if (objectToken?.value === "}") {
          braces--
          if (braces === 0) {
            return {
              start: token.start,
              end: objectToken.start,
              constructor
            }
          }
        }
      }
      return undefined
    }
  }
  return undefined
}

const placementFromSource = (source: string): Option.Option<Placement> => {
  const token = nextToken(source, 0, undefined)
  const directive = token?.kind === "string" ? stringLiteral(token.value) : undefined
  switch (directive) {
    case "use client":
      return Option.some("client")
    case "use server":
      return Option.some("local")
    case "use local":
      return Option.some("local")
    case "use sandbox":
      return Option.some("sandbox")
    case "use remote":
      return Option.some("remote")
    default:
      return Option.none()
  }
}

/**
 * Returns whether the default flow declaration is complete in a source prefix.
 * @category predicates
 *
 * @since 0.1.0
 * @private
 */
export const isComplete = (source: string): boolean => findFlowObject(source) !== undefined

const splitTopLevel = (source: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let start = 0
  let braces = 0
  let brackets = 0
  let parentheses = 0

  for (const token of tokenize(source)) {
    switch (token.value) {
      case "{":
        braces++
        break
      case "}":
        braces--
        break
      case "[":
        brackets++
        break
      case "]":
        brackets--
        break
      case "(":
        parentheses++
        break
      case ")":
        parentheses--
        break
      case ",":
        if (braces === 0 && brackets === 0 && parentheses === 0) {
          parts.push(source.slice(start, token.start))
          start = token.end
        }
        break
    }
  }
  parts.push(source.slice(start))
  return parts
}

const findTopLevelColon = (source: string): number | undefined => {
  let braces = 0
  let brackets = 0
  let parentheses = 0
  for (const token of tokenize(source)) {
    switch (token.value) {
      case "{":
        braces++
        break
      case "}":
        braces--
        break
      case "[":
        brackets++
        break
      case "]":
        brackets--
        break
      case "(":
        parentheses++
        break
      case ")":
        parentheses--
        break
      case ":":
        if (braces === 0 && brackets === 0 && parentheses === 0) {
          return token.start
        }
        break
    }
  }
  return undefined
}

const propertyKey = (source: string): string | undefined => {
  const trimmed = source.trim()
  const quoted = /^(["'])(.*?)\1$/.exec(trimmed)
  if (quoted?.[2] !== undefined) {
    return quoted[2]
  }
  return /^[A-Za-z_$][\w$-]*$/.test(trimmed) ? trimmed : undefined
}

const propertiesFrom = (
  source: string
): {
  readonly values: ReadonlyMap<string, string>
  readonly hasUnprojectableMembers: boolean
} => {
  const properties = new Map<string, string>()
  let hasUnprojectableMembers = false
  for (const part of splitTopLevel(source)) {
    const trimmed = part.trim()
    if (trimmed === "") {
      continue
    }
    if (trimmed.startsWith("...")) {
      hasUnprojectableMembers = true
      continue
    }
    const colon = findTopLevelColon(trimmed)
    if (colon === undefined) {
      const key = propertyKey(trimmed)
      if (key !== undefined) {
        properties.set(key, key)
      } else {
        hasUnprojectableMembers = true
      }
      continue
    }
    const key = propertyKey(trimmed.slice(0, colon))
    if (key !== undefined) {
      properties.set(key, trimmed.slice(colon + 1).trim())
    } else {
      hasUnprojectableMembers = true
    }
  }
  return { values: properties, hasUnprojectableMembers }
}

const decodeEscapes = (value: string): string =>
  value.replace(
    /\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|r|t|b|f|v|0|\\|"|'|`)/g,
    (_match, sequence: string) => {
      switch (sequence) {
        case "n":
          return "\n"
        case "r":
          return "\r"
        case "t":
          return "\t"
        case "b":
          return "\b"
        case "f":
          return "\f"
        case "v":
          return "\v"
        case "0":
          return "\0"
        case "\\":
          return "\\"
        case "\"":
          return "\""
        case "'":
          return "'"
        case "`":
          return "`"
        default: {
          const hexadecimal = sequence.startsWith("u{") ? sequence.slice(2, -1) : sequence.slice(1)
          const codePoint = Number.parseInt(hexadecimal, 16)
          return codePoint > 0x10ffff ? `\\${sequence}` : String.fromCodePoint(codePoint)
        }
      }
    }
  )

const stringLiteral = (source: string | undefined): string | undefined => {
  if (source === undefined) {
    return undefined
  }
  const trimmed = source.trim()
  const quote = trimmed[0]
  if (
    (quote !== "\"" && quote !== "'" && quote !== "`") ||
    trimmed.at(-1) !== quote ||
    (quote === "`" && trimmed.includes("${"))
  ) {
    return undefined
  }
  return decodeEscapes(trimmed.slice(1, -1))
}

const stringArray = (source: string | undefined): ReadonlyArray<string> | undefined => {
  if (source === undefined) {
    return undefined
  }
  const trimmed = source.trim()
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined
  }
  const parts = splitTopLevel(trimmed.slice(1, -1)).filter((part) => part.trim() !== "")
  const values = parts.map(stringLiteral)
  return values.every((value): value is string => value !== undefined) ? values : undefined
}

const booleanLiteral = (source: string | undefined): boolean | undefined =>
  source?.trim() === "true" ? true : source?.trim() === "false" ? false : undefined

const objectProperties = (
  source: string | undefined
): ReturnType<typeof propertiesFrom> | undefined => {
  if (source === undefined) {
    return undefined
  }
  const tokens = tokenize(source)
  const openingIndex = tokens.findIndex((token) => token.value === "{")
  const opening = tokens[openingIndex]
  if (opening === undefined) {
    return undefined
  }
  let depth = 1
  for (let index = openingIndex + 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token?.value === "{") {
      depth++
    } else if (token?.value === "}") {
      depth--
      if (depth === 0) {
        return propertiesFrom(source.slice(opening.end, token.start))
      }
    }
  }
  return undefined
}

const effectDeclaration = (
  source: string | undefined,
  capabilities: ReadonlyArray<string>,
  warnings: Array<MetadataWarning>
): EffectDeclaration => {
  const properties = objectProperties(source)
  const unreadable = source !== undefined &&
    (properties === undefined || properties.hasUnprojectableMembers)
  if (unreadable) {
    warnings.push({
      message: properties === undefined
        ? "Effects must be a statically projectable object literal; using conservative effects"
        : "Effects contain an object spread or computed member; using conservative effects"
    })
  }
  const paths = (key: "reads" | "writes"): ReadonlyArray<string> | "unreadable" | undefined => {
    if (properties?.values.has(key) !== true) return undefined
    return stringArray(properties.values.get(key)) ?? "unreadable"
  }
  const literal = (key: "mode" | "onConflict" | "tier"): string | undefined => {
    if (properties?.values.has(key) !== true) return undefined
    return stringLiteral(properties.values.get(key)) ?? "unreadable"
  }
  const projection = projectEffects({
    capabilities,
    declaration: source === undefined
      ? undefined
      : unreadable
      ? "unreadable"
      : {
        reads: paths("reads"),
        writes: paths("writes"),
        mode: literal("mode"),
        onConflict: literal("onConflict"),
        tier: literal("tier")
      }
  })
  let reportedPolicy = false
  for (const problem of projection.problems) {
    switch (problem._tag) {
      case "unreadableDeclaration":
        break
      case "unreadableMember":
        warnings.push({
          message: `Effects ${problem.member} must be a string-literal array; using the conservative wildcard`
        })
        break
      case "invalidMode":
      case "invalidOnConflict":
        if (!reportedPolicy) {
          reportedPolicy = true
          warnings.push({
            message: "Effects mode and conflict policy must be string literals; using conservative effects"
          })
        }
        break
      case "invalidTier":
        warnings.push({
          message: "Effects tier must be a sealed, compensable, or irreversible string literal; using irreversible"
        })
        break
      case "underClassifiedTier":
        warnings.push({
          message: `Effect tier ${problem.declared} under-classifies declared authority; using ${problem.projected}`
        })
        break
    }
  }
  return projection.effects
}

/**
 * Statically reads the metadata carried by the default `Flow.make` or
 * `Flow.agent` value without evaluating the module.
 * @category parsing
 *
 * @since 0.1.0
 * @private
 */
export const parse = (source: string): Metadata => {
  const flowObject = findFlowObject(source)
  const warnings: Array<MetadataWarning> = []
  if (flowObject === undefined) {
    return {
      description: undefined,
      hasInput: false,
      hasOutput: false,
      model: Option.none(),
      flows: [],
      capabilities: ["*"],
      effects: conservativeEffects,
      placement: placementFromSource(source),
      modelInvocable: true,
      declaresName: false,
      warnings: [{ message: "Could not statically read the default Flow.make or Flow.agent declaration" }]
    }
  }

  const parsedProperties = propertiesFrom(source.slice(flowObject.start + 1, flowObject.end))
  const properties = parsedProperties.values
  const capabilitiesSource = properties.get("capabilities")
  const literalCapabilities = capabilitiesSource === undefined ? [] : stringArray(capabilitiesSource)
  const flowsSource = properties.get("flows")
  const literalFlows = stringArray(flowsSource)
  const hasUnprojectableFlows = flowsSource !== undefined && (literalFlows === undefined || literalFlows.length > 0)
  const delegation = hasUnprojectableFlows ? unprojectableDelegation() : undefined
  if (literalCapabilities === undefined) {
    warnings.push({
      message: "Capabilities must be a string-literal array for discovery; using the conservative wildcard"
    })
  }
  if (hasUnprojectableFlows) {
    warnings.push({
      message: "Flow authority cannot be projected statically; using the conservative wildcard"
    })
  }
  if (parsedProperties.hasUnprojectableMembers) {
    warnings.push({
      message:
        "Object spread or computed properties make schemas and authority unprojectable; using conservative projections"
    })
  }
  const capabilities = literalCapabilities === undefined ||
      hasUnprojectableFlows ||
      parsedProperties.hasUnprojectableMembers
    ? delegation?.capabilities ?? ["*"]
    : literalCapabilities

  const effects = effectDeclaration(properties.get("effects"), capabilities, warnings)

  const modelInvocableSource = properties.get("modelInvocable")
  const disableModelInvocationSource = properties.get("disableModelInvocation")
  const modelInvocable = booleanLiteral(modelInvocableSource)
    ?? booleanLiteral(disableModelInvocationSource) !== true
  if (
    (modelInvocableSource !== undefined && booleanLiteral(modelInvocableSource) === undefined) ||
    (disableModelInvocationSource !== undefined && booleanLiteral(disableModelInvocationSource) === undefined)
  ) {
    warnings.push({ message: "Model invocation visibility must be declared as a boolean literal for discovery" })
  }

  return {
    description: stringLiteral(properties.get("description")),
    hasInput: properties.has("input") || parsedProperties.hasUnprojectableMembers,
    hasOutput: properties.has("output") || parsedProperties.hasUnprojectableMembers,
    model: Option.fromUndefinedOr(stringLiteral(properties.get("model"))),
    flows: literalFlows ?? [],
    capabilities,
    effects,
    placement: placementFromSource(source),
    modelInvocable,
    declaresName: properties.has("name"),
    warnings
  }
}
