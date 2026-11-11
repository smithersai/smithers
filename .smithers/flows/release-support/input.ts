import { Schema } from "effect"
import { ContentInput, ReleaseInput, Version } from "./schema.ts"

export const version = (value: unknown): string => Schema.decodeUnknownSync(Version)(value)
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Input must be a JSON object")
  }
  return value as Record<string, unknown>
}
const keys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown input field: ${key}`)
}

/** Normalize the old bump option into an explicit, persisted release version. */
const requestedVersion = (input: Record<string, unknown>, current: string): string => {
  if (input.bump === undefined) return version(input.version ?? current)
  if (input.version !== undefined) throw new Error("Choose version or bump, not both")
  if (!["major", "minor", "patch"].includes(String(input.bump))) throw new Error("bump must be major, minor, or patch")
  version(current)
  const [base, prerelease] = current.split("-", 2)
  let [major, minor, patch] = base!.split(".").map(BigInt) as [bigint, bigint, bigint]
  if (input.bump === "major") {
    if (minor !== 0n || patch !== 0n || !prerelease) major++
    minor = 0n
    patch = 0n
  } else if (input.bump === "minor") {
    if (patch !== 0n || !prerelease) minor++
    patch = 0n
  } else if (!prerelease) patch++
  return `${major}.${minor}.${patch}`
}

/** The host's version normalization in front of the flow's own input decoding and defaults. */
const decode = <S extends Schema.Struct<Schema.Struct.Fields>>(
  schema: S,
  value: unknown,
  currentVersion: string
): S["Type"] => {
  const input = record(value)
  keys(input, [...Object.keys(schema.fields), "bump"])
  const { bump: _bump, ...fields } = input
  const channels = input.channels === undefined ? undefined : record(input.channels)
  if (channels) keys(channels, ["changelog", "blog", "thread", "media"])
  return Schema.decodeUnknownSync(schema as Schema.Codec<S["Type"]>)({
    ...fields,
    version: requestedVersion(input, currentVersion)
  })
}

export const contentInput = (value: unknown, currentVersion: string): ContentInput =>
  decode(ContentInput, value, currentVersion)

export const releaseInput = (value: unknown, currentVersion: string): ReleaseInput =>
  decode(ReleaseInput, value, currentVersion)
