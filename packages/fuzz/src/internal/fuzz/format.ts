import * as Base64Url from "effect/encoding/Base64Url"
import * as Tape from "./tape.ts"

/**
 * One generation input: the header that `checkEffect` derives from the attempt index, the value tape, and the schedule
 * tape read by an execution driver. Words past the end of a tape come from its key.
 *
 * @internal
 */
export interface Input {
  readonly size: number
  readonly bias: number
  readonly nullPrototype: boolean
  readonly key: number
  readonly words: ReadonlyArray<number>
  readonly scheduleKey: number
  readonly schedule: ReadonlyArray<number>
}

/** @internal */
export interface Entry {
  readonly kind: "input" | "failure"
  readonly revision: string
  readonly input: Input
  readonly signature?: string | undefined
  readonly path: ReadonlyArray<number>
  readonly codec?: string | undefined
  readonly value?: string | undefined
  readonly note?: string | undefined
}

const header = "effect-fuzz 2"
const legacyHeader = "effect-fuzz 1"

// Version 2 writes every free-text field as a JSON string literal, so a newline or a field-looking line in a codec
// value, a revision or a codec id stays inside its field. Version 1 wrote them raw and is still read.
const text = (value: string): string => JSON.stringify(value)

/** @internal */
export function encodeEntry(entry: Entry): string {
  const lines = [
    header,
    `kind ${entry.kind}`,
    `revision ${text(entry.revision)}`,
    `size ${entry.input.size}`,
    `bias ${entry.input.bias}`,
    `null-prototype ${entry.input.nullPrototype}`,
    `key ${entry.input.key}`,
    `tape ${Tape.encodeWords(entry.input.words)}`,
    `schedule-key ${entry.input.scheduleKey}`,
    `schedule ${Tape.encodeWords(entry.input.schedule)}`
  ]
  if (entry.signature !== undefined) lines.push(`signature ${text(entry.signature)}`)
  lines.push(`path ${entry.path.join(".")}`)
  if (entry.codec !== undefined) lines.push(`codec ${text(entry.codec)}`, `value ${text(entry.value!)}`)
  if (entry.note !== undefined) lines.push(...entry.note.split("\n").map((line) => `# ${line}`))
  return lines.join("\n") + "\n"
}

function natural(text: string): number {
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
    throw new Error(`expected a non-negative integer, got "${text}"`)
  }
  return value
}

function path(text: string): ReadonlyArray<number> {
  return text === "" ? [] : text.split(".").map(natural)
}

function boolean(text: string): boolean {
  if (text !== "true" && text !== "false") throw new Error(`expected true or false, got "${text}"`)
  return text === "true"
}

// The bias factors the search generates; any other value cannot come from this engine.
function bias(value: number): number {
  if (value < 2 || value > 6) throw new Error(`expected a bias between 2 and 6, got ${value}`)
  return value
}

const failureSignature = /^(ReturnedFalse|Deadlock|PropertyError:.+|Died:.+)$/s

/**
 * Checks that a signature names a failure, so a token or a corpus entry cannot turn a pass into a finding.
 *
 * @internal
 */
export function signature(value: string): string {
  if (!failureSignature.test(value)) throw new Error(`"${value}" is not a failure signature`)
  return value
}

/**
 * Parses an entry written by {@link encodeEntry}. Lines starting with `#` are notes for people and are ignored. A
 * field may appear once.
 *
 * @internal
 */
export function decodeEntry(source: string): Entry {
  const lines = source.split("\n")
  if (lines[0] !== header && lines[0] !== legacyHeader) throw new Error(`expected "${header}" on the first line`)
  const legacy = lines[0] === legacyHeader
  const fields = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (line === "" || line.startsWith("#")) continue
    const space = line.indexOf(" ")
    const name = space === -1 ? line : line.slice(0, space)
    if (fields.has(name)) throw new Error(`duplicate field "${name}"`)
    fields.set(name, space === -1 ? "" : line.slice(space + 1))
  }
  const field = (name: string): string => {
    const value = fields.get(name)
    if (value === undefined) throw new Error(`missing field "${name}"`)
    return value
  }
  const string = (name: string): string => {
    const raw = field(name)
    if (legacy) return raw
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "string") throw new Error(`field "${name}" is not a string`)
    return value
  }
  const optional = (name: string): string | undefined => fields.has(name) ? string(name) : undefined
  const kind = field("kind")
  if (kind !== "input" && kind !== "failure") throw new Error(`unknown kind "${kind}"`)
  const codec = optional("codec")
  return {
    kind,
    revision: string("revision"),
    input: {
      size: natural(field("size")),
      bias: bias(natural(field("bias"))),
      nullPrototype: boolean(field("null-prototype")),
      key: natural(field("key")),
      words: Tape.decodeWords(field("tape")),
      scheduleKey: natural(field("schedule-key")),
      schedule: Tape.decodeWords(field("schedule"))
    },
    signature: kind === "failure" ? signature(string("signature")) : optional("signature"),
    path: path(field("path")),
    codec,
    value: codec === undefined ? undefined : string("value")
  }
}

const replayPrefix = "fuzz1:"

/** @internal */
export interface ReplayData {
  readonly input: Input
  readonly path: ReadonlyArray<number>
  readonly signature: string
}

/** @internal */
export function encodeReplay(data: ReplayData): string {
  const input = data.input
  return replayPrefix + Base64Url.encode(JSON.stringify([
    input.size,
    input.bias,
    input.nullPrototype,
    input.key,
    Tape.encodeWords(input.words),
    input.scheduleKey,
    Tape.encodeWords(input.schedule),
    data.path,
    data.signature
  ]))
}

/** @internal */
export function decodeReplay(token: string): ReplayData {
  if (!token.startsWith(replayPrefix)) throw new Error(`a fuzz replay token starts with "${replayPrefix}"`)
  const decoded = Base64Url.decode(token.slice(replayPrefix.length))
  if (decoded._tag === "Failure") throw new Error("the replay token is not base64url")
  const json: unknown = JSON.parse(new TextDecoder().decode(decoded.success))
  if (!Array.isArray(json) || json.length !== 9) throw new Error("a replay token holds nine fields")
  const [size, biasFactor, nullPrototype, key, words, scheduleKey, schedule, steps, failure] = json
  const number = (value: unknown, name: string): number => {
    if (typeof value !== "number") throw new Error(`the ${name} of a replay token is not a number`)
    return natural(String(value))
  }
  const words32 = (value: unknown, name: string): Array<number> => {
    if (typeof value !== "string") throw new Error(`the ${name} of a replay token is not a string`)
    return Tape.decodeWords(value)
  }
  if (typeof nullPrototype !== "boolean") throw new Error("the null-prototype flag of a replay token is not a boolean")
  if (!Array.isArray(steps)) throw new Error("the shrink path of a replay token is not an array")
  if (typeof failure !== "string") throw new Error("the signature of a replay token is not a string")
  return {
    input: {
      size: number(size, "size"),
      bias: bias(number(biasFactor, "bias")),
      nullPrototype,
      key: number(key, "key"),
      words: words32(words, "tape"),
      scheduleKey: number(scheduleKey, "schedule key"),
      schedule: words32(schedule, "schedule")
    },
    path: steps.map((step) => number(step, "shrink path")),
    signature: signature(failure)
  }
}
