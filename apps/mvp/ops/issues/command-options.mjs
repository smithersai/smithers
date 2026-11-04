import { GH_OPTIONS, CREDENTIAL_OPTIONS } from "./command-options-data.mjs"

// Values retain their original spelling. Compatibility normalization interprets option syntax only.
const syntaxOf = (value) => {
  let text = "", offset = 0
  const end = [0]
  for (const char of value) {
    offset += char.length
    const normalized = char.normalize("NFKC")
    text += normalized
    for (let i = 0; i < normalized.length; i++) end.push(offset)
  }
  return { text, end }
}
const roleOf = (name) => /^(?:raw-)?field$/.test(name) ? "field" : "data"
const schemas = new Map()
const schemaOf = (path) => {
  if (schemas.has(path)) return schemas.get(path)
  const short = { h: false, R: "repo" }, booleans = new Set(["help", "version"])
  const words = path.split(" ")
  for (let i = 1; i <= words.length; i++) {
    const schema = GH_OPTIONS[words.slice(0, i).join(" ")]
    if (schema) { Object.assign(short, schema.short); for (const flag of schema.booleans) booleans.add(flag) }
  }
  const result = { short, booleans }
  schemas.set(path, result)
  return result
}

/** Parse command option boundaries once, including detached data and boolean short-option clusters.
 * Unknown short flags have conservative alternative operands; callers cannot grant them a guessed identity.
 * Command context supplies operand semantics before consumers inspect values.
 */
const parseArguments = (values, executable, commandPath) => {
  const parsed = values.map((value) => ({ values: [{ text: value, offset: 0 }], role: "unbound", ambiguous: false }))
  if (executable < 0) return { parsed, path: "" }
  const tool = values[executable].normalize("NFKC").split(/[/\\]/).at(-1).toLowerCase().replace(/\.exe$/, ""), gh = tool === "gh"
  let path = "", ended = false
  const child = (word) => {
    const next = [path, word].filter(Boolean).join(" ")
    return Object.hasOwn(GH_OPTIONS, next) ? next : undefined
  }
  for (let i = executable + 1; i < values.length; i++) {
    const raw = values[i], syntax = syntaxOf(raw), word = syntax.text
    if (ended) continue
    if (word === "--") { parsed[i] = { values: [], role: "syntax", ambiguous: false }; ended = true; continue }
    if (!word.startsWith("-") || word === "-") { if (gh) path = child(word) ?? path; continue }
    const schema = gh ? schemaOf(commandPath ?? path) : { short: Object.fromEntries((CREDENTIAL_OPTIONS[tool] ?? []).map((name) => [name, name])), booleans: new Set() }
    const operand = (at) => ({ text: raw.slice(syntax.end[at] ?? raw.length), offset: syntax.end[at] ?? raw.length })
    const detached = (name) => {
      parsed[i] = { values: [], role: "syntax", ambiguous: false, option: name }
      const next = values[i + 1]
      if (next === undefined || next.startsWith("-") || (gh && child(next))) return
      parsed[++i] = { values: [{ text: next, offset: 0 }], role: roleOf(name), ambiguous: false, option: name }
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("="), name = word.slice(2, equals < 0 ? undefined : equals)
      if (equals >= 0) parsed[i] = { values: [operand(equals + 1)], role: roleOf(name), ambiguous: false, option: name }
      else if (schema.booleans.has(name)) parsed[i] = { values: [], role: "syntax", ambiguous: false, option: name }
      else detached(name)
      continue
    }
    parsed[i] = { values: [], role: "syntax", ambiguous: false }
    for (let at = 1; at < word.length; at++) {
      const flag = word[at], known = Object.hasOwn(schema.short, flag), name = schema.short[flag]
      if (known && name === false) {
        if (word[at + 1] === "=") { parsed[i] = { values: [operand(at + 2)], role: "data", ambiguous: false, option: flag }; break }
        continue
      }
      if (known) {
        if (at + 1 === word.length) detached(name)
        else parsed[i] = { values: [operand(at + 1 + (word[at + 1] === "=" ? 1 : 0))], role: roleOf(name), ambiguous: false, option: name }
      } else if (word[at + 1] === "=") {
        parsed[i] = { values: [operand(at + 2)], role: "data", ambiguous: false }
      } else if (at + 1 === word.length) detached(flag)
      else {
        const alternatives = []
        for (let cut = at; cut < word.length && !/[\/\\:\s]/.test(word[cut]); cut++) alternatives.push(operand(cut + 1))
        parsed[i] = { values: alternatives, role: "data", ambiguous: true }
      }
      break
    }
  }
  return { parsed, path }
}

export const commandArguments = (values, executable) => {
  const first = parseArguments(values, executable)
  // Local options may precede subcommands. Resolve their final schema before assigning roles.
  const { parsed, path } = first.path ? parseArguments(values, executable, first.path) : first
  const credentials = CREDENTIAL_OPTIONS[values[executable]?.normalize("NFKC").split(/[/\\]/).at(-1).toLowerCase().replace(/\.exe$/, "")] ?? []
  for (const argument of parsed) if (credentials.includes(argument.option)) argument.role = "credential"
  if (path === "secret set") for (const argument of parsed) if (argument.option === "body") argument.role = "credential"
  return parsed
}
