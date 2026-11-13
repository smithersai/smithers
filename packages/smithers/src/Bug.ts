/**
 * `smthrs bug`: a report an operator can send without pasting their secrets
 * into a browser.
 *
 * The value of the command is that it collects the context a maintainer always
 * asks for: versions, platform, and optionally the named run and its event
 * digest. A report is a diagnostic that leaves the machine, so the collected
 * value takes the shared diagnostic redaction rules before it does.
 *
 * @since 1.0.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import { Buffer } from "node:buffer"
import { isArrayBuffer, isDataView, isProxy } from "node:util/types"
import * as CliError from "./CliError.ts"

/**
 * Where reports are posted when the environment names no other endpoint.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultEndpoint = "https://bug.smithers.sh/api/bugs"

/** The two 0.x structural names not historically covered by journal text rules. */
const reportOnlySecretKey = /(?:dsn|connection)/i

const refusal = (reason: string): CliError.Refused =>
  new CliError.Refused({ fault: "bug", code: "bug_report_refused", message: `Bug report refused: ${reason}` })

// Invoke only the built-in getters. Ordinary property access can execute an
// own or inherited accessor before descriptor inspection has refused it.
const arrayBufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!
const dataViewSize = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!
const typedArraySize = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength"
)!.get!

const binarySize = (value: object): number | undefined => {
  if (isArrayBuffer(value)) return arrayBufferSize.call(value)
  if (ArrayBuffer.isView(value)) {
    return isDataView(value) ? dataViewSize.call(value) : typedArraySize.call(value)
  }
  return undefined
}

// These identities admit built-in storage without consulting caller-owned
// constructors or walking an untrusted prototype chain.
const binaryNames = new Map<object, string>([
  [ArrayBuffer.prototype, "ArrayBuffer"],
  [DataView.prototype, "DataView"],
  [Buffer.prototype, "Buffer"],
  [Int8Array.prototype, "Int8Array"],
  [Uint8Array.prototype, "Uint8Array"],
  [Uint8ClampedArray.prototype, "Uint8ClampedArray"],
  [Int16Array.prototype, "Int16Array"],
  [Uint16Array.prototype, "Uint16Array"],
  [Int32Array.prototype, "Int32Array"],
  [Uint32Array.prototype, "Uint32Array"],
  [Float32Array.prototype, "Float32Array"],
  [Float64Array.prototype, "Float64Array"],
  [BigInt64Array.prototype, "BigInt64Array"],
  [BigUint64Array.prototype, "BigUint64Array"]
])
// Older supported Node hosts do not expose this optional typed-array intrinsic.
const float16Array = Object.getOwnPropertyDescriptor(globalThis, "Float16Array")?.value as {
  readonly prototype: object
} | undefined
if (float16Array !== undefined) binaryNames.set(float16Array.prototype, "Float16Array")

const indexKey = /^(?:0|[1-9][0-9]*)$/

const renderableSnapshot = (value: unknown): unknown => {
  let walked = 0
  const ancestors = new WeakSet<object>()

  const charge = (members: number): void => {
    walked += members
    if (walked > Redaction.binaryWalkLimit) {
      throw refusal(`the value exceeds the ${Redaction.binaryWalkLimit} member walk limit`)
    }
  }

  const walk = (node: unknown, depth: number, charged = false): unknown => {
    if (!charged) charge(1)
    if (depth > Redaction.maxDepth) {
      throw refusal(`the value exceeds the ${Redaction.maxDepth} container depth limit`)
    }
    if ((typeof node !== "object" && typeof node !== "function") || node === null) return node
    if (typeof node === "function") {
      throw refusal("the value contains a callable member")
    }
    if (isProxy(node)) {
      throw refusal("the value contains a proxy, which could run code while the report is inspected")
    }
    if (ancestors.has(node)) return "[Circular]"

    const size = binarySize(node)
    if (size !== undefined && size > Redaction.binaryWalkLimit) {
      throw refusal(`a binary value exceeds the ${Redaction.binaryWalkLimit} byte walk limit`)
    }
    const prototype: object | null = Object.getPrototypeOf(node)
    const binaryName = prototype === null ? undefined : binaryNames.get(prototype)
    if (
      prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype &&
      !(size !== undefined && binaryName !== undefined)
    ) {
      throw refusal("a value has an unsupported prototype, which could run code while the report is rendered")
    }

    const length: number | undefined = Array.isArray(node)
      ? Object.getOwnPropertyDescriptor(node, "length")!.value
      : undefined
    // Holes cost redaction work too. Reserve every slot before allocating a
    // snapshot or inspecting indices, sharing the same budget across arrays.
    if (length !== undefined) charge(length)
    const snapshot = length === undefined ? Object.create(null) : new Array<unknown>(length)
    if (size !== undefined) {
      Object.defineProperty(snapshot, Redaction.binaryMarker, {
        value: `${binaryName} ${size} bytes`,
        enumerable: true,
        configurable: true
      })
    }

    ancestors.add(node)
    try {
      for (const key of Reflect.ownKeys(node)) {
        const descriptor = Object.getOwnPropertyDescriptor(node, key)!
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw refusal("a value contains an accessor, which could run code while the report is rendered")
        }
        if (key === "toJSON") {
          throw refusal("a value defines toJSON, which could run code while the report is rendered")
        }
        if (typeof key !== "string") continue
        const arrayIndex = length !== undefined && indexKey.test(key) && Number(key) < length
        if (descriptor.enumerable !== true && !arrayIndex) continue
        const field = walk(descriptor.value, depth + 1, arrayIndex)
        // Binary bytes are represented by the inert brand/size marker, while
        // attached diagnostic fields still take the shared redaction rules.
        if (size !== undefined && indexKey.test(key)) continue
        Object.defineProperty(snapshot, key, { value: field, enumerable: true, configurable: true })
      }
      return snapshot
    } finally {
      ancestors.delete(node)
    }
  }

  return walk(value, 0)
}

const applyReportOnlyKeys = (value: unknown): unknown => {
  const walk = (node: unknown, depth: number): unknown => {
    // `renderableSnapshot` has already admitted the exact tree against both
    // bounds, and redaction cannot add members or nesting.
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1))
    if (typeof node !== "object" || node === null) return node
    return Object.fromEntries(
      Object.entries(node).map(([key, entry]) => [
        key,
        reportOnlySecretKey.test(key) ? Redaction.placeholder : walk(entry, depth + 1)
      ])
    )
  }

  return walk(value, 0)
}

/**
 * Redacts secret-looking material inside free text.
 *
 * Reach for this when report prose must take the diagnostic rule set
 * (`Redaction.redactDiagnostic`). It is total for strings and returns the
 * shared journal markers for matched text.
 *
 * @category conversions
 * @since 1.0.0
 */
export const scrubText = (text: string): string => Redaction.redactDiagnostic(text) as string

/**
 * Recursively scrubs a JSON-safe value with the diagnostic rules and the retained
 * report-only `dsn` and `connection` key coverage. It snapshots own data
 * descriptors, names binary storage, and refuses accessors, unsupported
 * prototypes, executable `toJSON` hooks, excessive depth, and excessive walk
 * size (including sparse slots) before redaction so no partial report can be posted.
 *
 * @category conversions
 * @since 1.0.0
 */
export const scrub = (value: unknown): unknown => {
  return applyReportOnlyKeys(Redaction.redactDiagnostic(renderableSnapshot(value)))
}

/**
 * The report body.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly summary: string
  readonly version: string
  readonly platform: string
  readonly node: string
  readonly runs: unknown
  readonly digest?: unknown
}

/**
 * Assembles a scrubbed report for the bug endpoint. It throws before returning
 * when the value cannot be walked safely within the journal's bounds, which
 * prevents the caller from posting a partially inspected body.
 *
 * @category constructors
 * @since 1.0.0
 */
export const report = (input: Report): Report => scrub(input) as Report

/**
 * How long the post is allowed to take before the command gives up.
 *
 * @category constants
 * @since 1.0.0
 */
export const timeoutMs = 15_000
