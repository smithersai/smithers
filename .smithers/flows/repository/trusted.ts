/**
 * The foreign synchronous helpers the repository flows call from `.vibe` code.
 * `trusted` (vibelang-runtime) keeps each callee's failure contract in its
 * value: a `.vibe` call needs no `Effect.try`, and with no listed classes any
 * exception is a defect, exactly as a throw inside `Effect.gen` was before.
 */
import { extractPaths as extractPathsImpl, normalizePath as normalizePathImpl } from "@smthrs/agent/Memory"
import * as Digest from "@smthrs/core/Digest"
import type { Schema } from "effect"
import { trusted } from "vibelang-runtime"
import { registrationScopeProblems as registrationScopeProblemsImpl } from "../../../packages/rpc/src/RepositorySetup.ts"
import { contained as containedImpl } from "../coding/immutable-source.vibe"
import { requestIdFor as requestIdForImpl } from "../coding/native.vibe"
import { triggerCandidate as triggerCandidateImpl } from "./trigger-candidate.ts"

/** The SHA-256 of `text`; text that is not well-formed UTF-16 is a programming error. */
export const digest = trusted(Digest.digest, [])
/** The RFC 8785 canonical JSON of `value`; a value with no canonical form is a programming error. */
export const canonical = trusted(Digest.canonical, [])
/** The SHA-256 of the canonical JSON of `value`. */
export const canonicalDigest = trusted((value: unknown): string => Digest.digest(Digest.canonical(value)), [])
export const normalizePath = trusted(normalizePathImpl, [])
export const extractPaths = trusted(extractPathsImpl, [])
export const contained = trusted(containedImpl, [])
export const requestIdFor = trusted(requestIdForImpl, [])
export const registrationScopeProblems = trusted(registrationScopeProblemsImpl, [])
export const triggerCandidate = trusted(triggerCandidateImpl, [])
/** `value` as plain JSON data: a structural copy with `undefined` members dropped. */
export const json = trusted((value: unknown): Schema.Json => JSON.parse(JSON.stringify(value)) as Schema.Json, [])
/**
 * A structural copy of `value` through JSON, typed by the place it goes to, as
 * the inline `JSON.parse(JSON.stringify(value))` it replaces was. Plain
 * TypeScript rather than a trusted value, so the type parameter still infers
 * from its context; its callers are plain functions.
 */
export function jsonClone<T = unknown>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T
}
const decoder = new TextDecoder()
/** The text of one complete UTF-8 buffer; malformed sequences become U+FFFD. */
export const utf8 = trusted((bytes: Uint8Array): string => decoder.decode(bytes), [])
/** The text of the next chunk of a stream, through the caller's own non-fatal decoder. */
export const utf8Chunk = trusted(
  (streaming: TextDecoder, chunk: Uint8Array): string => streaming.decode(chunk, { stream: true }),
  []
)
