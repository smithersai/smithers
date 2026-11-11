import * as Fault from "@smthrs/flow/Fault"
import { Effect, Schema } from "effect"

export class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
  step: Schema.String,
  message: Schema.String
}) {}
// A release step that refused: the release is not in the state the step needs.
Fault.register("ReleaseError", "user")

/** Semver without a v prefix or build metadata; every operator message for a version lives here. */
export const Version = Schema.NonEmptyString.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, {
    message: "version must be a semver without a v prefix or build metadata"
  }),
  Schema.makeFilter<string>(
    (value) => value.split("-").slice(1).join("-").split(".").every((part) => !/^0\d+$/.test(part)),
    { message: "Numeric prerelease identifiers cannot have leading zeros" }
  )
)

export const Recording = Schema.Struct({
  url: Schema.NonEmptyString,
  readySelector: Schema.NonEmptyString,
  steps: Schema.Array(Schema.Struct({
    kind: Schema.Literals(["click", "fill", "wait-text"]),
    selector: Schema.NonEmptyString,
    value: Schema.String
  })).check(Schema.isMaxLength(24))
})
export const RecordingAsset = Schema.Struct({ path: Schema.String, digest: Schema.String })

/**
 * An input key the caller may omit; it then holds `value`. A host builds flow
 * input with the payload schema's `make`, and a journal decodes it, so the
 * default is both a constructor and a decoding default.
 */
const defaultKey = <S extends Schema.Constraint & Schema.WithoutConstructorDefault>(
  schema: S,
  value: S["~type.make.in"] & S["Encoded"]
): Schema.withDecodingDefaultKey<Schema.withConstructorDefault<S>> =>
  Schema.withDecodingDefaultKey<Schema.withConstructorDefault<S>>(Effect.succeed(value))(
    Schema.withConstructorDefault<S>(Effect.succeed(value))(schema)
  )

const localOrigins = ["localhost", "127.0.0.1", "[::1]"]
const isLocalOrigin = (value: string) => {
  const url = URL.parse(value)
  return url !== null && /^https?:$/.test(url.protocol) && localOrigins.includes(url.hostname) && url.username === "" &&
    url.password === ""
}

/**
 * The release-content flow's input. Every key but `version` has a default, so a
 * run started with only a version is a dry-run preview of every channel.
 */
export const ContentInput = Schema.Struct({
  version: Version,
  from: defaultKey(Schema.NonEmptyString, "auto"),
  dryRun: defaultKey(Schema.Boolean, true),
  publish: defaultKey(Schema.Boolean, false),
  postX: defaultKey(Schema.Boolean, false),
  autoCommit: defaultKey(Schema.Boolean, false),
  recording: defaultKey(Schema.NullOr(Recording), null),
  channels: defaultKey(
    Schema.Struct({
      changelog: defaultKey(Schema.Boolean, true),
      blog: defaultKey(Schema.Boolean, true),
      thread: defaultKey(Schema.Boolean, true),
      media: defaultKey(Schema.Boolean, true)
    }),
    { changelog: true, blog: true, thread: true, media: true }
  ),
  title: defaultKey(Schema.String, ""),
  notes: defaultKey(Schema.String, ""),
  minScore: defaultKey(
    Schema.Finite.check(
      Schema.isBetween({ minimum: 0, maximum: 1 }, { message: "minScore must be between 0 and 1" })
    ),
    0.86
  ),
  maxRevisions: defaultKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: 3 }, { message: "maxRevisions must be an integer from 0 to 3" })
    ),
    2
  ),
  maxTweets: defaultKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: 12 }, { message: "maxTweets must be an integer from 1 to 12" })
    ),
    8
  ),
  maxTweetChars: defaultKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: 280 }, { message: "maxTweetChars must be an integer from 1 to 280" })
    ),
    280
  )
}).check(
  Schema.makeFilter((input) => input.channels.changelog || input.channels.blog || input.channels.thread, {
    message: "Enable at least one text channel"
  }),
  Schema.makeFilter((input) => !input.postX || (input.publish && input.channels.thread), {
    message: "postX requires publish=true and channels.thread=true"
  }),
  Schema.makeFilter((input) => !input.autoCommit || input.publish, { message: "autoCommit requires publish=true" }),
  Schema.makeFilter((input) => input.recording === null || isLocalOrigin(input.recording.url), {
    message: "recording.url must be a local HTTP(S) origin without credentials"
  })
)
export type ContentInput = typeof ContentInput.Type

/**
 * The release flow's input. Every key but `version` has a default, so a run
 * started with only a version is a dry-run preview of the prepare phase.
 */
export const ReleaseInput = Schema.Struct({
  version: Version,
  from: defaultKey(Schema.NonEmptyString, "auto"),
  phase: defaultKey(Schema.Literals(["prepare", "publish"]), "prepare"),
  dryRun: defaultKey(Schema.Boolean, true),
  contentArtifact: defaultKey(Schema.String, ""),
  requireContentApproval: defaultKey(Schema.Boolean, true),
  provenance: defaultKey(Schema.Boolean, true)
})
export type ReleaseInput = typeof ReleaseInput.Type

/** One release.yml gate the local path declared it cannot run; reported, never counted as passed. */
export const GateException = Schema.Struct({ name: Schema.String, command: Schema.String, reason: Schema.String })
/**
 * The checks step's receipt: every inventory gate that passed, by release.yml
 * step name and in order, and every declared exception that did not run. The
 * pack step writes it beside the release manifest as gate-evidence.json and
 * the approval prompt repeats the exceptions.
 */
export const GateEvidence = Schema.Struct({ ran: Schema.Array(Schema.String), exceptions: Schema.Array(GateException) })
export type GateEvidence = typeof GateEvidence.Type

export const Evidence = Schema.Struct({
  version: Schema.String,
  currentVersion: Schema.String,
  sourceSha: Schema.String,
  from: Schema.String,
  date: Schema.String,
  commits: Schema.String,
  changes: Schema.String,
  documents: Schema.String,
  recordings: Schema.Array(RecordingAsset),
  sources: Schema.Array(Schema.String),
  // Absent until the checks step runs; pack refuses evidence without it.
  gates: Schema.optionalKey(GateEvidence)
})
export type Evidence = typeof Evidence.Type

export const Analysis = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  highlights: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  migration: Schema.Array(Schema.String),
  claims: Schema.Array(Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    sources: Schema.Array(Schema.String)
  }))
})
export type Analysis = typeof Analysis.Type

/**
 * What the writer seat produces once the narrative is settled. The narrative
 * itself is not in here: Jev picks it and the caller writes it, so the seat
 * has no field to overwrite it with.
 */
export const Outline = Schema.Struct({
  angle: Schema.String,
  outline: Schema.Array(Schema.String)
})
export const Brief = Schema.Struct({
  template: Schema.String,
  ...Outline.fields
})
export const Copy = Schema.Struct({ text: Schema.String, claimIds: Schema.Array(Schema.String) })
export const Thread = Schema.Struct({ tweets: Schema.Array(Copy) })
export const Draft = Schema.Struct({ changelog: Copy, blog: Copy, thread: Thread })
export type Draft = typeof Draft.Type

export const Review = Schema.Struct({
  passed: Schema.Boolean,
  score: Schema.Number,
  feedback: Schema.Array(Schema.String)
})
export type Review = typeof Review.Type

export const Artifact = Schema.Struct({
  directory: Schema.String,
  digest: Schema.String,
  version: Schema.String,
  sourceSha: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String })),
  approvalPrompt: Schema.String
})
export type Artifact = typeof Artifact.Type

export const ContentResult = Schema.Struct({
  status: Schema.Literals(["preview", "approved", "declined", "published"]),
  artifact: Artifact,
  files: Schema.Array(Schema.String),
  tweetIds: Schema.Array(Schema.String)
})
export type ContentResult = typeof ContentResult.Type

export const DocumentationAudit = Schema.Struct({
  passed: Schema.Boolean,
  missing: Schema.Array(Schema.String),
  explanation: Schema.String
})

export const Candidate = Schema.Struct({
  directory: Schema.String,
  digest: Schema.String,
  sourceSha: Schema.String,
  version: Schema.String,
  packageCount: Schema.Number,
  approvalPrompt: Schema.String
})
export type Candidate = typeof Candidate.Type

export const ReleaseResult = Schema.Struct({
  status: Schema.Literals(["preview", "prepared", "declined", "published"]),
  version: Schema.String,
  artifact: Schema.String,
  published: Schema.Array(Schema.String)
})
export type ReleaseResult = typeof ReleaseResult.Type
