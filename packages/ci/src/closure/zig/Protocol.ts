/**
 * The two stdio protocols Zig 0.17.1 speaks when started with `--listen=-`.
 *
 * `zig build --listen=-` is the build server: a client names the steps to
 * build by index and the server reports each step's result and output paths.
 * `zig test FILE --listen=-` is the compiler server: after an update it
 * reports every file the compilation read. Both frame a message as a tag and a
 * body length, each a little-endian `u32`, then the body. The messages are
 * `std.zig.Client.Message` and `std.zig.Server.Message` in Zig's `lib/std/zig`.
 *
 * @since 0.1.0
 */

import * as Manifest from "./Manifest.ts"

const clientExit = 0
const clientUpdate = 1
const clientBuildSteps = 0x8000_0000
const serverErrorBundle = 1
const serverFileSystemInputs = 6
const serverConfiguration = 0x8000_0001
const serverConfigurationFailed = 0x8000_0002
const serverBuildCompleted = 0x8000_0004
const serverStepCompleted = 0x8000_0006

const statuses = ["success", "failure", "skipped", "skipped-oom"] as const
const text = new TextDecoder()

const words = (...values: ReadonlyArray<number>): Uint8Array => {
  const out = new Uint8Array(4 * values.length)
  const view = new DataView(out.buffer)
  values.forEach((value, index) => view.setUint32(4 * index, value, true))
  return out
}

/**
 * What a client writes to `zig build --listen=-` to build `steps` once and
 * then stop the server.
 *
 * @param steps - Step indices, as the configuration numbers them.
 * @throws {never}
 *
 * @category encoding
 * @since 0.1.0
 */
export const buildRequest = (steps: ReadonlyArray<number>): Uint8Array =>
  words(clientBuildSteps, 8 + 4 * steps.length, steps.length, 0, ...steps, clientExit, 0)

/**
 * What a client writes to `zig test FILE --listen=-` to compile once and then
 * stop the server.
 *
 * @category encoding
 * @since 0.1.0
 */
export const compileRequest: Uint8Array = words(clientUpdate, 0, clientExit, 0)

/**
 * A path a server reported: the directory it starts from and the rest.
 *
 * @category models
 * @since 0.1.0
 */
export interface Located {
  readonly prefix: Manifest.Prefix
  readonly path: string
}

/**
 * One compile error: the message and the file it points at, when it has one.
 *
 * @category models
 * @since 0.1.0
 */
export interface Problem {
  readonly message: string
  readonly file: string | undefined
}

/**
 * How one step ended.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepResult {
  readonly step: number
  readonly status: (typeof statuses)[number] | "unknown"
  readonly problems: ReadonlyArray<Problem>
  readonly outputs: ReadonlyArray<Located>
}

/**
 * Everything the build server said.
 *
 * @category models
 * @since 0.1.0
 */
export interface BuildReply {
  /** The path of the configuration file, as the server printed it. */
  readonly configuration: string | undefined
  /** True when `build.zig` itself did not compile. */
  readonly configurationFailed: boolean
  readonly steps: ReadonlyArray<StepResult>
  /** True when the server finished the build it was asked for. */
  readonly completed: boolean
}

/**
 * Everything the compiler server said about one compilation.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompileReply {
  readonly completed: boolean
  /** The files the compilation read, or `undefined` when it reported none. */
  readonly inputs: ReadonlyArray<Located> | undefined
  readonly problems: ReadonlyArray<Problem>
}

interface Message {
  readonly tag: number
  readonly body: Uint8Array
}

/** Splits a server's output into messages. A message cut short ends the list. */
const messages = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Array<Message> = []
  let at = 0
  while (at + 8 <= bytes.length) {
    const end = at + 8 + view.getUint32(at + 4, true)
    if (end > bytes.length) break
    out.push({ tag: view.getUint32(at, true), body: bytes.subarray(at + 8, end) })
    at = end
  }
  return { all: out, framed: at === bytes.length }
}

/** A reader of little-endian `u32`s that yields zero past the end, so a short body cannot throw. */
const word = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return (at: number): number => at + 4 <= bytes.length ? view.getUint32(at, true) : 0
}

/** The zero-terminated string at `at`. */
const stringAt = (bytes: Uint8Array, at: number): string => {
  const end = bytes.indexOf(0, at)
  return text.decode(bytes.subarray(at, end === -1 ? bytes.length : end))
}

/**
 * Reads the top-level messages of a `std.zig.ErrorBundle`: `extra` words then
 * string bytes.
 */
const problems = (extra: Uint8Array, strings: Uint8Array): ReadonlyArray<Problem> => {
  const at = word(extra)
  const count = at(0)
  const start = at(4)
  const out: Array<Problem> = []
  for (let index = 0; index < count && 4 * (start + index) < extra.length; index += 1) {
    const message = 4 * at(4 * (start + index))
    const location = at(message + 8)
    out.push({
      message: stringAt(strings, at(message)),
      file: location === 0 ? undefined : stringAt(strings, at(4 * location))
    })
  }
  return out
}

/** A path sent as a prefix byte then the rest. `shift` is what the sender added to the prefix. */
const located = (bytes: Uint8Array, shift: number): Located => ({
  prefix: Manifest.prefix(Number(bytes[0]) - shift),
  path: text.decode(bytes.subarray(1))
})

const stepResult = (body: Uint8Array): StepResult => {
  const at = word(body)
  const extraBytes = 4 * at(8)
  const stringBytes = at(12)
  const outputCount = at(16)
  const table = 20 + extraBytes + stringBytes
  const outputs: Array<Located> = []
  let path = table + 8 * outputCount
  for (let index = 0; index < outputCount && path < body.length; index += 1) {
    const length = 1 + at(table + 8 * index + 4)
    outputs.push(located(body.subarray(path, path + length), 0))
    path += length
  }
  return {
    step: at(0),
    status: statuses[at(4)] ?? "unknown",
    problems: problems(body.subarray(20, 20 + extraBytes), body.subarray(20 + extraBytes, table)),
    outputs
  }
}

/**
 * Decodes what `zig build --listen=-` wrote to its standard output.
 *
 * @throws {never}
 *
 * @category decoding
 * @since 0.1.0
 */
export const decodeBuild = (bytes: Uint8Array): BuildReply => {
  const { all, framed } = messages(bytes)
  const configuration = all.find((message) => message.tag === serverConfiguration)
  return {
    configuration: configuration === undefined ? undefined : text.decode(configuration.body),
    configurationFailed: all.some((message) => message.tag === serverConfigurationFailed),
    steps: all.filter((message) => message.tag === serverStepCompleted).map((message) => stepResult(message.body)),
    completed: framed && all.some((message) => message.tag === serverBuildCompleted && message.body.length === 0)
  }
}

/**
 * Decodes what `zig test FILE --listen=-` wrote to its standard output.
 *
 * @throws {never}
 *
 * @category decoding
 * @since 0.1.0
 */
export const decodeCompile = (bytes: Uint8Array): CompileReply => {
  const { all, framed } = messages(bytes)
  const inputs = all.find((message) => message.tag === serverFileSystemInputs)
  const bundle = all.find((message) => message.tag === serverErrorBundle)
  const extraBytes = bundle === undefined ? 0 : 4 * word(bundle.body)(0)
  return {
    completed: framed && bundle !== undefined && bundle.body.length === 8 + extraBytes + word(bundle.body)(4),
    inputs: inputs === undefined || inputs.body.length === 0
      ? undefined
      : splitZero(inputs.body).map((entry) => located(entry, 1)),
    problems: bundle === undefined
      ? []
      : problems(bundle.body.subarray(8, 8 + extraBytes), bundle.body.subarray(8 + extraBytes))
  }
}

/** Splits bytes at zero bytes. */
const splitZero = (bytes: Uint8Array): ReadonlyArray<Uint8Array> => {
  const out: Array<Uint8Array> = []
  let at = 0
  while (at < bytes.length) {
    const end = bytes.indexOf(0, at)
    if (end === -1) return [...out, bytes.subarray(at)]
    out.push(bytes.subarray(at, end))
    at = end + 1
  }
  return out
}

/**
 * Joins chunks of bytes into one array.
 *
 * @throws {never}
 *
 * @category bytes
 * @since 0.1.0
 */
export const join = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/**
 * Reads bytes as UTF-8 text. Bytes that are not UTF-8 read as U+FFFD.
 *
 * @throws {never}
 *
 * @category bytes
 * @since 0.1.0
 */
export const utf8 = (bytes: Uint8Array): string => text.decode(bytes)
