/**
 * Inert text and JSON admission for values crossing run-store boundaries.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as BoundedJson from "@smthrs/canonical/BoundedJson"

/**
 * Maximum UTF-16 length of one durable identifier.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const maximumIdentifierLength = 1_024

/**
 * Resource limits for one admitted JSON tree.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type JsonLimits = Omit<BoundedJson.Limits, "maxTotalMembers">

/**
 * Detached JSON value accepted by the persistence boundary.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Json = BoundedJson.Json

/**
 * Compares admitted JSON trees while ignoring object key order.
 *
 * Array order remains significant. `undefined` represents an absent optional
 * tree and equals only `undefined`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const sameJson = (left: Json | undefined, right: Json | undefined): boolean => {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left === null || right === null) return false
  if (typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!sameJson(left[index], right[index])) return false
    }
    return true
  }
  if (Array.isArray(right)) return false
  const leftObject = left as { readonly [key: string]: Json }
  const rightObject = right as { readonly [key: string]: Json }
  const leftKeys = Object.keys(leftObject)
  if (leftKeys.length !== Object.keys(rightObject).length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightObject, key) || !sameJson(leftObject[key], rightObject[key])) return false
  }
  return true
}

/**
 * Result of admitting or refusing an unknown JSON candidate.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type JsonResult =
  | { readonly ok: true; readonly value: Json; readonly bytes: number }
  | { readonly ok: false; readonly complaint: string }

/**
 * Whether text has a complete UTF-16 encoding and contains no NUL.
 *
 * @since 1.0.0-rc.0
 * @private
 * @throws {never}
 */
export const isDurableText = (value: unknown, maximum = maximumIdentifierLength): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) return false
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/**
 * Copies an inert JSON tree with a cumulative member budget for run state.
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const admitJson = (input: unknown, limits: JsonLimits): JsonResult => {
  const result = BoundedJson.admit(input, { ...limits, maxTotalMembers: limits.maxMembers })
  return result.ok ? result : { ok: false, complaint: result.complaint }
}

/**
 * Parses and bounds JSON text while preserving the caller's original bytes.
 *
 * @since 1.0.0-rc.0
 * @private
 * @throws {never}
 */
export const admitJsonText = (
  input: unknown,
  limits: JsonLimits
):
  | { readonly ok: true; readonly value: string; readonly json: Json }
  | { readonly ok: false; readonly complaint: string } =>
{
  if (typeof input !== "string" || input.length === 0) return { ok: false, complaint: "must be non-empty JSON text" }
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    return { ok: false, complaint: "must be valid JSON text" }
  }
  const admitted = admitJson(parsed, limits)
  if (!admitted.ok) return admitted
  if (limits.maxBytes !== undefined && new TextEncoder().encode(input).byteLength > limits.maxBytes) {
    return { ok: false, complaint: "exceeds the JSON byte limit" }
  }
  return { ok: true, value: input, json: admitted.value }
}
