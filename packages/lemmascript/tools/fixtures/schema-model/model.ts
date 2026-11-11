// An Effect Schema model, as an app declares it. `use.ts` proves functions over `typeof Model.Type`; LemmaScript reads
// the value type the checker resolves, never the schema's own type text.
import { Effect, Schema } from "effect"

const Entry = Schema.Struct({ id: Schema.String, done: Schema.Boolean })
export const Client = Schema.Struct({
  seq: Schema.Int,
  entries: Schema.Array(Entry),
  pending: Schema.Array(Schema.Struct({ key: Schema.String, at: Schema.Int })),
})
export const Model = Schema.Struct({
  docs: Schema.Literals(["pane", "max"]),
  current: Client,
  previous: Client,
  rows: Schema.Array(Schema.Struct({ key: Schema.String, at: Schema.Int })),
  account: Schema.optionalKey(Schema.Struct({ name: Schema.String, owner: Schema.String.pipe(Schema.brand("Owner")) })),
  review: Schema.optional(Schema.Struct({ page: Schema.String })),
  sources: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  seen: Schema.optionalKey(Schema.Array(Schema.String)),
  age: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("new"))),
  status: Schema.Union([Schema.TaggedStruct("Idle", {}), Schema.TaggedStruct("Busy", { since: Schema.Int })]),
  count: Schema.Number,
})
export type Model = typeof Model.Type
export type Client = typeof Client.Type
